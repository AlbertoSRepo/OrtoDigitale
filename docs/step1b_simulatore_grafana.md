# Step 1b — Simulatore Sensori e Visualizzazione
## Simulatore WH51 + Grafana

**Progetto:** Orto Digitale v1.1
**Step:** 1b (parallelo allo sviluppo Step 2–5)
**Output atteso:** Dati simulati dei 6 sensori WH51 presenti in InfluxDB con lo schema identico ai dati reali; dashboard Grafana operativa per testare la visualizzazione prima che l'hardware reale sia integrato

---

## Indice

1. [Contesto e obiettivo](#1-contesto-e-obiettivo)
2. [Simulatore sensori WH51](#2-simulatore-sensori-wh51)
3. [Logica di simulazione](#3-logica-di-simulazione)
4. [Grafana — Configurazione come servizio Docker](#4-grafana--configurazione-come-servizio-docker)
5. [Provisioning automatico](#5-provisioning-automatico)
6. [Dashboard — Umidità Sensori](#6-dashboard--umidità-sensori)
7. [Struttura directory e file](#7-struttura-directory-e-file)
8. [Docker Compose — Stack aggiornato](#8-docker-compose--stack-aggiornato)
9. [Flusso operativo](#9-flusso-operativo)
10. [Criteri di accettazione](#10-criteri-di-accettazione)
11. [Gestione del simulatore](#11-gestione-del-simulatore)
12. [Persistenza al riavvio](#12-persistenza-al-riavvio)
13. [Dipendenze e note](#13-dipendenze-e-note)
14. [Stato di completamento](#14-stato-di-completamento)

---

## 1. Contesto e obiettivo

Lo Step 2 (GW3000 → MQTT → Node-RED → InfluxDB) e lo Step 5 (Grafana) vengono sviluppati in momenti diversi. Per consentire lo sviluppo e il test del layer di visualizzazione in anticipo, questo step introduce:

1. **Un simulatore Python** che scrive in InfluxDB dati di umidità realistici per tutti e 6 i sensori WH51, con lo stesso schema (measurement, tag, field) che i dati reali avranno a regime.
2. **Grafana come servizio Docker** aggiunto allo stack, con datasource e dashboard pre-configurati via provisioning automatico.

Il simulatore viene rimosso (o disabilitato) quando i sensori reali iniziano a pubblicare dati tramite GW3000 → MQTT → Node-RED.

---

## 2. Simulatore sensori WH51

### 2.1 Collocazione

| Elemento | Percorso |
|---|---|
| Script | `/opt/orto-digitale/simulator/sensor_simulator.py` |
| Log | `/opt/orto-digitale/simulator/simulator.log` |
| PID file | `/opt/orto-digitale/simulator/simulator.pid` |

### 2.2 Dipendenze

- Python 3 (già presente su Raspberry Pi OS Bookworm)
- Libreria `influxdb-client`: `pip3 install --break-system-packages influxdb-client`

Non richiede Docker: gira direttamente sull'OS host.

### 2.3 Configurazione

Lo script legge il token InfluxDB dal file `/opt/orto-digitale/.env` tramite la chiave `INFLUX_TOKEN_NODERED_RW` (token con permessi Read+Write sul bucket `garden`). In alternativa la variabile può essere esportata nell'ambiente.

### 2.4 Modalità di esecuzione

| Comando | Comportamento |
|---|---|
| `python3 sensor_simulator.py` | Loop real-time (60s/ciclo) senza storia |
| `python3 sensor_simulator.py --backfill N` | Riempie N ore di dati storici, poi esce |
| `python3 sensor_simulator.py --backfill N --run` | Riempie N ore di storia, poi continua in loop |

**Utilizzo consigliato al primo avvio:**
```bash
nohup python3 -u /opt/orto-digitale/simulator/sensor_simulator.py \
  --backfill 48 --run \
  > /opt/orto-digitale/simulator/simulator.log 2>&1 &
echo $! > /opt/orto-digitale/simulator/simulator.pid
```

Questo popola 48 ore di storia (per avere grafici significativi da subito) e poi continua a scrivere ogni 60 secondi.

### 2.5 Schema dati scritti

Il simulatore scrive nello stesso formato che i dati reali avranno dopo Step 2 (Node-RED → InfluxDB).

**Measurement `soil_moisture`** — scritto ogni 60 secondi per tutti e 6 i sensori:

| Campo | Tipo | Descrizione |
|---|---|---|
| Tag `sensor_id` | string | `WH51_01` … `WH51_06` |
| Tag `aiuola` | string | `"1"`, `"2"`, `"3"` |
| Tag `position` | string | `"near"` oppure `"far"` |
| Field `value` | float | Umidità % (0.0–100.0) |
| Field `battery_voltage` | float | Tensione batteria V (1.2–1.6) |
| Field `battery_ok` | boolean | `true` se battery_voltage ≥ 1.1V |
| Field `rssi` | integer | Qualità segnale RF in dBm (−95 a −65) |

**Measurement `system_health`** — scritto ogni 5 cicli (~5 min) per 6 sensori + gateway GW3000:

| Campo | Tipo | Descrizione |
|---|---|---|
| Tag `component` | string | `WH51_01`…`WH51_06`, `GW3000` |
| Tag `component_type` | string | `sensor` oppure `gateway` |
| Field `online` | boolean | `true` se `last_seen_seconds_ago < 180` |
| Field `last_seen_seconds_ago` | integer | Secondi dall'ultimo dato |
| Field `battery_low` | boolean | `true` se batteria < 1.1V |
| Field `battery_voltage` | float | Tensione batteria corrente |

---

## 3. Logica di simulazione

### 3.1 Parametri iniziali per sensore

| Sensore | Aiuola | Position | Umidità iniziale | Drift factor |
|---|---|---|---|---|
| WH51_01 | 1 | near | 52% | 1.00× (base) |
| WH51_02 | 1 | far | 45% | 1.10× (asciuga prima) |
| WH51_03 | 2 | near | 60% | 1.00× |
| WH51_04 | 2 | far | 38% | 1.10× |
| WH51_05 | 3 | near | 55% | 1.00× |
| WH51_06 | 3 | far | 42% | 1.10× |

### 3.2 Evoluzione dell'umidità

Ogni lettura fa avanzare lo stato interno del sensore:

- **Drift**: −0.4% per ora in media × drift_factor (essiccazione naturale del suolo)
- **Rumore**: campionamento gaussiano (σ ≈ 1.5%) per realismo
- **Clamp**: valori mantenuti nell'intervallo [15.0, 85.0]%
- **Near vs Far**: i sensori `far` perdono umidità più velocemente (drift_factor 1.10) perché più lontani dal punto di irrigazione

> **Nota:** il simulatore non implementa eventi di irrigazione — l'umidità scende monotonicamente fino al clamp di 15%. Questo è intenzionale: serve a vedere le soglie di allarme nella dashboard. L'irrigazione simulata verrà aggiunta in Step 4.

### 3.3 Battery e RSSI

| Campo | Logica |
|---|---|
| `battery_voltage` | Valore stabile per sensore (1.33–1.45V) con micro-rumore ±0.02V |
| `rssi` | Valore base per sensore (−68 a −90 dBm) con rumore ±5 dBm |
| `battery_ok` | Sempre `true` (batterie simulate come nuove) |

### 3.4 Backfill

In modalità backfill, lo script genera dati storici dalla data/ora corrente − N ore fino a adesso, con timestamp accurati. I dati vengono scritti in batch da 100 righe in Line Protocol per efficienza. Un backfill di 48 ore produce circa 21.000 punti (6 sensori × 2880 minuti + punti `system_health`).

---

## 4. Grafana — Configurazione come servizio Docker

### 4.1 Parametri del servizio

| Parametro | Valore |
|---|---|
| Image | `grafana/grafana:latest` |
| Container | `grafana` |
| Porta host:container | `3000:3000` |
| Restart policy | `always` |
| Admin user | `admin` |
| Admin password | `OrtoDigitale2026` (in `.env` in futuro) |
| Login anonimo | Disabilitato |
| Registrazione utenti | Disabilitata |

### 4.2 Volume e rete

| Volume | Mount container | Contenuto |
|---|---|---|
| `./grafana/data` | `/var/lib/grafana` | Database SQLite, sessioni, plugin |
| `./grafana/provisioning` | `/etc/grafana/provisioning` | Datasource e dashboard (read-only) |
| `./grafana/dashboards` | `/var/lib/grafana/dashboards` | File JSON dashboard (read-only) |

**Ownership:** La directory `grafana/data` deve avere ownership `472:472` (UID interno del container Grafana) prima del primo avvio.

Grafana si connette a InfluxDB tramite la rete `iot-net` usando l'hostname `influxdb:8086`.

### 4.3 Accesso

| Elemento | Valore |
|---|---|
| URL | `http://192.168.1.46:3000` |
| Login | `admin` |
| Password | `OrtoDigitale2026` |

---

## 5. Provisioning automatico

Il provisioning consente a Grafana di configurarsi automaticamente al primo avvio senza intervento manuale nella UI.

### 5.1 Datasource — `grafana/provisioning/datasources/influxdb.yml`

```yaml
apiVersion: 1

datasources:
  - name: InfluxDB
    uid: influxdb-garden
    type: influxdb
    access: proxy
    url: http://influxdb:8086
    isDefault: true
    jsonData:
      version: Flux
      organization: orto-digitale
      defaultBucket: garden
      httpMode: POST
    secureJsonData:
      token: <INFLUX_TOKEN_GRAFANA_RO>
    editable: false
```

Usa il token `INFLUX_TOKEN_GRAFANA_RO` (Read-only sul bucket `garden`, creato in Step 1 fase F.3).

> **Sicurezza:** Il token è in chiaro nel file YAML. Il file è montato read-only nel container. Per ambienti di produzione, si potrebbe usare una variabile d'ambiente Grafana invece.

### 5.2 Dashboard provider — `grafana/provisioning/dashboards/orto-digitale.yml`

```yaml
apiVersion: 1

providers:
  - name: Orto Digitale
    orgId: 1
    folder: Orto Digitale
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
```

- `updateIntervalSeconds: 30`: Grafana ricarica automaticamente i file JSON ogni 30s. Modifica il JSON localmente, rideploya, e la dashboard si aggiorna.
- `allowUiUpdates: true`: Permette modifiche dalla UI (non vengono perse al reload).

---

## 6. Dashboard — Umidità Sensori

### 6.1 Metadata

| Elemento | Valore |
|---|---|
| Titolo | `Orto Digitale — Umidità Sensori` |
| UID | `orto-moisture-v1` |
| Cartella | `Orto Digitale` |
| Refresh | 30 secondi |
| Range default | Ultime 24 ore |
| File | `grafana/dashboards/orto-digitale.json` |

### 6.2 Sezioni e pannelli

**Sezione 1 — Panoramica**

| Pannello | Tipo | Query | Descrizione |
|---|---|---|---|
| Umidità suolo — tutti i sensori | Time series | `soil_moisture`, tutti i sensori, `aggregateWindow(fn: mean)` | Overlay di tutte e 6 le serie temporali con legenda e valori min/max/last |

Colori assegnati per sensore:
| Sensore | Colore |
|---|---|
| WH51_01 (A1 near) | Verde chiaro |
| WH51_02 (A1 far) | Verde scuro |
| WH51_03 (A2 near) | Blu chiaro |
| WH51_04 (A2 far) | Blu scuro |
| WH51_05 (A3 near) | Arancione |
| WH51_06 (A3 far) | Rosso |

**Sezione 2 — Per aiuola**

| Pannello | Tipo | Filtro | Descrizione |
|---|---|---|---|
| Aiuola 1 — Sinistra (WH51_01/02) | Time series | `aiuola == "1"` | Near vs Far sovrapposti |
| Aiuola 2 — Centro (WH51_03/04) | Time series | `aiuola == "2"` | Near vs Far sovrapposti |
| Aiuola 3 — Destra (WH51_05/06) | Time series | `aiuola == "3"` | Near vs Far sovrapposti |

**Sezione 3 — Valori correnti**

6 pannelli gauge (uno per sensore), range [0–100], con soglie:

| Soglia | Colore | Significato |
|---|---|---|
| < 30% | Rosso | Critico — suolo troppo asciutto |
| 30–40% | Giallo | Sotto soglia irrigazione |
| 40–65% | Verde | Range ottimale |
| > 65% | Blu | Sopra soglia chiusura valvola |

**Sezione 4 — Stato sistema**

| Pannello | Tipo | Query | Descrizione |
|---|---|---|---|
| Stato sensori | Tabella | `system_health`, ultimi 10 min | Sensore, stato online/offline, batteria V, secondi dall'ultimo dato |

### 6.3 Query Flux di riferimento

**Umidità per aiuola (overview):**
```flux
from(bucket: "garden")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
  |> map(fn: (r) => ({ r with _field: r.sensor_id + " (A" + r.aiuola + " " + r.position + ")" }))
```

**Valore corrente singolo sensore (gauge):**
```flux
from(bucket: "garden")
  |> range(start: -5m)
  |> filter(fn: (r) => r._measurement == "soil_moisture"
       and r._field == "value"
       and r.sensor_id == "WH51_01")
  |> last()
```

**Stato sistema (tabella):**
```flux
from(bucket: "garden")
  |> range(start: -10m)
  |> filter(fn: (r) => r._measurement == "system_health" and r.component_type == "sensor")
  |> filter(fn: (r) => r._field == "online"
       or r._field == "battery_voltage"
       or r._field == "last_seen_seconds_ago")
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
```

---

## 7. Struttura directory e file

```
/opt/orto-digitale/
│
├── docker-compose.yml              ← aggiornato con servizio grafana
├── .env                            ← aggiunto INFLUX_TOKEN_GRAFANA_RO
│
├── grafana/
│   ├── data/                       ← database Grafana (ownership 472:472)
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   └── influxdb.yml        ← datasource InfluxDB con token grafana-ro
│   │   └── dashboards/
│   │       └── orto-digitale.yml   ← provider file-based per dashboard JSON
│   └── dashboards/
│       └── orto-digitale.json      ← definizione completa dashboard
│
└── simulator/
    ├── sensor_simulator.py         ← script simulatore
    ├── simulator.log               ← log runtime (creato all'avvio)
    └── simulator.pid               ← PID processo (creato all'avvio)
```

**Ownership richiesta:**

| Directory | UID:GID | Comando |
|---|---|---|
| `grafana/data/` | `472:472` | `sudo chown -R 472:472 grafana/data/` |

Le directory `grafana/provisioning/` e `grafana/dashboards/` possono rimanere con ownership dell'utente OS (es. `as:as`) perché montate read-only.

---

## 8. Docker Compose — Stack aggiornato

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:latest
    container_name: mosquitto
    restart: always
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/config:/mosquitto/config:ro
      - ./mosquitto/data:/mosquitto/data
      - ./mosquitto/log:/mosquitto/log
    networks:
      - iot-net

  influxdb:
    image: influxdb:2
    container_name: influxdb
    restart: always
    ports:
      - "8086:8086"
    volumes:
      - ./influxdb/data:/var/lib/influxdb2
      - ./influxdb/config:/etc/influxdb2
    env_file:
      - .env
    networks:
      - iot-net

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - ./grafana/data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=OrtoDigitale2026
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_AUTH_ANONYMOUS_ENABLED=false
      - GF_SERVER_ROOT_URL=http://%(domain)s:3000/
      - GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/orto-digitale.json
    depends_on:
      - influxdb
    networks:
      - iot-net

networks:
  iot-net:
    driver: bridge
```

> **Nota:** `depends_on: influxdb` garantisce che InfluxDB sia avviato prima di Grafana, ma non ne garantisce la disponibilità API. Se Grafana si avvia troppo presto rispetto a InfluxDB, il datasource risulterà offline temporaneamente e si auto-riconfigura entro pochi minuti.

---

## 9. Flusso operativo

### FASE A — Preparazione simulatore

**A.1 — Installazione dipendenza Python**

- Operazione: `pip3 install --break-system-packages influxdb-client`
- Stato atteso: `python3 -c "import influxdb_client; print(influxdb_client.__version__)"` restituisce versione (`1.x`)

**A.2 — Creazione directory simulatore**

- Operazione: `mkdir -p /opt/orto-digitale/simulator`
- Stato atteso: directory presente

**A.3 — Copia script**

- Operazione: copiare `sensor_simulator.py` in `/opt/orto-digitale/simulator/`
- Verifica: `ls -la /opt/orto-digitale/simulator/sensor_simulator.py`

**A.4 — Avvio simulatore con backfill**

- Operazione:
  ```bash
  cd /opt/orto-digitale/simulator
  nohup python3 -u sensor_simulator.py --backfill 48 --run \
    > simulator.log 2>&1 &
  echo $! > simulator.pid
  ```
- Stato atteso: log mostra progressione backfill (`0.5% … 100%`) poi `Loop real-time avviato`
- Verifica: `tail -5 simulator.log`

---

### FASE B — Configurazione Grafana

**B.1 — Creazione struttura directory**

- Operazione:
  ```bash
  mkdir -p /opt/orto-digitale/grafana/data
  mkdir -p /opt/orto-digitale/grafana/provisioning/datasources
  mkdir -p /opt/orto-digitale/grafana/provisioning/dashboards
  mkdir -p /opt/orto-digitale/grafana/dashboards
  sudo chown -R 472:472 /opt/orto-digitale/grafana/data
  ```
- Stato atteso: `ls -lan /opt/orto-digitale/grafana/` mostra `data` con UID `472`
- ⛔ Se ownership mancante: Grafana non riesce a creare il proprio database SQLite e va in crash

**B.2 — Copia file di configurazione**

- Operazione: copiare i seguenti file nel RPi5 (es. via `scp` o SFTP):
  - `grafana/provisioning/datasources/influxdb.yml` → `/opt/orto-digitale/grafana/provisioning/datasources/`
  - `grafana/provisioning/dashboards/orto-digitale.yml` → `/opt/orto-digitale/grafana/provisioning/dashboards/`
  - `grafana/dashboards/orto-digitale.json` → `/opt/orto-digitale/grafana/dashboards/`
  - `docker-compose.yml` aggiornato → `/opt/orto-digitale/docker-compose.yml`
- Verifica: `docker compose config --quiet && echo VALIDO` dalla directory del progetto

**B.3 — Pull immagine e avvio**

- Operazione: `cd /opt/orto-digitale && docker compose up -d`
- Docker scarica `grafana/grafana:latest` (~300MB al primo avvio) e avvia il container
- Stato atteso: `docker compose ps` mostra `grafana Up` con porta `3000`

**B.4 — Apertura firewall**

- Operazione: `sudo ufw allow 3000/tcp`
- Stato atteso: `ufw status` mostra la regola per la porta 3000

---

### Riepilogo flusso operativo

```
FASE A — Simulatore
  A.1 pip3 install influxdb-client
  A.2 mkdir simulator/
  A.3 Copia sensor_simulator.py
  A.4 Avvio con --backfill 48 --run    ← output: 21k+ punti in InfluxDB

FASE B — Grafana
  B.1 Crea directory + chown 472:472   ← GATE: Grafana crasha senza
  B.2 Copia file provisioning + compose
  B.3 docker compose up -d
  B.4 ufw allow 3000/tcp

        ▼
   STEP 1b COMPLETATO
   → Grafana accessibile su http://<ip>:3000
   → Dashboard pre-configurata con dati simulati
```

---

## 10. Criteri di accettazione

| # | Verifica | Metodo | Risultato atteso |
|---|---|---|---|
| 1 | Simulatore in esecuzione | `kill -0 $(cat /opt/orto-digitale/simulator/simulator.pid)` | Nessun errore |
| 2 | Dati in InfluxDB | `docker exec influxdb influx query '...' \| count` | ≥ 17.000 punti `soil_moisture` (48h backfill) |
| 3 | Loop real-time attivo | `tail -3 simulator.log` ogni 60s | Nuova riga con valori per tutti e 6 i sensori |
| 4 | Container Grafana running | `docker compose ps` | Status `Up` su porta `3000` |
| 5 | Grafana health | `curl http://<ip>:3000/api/health` | `{"database":"ok","version":"..."}`|
| 6 | Login funzionante | Browser → `http://<ip>:3000` | Dashboard home visibile dopo login |
| 7 | Datasource InfluxDB | `curl -u admin:... http://<ip>:3000/api/datasources` | `"name":"InfluxDB"` presente |
| 8 | Dashboard provisioned | `curl -u admin:... http://<ip>:3000/api/search` | `"uid":"orto-moisture-v1"` presente |
| 9 | Grafici con dati | Aprire dashboard in browser | Grafici time series con dati visibili nelle ultime 24h |
| 10 | Gauge aggiornati | Sezione "Valori correnti" | 6 gauge con valori recenti e colori corretti |
| 11 | Riavvio automatico container | `sudo reboot` → attesa 90s → `docker compose ps` | Tutti e 3 i container `Up` senza intervento |
| 12 | Riavvio automatico simulatore | `sudo reboot` → attesa 90s → `systemctl is-active orto-simulator` | `active` |
| 13 | Scrittura post-reboot | `tail -f simulator.log` per 2 min dal boot | Massimo 1 errore, poi scritture regolari ogni 60s |

---

## 11. Gestione del simulatore

### Servizio systemd (auto-start al boot)

Il simulatore è registrato come servizio systemd `/etc/systemd/system/orto-simulator.service`:

```ini
[Unit]
Description=Orto Digitale — Simulatore sensori WH51
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=as
WorkingDirectory=/opt/orto-digitale/simulator
ExecStart=/usr/bin/python3 -u /opt/orto-digitale/simulator/sensor_simulator.py --run
Restart=on-failure
RestartSec=30
StandardOutput=append:/opt/orto-digitale/simulator/simulator.log
StandardError=append:/opt/orto-digitale/simulator/simulator.log

[Install]
WantedBy=multi-user.target
```

Il servizio usa `--run` (senza `--backfill`) perché i dati storici sono già in InfluxDB dal primo avvio. Se InfluxDB non è ancora pronto al momento del primo ciclo di scrittura, l'errore viene catturato, loggato, e il ciclo successivo (60s dopo) ritenta con successo.

### Comandi di gestione

```bash
# Stato
systemctl status orto-simulator

# Stop manuale
sudo systemctl stop orto-simulator

# Avvio manuale
sudo systemctl start orto-simulator

# Rimozione dal boot (quando si passa ai sensori reali)
sudo systemctl disable orto-simulator
sudo systemctl stop orto-simulator
```

### Monitoraggio

```bash
tail -f /opt/orto-digitale/simulator/simulator.log
```

### Verifica dati in InfluxDB (ultime 5 min)

```bash
docker exec influxdb influx query \
  'from(bucket:"garden") |> range(start:-5m) |> filter(fn:(r)=>r._measurement=="soil_moisture" and r._field=="value") |> last()' \
  --host http://localhost:8086 \
  --token <INFLUX_TOKEN_NODERED_RW> \
  --org orto-digitale
```

### Dismissione (quando i sensori reali sono attivi)

Quando Node-RED inizia a ricevere dati reali dal GW3000 e a scriverli in InfluxDB (Step 2):
1. Fermare il simulatore: `kill $(cat simulator.pid)`
2. I dati simulati rimangono in InfluxDB e si mescolano con quelli reali per 120 giorni (retention), dopodiché vengono eliminati automaticamente

> **Nota:** È possibile eliminare i dati simulati prima della scadenza tramite l'API InfluxDB delete con il predicato `_measurement="soil_moisture"` su un range temporale specifico, se necessario.

---

## 12. Persistenza al riavvio

Tutti i componenti dello stack sono configurati per ripartire automaticamente dopo uno spegnimento o un riavvio del RPi5, senza alcun intervento manuale.

### Quadro completo

| Componente | Meccanismo | Tempo atteso | Verifica |
|---|---|---|---|
| Docker Engine | `systemctl enable docker` | ~5s | `systemctl is-active docker` |
| Mosquitto | `restart: always` in Compose | ~15s | `docker compose ps` |
| InfluxDB + dati | `restart: always` + volume persistente | ~20–40s | `docker compose ps` |
| Grafana + dashboard | `restart: always` + volume persistente | ~40–50s | `curl http://localhost:3000/api/health` |
| Simulatore | `orto-simulator.service` (systemd, enabled) | ~45s | `systemctl is-active orto-simulator` |

> **Verifica rapida post-reboot** (da eseguire ~90s dopo il riavvio):
> ```bash
> systemctl is-active docker orto-simulator
> cd /opt/orto-digitale && docker compose ps
> ```

### Comportamento del simulatore al boot

Il simulatore parte tramite il servizio systemd `orto-simulator.service` con la direttiva `After=docker.service`. In alcuni casi InfluxDB può impiegare qualche secondo in più del simulatore per essere pronto ad accettare scritture. In quel caso:

1. Il primo ciclo di scrittura (~45s dal boot) produce un errore catturato nel log:
   ```
   [HH:MM:SS] ERRORE scrittura: ('Connection aborted.', ConnectionResetError(...))
   ```
2. Il simulatore **non crasha** — l'eccezione è gestita e il processo continua
3. Il ciclo successivo (60s dopo) scrive correttamente

Questo comportamento è stato verificato su reboot reale (2026-04-08): l'errore è comparso una sola volta e il ciclo successivo ha scritto correttamente.

### Persistenza dei dati InfluxDB

I dati scritti in InfluxDB sopravvivono al riavvio perché il volume `./influxdb/data` è mappato su disco (`/opt/orto-digitale/influxdb/data/`). Non esiste perdita di dati in caso di spegnimento ordinato o interruzione di corrente (InfluxDB usa WAL — Write-Ahead Log).

### Riavvio della configurazione Grafana

Grafana memorizza il proprio stato (sessioni, preferenze, plugin installati) nel volume `./grafana/data/`. Il provisioning (datasource e dashboard) viene riapplicato ad ogni avvio leggendo i file da `./grafana/provisioning/` e `./grafana/dashboards/`, garantendo che la configurazione sia sempre coerente con i file su disco.

### Sequenza di avvio verificata

```
t=0s    → RPi5 si riaccende
t=5s    → systemd avvia Docker Engine
t=15s   → Docker Compose avvia mosquitto (Up)
t=20s   → Docker Compose avvia influxdb (Up, ancora in init)
t=40s   → Docker Compose avvia grafana (Up)
t=40s   → influxdb pronto ad accettare query e scritture
t=45s   → orto-simulator.service avvia il simulatore Python
t=45s   → primo ciclo scrittura: potrebbe fallire (influxdb race condition)
t=105s  → secondo ciclo scrittura: OK garantito
```

---

## 13. Dipendenze e note

### Prerequisiti da Step 1

| Elemento | Richiesto da |
|---|---|
| InfluxDB operativo su `8086` con bucket `garden` | Simulatore (scrittura) e Grafana (lettura) |
| Token `INFLUX_TOKEN_NODERED_RW` nel `.env` | Simulatore |
| Token `INFLUX_TOKEN_GRAFANA_RO` nel `.env` e in `influxdb.yml` | Grafana datasource |
| Rete Docker `iot-net` | Container Grafana → InfluxDB |

### Note importanti

- **Il simulatore sopravvive al reboot** tramite systemd (`orto-simulator.service`, enabled). Al primo ciclo post-reboot potrebbe loggare un errore di connessione se InfluxDB non è ancora pronto; riprende automaticamente al ciclo successivo (30s di `RestartSec` + 60s di loop).
- **La dashboard è `allowUiUpdates: true`**: modifiche fatte dalla UI vengono mantenute fino al prossimo reload del file JSON. Per rendere permanenti le modifiche della UI, esportare il JSON aggiornato e sovrascrivere `grafana/dashboards/orto-digitale.json`.
- **Grafana 12.x**: il provisioning file-based funziona normalmente, ma l'API Grafana potrebbe richiedere pochi secondi dopo l'avvio per rendere disponibili datasource e dashboard.
- **InfluxDB Flux vs InfluxQL**: il datasource è configurato in modalità **Flux** (InfluxDB 2.x nativo). Le query InfluxQL non sono supportate in questa configurazione.

---

## 14. Stato di completamento

**Completato il 2026-04-08**

| Componente | Versione | Stato |
|---|---|---|
| `influxdb-client` (Python) | 1.50.0 | Installato |
| `sensor_simulator.py` | v1.0 | In esecuzione con backfill 48h + loop |
| Grafana | 12.4.2 | Container Up, porta 3000 |
| Datasource InfluxDB | UID `influxdb-garden` | Provisioned (token grafana-ro) |
| Dashboard `orto-moisture-v1` | v1 | Provisioned, cartella `Orto Digitale` |

### Metriche al completamento

| Metrica | Valore |
|---|---|
| Punti `soil_moisture` scritti (backfill 48h) | ~21.312 |
| Punti per sensore | ~7.437 (48h a 60s/lettura da precedenti run + run corrente) |
| Ciclo loop attivo | ogni 60 secondi |
| URL Grafana | `http://192.168.1.46:3000` |
| Credenziali Grafana | `admin` / `OrtoDigitale2026` |

---

*Specifica Step 1b — Orto Digitale v1.1 — Aprile 2026*
