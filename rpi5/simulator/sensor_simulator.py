#!/usr/bin/env python3
"""
Orto Digitale v1.1 — Simulatore sensori WH51
Scrive in InfluxDB con lo schema identico ai dati reali.

Utilizzo:
  python3 sensor_simulator.py                     # loop real-time (60s)
  python3 sensor_simulator.py --backfill 48       # riempie 48h di storia, poi esce
  python3 sensor_simulator.py --backfill 48 --run # storia + loop real-time
"""

import argparse
import math
import os
import random
import sys
import time
from datetime import datetime, timezone, timedelta

try:
    from influxdb_client import InfluxDBClient, WriteOptions
    from influxdb_client.client.write_api import SYNCHRONOUS
    from influxdb_client.domain.write_precision import WritePrecision  # noqa
except ImportError:
    print("ERRORE: influxdb-client non installato.")
    print("Esegui: pip3 install influxdb-client")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Configurazione
# ---------------------------------------------------------------------------

INFLUXDB_URL    = "http://localhost:8086"
INFLUXDB_ORG    = "orto-digitale"
INFLUXDB_BUCKET = "garden"
LOOP_INTERVAL_S = 60        # secondi tra una scrittura e la successiva
HEALTH_EVERY    = 5         # scrivi system_health ogni N cicli (~5 min)
BATCH_SIZE      = 100       # punti per batch durante il backfill

ENV_FILE = os.path.join(os.path.dirname(__file__), "..", ".env")


def load_token() -> str:
    """Legge INFLUX_TOKEN_NODERED_RW dal file .env del progetto."""
    token = os.environ.get("INFLUX_TOKEN_NODERED_RW")
    if token:
        return token
    env_path = os.path.abspath(ENV_FILE)
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("INFLUX_TOKEN_NODERED_RW="):
                    return line.split("=", 1)[1].strip()
    raise RuntimeError(
        "Token INFLUX_TOKEN_NODERED_RW non trovato.\n"
        "Verifica il file .env o esporta la variabile d'ambiente."
    )


# ---------------------------------------------------------------------------
# Definizione sensori
# ---------------------------------------------------------------------------

SENSORS = [
    # (sensor_id, aiuola, position, moisture_start, drift_factor, batt_base, rssi_base)
    ("WH51_01", "1", "near", 52.0, 1.00, 1.42, -72),
    ("WH51_02", "1", "far",  45.0, 1.10, 1.38, -80),
    ("WH51_03", "2", "near", 60.0, 1.00, 1.45, -68),
    ("WH51_04", "2", "far",  38.0, 1.10, 1.35, -85),
    ("WH51_05", "3", "near", 55.0, 1.00, 1.40, -75),
    ("WH51_06", "3", "far",  42.0, 1.10, 1.33, -90),
]

# Perdita di umidità media per lettura a 60s: 0.4% / ora / 60 = ~0.00667% per lettura
BASE_DRIFT_PER_READING = 0.4 / 60.0  # %/lettura (a 60s interval)
MOISTURE_NOISE_SIGMA   = 1.5          # deviazione std rumore %
MOISTURE_MIN           = 15.0
MOISTURE_MAX           = 85.0
BATTERY_NOISE          = 0.02         # V
RSSI_NOISE             = 5            # dBm


# ---------------------------------------------------------------------------
# Stato per sensore
# ---------------------------------------------------------------------------

class SensorState:
    def __init__(self, sensor_id, aiuola, position, moisture_start,
                 drift_factor, batt_base, rssi_base):
        self.sensor_id    = sensor_id
        self.aiuola       = aiuola
        self.position     = position
        self.drift_factor = drift_factor
        self.batt_base    = batt_base
        self.rssi_base    = rssi_base
        self.moisture     = moisture_start
        # seed riproducibile per sensore (utile per backfill deterministico)
        self._rng = random.Random(hash(sensor_id))

    def next_reading(self, interval_s: int = 60) -> dict:
        """
        Genera la prossima lettura facendo avanzare lo stato interno.
        interval_s: secondi dall'ultima lettura (usato per scalare il drift).
        """
        # drift proporzionale all'intervallo
        drift = BASE_DRIFT_PER_READING * self.drift_factor * (interval_s / 60.0)
        noise = self._rng.gauss(0.0, MOISTURE_NOISE_SIGMA)
        self.moisture -= drift + noise * 0.1  # il rumore non sposta molto la media
        self.moisture = max(MOISTURE_MIN, min(MOISTURE_MAX, self.moisture))

        batt = self.batt_base + self._rng.uniform(-BATTERY_NOISE, BATTERY_NOISE)
        rssi = int(self.rssi_base + self._rng.uniform(-RSSI_NOISE, RSSI_NOISE))

        return {
            "value":           round(self.moisture + self._rng.gauss(0, MOISTURE_NOISE_SIGMA), 2),
            "battery_voltage": round(batt, 3),
            "battery_ok":      batt >= 1.1,
            "rssi":            rssi,
        }


def make_sensors() -> list[SensorState]:
    return [SensorState(*s) for s in SENSORS]


# ---------------------------------------------------------------------------
# Scrittura InfluxDB (Line Protocol)
# ---------------------------------------------------------------------------

def _soil_line(sensor: SensorState, reading: dict, ts_ns: int) -> str:
    """Genera una riga in Line Protocol per soil_moisture."""
    tags = (
        f"sensor_id={sensor.sensor_id},"
        f"aiuola={sensor.aiuola},"
        f"position={sensor.position}"
    )
    batt_ok = "true" if reading["battery_ok"] else "false"
    fields = (
        f"value={reading['value']},"
        f"battery_voltage={reading['battery_voltage']},"
        f"battery_ok={batt_ok},"
        f"rssi={reading['rssi']}i"
    )
    return f"soil_moisture,{tags} {fields} {ts_ns}"


def _health_line(sensor: SensorState, reading: dict, ts_ns: int,
                 last_seen_s: int) -> str:
    """Genera una riga in Line Protocol per system_health (sensore).
    Nota: online e battery_low sono interi (1/0) per coerenza con i dati esistenti.
    """
    online = "true" if last_seen_s < 180 else "false"
    batt_low = "false" if reading["battery_ok"] else "true"
    tags = f"component={sensor.sensor_id},component_type=sensor"
    fields = (
        f"online={online},"
        f"last_seen_seconds_ago={last_seen_s}i,"
        f"battery_low={batt_low},"
        f"battery_voltage={reading['battery_voltage']}"
    )
    return f"system_health,{tags} {fields} {ts_ns}"


def _gateway_health_line(ts_ns: int, last_seen_s: int) -> str:
    """Genera una riga in Line Protocol per system_health (gateway GW3000)."""
    online = "true" if last_seen_s < 180 else "false"
    tags = "component=GW3000,component_type=gateway"
    fields = f"online={online},last_seen_seconds_ago={last_seen_s}i"
    return f"system_health,{tags} {fields} {ts_ns}"


def write_batch(write_api, lines: list[str]):
    """Scrive un batch di righe Line Protocol in InfluxDB."""
    write_api.write(
        bucket=INFLUXDB_BUCKET,
        org=INFLUXDB_ORG,
        record="\n".join(lines),
        write_precision="ns",
    )


# ---------------------------------------------------------------------------
# Modalità backfill
# ---------------------------------------------------------------------------

def run_backfill(write_api, sensors: list[SensorState], hours: int):
    """
    Genera `hours` ore di dati storici a partire da adesso - hours fino a adesso.
    I dati vengono scritti in batch da BATCH_SIZE righe.
    """
    now_utc = datetime.now(timezone.utc)
    start_utc = now_utc - timedelta(hours=hours)
    total_readings = hours * 60  # una lettura al minuto per sensore

    print(f"Backfill: {hours}h di dati ({total_readings} letture per sensore)")
    print(f"  Da: {start_utc.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"  A:  {now_utc.strftime('%Y-%m-%d %H:%M UTC')}")

    batch: list[str] = []
    health_counter = 0
    written_points = 0

    for i in range(total_readings):
        ts = start_utc + timedelta(seconds=i * 60)
        ts_ns = int(ts.timestamp() * 1_000_000_000)

        for sensor in sensors:
            reading = sensor.next_reading(interval_s=60)
            batch.append(_soil_line(sensor, reading, ts_ns))

        health_counter += 1
        if health_counter >= HEALTH_EVERY:
            for sensor in sensors:
                reading = {"battery_voltage": sensor.batt_base, "battery_ok": True}
                batch.append(_health_line(sensor, reading, ts_ns, last_seen_s=60))
            batch.append(_gateway_health_line(ts_ns, last_seen_s=60))
            health_counter = 0

        if len(batch) >= BATCH_SIZE:
            write_batch(write_api, batch)
            written_points += len(batch)
            batch.clear()
            progress = (i + 1) / total_readings * 100
            print(f"  {progress:5.1f}%  {written_points} punti scritti", end="\r", flush=True)

    if batch:
        write_batch(write_api, batch)
        written_points += len(batch)

    print(f"\nBackfill completato: {written_points} punti totali scritti.")


# ---------------------------------------------------------------------------
# Modalità loop real-time
# ---------------------------------------------------------------------------

def run_loop(write_api, sensors: list[SensorState]):
    """
    Loop continuo: scrive una lettura per ogni sensore ogni LOOP_INTERVAL_S secondi.
    """
    print(f"Loop real-time avviato (intervallo {LOOP_INTERVAL_S}s). Ctrl+C per fermare.")
    cycle = 0

    while True:
        start = time.monotonic()
        ts_ns = int(time.time() * 1_000_000_000)
        ts_str = datetime.now(timezone.utc).strftime("%H:%M:%S")

        lines: list[str] = []
        readings: dict[str, dict] = {}

        for sensor in sensors:
            reading = sensor.next_reading(interval_s=LOOP_INTERVAL_S)
            readings[sensor.sensor_id] = reading
            lines.append(_soil_line(sensor, reading, ts_ns))

        cycle += 1
        if cycle % HEALTH_EVERY == 0:
            for sensor in sensors:
                lines.append(_health_line(sensor, readings[sensor.sensor_id],
                                          ts_ns, last_seen_s=LOOP_INTERVAL_S))
            lines.append(_gateway_health_line(ts_ns, last_seen_s=LOOP_INTERVAL_S))

        try:
            write_batch(write_api, lines)
            moisture_str = " | ".join(
                f"{s.sensor_id}:{readings[s.sensor_id]['value']:.1f}%"
                for s in sensors
            )
            print(f"[{ts_str}] {moisture_str}")
        except Exception as exc:
            print(f"[{ts_str}] ERRORE scrittura: {exc}", file=sys.stderr)

        elapsed = time.monotonic() - start
        sleep_s = max(0.0, LOOP_INTERVAL_S - elapsed)
        time.sleep(sleep_s)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Simulatore sensori WH51 — Orto Digitale")
    parser.add_argument(
        "--backfill", type=int, metavar="HOURS",
        help="Riempie N ore di dati storici in InfluxDB prima di uscire (o di avviare il loop)."
    )
    parser.add_argument(
        "--run", action="store_true",
        help="Avvia il loop real-time dopo il backfill (ignorato senza --backfill)."
    )
    args = parser.parse_args()

    # Se né --backfill né --run: modalità loop di default
    if not args.backfill and not args.run:
        args.run = True

    token = load_token()
    client = InfluxDBClient(url=INFLUXDB_URL, token=token, org=INFLUXDB_ORG)
    write_api = client.write_api(write_options=SYNCHRONOUS)

    sensors = make_sensors()

    try:
        if args.backfill:
            run_backfill(write_api, sensors, args.backfill)

        if args.run or not args.backfill:
            run_loop(write_api, sensors)

    except KeyboardInterrupt:
        print("\nSimulatore fermato.")
    finally:
        write_api.close()
        client.close()


if __name__ == "__main__":
    main()
