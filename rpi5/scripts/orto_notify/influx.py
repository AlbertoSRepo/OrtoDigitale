"""Client InfluxDB di sola lettura. Nessuna scrittura, mai."""
import csv
import io
import urllib.request
from datetime import datetime, timedelta, timezone

from orto_notify import (
    ESCLUSIONE_DOPO_MIN,
    ESCLUSIONE_PRIMA_MIN,
    INFLUX_BUCKET,
    INFLUX_ORG,
    INFLUX_URL,
)

TIMEOUT_S = 20

# Aggregato orario di un campo, con la funzione richiesta.
# Raggruppa SOLO per sensor_id: aiuola/position sono inaffidabili sui punti
# anteriori al 2026-08-15 (valevano la stringa "test").
FLUX_AGGREGATO = '''
from(bucket: "{bucket}")
  |> range(start: -{giorni}d)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "{campo}")
  |> group(columns: ["sensor_id"])
  |> aggregateWindow(every: 1h, fn: {fn}, createEmpty: true)
  |> keep(columns: ["_time", "_value", "sensor_id"])
'''

# Il piu' lungo intervallo fra due campioni consecutivi, per ora.
# elapsed() da' la distanza in minuti fra record successivi.
FLUX_SILENZIO = '''
from(bucket: "{bucket}")
  |> range(start: -{giorni}d)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> group(columns: ["sensor_id"])
  |> elapsed(unit: 1m)
  |> aggregateWindow(every: 1h, fn: max, column: "elapsed", createEmpty: true)
  |> keep(columns: ["_time", "elapsed", "sensor_id"])
'''

# Istante dell'ultima lettura per sonda. Serve perche' un bucket orario e'
# vecchio fino a 60 min per costruzione: usarlo per misurare il silenzio
# farebbe risultare muta ogni sonda a ogni ciclo.
FLUX_ULTIMO = '''
from(bucket: "{bucket}")
  |> range(start: -6h)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> group(columns: ["sensor_id"])
  |> last()
  |> keep(columns: ["_time", "_value", "sensor_id"])
'''

# Chiusure valvola: servono per escludere le finestre di irrigazione.
FLUX_EVENTI = '''
from(bucket: "{bucket}")
  |> range(start: -{giorni}d)
  |> filter(fn: (r) => r._measurement == "irrigation_events" and r._field == "duration_seconds")
  |> keep(columns: ["_time", "_value"])
'''


def _trasporto_http(url, headers, body):
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read().decode("utf-8")


def interroga(flux, token, trasporto=None):
    """Esegue una query Flux e restituisce le righe come dizionari.

    Il timestamp `_time`, se presente, viene convertito in datetime con fuso.
    """
    inviare = trasporto or _trasporto_http
    url = "%s?org=%s" % (INFLUX_URL, INFLUX_ORG)
    headers = {
        "Authorization": "Token %s" % token,
        "Content-Type": "application/vnd.flux",
        "Accept": "application/csv",
    }
    testo = inviare(url, headers, flux)

    righe = []
    for record in csv.DictReader(io.StringIO(testo)):
        # Le tabelle Flux sono separate da righe vuote: DictReader le rende
        # dizionari con sole chiavi None/vuote. Si scartano.
        if not record.get("result") and not record.get("_time"):
            continue
        pulito = {k: v for k, v in record.items() if k}
        if "_time" in pulito and pulito["_time"]:
            pulito["_time"] = datetime.fromisoformat(pulito["_time"].replace("Z", "+00:00"))
        righe.append(pulito)
    return righe


def _num(valore):
    try:
        return float(valore)
    except (TypeError, ValueError):
        return None


def serie_oraria(token, giorni, trasporto=None):
    """Aggregati orari per sonda: campioni, media, sigma, silenzio, batteria.

    Tutte le feature dello step si ricavano da qui: ~2.880 righe per 30 giorni,
    invece delle ~173.000 dei campioni grezzi.
    """
    def q(campo, fn):
        return interroga(
            FLUX_AGGREGATO.format(bucket=INFLUX_BUCKET, giorni=giorni, campo=campo, fn=fn),
            token, trasporto=trasporto,
        )

    unite = {}

    def deposita(righe, chiave, colonna="_value"):
        for r in righe:
            k = (r.get("sensor_id"), r.get("_time"))
            if not k[0] or not k[1]:
                continue
            unite.setdefault(k, {"sensor_id": k[0], "ora": k[1]})[chiave] = _num(r.get(colonna))

    deposita(q("value", "count"), "campioni")
    deposita(q("value", "mean"), "media")
    deposita(q("value", "stddev"), "sigma")
    deposita(q("battery_voltage", "mean"), "batteria")
    deposita(
        interroga(FLUX_SILENZIO.format(bucket=INFLUX_BUCKET, giorni=giorni), token, trasporto=trasporto),
        "silenzio_max_min", colonna="elapsed",
    )

    fuori = []
    for riga in unite.values():
        riga["campioni"] = int(riga.get("campioni") or 0)
        fuori.append(riga)
    fuori.sort(key=lambda r: (r["sensor_id"], r["ora"]))
    return fuori


def ultimo_campione(token, trasporto=None):
    """Istante dell'ultima lettura per sonda: {sensor_id: datetime}.

    E' il solo modo esatto di misurare il silenzio: gli aggregati orari non
    bastano (vedi commento su FLUX_ULTIMO).
    """
    righe = interroga(FLUX_ULTIMO.format(bucket=INFLUX_BUCKET), token, trasporto=trasporto)
    fuori = {}
    for r in righe:
        sonda, quando = r.get("sensor_id"), r.get("_time")
        if sonda and quando:
            fuori[sonda] = quando
    return fuori


def finestre_irrigazione(token, giorni, trasporto=None):
    """Intervalli da escludere, gia' allargati secondo la spec §3/D7.

    irrigation_events viene scritto solo alla chiusura, con duration_seconds:
    l'apertura si ricava all'indietro, come fa gia' /api/valve/intervals.
    """
    righe = interroga(
        FLUX_EVENTI.format(bucket=INFLUX_BUCKET, giorni=giorni), token, trasporto=trasporto
    )
    finestre = []
    for r in righe:
        fine = r.get("_time")
        durata = _num(r.get("_value"))
        if not fine or not durata:
            continue
        inizio = fine - timedelta(seconds=durata)
        finestre.append((
            inizio - timedelta(minutes=ESCLUSIONE_PRIMA_MIN),
            fine + timedelta(minutes=ESCLUSIONE_DOPO_MIN),
        ))
    return finestre


def dentro_finestra(istante, finestre):
    return any(a <= istante <= b for a, b in finestre)
