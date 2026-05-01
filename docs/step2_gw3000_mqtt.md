# Step 2 — Gateway Ecowitt GW3000 → Mosquitto → InfluxDB

**Progetto:** Orto Digitale v1.1
**Step:** 2 di 6
**Precondizioni:** Step 1 completato (Mosquitto + InfluxDB + Grafana in esecuzione su RPi5, `.env` popolato)
**Output atteso:** 4 sensori WH51 visibili in InfluxDB bucket `garden` con tag `aiuola=test, position=test`

---

## Indice

1. [Architettura del flusso dati](#1-architettura-del-flusso-dati)
2. [Preparazione credenziali MQTT](#2-preparazione-credenziali-mqtt)
3. [Configurazione del form GW3000](#3-configurazione-del-form-gw3000)
4. [Formato payload Ecowitt](#4-formato-payload-ecowitt)
5. [Node-RED: parsing e scrittura su InfluxDB](#5-node-red-parsing-e-scrittura-su-influxdb)
6. [Verifica end-to-end](#6-verifica-end-to-end)
7. [Rischi noti](#7-rischi-noti)

---

## 1. Architettura del flusso dati

```
 4× WH51  --RF 868MHz-->  GW3000  --MQTT form-urlencoded (1 topic)-->  Mosquitto
                                                                           |
                                                                           v
                                                                       Node-RED
                                                         (decode form-urlencoded + split 4 point)
                                                                           |
                                                                           v
                                                                   InfluxDB bucket `garden`
                                                                   measurement `soil_moisture`
                                                                   tag aiuola=test
```

**Scelta architetturale:** il GW3000 pubblica TUTTI i sensori accoppiati in **un solo** topic MQTT. Il firmware `GW3000A_V1.2.0` invia il payload come **stringa form-urlencoded** stile HTTP POST (es. `soilmoisture1=33&soilbatt1=1.7&...`), NON come JSON (cfr. §4). Non è possibile configurarlo per pubblicare un topic per sensore. Decoding e split per `sensor_id` vengono realizzati in Node-RED durante il parsing, come anticipato in `step1_setup_rpi5.md:163-168`.

---

## 2. Preparazione credenziali MQTT

Tutti i comandi vanno eseguiti via SSH sul RPi5 dalla directory di progetto.

```bash
ssh as@192.168.1.12
cd /opt/orto-digitale
```

### 2.1 Generare password (solo se non già presenti in `.env`)

```bash
for u in GW3000 NODERED ZIGBEE2MQTT MONITOR; do
  echo "MQTT_PASS_${u}=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
done >> .env
chmod 600 .env
```

> **Attenzione:** se il file `.env` esiste già con valori validi, NON rieseguire questo blocco — riscriverebbe le password e rompesse i client già configurati.

### 2.2 Caricare le variabili nella shell

```bash
set -a; . ./.env; set +a
```

### 2.3 Creare gli utenti nel password_file Mosquitto

```bash
# Primo utente: crea il file. Dal secondo in poi: -b senza -c.
docker exec -i mosquitto mosquitto_passwd -b -c /mosquitto/config/password_file gw3000      "$MQTT_PASS_GW3000"
docker exec -i mosquitto mosquitto_passwd -b    /mosquitto/config/password_file nodered     "$MQTT_PASS_NODERED"
docker exec -i mosquitto mosquitto_passwd -b    /mosquitto/config/password_file zigbee2mqtt "$MQTT_PASS_ZIGBEE2MQTT"
docker exec -i mosquitto mosquitto_passwd -b    /mosquitto/config/password_file monitor     "$MQTT_PASS_MONITOR"
```

### 2.4 Reload del broker

```bash
docker compose restart mosquitto
# fallback leggero se il restart è indesiderato:
# docker exec mosquitto kill -HUP 1
```

### 2.5 Test autenticazione (loopback)

Terminal A (subscriber):
```bash
docker exec mosquitto mosquitto_sub -h localhost -u monitor -P "$MQTT_PASS_MONITOR" -t 'ecowitt/#' -v
```

Terminal B (publisher):
```bash
docker exec mosquitto mosquitto_pub -h localhost -u gw3000 -P "$MQTT_PASS_GW3000" -t ecowitt/gw3000 -m '{"ping":"ok"}'
```

Il sub deve ricevere `ecowitt/gw3000 {"ping":"ok"}`. Se non succede, rileggere `mosquitto.log` dal volume `./mosquitto/log/`.

---

## 3. Configurazione del form GW3000

Aprire l'interfaccia web del gateway: **http://192.168.1.5** → sezione **Customized** (screenshot di riferimento: `image.png` nella root del progetto).

| Campo | Valore | Note |
|---|---|---|
| Customized | `Enable` | Attivare il server personalizzato. |
| Protocol Type Same As | `MQTT` | Il progetto usa MQTT nativo, NON il protocollo Ecowitt HTTP. |
| Host | `192.168.1.12` | IP statico del RPi5. **Riservare via DHCP** sul router prima di salvare. |
| Port | `1883` | Porta MQTT standard non-TLS (LAN privata). |
| Publish Topic | `ecowitt/gw3000` | Sovrascrivere il default `ecowitt/885721D3C4A7` (MAC). |
| Transport | `MQTT over TCP` | Default del firmware. |
| Upload Interval | `60` | Secondi. Coerente con `step1_setup_rpi5.md:263`. |
| Keep Alive | `60` | Secondi. Se si osservano disconnessioni, alzare a `120`. |
| Client Name | `GW3000-Orto` | Etichetta descrittiva (alcuni firmware la ignorano). |
| Client ID | `gw3000-orto-01` | **Deve essere univoco** sul broker — evita race con altri client. |
| Username | `gw3000` | Utente MQTT creato in §2.3. |
| Password | *(valore di `MQTT_PASS_GW3000`)* | Leggere con `grep MQTT_PASS_GW3000 /opt/orto-digitale/.env`. |

Premere **Save**. Il gateway riavvia la connessione MQTT. Il primo payload arriva entro ~60s.

### 3.1 Verifica arrivo dei dati reali

Dal RPi5:
```bash
docker exec -it mosquitto mosquitto_sub -h localhost -u monitor -P "$MQTT_PASS_MONITOR" -t 'ecowitt/gw3000' -v
```

Atteso: un messaggio ogni ~60s con JSON tipico Ecowitt (vedi §4).

---

## 4. Formato payload Ecowitt

Il GW3000 (firmware `GW3000A_V1.2.0`) pubblica **una stringa form-urlencoded** (NON JSON). Esempio reale catturato sul campo:

```
PASSKEY=2E665D6A7F08EF77F224C3E4DC46A0BC&stationtype=GW3000A_V1.2.0
&runtime=85032&heap=91088&dateutc=2026-04-18%2014%3A10%3A14
&dns_err_cnt=0&cdnflg=3
&tempinf=91.22&humidityin=27&baromrelin=29.060&baromabsin=29.060
&soilmoisture1=33&soilad1=184
&soilmoisture2=35&soilad2=194
&soilmoisture3=28&soilad3=165
&soilmoisture4=45&soilad4=224
&soilbatt1=1.7&soilbatt2=1.7&soilbatt3=1.7&soilbatt4=1.6
&freq=868M&model=GW3000A&interval=60
```

(in una sola riga, qui spezzata per leggibilità).

| Chiave | Canale | Unità | Mappatura InfluxDB |
|---|---|---|---|
| `soilmoisture{N}` | 1..4 | % | field `value` |
| `soilbatt{N}` | 1..4 | V | field `battery_voltage` |
| *derivato* `soilbatt{N} >= 1.1` | — | bool | field `battery_ok` |

**Campi presenti nel payload ma volutamente scartati:**
- `PASSKEY`, `stationtype`, `runtime`, `heap`, `dateutc`, `freq`, `model`, `interval`, `dns_err_cnt`, `cdnflg` → metadati gateway
- `tempinf`, `humidityin`, `baromrelin`, `baromabsin` → sensori interni (temperatura/umidità/pressione indoor), fuori scope
- `soilad{N}` → valore ADC grezzo del WH51, ridondante con `soilmoisture{N}`

**Nota `rssi` (RF signal strength):** non presente in questo firmware (`GW3000A_V1.2.0`). Firmware più recenti aggiungono `wh51ch{N}_sig` / `wh51_ch{N}_sig` (dBm). Il flow attuale non lo scrive per due motivi: (a) non c'è in payload, (b) anche ci fosse, il simulatore step 1b ha tipizzato il field `rssi` come **integer** in InfluxDB mentre `node-red-contrib-influxdb` serializza i `Number` JS come float → conflict. Per aggiungerlo in futuro: usare il nome `rssi_dbm` (nuovo field) oppure ricreare il bucket `garden` da zero.

**Formato data:** `dateutc` arriva url-encodata (`2026-04-18%2014%3A10%3A14` → `2026-04-18 14:10:14`). Il flow usa il timestamp di scrittura InfluxDB (precision ms), non quello del gateway.

---

## 5. Node-RED: parsing e scrittura su InfluxDB

### 5.1 Prerequisiti container

Il servizio `nodered` è già definito in `rpi5/docker-compose.yml`:

```yaml
nodered:
  image: nodered/node-red:latest
  container_name: nodered
  ports: ["1880:1880"]
  volumes: ["./nodered/data:/data"]
  environment:
    - TZ=Europe/Rome
    - INFLUX_TOKEN_NODERED_RW=${INFLUX_TOKEN_NODERED_RW}
    - INFLUXDB_ORG=${INFLUXDB_ORG:-orto-digitale}
    - INFLUXDB_BUCKET=${INFLUXDB_BUCKET:-garden}
    - MQTT_PASS_NODERED=${MQTT_PASS_NODERED}
  depends_on: [mosquitto, influxdb]
  networks: [iot-net]
```

Prima del primo `up`:
```bash
sudo mkdir -p /opt/orto-digitale/nodered/data
sudo chown -R 1000:1000 /opt/orto-digitale/nodered/data
docker compose up -d nodered
```

### 5.2 Installare `node-red-contrib-influxdb`

Il flow versionato usa i nodi `influxdb out`, forniti dal palette `node-red-contrib-influxdb`. Non è incluso nell'immagine base, va installato nel volume `/data`:

```bash
docker exec -u node-red nodered npm install --prefix /data node-red-contrib-influxdb
docker restart nodered
```

(Metodo equivalente via UI: http://192.168.1.12:1880 → hamburger menu → **Manage palette** → tab **Install** → cerca `node-red-contrib-influxdb`.)

### 5.3 Struttura del flow

Il flow è in `rpi5/nodered/data/flows.json` e contiene:

| ID nodo | Tipo | Ruolo |
|---|---|---|
| `cfg-mqtt-mosquitto` | `mqtt-broker` | Config broker: `mosquitto:1883`, clientId `nodered-orto`, LWT su `nodered/status` |
| `cfg-influxdb` | `influxdb` | Config DB: `http://influxdb:8086`, org `orto-digitale`, bucket `garden`, v2.0 |
| `n-mqtt-in-ecowitt` | `mqtt in` | Sub `ecowitt/gw3000`, **`datatype=utf8`** (stringa grezza, non JSON) |
| `n-fn-parse` | `function` | Decoding form-urlencoded + split 4 canali → array di `[fields, tags]` |
| `n-influx-out` | `influxdb out` | Scrive measurement `soil_moisture` nel bucket `garden` |
| `n-inject-test` | `inject` | Payload sintetico di test (4 canali) |
| `n-debug-raw`, `n-debug-points` | `debug` | Ispezione in sidebar Node-RED |

**Logica della function `n-fn-parse`:**

```javascript
// 1) Decoding form-urlencoded (o passthrough se già oggetto per test)
let raw = msg.payload;
if (typeof raw === 'string') {
    const parsed = {};
    for (const pair of raw.split('&')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = decodeURIComponent(pair.slice(0, eq));
        const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
        parsed[k] = v;
    }
    raw = parsed;
}

// 2) Iterazione 4 canali, costruzione point InfluxDB
const out = [];
for (const ch of [1, 2, 3, 4]) {
    const value = Number(raw['soilmoisture' + ch]);
    if (!Number.isFinite(value)) continue;
    const battery_voltage = Number(raw['soilbatt' + ch]);
    const battery_ok = Number.isFinite(battery_voltage) && battery_voltage >= 1.1;
    out.push([
        { value, battery_voltage, battery_ok },                           // fields
        { sensor_id: 'WH51_0' + ch, aiuola: 'test', position: 'test' }    // tags
    ]);
}
return { payload: out, measurement: 'soil_moisture' };
```

Il nodo `influxdb out` riceve `msg.payload` come array di `[fields, tags]` e fa una singola write batch con 4 point.

### 5.4 Iniettare le credenziali via Admin API (metodo automatico)

Le credenziali MQTT e InfluxDB non sono nel `flows.json` (sono confidenziali). Vengono caricate via l'Admin API di Node-RED con uno script Python che legge i valori da `.env`:

```bash
ssh as@192.168.1.12 'bash -c "
set -a; . /opt/orto-digitale/.env; set +a
python3 <<PYEOF
import os, json, urllib.request
with open(\"/opt/orto-digitale/nodered/data/flows.json\") as f:
    flows = json.load(f)
# GET rev corrente
req = urllib.request.Request(\"http://localhost:1880/flows\",
    headers={\"Node-RED-API-Version\":\"v2\"})
with urllib.request.urlopen(req) as r: cur = json.load(r)
body = {
    \"flows\": flows, \"rev\": cur[\"rev\"],
    \"credentials\": {
        \"cfg-mqtt-mosquitto\": {\"user\": \"nodered\", \"password\": os.environ[\"MQTT_PASS_NODERED\"]},
        \"cfg-influxdb\": {\"token\": os.environ[\"INFLUX_TOKEN_NODERED_RW\"]}
    }
}
req = urllib.request.Request(\"http://localhost:1880/flows\",
    data=json.dumps(body).encode(), method=\"POST\",
    headers={\"Content-Type\":\"application/json\",\"Node-RED-Deployment-Type\":\"full\",\"Node-RED-API-Version\":\"v2\"})
with urllib.request.urlopen(req) as r: print(\"HTTP\", r.status)
PYEOF
"'
```

In alternativa, farlo manualmente dalla UI (http://192.168.1.12:1880):
1. Aprire il nodo config **mqtt-broker "Mosquitto (iot-net)"** → tab **Security** → `user=nodered`, `password=<valore di MQTT_PASS_NODERED>`.
2. Aprire il nodo config **influxdb "InfluxDB garden"** → `token=<valore di INFLUX_TOKEN_NODERED_RW>`.
3. Deploy.

### 5.5 Generazione del token InfluxDB per Node-RED

Se non già presente in `.env` come `INFLUX_TOKEN_NODERED_RW`:
```bash
# ID del bucket garden
BUCKET_ID=$(docker exec influxdb influx bucket list \
  --org orto-digitale --name garden \
  --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" --hide-headers | awk '{print $1}')

# Token R+W solo su garden
docker exec influxdb influx auth create \
  --org orto-digitale \
  --read-bucket "$BUCKET_ID" \
  --write-bucket "$BUCKET_ID" \
  --description "nodered-rw" \
  --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" \
  --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
```

Aggiungere l'output a `/opt/orto-digitale/.env` come `INFLUX_TOKEN_NODERED_RW=<token>`.

### 5.6 Test del flow con payload sintetico

Il flow include un nodo **inject** "TEST: payload sintetico". Dopo il Deploy, premere il pulsante del nodo inject: devono comparire 4 punti in InfluxDB con `sensor_id=WH51_01..04` taggati `aiuola=test`.

---

## 6. Verifica end-to-end

### 6.1 Query Flux (sanity check ultimi 5 minuti)

Dal RPi5:
```bash
docker exec influxdb influx query '
from(bucket:"garden")
  |> range(start: -5m)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> group(columns: ["sensor_id"])
  |> last()
' --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"
```

Atteso: **4 righe**, una per `WH51_01..04`, `_time` entro 60s, tag `aiuola=test`, `position=test`.

### 6.2 Healthcheck script

```bash
bash /opt/orto-digitale/scripts/verify_rpi5.sh
```

Deve chiudere con `═══ TUTTO OK ═══` (o solo warning informativi).

### 6.3 Dashboard Grafana

Aprire http://192.168.1.12:3000 (login: `admin` / `OrtoDigitale2026`, definito in `rpi5/docker-compose.yml` tramite `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`). La dashboard "Orto Digitale" provisioned dallo step 1b mostra 4 serie con i valori reali del GW3000.

Il simulatore Python (`orto-simulator.service`) è stato **fermato e disabilitato** durante il deployment di questo step; la dashboard non mostra più dati finti. Per verificare:
```bash
systemctl is-active orto-simulator    # atteso: inactive
systemctl is-enabled orto-simulator   # atteso: disabled
```

---

## 7. Rischi noti

1. **IP dinamico del RPi5:** al momento `192.168.1.12` via DHCP (`docs/rpi5_info.md:10`). Se il lease cambia, il GW3000 perde il broker e smette di pubblicare. **Azione obbligatoria:** DHCP reservation sul router prima di salvare il form GW3000.
2. **Client ID duplicato:** il broker chiude silenziosamente connessioni con Client ID già in uso. Se si sperimenta disconnessione ciclica, variare `Client ID` (es. `gw3000-orto-02`).
3. **Firmware GW3000 legacy:** alcuni firmware pre-2024 ignorano il campo `Client ID` o non supportano `Publish Topic` custom — in quel caso Node-RED va riconfigurato per fare sub su `ecowitt/885721D3C4A7` (il MAC del gateway). Il flow va modificato in un solo punto (topic del nodo `mqtt in`).
4. **Collisione col simulatore:** se `sensor_simulator.py` resta attivo, Grafana mostra due serie sovrapposte (finta + reale). `verify_rpi5.sh` segnala con warning quando è in esecuzione.
5. **Campo `rssi` / `wh51ch{N}_sig` assente in firmware 1.2.0:** il flow non scrive il field `rssi` (vedi §4). Non è un bug del sistema, è una limitazione del gateway.
6. **Password MQTT visibile in chiaro nell'interfaccia GW3000:** il gateway salva la password in chiaro nella sua NVRAM. Rotazione periodica consigliata (ogni 6 mesi): rigenerare `MQTT_PASS_GW3000`, aggiornare `password_file` Mosquitto e reinserire la nuova password nel form.
7. **Redeploy di `flows.json` resetta le credenziali:** `flows_cred.json` viene invalidato quando `flows.json` cambia da file esterno e Node-RED reinizializza il keystore. Dopo ogni `scp` di un nuovo `flows.json` bisogna ri-eseguire l'injection credentials §5.4 (Python/Admin API).

---

## Dipendenze verso gli step successivi

- **Step 3 (Zigbee2MQTT + SWV):** riusa il pattern credenziali MQTT di questo step. L'utente `zigbee2mqtt` è già predisposto in §2.3.
- **Step 4 (logica irrigazione):** Node-RED è già pronto, si aggiungerà un secondo flow che legge `soil_moisture` e scrive `irrigation_events`.
- **Step 5 (Grafana dashboards definitive):** le query aggregate per aiuola funzioneranno solo quando i sensori saranno taggati `aiuola=1|2|3` (oggi tutti a `test`). Prevedere una migrazione tag prima di step 5.
