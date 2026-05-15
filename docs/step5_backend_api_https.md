# Step 5 — Backend API + HTTPS infrastructure

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Architettura](#2-architettura)
3. [Endpoint HTTP — specifica completa](#3-endpoint-http--specifica-completa)
4. [Estensione flow Node-RED `f-valve`](#4-estensione-flow-node-red-f-valve)
5. [Nuovo flow `f-api-readers`](#5-nuovo-flow-f-api-readers)
6. [Nuovo flow `f-system`](#6-nuovo-flow-f-system)
7. [Sudoers per shutdown](#7-sudoers-per-shutdown)
8. [Container Caddy + HTTPS](#8-container-caddy--https)
9. [Estrazione root CA + installazione su telefono](#9-estrazione-root-ca--installazione-su-telefono)
10. [Aggiornamento `verify_rpi5.sh`](#10-aggiornamento-verify_rpi5sh)
11. [Verifica end-to-end](#11-verifica-end-to-end)
12. [Out of scope](#12-out-of-scope)

> Documenti propedeutici: [`frontend_dati_spec.md`](./frontend_dati_spec.md), [`step4_irrigazione_automatica.md`](./step4_irrigazione_automatica.md)

---

## 1. Obiettivo

Esporre via HTTP tutti i dati e i comandi che la PWA (step 6-7) consumerà, e mettere in piedi un layer HTTPS terminato da Caddy con CA locale per rendere la PWA installabile su Android. Il frontend non parlerà mai direttamente con InfluxDB o MQTT: tutto passa da Node-RED, che resta il single source of truth.

**Vincolo non negoziabile:** nessun token InfluxDB esposto al browser; nessuna porta InfluxDB pubblicata su Caddy.

---

## 2. Architettura

```
                  ┌─────────────────────────┐
                  │       Browser PWA       │
                  │   https://orto.local    │
                  └────────────┬────────────┘
                               │ HTTPS (TLS internal Caddy CA)
                               ▼
                  ┌─────────────────────────┐
                  │   Container caddy:443   │
                  │  - tls internal         │
                  │  - file_server /srv     │  (vuoto fino a step 6)
                  │  - reverse_proxy /api/* │
                  └────────────┬────────────┘
                               │ HTTP iot-net
                               ▼
                  ┌─────────────────────────┐
                  │  Container nodered:1880 │
                  │       /api/*            │
                  └────┬─────────────┬──────┘
                       │             │
                ┌──────▼────┐   ┌────▼──────────┐
                │ InfluxDB  │   │  Mosquitto    │
                │  garden   │   │ zigbee2mqtt/* │
                └───────────┘   └───────────────┘
```

---

## 3. Endpoint HTTP — specifica completa

Tutti gli endpoint sono prefissati `/api`. Risposta JSON, `Content-Type: application/json`. Errori in formato `{ "error": "...", "code": 4xx/5xx }`.

### 3.1 Lettura sensori

| Endpoint | Verbo | Query | Risposta |
|---|---|---|---|
| `/api/sensors/last` | GET | — | `[{ sensor_id, aiuola, position, value, timestamp, battery_ok, rssi, online }]` (6 elementi) |
| `/api/sensors/trend` | GET | `sensor_id` (opz: tutti se omesso), `start` (ISO8601 o relativo `-24h`), `stop` (default `now()`), `every` (opz: aggregation interval) | `{ "WH51_01": [{t, value}, ...], ... }` |

Query Flux per `last`:
```flux
from(bucket:"garden")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "soil_moisture")
  |> last()
  |> pivot(rowKey:["_time"], columnKey:["_field"], valueColumn:"_value")
```
`online` = `(now - timestamp) < 30 min`.

Query Flux per `trend` con aggregation automatica:
- finestra ≤ 6h → no aggregation (raw ~60s)
- 6h < finestra ≤ 7d → `aggregateWindow(every: 5m, fn: mean)`
- finestra > 7d → `aggregateWindow(every: 1h, fn: mean)`

### 3.2 Valvola

| Endpoint | Verbo | Body / Query | Risposta |
|---|---|---|---|
| `/api/valve/state` | GET | — | `{ valve_id, state, reachable, linkquality, last_change, open_since_seconds, auto_close_in_seconds, max_duration_seconds }` |
| `/api/valve/on` | POST | `{ duration_seconds?: int }` | `{ ok, state, duration_seconds_applied }` |
| `/api/valve/off` | POST | — | `{ ok, state }` |
| `/api/valve/toggle` | POST | — | `{ ok, state }` |
| `/api/valve/intervals` | GET | `start`, `stop` | `[{ start, end, duration_seconds, trigger }]` (auto/manual) |
| `/api/valve/cumulative` | GET | `start`, `stop` | `{ total_open_seconds }` |

**`/api/valve/on` body:**
- Se `duration_seconds` omesso → usa `safety_timeout_seconds` da config (default 900s).
- Se `duration_seconds` presente → **clamp a `[60, safety_timeout_seconds]`**: rifiuta valori < 60s con 400, satura a `safety_timeout_seconds` se maggiore.
- Salva la durata richiesta in `global.context.valve_runtime.requested_duration` perché lo step chart e `auto_close_in_seconds` la usino.

**`open_since_seconds` / `auto_close_in_seconds`:**
- `open_since_seconds = (now - last_change_to_ON) / 1000` se state == ON, altrimenti `null`.
- `auto_close_in_seconds = max(0, requested_duration - open_since_seconds)` se ON, altrimenti `null`.

### 3.3 Meteo

| Endpoint | Verbo | Risposta |
|---|---|---|
| `/api/weather/now` | GET | `{ temperature_c, humidity_pct, timestamp, source }` (`source = "openmeteo"`) |
| `/api/weather/forecast` | GET | `[{ date, t_min, t_max, precip_mm, icon, weather_code }, ...]` (7 elementi) |

Sorgente: measurement `weather_forecast` (già scritto da step 4 ogni 30 min). Per forecast 7 giorni, leggere ultimi 7 punti aggregati per giornata. Mapping `weather_code` → `icon` (emoji o nome PNG asset) fatto lato Node-RED tramite tabella standard WMO.

### 3.4 Sistema

| Endpoint | Verbo | Body | Risposta |
|---|---|---|---|
| `/api/system/shutdown` | POST | `{ "confirm": "shutdown" }` | `{ ok: true, scheduled_in_seconds: 5 }` |
| `/api/system/health` | GET | — | `{ uptime_seconds, nodered_version, influxdb_reachable, mosquitto_reachable, zigbee2mqtt_reachable }` |

**`/api/system/shutdown`:**
- Rifiuta con 400 se body non contiene `confirm == "shutdown"`.
- Esegue `exec sudo /sbin/shutdown -h +1` (1 min, per dare tempo alla UI di mostrare conferma).
- Risponde immediatamente, lo spegnimento avviene asincrono.
- Log su InfluxDB measurement `system_events` con `event=shutdown_requested, source=api`.

---

## 4. Estensione flow Node-RED `f-valve`

Modifiche al flow esistente (vedi `docs/step4_irrigazione_automatica.md §3.1`):

1. Sostituire il nodo `http-in POST /api/valve/on` (oggi senza body) con uno che parsa `msg.req.body.duration_seconds`.
2. Aggiungere function node `clamp-duration`:
   ```javascript
   const cfg = global.get("irrigation_config");
   const safety = cfg.safety_timeout_seconds || 900;
   let d = msg.payload?.duration_seconds;
   if (d === undefined || d === null) d = safety;
   if (typeof d !== "number" || d < 60) {
     msg.statusCode = 400;
     msg.payload = { error: "duration_seconds must be >= 60", code: 400 };
     return [null, msg];
   }
   d = Math.min(d, safety);
   const runtime = global.get("valve_runtime") || {};
   runtime.requested_duration = d;
   runtime.opened_at = Date.now();
   global.set("valve_runtime", runtime);
   msg.duration_seconds_applied = d;
   return [msg, null];
   ```
3. Il decision-loop esistente deve leggere `requested_duration` quando l'apertura è manuale, non sovrascrivere con `safety_timeout`.
4. Nuovo nodo `http-in GET /api/valve/state` che assembla la risposta da:
   - `global.context.valve_state` (state, reachable, linkquality, last_change)
   - `global.context.valve_runtime` (requested_duration, opened_at)
   - calcoli inline per `open_since_seconds`, `auto_close_in_seconds`

---

## 5. Nuovo flow `f-api-readers`

Tab dedicato ai soli endpoint di lettura InfluxDB. Pattern uniforme: `http-in` → `function` (costruisce query Flux) → `influxdb-query` → `function` (formatta risposta) → `http-response`.

Nodi richiesti:
- `http-in GET /api/sensors/last` + function `flux-last-all-sensors`
- `http-in GET /api/sensors/trend` + function `flux-trend-aggregated`
- `http-in GET /api/valve/intervals` + function `flux-intervals`
- `http-in GET /api/valve/cumulative` + function `flux-cumulative`
- `http-in GET /api/weather/now` + function `flux-weather-now`
- `http-in GET /api/weather/forecast` + function `flux-weather-forecast`

**Caching opzionale (consigliato per ridurre carico InfluxDB):**
Per gli endpoint `last` e `weather/now`, cache in memoria di 10s (Node-RED `flow.context` con TTL).

---

## 6. Nuovo flow `f-system`

Tab dedicato a comandi di sistema.

Nodi:
- `http-in POST /api/system/shutdown` → function `validate-confirm` → `exec` con `sudo /sbin/shutdown -h +1`
- `http-in GET /api/system/health` → function che fa ping TCP su `influxdb:8086`, `mosquitto:1883`, `zigbee2mqtt:8080` (usa nodo `tcp-request` o `exec nc -z`)

Il nodo `exec` per shutdown deve:
- Comando: `sudo`
- Argomenti: `/sbin/shutdown -h +1 "Shutdown richiesto da PWA"`
- Append: false
- Use spawn: false
- Append timeout: 5s

---

## 7. Sudoers per shutdown

Sul RPi5, creare `/etc/sudoers.d/nodered-shutdown` con permessi 440:

```
# Consente al container nodered di spegnere il sistema
nodered ALL=(root) NOPASSWD: /sbin/shutdown -h +1
nodered ALL=(root) NOPASSWD: /sbin/shutdown -h now
nodered ALL=(root) NOPASSWD: /sbin/shutdown -c
```

**Vincolo:** il processo Node-RED nel container gira con UID 1000 (mappato a un utente `nodered` sull'host, se esiste — verificare con `id 1000` sul host).

**Alternativa più sicura** (se UID mapping non funziona): mount socket `/var/run/docker.sock` no, **evita**. Meglio uno script wrapper SSH:
- Container nodered esegue `ssh -i /data/.ssh/shutdown_key shutdown@localhost shutdown.sh`
- `shutdown@localhost` è un utente OS dedicato con `authorized_keys` limitata a `command="/usr/local/bin/shutdown.sh"`
- `shutdown.sh` contiene `sudo /sbin/shutdown -h +1`

Decisione: si parte con sudoers diretto (più semplice); se UID mapping non funziona, fallback su SSH wrapper.

Test: `sudo -u nodered sudo -n /sbin/shutdown --help` deve funzionare senza prompt password.

---

## 8. Container Caddy + HTTPS

### 8.1 Aggiunta a `rpi5/docker-compose.yml`

```yaml
  caddy:
    image: caddy:latest
    container_name: caddy
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
      - ./frontend/dist:/srv:ro
    depends_on:
      - nodered
    networks:
      - iot-net
```

### 8.2 `rpi5/caddy/Caddyfile`

```caddy
{
  email admin@orto.local
}

orto.local, 192.168.1.12, 192.168.1.46 {
  tls internal
  encode gzip

  handle /api/* {
    reverse_proxy nodered:1880
  }

  handle {
    root * /srv
    try_files {path} /index.html
    file_server
  }

  log {
    output file /data/access.log {
      roll_size 10mb
      roll_keep 5
    }
  }
}
```

Caddy con `tls internal` genera automaticamente una CA locale in `/data/caddy/pki/authorities/local/` e certificati per gli host elencati. Riusa la stessa CA fino a quando il volume `caddy/data` esiste.

### 8.3 Setup iniziale (sul RPi5)

```bash
sudo mkdir -p /opt/orto-digitale/caddy/{data,config}
sudo chown -R 1000:1000 /opt/orto-digitale/caddy
docker compose up -d caddy
docker compose logs caddy   # verifica "certificate obtained successfully"
```

### 8.4 Prima volta che si serve la PWA

Fino al merge dello step 6 la cartella `frontend/dist/` non esiste. Per evitare crash di Caddy, creare un placeholder:
```bash
mkdir -p /opt/orto-digitale/frontend/dist
echo "<h1>Orto Digitale — PWA in arrivo</h1>" > /opt/orto-digitale/frontend/dist/index.html
```

---

## 9. Estrazione root CA + installazione su telefono

### 9.1 Estrazione dal container

```bash
docker exec caddy cat /data/caddy/pki/authorities/local/root.crt \
  | sudo tee /opt/orto-digitale/caddy_root.crt > /dev/null
```

Trasferire `caddy_root.crt` dal RPi al PC (`scp as@192.168.1.12:/opt/orto-digitale/caddy_root.crt .`), poi al telefono (email, USB, AirDrop-equivalente).

### 9.2 Installazione su Android

1. Impostazioni → Sicurezza e privacy → Cripto e credenziali → Installa certificato → **Certificato CA**
2. Seleziona `caddy_root.crt`
3. Conferma "Installa lo stesso" (Android avvisa che le CA utente sono meno sicure delle root system — accettabile per LAN privata)
4. Nominare la CA "Orto Digitale local CA"

Da quel momento, `https://orto.local` (o `https://192.168.1.12`) mostra il lucchetto verde e la PWA sarà installabile in step 7.

### 9.3 Installazione su PC (browser desktop)

- **Windows:** doppio click sul `.crt` → "Installa certificato" → "Computer locale" → "Autorità di certificazione radice attendibili".
- **Linux:** copia in `/usr/local/share/ca-certificates/orto-local.crt` → `sudo update-ca-certificates`.
- **macOS:** doppio click → Keychain Access → System → trust "Always Trust".

### 9.4 Mapping `orto.local`

Aggiungere a `hosts`:
- **Windows:** `C:\Windows\System32\drivers\etc\hosts` → `192.168.1.12 orto.local`
- **Linux/macOS:** `/etc/hosts` → idem
- **Android:** non modificabile senza root → usare IP `https://192.168.1.12` direttamente, oppure DNS locale (fuori scope).

---

## 10. Aggiornamento `verify_rpi5.sh`

Aggiungere a `rpi5/scripts/verify_rpi5.sh` un nuovo check:

```bash
# Check 11: Caddy HTTPS reachable
echo -n "[11] Caddy HTTPS reachable... "
if curl -sk --max-time 5 https://localhost/api/system/health | grep -q "uptime_seconds"; then
  echo "OK"
else
  echo "FAIL"
  exit 1
fi
```

E altri check per i nuovi endpoint:
- `/api/sensors/last` ritorna almeno 4 sensori online
- `/api/valve/state` risponde 200
- `/api/weather/now` ritorna `temperature_c` non null

---

## 11. Verifica end-to-end

Da PC (con CA installata e `hosts` mappato):

```bash
curl https://orto.local/api/sensors/last | jq
curl https://orto.local/api/sensors/trend?sensor_id=WH51_01&start=-24h | jq '.WH51_01 | length'
curl https://orto.local/api/valve/state | jq
curl -X POST https://orto.local/api/valve/on \
     -H 'Content-Type: application/json' \
     -d '{"duration_seconds": 300}' | jq
# attendere 10s
curl https://orto.local/api/valve/state | jq '.open_since_seconds, .auto_close_in_seconds'
curl -X POST https://orto.local/api/valve/off | jq
curl https://orto.local/api/valve/intervals?start=-7d&stop=now | jq '. | length'
curl https://orto.local/api/valve/cumulative?start=-7d&stop=now | jq
curl https://orto.local/api/weather/now | jq
curl https://orto.local/api/weather/forecast | jq '. | length'  # → 7
curl https://orto.local/api/system/health | jq
```

Per shutdown (test prudente con `-c` per cancellare subito dopo):
```bash
curl -X POST https://orto.local/api/system/shutdown \
     -H 'Content-Type: application/json' \
     -d '{"confirm": "shutdown"}'
# entro 60 secondi:
ssh as@192.168.1.12 'sudo shutdown -c'
```

Healthcheck finale:
```bash
ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh'
```
Tutti gli 11 check devono essere verdi.

---

## 12. Out of scope

- Rate limiting o auth sugli endpoint `/api/*` (LAN privata, niente esposizione esterna).
- WebSocket MQTT per push real-time della valvola — il polling 5s di step 6 è sufficiente.
- HTTPS con CA pubblica (Let's Encrypt) — richiederebbe dominio esterno, fuori filosofia "tutto locale".
- Endpoint write per `irrigation_config` da FE — la modifica della config resta via MQTT come da step 4. Step 6 si limita alla lettura via `/api/config` (già esistente).
- DNS locale automatico per `orto.local` su Android (richiede pi-hole o simili).
