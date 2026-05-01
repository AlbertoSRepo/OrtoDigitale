# Comandi di verifica — Orto Digitale RPi5

Raccolta comandi pronti per copy-paste, organizzati per scenario. Tutti i comandi assumono di essere eseguiti dal **PC via SSH** verso il RPi5 (`as@192.168.1.12`, password `aru63` fallback se la chiave SSH non è installata). Quando il comando è eseguito direttamente sul RPi5 (dopo `ssh as@192.168.1.12`) è indicato con `[RPi5]`.

> Convenzione: il prefisso `set -a; . /opt/orto-digitale/.env; set +a` carica tutte le variabili del `.env` nell'ambiente corrente. È richiesto da quasi tutti i comandi sotto perché leggono password/token da env.

---

## 0. Connessione SSH

```bash
# Da PC Windows
ssh as@192.168.1.12

# Se la host key cambia (RPi5 reinstallato / chiave rigenerata):
ssh-keygen -R 192.168.1.12
ssh -o StrictHostKeyChecking=accept-new as@192.168.1.12
```

---

## 1. Healthcheck completo (one-liner)

Esegue lo script `verify_rpi5.sh` (OS, Docker, filesystem, 4 container, 3 porte, MQTT auth, InfluxDB, Grafana, disco, simulatore). Output `═══ TUTTO OK ═══` se tutto verde.

```bash
ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh'
```

Test post-reboot (fa `sudo reboot`, aspetta 30s, rilancia verify):
```bash
ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/post_reboot_test.sh'
```

---

## 2. Stato container Docker

```bash
# Tutti i container del progetto
ssh as@192.168.1.12 'docker compose -f /opt/orto-digitale/docker-compose.yml ps'

# Snapshot con health e restart count
ssh as@192.168.1.12 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'

# Log live (Ctrl-C per uscire)
ssh as@192.168.1.12 'docker logs -f nodered'
ssh as@192.168.1.12 'docker logs -f mosquitto'
ssh as@192.168.1.12 'docker logs -f influxdb'
ssh as@192.168.1.12 'docker logs -f grafana'

# Restart mirato (senza toccare gli altri)
ssh as@192.168.1.12 'docker restart nodered'

# Riavvio completo stack
ssh as@192.168.1.12 'cd /opt/orto-digitale && docker compose restart'
```

---

## 3. MQTT — Mosquitto

### 3.1 Sub di un messaggio reale dal GW3000 (max 75s)

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  timeout 75 docker exec mosquitto mosquitto_sub \
    -u monitor -P "$MQTT_PASS_MONITOR" -t ecowitt/gw3000 -v -C 1'
```
Atteso: `ecowitt/gw3000 PASSKEY=...&soilmoisture1=XX&...` entro ~60s (upload interval del gateway).

### 3.2 Sub live continuo (tutti i topic ecowitt)

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec mosquitto mosquitto_sub \
    -u monitor -P "$MQTT_PASS_MONITOR" -t "ecowitt/#" -v'
```

### 3.3 Test pub/sub in loopback (sanity auth)

Terminal A (subscriber — lasciare in esecuzione):
```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec mosquitto mosquitto_sub -u monitor -P "$MQTT_PASS_MONITOR" -t test/ping -v'
```

Terminal B (publisher):
```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec mosquitto mosquitto_pub -u gw3000 -P "$MQTT_PASS_GW3000" -t test/ping -m "hello"'
```

### 3.4 Verifica utenti nel password_file

```bash
ssh as@192.168.1.12 'sudo cat /opt/orto-digitale/mosquitto/config/password_file | cut -d: -f1'
```
Atteso: `gw3000`, `nodered`, `zigbee2mqtt`, `monitor` (uno per riga).

### 3.5 Test credenziali sbagliate (deve FALLIRE)

```bash
ssh as@192.168.1.12 'docker exec mosquitto mosquitto_pub \
  -u monitor -P wrong-password -t test/x -m ping'
```
Atteso: `Connection Refused: not authorised.` (se passa, Mosquitto è configurato male).

---

## 4. InfluxDB

### 4.1 Health endpoint

```bash
ssh as@192.168.1.12 'curl -sf http://localhost:8086/health | python3 -m json.tool'
```
Atteso: `"status": "pass"`.

### 4.2 Ultimi valori per sensore (last-5-min)

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -5m)
  |> filter(fn: (r) => r._measurement == \"soil_moisture\" and r._field == \"value\")
  |> group(columns: [\"sensor_id\"])
  |> last()
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'
```
Atteso: 4 righe, una per `WH51_01..04`, con `_time` entro 60s.

### 4.3 Tutti i field di un sensore (debug)

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -10m)
  |> filter(fn: (r) => r.sensor_id == \"WH51_01\")
  |> last()
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'
```
Atteso: 3 righe (`value`, `battery_voltage`, `battery_ok`) per `WH51_01`.

### 4.4 Conteggio punti scritti nell'ultima ora

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == \"soil_moisture\" and r._field == \"value\")
  |> count()
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'
```
Atteso: ~60 righe per sensore (1 upload/minuto).

### 4.5 Lista bucket e token

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx bucket list --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'

ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx auth list --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'
```

### 4.6 UI Web InfluxDB

Browser → http://192.168.1.12:8086 → login `admin` / valore di `INFLUXDB_ADMIN_PASSWORD` in `.env`.

---

## 5. Node-RED

### 5.1 UI Web

Browser → http://192.168.1.12:1880

### 5.2 Verifica flow attivo e connesso al broker

```bash
ssh as@192.168.1.12 'docker logs nodered --tail 20 | grep -E "Started flows|Connected to broker|Error"'
```
Atteso: `Started flows` + `Connected to broker: nodered-orto@mqtt://mosquitto:1883`.

### 5.3 Debug live messaggi parsati

Nella UI Node-RED → sidebar **Debug** (icona bug) → attivare il nodo `parsed points` (aprirlo e cliccare la linguetta verde). Ogni ~60s deve apparire un array di 4 oggetti.

### 5.4 Iniettare payload di test (sintetico)

Nella UI Node-RED → flow "Ecowitt GW3000 -> InfluxDB" → premere il pulsante blu del nodo **TEST: payload sintetico**. Scrive 4 point in InfluxDB con valori `42.5/38.1/55.0/29.7` e tag `aiuola=test`.

### 5.5 Reiniettare credenziali dopo redeploy `flows.json`

Necessario ogni volta che `flows.json` viene sovrascritto da esterno:
```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; python3 <<PYEOF
import os, json, urllib.request
BASE = "http://localhost:1880"
req = urllib.request.Request(BASE + "/flows", headers={"Node-RED-API-Version":"v2"})
data = json.loads(urllib.request.urlopen(req).read())
rev, flows = data["rev"], data["flows"]
for n in flows:
    if n.get("id") == "cfg-mqtt-mosquitto":
        n["credentials"] = {"user":"nodered", "password": os.environ["MQTT_PASS_NODERED"]}
    if n.get("id") == "cfg-influxdb":
        n["credentials"] = {"token": os.environ["INFLUX_TOKEN_NODERED_RW"]}
body = json.dumps({"flows":flows,"rev":rev}).encode()
req = urllib.request.Request(BASE+"/flows", data=body, method="POST",
    headers={"Content-Type":"application/json","Node-RED-API-Version":"v2"})
print("HTTP", urllib.request.urlopen(req).status)
PYEOF'
```

### 5.6 Re-deploy di `flows.json` dal PC

```bash
# Da PC Windows
scp "C:\Users\user\Desktop\OrtoDigitale\dev\rpi5\nodered\data\flows.json" \
    as@192.168.1.12:/tmp/flows.json
ssh as@192.168.1.12 'echo aru63 | sudo -S bash -c "
  cp /tmp/flows.json /opt/orto-digitale/nodered/data/flows.json &&
  chown 1000:1000 /opt/orto-digitale/nodered/data/flows.json
" && docker restart nodered'
# Attendi ~15s, poi ri-inietta credenziali (§5.5)
```

---

## 6. Grafana

### 6.1 UI Web + credenziali

Browser → **http://192.168.1.12:3000**

| Campo | Valore |
|---|---|
| Username | `admin` |
| Password | `OrtoDigitale2026` |

(Definite in `rpi5/docker-compose.yml` → `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`.)

### 6.2 Health endpoint

```bash
ssh as@192.168.1.12 'curl -sf http://localhost:3000/api/health | python3 -m json.tool'
```
Atteso: `"database": "ok"`.

### 6.3 Dashboard default

Provisioned in `rpi5/grafana/dashboards/orto-digitale.json`. Dopo il login è la home dashboard (`GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH` in compose).

---

## 7. Pipeline end-to-end (sanity check completo in 90s)

Da eseguire in sequenza dopo una modifica alla configurazione:

```bash
# 1) Stack sano
ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh' | tail -5

# 2) Il GW3000 pubblica?
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  timeout 75 docker exec mosquitto mosquitto_sub \
    -u monitor -P "$MQTT_PASS_MONITOR" -t ecowitt/gw3000 -v -C 1'

# 3) Node-RED parsa?
ssh as@192.168.1.12 'docker logs nodered --since 2m | grep -E "Error|warn" || echo "no errors"'

# 4) I dati sono in InfluxDB?
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")|>range(start:-3m)
|>filter(fn:(r)=>r._field==\"value\")
|>group(columns:[\"sensor_id\"])|>last()
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'
```

Atteso a fine sequenza:
- step 1: `═══ TUTTO OK ═══`
- step 2: una riga `PASSKEY=...&soilmoisture1=...`
- step 3: `no errors`
- step 4: 4 righe una per `WH51_01..04`, `_time` recente

---

## 8. Gestione `.env` e credenziali

### 8.1 Lettura sicura di una password

```bash
ssh as@192.168.1.12 'sudo grep MQTT_PASS_GW3000 /opt/orto-digitale/.env | cut -d= -f2-'
```

### 8.2 Permessi corretti

```bash
ssh as@192.168.1.12 'sudo ls -la /opt/orto-digitale/.env'
```
Atteso: `-rw------- 1 root root ... .env` (permessi 600).

### 8.3 Rigenerare una password MQTT

```bash
ssh as@192.168.1.12 'echo "NUOVA_PWD=$(openssl rand -base64 24 | tr -d "/+=" | cut -c1-20)"; echo "Poi: aggiornare .env, aggiornare password_file con mosquitto_passwd, restart mosquitto, riconfigurare il client nel suo form."'
```

---

## 9. Simulatore sensori (step 1b)

Il simulatore è stato **fermato e disabilitato** dopo il deployment dello step 2 per evitare dati misti.

```bash
# Stato
ssh as@192.168.1.12 'systemctl is-active orto-simulator && systemctl is-enabled orto-simulator'
# Atteso: inactive + disabled

# Riattivarlo (se serve per test di regressione)
ssh as@192.168.1.12 'echo aru63 | sudo -S systemctl start orto-simulator'

# Fermarlo di nuovo
ssh as@192.168.1.12 'echo aru63 | sudo -S systemctl stop orto-simulator'
```

---

## 10. Troubleshooting rapido

| Sintomo | Comando di diagnosi | Azione |
|---|---|---|
| Grafana non mostra dati | `curl -sf http://localhost:8086/health` + query §4.2 | Se InfluxDB OK ma dati assenti → verifica Node-RED (§5.2) |
| Node-RED logs dicono `Error: Not authorized` | `sudo cat /opt/orto-digitale/mosquitto/config/password_file \| cut -d: -f1` | Utente `nodered` mancante → ri-esegui §2.3 step2 doc |
| Node-RED logs dicono `field type conflict` | Controlla schema field in InfluxDB | Usa nome field nuovo o ricrea bucket `garden` |
| `mosquitto_sub` non riceve nulla | `docker logs mosquitto --tail 50` | Cerca "Client connected" del `gw3000-orto-01` |
| GW3000 ha perso il broker | `ping 192.168.1.12` da GW3000 (se possibile) + controllo IP del RPi5 | DHCP reservation sul router, IP fisso |
| SSH "REMOTE HOST KEY CHANGED" | — | `ssh-keygen -R 192.168.1.12` poi riconnetti |
