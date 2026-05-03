# Step 4 — Logica Irrigazione Automatica

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Architettura](#2-architettura)
3. [Flussi Node-RED](#3-flussi-node-red)
4. [Schema InfluxDB](#4-schema-influxdb)
5. [Config Store](#5-config-store)
6. [Integrazione Open-Meteo](#6-integrazione-open-meteo)
7. [Algoritmo decisionale](#7-algoritmo-decisionale)
8. [State machine valvola](#8-state-machine-valvola)
9. [Boot recovery](#9-boot-recovery)
10. [Modalità dry_run](#10-modalit%C3%A0-dry_run)
11. [Endpoint HTTP](#11-endpoint-http)
12. [Out of scope per step 4](#12-out-of-scope-per-step-4)

> Documenti propedeutici (decisioni di design):
> - [`analisi_logica_irrigazione.md`](./analisi_logica_irrigazione.md)
> - [`analisi_integrazione_meteo.md`](./analisi_integrazione_meteo.md)
> - [`analisi_completezza_step4.md`](./analisi_completezza_step4.md)

---

## 1. Obiettivo

Trasformare il sistema da reattivo (utente preme bottone, valvola apre) ad autonomo: Node-RED decide ogni 5 minuti se aprire la valvola SWV_valvola in base a umidità del suolo, finestra orario, cooldown, previsioni meteo e validità sensori, registrando ogni decisione (anche le non-aperture) su InfluxDB.

**Vincolo non negoziabile:** tutti i parametri sono configurabili a runtime (no hardcoded), modificabili via MQTT/HTTP per il futuro frontend di step 5.

---

## 2. Architettura

```
                        ┌────────────────────────┐
                        │  irrigation_config.json │ (persistente, /data/)
                        └────────────┬───────────┘
                                     │ load at boot
                                     ▼
   ┌────────────────────────────────────────────────────────────────┐
   │                   Node-RED — global.context                    │
   │  irrigation_config | weather_cache | valve_runtime | last_*    │
   └────┬─────────────┬──────────────┬─────────────────┬────────────┘
        │             │              │                 │
        ▼             ▼              ▼                 ▼
   ┌────────┐   ┌─────────┐   ┌────────────┐   ┌──────────────┐
   │ Config │   │ Weather │   │  Decision  │   │ Boot Recovery│
   │ Store  │   │ Polling │   │   Loop     │   │  (one-shot)  │
   │ (HTTP+ │   │  30min  │   │   5min     │   │              │
   │  MQTT) │   │         │   │            │   │              │
   └────┬───┘   └────┬────┘   └──────┬─────┘   └──────┬───────┘
        │            │               │                │
        │            │   ┌───────────┴────┐           │
        │            │   ▼                ▼           │
        │            │ apri valvola   skip + log     │
        │            │   │                │           │
        │            ▼   ▼                ▼           ▼
        │       ┌──────────────────────────────────────┐
        └──────►│           InfluxDB (garden)          │
                │ weather_forecast | irrigation_events │
                │ valve_state      | soil_moisture     │
                └──────────────────────────────────────┘
                                ▲                    ▲
                                │                    │
                  zigbee2mqtt/SWV_valvola      ecowitt/gw3000
                  (sub stato + pub set)        (esistente, immutato)
```

---

## 3. Flussi Node-RED

| Tab | Ruolo | Esistente |
|---|---|---|
| `f-ecowitt` | Parsing GW3000 → `soil_moisture` | ✅ immutato |
| `f-valve` | HTTP POST /api/valve/{on,off,toggle} + sub stato + safety + tracking irrigation_events | ✅ esteso (vedi §3.1) |
| `f-config` | Config store: load file, HTTP/MQTT endpoints, validazione, persist | ➕ nuovo |
| `f-weather` | Open-Meteo polling 30 min + cache + write `weather_forecast` | ➕ nuovo |
| `f-decision` | Tick 5 min + algoritmo decisionale + monitoring 60s | ➕ nuovo |
| `f-recovery` | Recovery al boot Node-RED (one-shot) | ➕ nuovo |

### 3.1 Estensioni a `f-valve`

- `safety_min_override` rimpiazzato dal valore `irrigation.safety_timeout_seconds` letto dal config store
- `n-fn-valve-irrigation-event` riscritto per popolare i 15 campi (vedi §4)
- Aggiunto un `valve_state_runtime` in `global.context` aggiornato al ricevere ogni messaggio MQTT da `zigbee2mqtt/SWV_valvola`

---

## 4. Schema InfluxDB

### 4.1 Measurement `irrigation_events` (esteso)

| Field | Tipo | Quando | Note |
|---|---|---|---|
| `state` | string | start/end | "ON"/"OFF" |
| `duration_seconds` | float | end | misurato a fine evento |
| `avg_moisture_at_trigger` | float | start | media sensori validi |
| `avg_moisture_at_close` | float | end | media sensori validi a chiusura |
| `delta_moisture` | float | end | derivata: close − trigger |
| `reason` | string | end/skip | "scheduled"/"emergency"/"recovery_timeout"/"recovery_lost"/"manual" |
| `skip_reason` | string | skip | "rain_delay"/"cooldown"/"no_quorum"/"out_of_window"/"paused"/"valve_unreachable"/null |
| `rain_forecast_mm` | float | start/skip | da snapshot meteo |
| `weather_data_age_seconds` | int | start/skip | età cache al momento decisione |
| `weather_available` | bool | start/skip | false se cache scaduta |
| `sensor_count` | int | start/skip | sensori validi al tick |
| `sensors_high_variance` | bool | start/skip | stddev > soglia |
| `total_liters` | float | end | duration × flow rate (se disponibile) |
| `dry_run` | bool | sempre | true se mode=dry_run |

| Tag | Valori |
|---|---|
| `trigger` | `auto` / `manual` / `emergency` / `orphan_recovery` / `skip` |
| `valve_id` | `SWV_01` |

> **Nota retrocompatibilità:** i record esistenti pre-step 4 hanno solo `state`, `duration_seconds`, `avg_moisture_at_trigger`, `reason`. InfluxDB è schemaless, quindi nessuna migrazione necessaria. Le query Flux di step 5 dovranno gestire campi mancanti.

### 4.2 Measurement `weather_forecast` (nuovo)

| Tag | Valore |
|---|---|
| `source` | `openmeteo` |
| `location` | `orto` |

| Field | Tipo | Calcolo |
|---|---|---|
| `precip_next_24h_mm` | float | sum(hourly.precipitation[0:24]) |
| `precip_next_6h_mm` | float | sum(hourly.precipitation[0:6]) |
| `temp_max_next_12h_c` | float | max(hourly.temperature_2m[0:12]) |
| `humidity_now_pct` | float | hourly.relative_humidity_2m[0] |
| `api_latency_ms` | int | misurato lato Node-RED |

### 4.3 Measurement `valve_state` (immutato)
Già popolato dal flow esistente: `state`, `battery`, `linkquality`, `current_device_status`, `flow`, `reachable`, tag `valve_id=SWV_01`.

---

## 5. Config Store

### 5.1 File persistente
**Path:** `/data/irrigation_config.json` (relativo al volume Node-RED `/opt/orto-digitale/rpi5/nodered/data/`)

### 5.2 Schema completo + default

```json
{
  "irrigation": {
    "soglia_apertura_pct": 40,
    "soglia_chiusura_pct": 65,
    "soglia_emergenza_pct": 25,
    "cooldown_seconds": 7200,
    "safety_timeout_seconds": 900,
    "emergency_duration_seconds": 300,
    "finestra_mattina": ["06:00", "08:00"],
    "finestra_sera": ["19:00", "21:00"],
    "polling_interval_seconds": 300,
    "monitoring_interval_seconds": 60
  },
  "weather": {
    "polling_interval_seconds": 1800,
    "cache_max_age_seconds": 5400,
    "rain_threshold_mm": 5,
    "rain_window_hours": 24,
    "api_url": "https://api.open-meteo.com/v1/forecast",
    "lat": 45.71722434055733,
    "lon": 9.733793667999565
  },
  "valve": {
    "command_timeout_seconds": 30,
    "max_retries": 1,
    "unreachable_alert_after": 3
  },
  "sensors": {
    "max_age_seconds": 1800,
    "min_quorum": 2,
    "stddev_warning_pct": 25
  },
  "mode": "dry_run",
  "pause_until": null
}
```

### 5.3 Validazione (backend authoritative)

Vincoli applicati al set:
- `soglia_emergenza < soglia_apertura < soglia_chiusura` (tutte 0–100)
- `emergency_duration < safety_timeout`
- `weather.cache_max_age > weather.polling_interval`
- `mode ∈ {auto, paused, dry_run}`
- `pause_until` ISO 8601 o null

Set non valido → 400 Bad Request, stato non modificato.

### 5.4 Endpoint
- `GET /api/config` → JSON intero
- `POST /api/config/<dot.path>` body `{"value": ...}` → modifica chiave singola, persiste, applica al prossimo tick
- `GET /api/state` → snapshot runtime (valvola, last_irrigation_at, in_progress, mode, weather cache age)
- MQTT: subscribe `orto/config/set/+/+`, payload = nuovo valore. Risposta su `orto/config/result`.

---

## 6. Integrazione Open-Meteo

**Polling node** ogni `weather.polling_interval_seconds` (default 1800):

1. HTTP GET `https://api.open-meteo.com/v1/forecast?latitude=45.71722434055733&longitude=9.733793667999565&hourly=precipitation,temperature_2m,relative_humidity_2m&forecast_days=2&timezone=Europe/Rome`
2. Calcola i 4 scalari (vedi §4.2)
3. Aggiorna `global.weather_cache = { ...scalari, fetched_at: Date.now() }`
4. Scrive su `weather_forecast`

**Fallback:** chiamata fallita → log warning, **non svuota la cache**. Cache scaduta (`age > cache_max_age_seconds`) → `weather_available=false` per la decisione successiva, rain delay disattivato.

---

## 7. Algoritmo decisionale

Tick ogni `irrigation.polling_interval_seconds` (default 300s):

```
SE in_progress = true → vai a monitoring (§7.1)
SE mode = "paused" → skip "paused"
SE mode != "auto" e mode != "dry_run" → skip

1. UMIDITÀ
   Carica sensori: filter(_measurement=soil_moisture, last point per sensor_id, age < sensors.max_age_seconds)
   SE count < sensors.min_quorum → skip "no_quorum"
   media = avg(value)
   stddev = stddev(value)
   high_variance = stddev > sensors.stddev_warning_pct

   SE media >= soglia_apertura → skip null (umidità sufficiente, no log evento)

   is_emergency = (media < soglia_emergenza)

2. ORARIO
   SE NOT is_emergency E orario fuori da finestra_mattina e finestra_sera → skip "out_of_window"

3. COOLDOWN (sempre, anche emergency)
   SE (now - last_irrigation_at) < cooldown_seconds → skip "cooldown"

4. PIOGGIA
   weather_age = (now - weather_cache.fetched_at)
   weather_available = (weather_age < cache_max_age_seconds)
   SE weather_available E precip_next_24h_mm >= rain_threshold_mm → skip "rain_delay"

5. APRI
   trigger = is_emergency ? "emergency" : "auto"
   target_duration = is_emergency ? emergency_duration_seconds : safety_timeout_seconds
   pubblica su zigbee2mqtt/SWV_valvola/set (o mock se dry_run)
   set in_progress=true, opened_at=now, target_duration=...
   log evento ON su irrigation_events
```

### 7.1 Monitoring durante irrigazione

Tick ogni `monitoring_interval_seconds` (default 60s) finché `in_progress=true`:

```
ricarica sensori (stesso quorum check)
SE media > soglia_chiusura → CHIUDI ("threshold_reached")
SE (now - opened_at) > target_duration → CHIUDI ("safety_timeout")
```

Chiusura: pubblica `{"state":"OFF"}` su `zigbee2mqtt/SWV_valvola/set`, log evento OFF con `delta_moisture`, `total_liters` (se `valve_state.flow` disponibile), `reason`.

> La finestra orario governa **solo** l'apertura: il monitoring continua oltre la fine della finestra fino a soglia/timeout.

---

## 8. State machine valvola

Stati: `IDLE → OPENING → OPEN → CLOSING → IDLE`.

### 8.1 Apertura

```
publish zigbee2mqtt/SWV_valvola/set {"state":"ON"}
attendi conferma sub zigbee2mqtt/SWV_valvola con state=ON
  └─ entro valve.command_timeout_seconds (30s) → IDLE→OPEN, log evento ON
  └─ oltre timeout → retry una volta (max_retries=1)
                        └─ ancora timeout → log error + scrive evento valve_failure (reason="no_confirmation")
```

### 8.2 Reachability
Subscribe a `valve_state` (via flow esistente) → se `reachable=false` (campo del payload Z2M) prima di tentare apertura: skip immediato `valve_unreachable`.

Counter `flow.context.valve_unreachable_consecutive`: incrementato ad ogni skip. Dopo `valve.unreachable_alert_after` (default 3) consecutivi → log warning. Reset al primo successo.

---

## 9. Boot recovery

One-shot all'avvio Node-RED, **dopo** subscribe MQTT e load config:

1. Subscribe `zigbee2mqtt/SWV_valvola` (max attesa 60s primo messaggio)
2. Query Flux:
   - `from(bucket:"garden") |> range(start: -24h) |> filter(_measurement=="irrigation_events") |> last()` → ultimo evento
   - `from(bucket:"garden") |> range(start: -1h) |> filter(_measurement=="valve_state") |> filter(_field=="state") |> last()` → ultimo stato
3. Risolvi:

| Stato MQTT | Ultimo evento | Azione |
|---|---|---|
| OFF | chiuso/assente | normale, `in_progress=false` |
| ON | aperto, durata < safety_timeout | riprendi monitoring (`opened_at` da evento) |
| ON | aperto, durata > safety_timeout | force CLOSE + chiudi evento `recovery_timeout` |
| ON | nessun evento aperto | force CLOSE + scrivi evento orfano `trigger=orphan_recovery` |
| OFF | aperto | chiudi evento `recovery_lost` (perdita di tracking) |

Tutti gli scenari anomali vengono **loggati** (non normalizzati silenziosamente).

---

## 10. Modalità dry_run

Default a deploy. `mode="dry_run"`:

- Logica decisionale gira normalmente
- Comando di apertura/chiusura va su topic mock `orto/dryrun/valve/set` invece di `zigbee2mqtt/SWV_valvola/set`
- Eventi su `irrigation_events` con field `dry_run=true`
- Switch a `auto` manuale dopo 1–2 settimane di osservazione

---

## 11. Endpoint HTTP

Tutti su `http://192.168.1.12:1880`, no auth (rete locale step 4).

| Metodo | Path | Descrizione |
|---|---|---|
| `GET` | `/api/config` | Config corrente JSON |
| `POST` | `/api/config/<dot.path>` | Modifica chiave (body `{"value": ...}`) |
| `GET` | `/api/state` | Stato runtime |
| `POST` | `/api/valve/{on,off,toggle}` | Manuale (esistente) |

---

## 12. Out of scope per step 4

Rimandato a step 4+, 5 o 6:
- Soglie adattive per temperatura estiva
- Backfill storico Open-Meteo `/archive`
- Measurement `weather_observation`
- Calibrazione adattiva durata in base a `delta_moisture`
- Notifiche Telegram/email
- Auth sugli endpoint HTTP
- `force_irrigate` UI button
- Migrazione tag `aiuola=test` → valori reali (pre step 5)
- Dashboard Grafana decisioni
- Modello evapotraspirazione

---
