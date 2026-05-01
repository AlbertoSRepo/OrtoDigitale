# Step 1 — Setup Docker Compose su Raspberry Pi 5
## Mosquitto + InfluxDB 2.x

**Progetto:** Orto Digitale v1.1
**Step:** 1 di 6
**Output atteso:** Broker MQTT e database time series operativi, accessibili in LAN, pronti a ricevere i servizi degli step successivi

---

## Indice

1. [Prerequisiti di sistema](#1-prerequisiti-di-sistema)
2. [Installazione Docker](#2-installazione-docker)
3. [Struttura directory e volumi](#3-struttura-directory-e-volumi)
4. [Configurazione Mosquitto](#4-configurazione-mosquitto)
5. [Configurazione InfluxDB](#5-configurazione-influxdb)
6. [Schema del database InfluxDB](#6-schema-del-database-influxdb)
7. [Docker Compose — Definizione dello stack](#7-docker-compose--definizione-dello-stack)
8. [Networking tra container](#8-networking-tra-container)
9. [Criteri di accettazione (verifica Step 1)](#9-criteri-di-accettazione-verifica-step-1)
10. [Rischi specifici di questo step](#10-rischi-specifici-di-questo-step)
11. [Dipendenze verso gli step successivi](#11-dipendenze-verso-gli-step-successivi)

---

## 1. Prerequisiti di sistema

Prima di avviare qualsiasi servizio Docker, il Raspberry Pi 5 deve soddisfare i seguenti requisiti.

### 1.1 Sistema operativo

| Requisito | Valore atteso | Note |
|---|---|---|
| Distribuzione | Raspberry Pi OS Lite | Versione headless, senza desktop |
| Architettura | 64-bit (arm64/aarch64) | **Obbligatorio** — InfluxDB 2.x non ha immagine Docker a 32 bit |
| Versione kernel | ≥ 6.1 | Incluso in RPi OS basato su Debian 12 Bookworm |
| Hostname | `rpi5-orto` (o simile) | Fisso e identificativo |

> **Attenzione:** abilitare il kernel a 64 bit in `/boot/config.txt` non è sufficiente. Deve essere un'installazione OS completa a 64 bit. Verificare con `uname -m` → deve restituire `aarch64`.

### 1.2 Rete

| Requisito | Configurazione consigliata |
|---|---|
| IP del RPi5 in LAN | Statico via DHCP reservation sul router (es. `192.168.1.50`) |
| Accesso SSH | Abilitato in `raspi-config` prima del primo avvio |
| Hostname risolvibile | `rpi5-orto.local` via mDNS (avahi-daemon) |

L'IP statico è un prerequisito critico: tutti gli altri dispositivi (GW3000, client MQTT, browser per Grafana) devono raggiungere il RPi5 sempre allo stesso indirizzo. La DHCP reservation sul router è preferibile alla configurazione statica lato OS perché più facile da gestire.

### 1.3 Storage

| Elemento | Requisito minimo | Consigliato |
|---|---|---|
| SD card o SSD | 16 GB | 32 GB su SSD USB (più affidabile della SD) |
| Mount punto dati | `/opt/orto-digitale/` | Sulla partizione principale |
| Mount archivio CSV | `/mnt/archivio/` | Disco USB esterno dedicato (Step 6) |

### 1.4 Pacchetti OS da installare prima di Docker

- `curl` — per lo script di installazione Docker
- `ca-certificates` — certificati radice per HTTPS
- `gnupg` — verifica firme repository
- `avahi-daemon` — risoluzione `rpi5-orto.local` in LAN
- `ufw` (opzionale) — firewall per restringere porte esposte

---

## 2. Installazione Docker

### 2.1 Metodo consigliato

Installare **Docker Engine** (non Docker Desktop) seguendo la procedura ufficiale per Debian/ARM64 tramite il repository ufficiale Docker. Non usare il pacchetto `docker.io` dei repository Debian: è una versione vecchia e non include il plugin Compose v2.

Riferimento ufficiale: [https://docs.docker.com/engine/install/debian/](https://docs.docker.com/engine/install/debian/)

### 2.2 Verifiche post-installazione

| Verifica | Comando di controllo | Risultato atteso |
|---|---|---|
| Docker Engine attivo | `docker --version` | `Docker version 26.x` o superiore |
| Plugin Compose v2 | `docker compose version` | `Docker Compose version v2.x` |
| Daemon in esecuzione | `systemctl is-active docker` | `active` |
| Utente nel gruppo docker | `groups $USER` | Il gruppo `docker` è presente |

> **Nota:** aggiungere l'utente al gruppo `docker` evita di dover usare `sudo` ad ogni comando. Richiede un nuovo login per diventare effettivo.

### 2.3 Configurazione daemon Docker

Il daemon Docker deve essere configurato per:

- **Log driver:** `json-file` con `max-size: 10m` e `max-file: 3` — evita che i log dei container saturino la SD card
- **Data root:** default `/var/lib/docker` — accettabile se su SSD, da spostare su USB se si usa SD card

---

## 3. Struttura directory e volumi

Tutta la configurazione del progetto vive sotto una directory radice unica. Questa struttura consente di fare backup dell'intera configurazione con una singola operazione e di ricreare lo stack da zero in pochi minuti.

```
/opt/orto-digitale/
│
├── docker-compose.yml          ← definizione dell'intero stack
├── .env                        ← variabili d'ambiente (credenziali, parametri)
│
├── mosquitto/
│   ├── config/
│   │   ├── mosquitto.conf      ← configurazione broker
│   │   └── password_file       ← utenti MQTT (generato con mosquitto_passwd)
│   ├── data/                   ← messaggi retained (persistenza)
│   └── log/                    ← log del broker
│
└── influxdb/
    ├── data/                   ← dati del database (volume principale)
    └── config/                 ← configurazione runtime InfluxDB
```

### 3.1 Ownership delle directory

| Directory | UID richiesto | Motivo |
|---|---|---|
| `mosquitto/data/` | `1883:1883` | UID interno del container Mosquitto |
| `mosquitto/log/` | `1883:1883` | UID interno del container Mosquitto |
| `influxdb/data/` | `1000:1000` | UID interno del container InfluxDB |

Le directory devono essere create e la ownership assegnata **prima** del primo avvio di Docker Compose, altrimenti i container restituiscono errori "Permission denied" e vanno in restart loop.

---

## 4. Configurazione Mosquitto

### 4.1 Parametri principali di `mosquitto.conf`

| Parametro | Valore | Motivazione |
|---|---|---|
| `listener` | `1883` | Porta MQTT standard |
| `protocol` | `mqtt` | Solo MQTT puro (no WebSocket in v1.0) |
| `allow_anonymous` | `false` | Richiedere autenticazione anche in LAN |
| `password_file` | `/mosquitto/config/password_file` | Path interno al container |
| `persistence` | `true` | Salva messaggi retained su disco |
| `persistence_location` | `/mosquitto/data/` | Directory di persistenza |
| `log_dest` | `file /mosquitto/log/mosquitto.log` | Log su file (non solo stdout) |
| `log_type` | `error warning notice` | Non loggare ogni connessione in produzione |

### 4.2 Utenti MQTT da creare

| Utente | Permessi | Usato da |
|---|---|---|
| `gw3000` | Publish only | Gateway Ecowitt GW3000 (pubblica dati sensori) |
| `nodered` | Publish + Subscribe | Node-RED (legge sensori, scrive comandi valvola) |
| `zigbee2mqtt` | Publish + Subscribe | Zigbee2MQTT (stato e comandi valvola) |
| `monitor` | Subscribe only | Client di debug/monitoraggio (MQTT Explorer, ecc.) |

> **Nota:** il GW3000 supporta autenticazione MQTT con username e password. Configurarlo nella sezione "Server personalizzato" della sua interfaccia web.

### 4.3 Topic MQTT previsti in questo step

In Step 1 Mosquitto è configurato ma non riceve ancora dati reali. I topic vengono definiti qui come riferimento per i test di verifica:

| Topic | Direzione | Publisher | Subscriber |
|---|---|---|---|
| `ecowitt/sensor/WH51_01/soil_moisture` | → broker | GW3000 | Node-RED |
| `ecowitt/sensor/WH51_02/soil_moisture` | → broker | GW3000 | Node-RED |
| `ecowitt/sensor/WH51_03/soil_moisture` | → broker | GW3000 | Node-RED |
| `ecowitt/sensor/WH51_04/soil_moisture` | → broker | GW3000 | Node-RED |
| `ecowitt/sensor/WH51_05/soil_moisture` | → broker | GW3000 | Node-RED |
| `ecowitt/sensor/WH51_06/soil_moisture` | → broker | GW3000 | Node-RED |
| `zigbee2mqtt/SWV_valvola/set` | → broker | Node-RED | Zigbee2MQTT |
| `zigbee2mqtt/SWV_valvola` | → broker | Zigbee2MQTT | Node-RED |

---

## 5. Configurazione InfluxDB

### 5.1 Parametri di inizializzazione (primo avvio)

InfluxDB 2.x richiede una fase di setup al primo avvio, controllata dalla variabile `DOCKER_INFLUXDB_INIT_MODE=setup`. Al termine del setup questa variabile va rimossa o commentata per i successivi avvii normali.

| Parametro | Valore | Note |
|---|---|---|
| `INIT_MODE` | `setup` | Solo al primo avvio |
| `INIT_USERNAME` | `admin` | Utente amministratore |
| `INIT_PASSWORD` | `<scegliere>` | Min 8 caratteri, max 72 — obbligatorio |
| `INIT_ORG` | `orto-digitale` | Nome organizzazione (definitivo, non cambiabile senza migrazione) |
| `INIT_BUCKET` | `garden` | Bucket iniziale (definitivo) |
| `INIT_RETENTION` | `120d` | 120 giorni di retention |
| `INIT_ADMIN_TOKEN` | `<generare>` | Token admin — conservare in modo sicuro |

> **Critico:** il token admin viene mostrato una sola volta durante il setup. Se perso, va rigenerato manualmente e tutti i client che lo usano devono essere aggiornati.

### 5.2 Token da creare dopo il setup

Oltre al token admin, vanno creati token con permessi ridotti per ogni servizio client. Questo limita l'impatto in caso di compromissione di un singolo servizio.

| Token | Permessi | Usato da | Quando crearlo |
|---|---|---|---|
| `token-nodered-rw` | Read + Write su bucket `garden` | Node-RED | Step 2 |
| `token-grafana-ro` | Read only su bucket `garden` | Grafana | Step 5 |
| `token-export-ro` | Read only su bucket `garden` | Job archivio CSV | Step 6 |

I token vanno generati dalla UI InfluxDB (`Load Data → API Tokens → Generate API Token → Custom API Token`) e salvati nel file `.env` del progetto.

### 5.3 Struttura bucket

| Elemento | Valore | Note |
|---|---|---|
| Nome bucket | `garden` | Contiene tutti i dati operativi |
| Organizzazione | `orto-digitale` | Contesto di appartenenza |
| Retention | `120d` | Dati eliminati automaticamente dopo 120 giorni |
| Bucket di sistema | `_monitoring`, `_tasks` | Creati automaticamente da InfluxDB, non modificare |

---

## 6. Schema del database InfluxDB

InfluxDB 2.x è un database **time series**. Il modello dei dati è diverso da un database relazionale: ogni record è un punto nel tempo identificato da measurement, tag e field.

### 6.1 Concetti chiave del modello dati

| Concetto | Equivalente relazionale | Descrizione |
|---|---|---|
| **Measurement** | Tabella | Tipo di dato (es. `soil_moisture`) |
| **Tag** | Colonna indicizzata | Metadato per filtrare/raggruppare (string) |
| **Field** | Colonna non indicizzata | Valore misurato (number, string, bool) |
| **Timestamp** | Chiave primaria implicita | Sempre presente, in nanosecondi UTC |
| **Point** | Riga | Una singola misurazione in un momento |

> **Regola critica:** i **tag** sono indicizzati e ottimali per `GROUP BY` e filtri frequenti. I **field** non sono indicizzati. Mettere come tag solo ciò che si userà per filtrare/raggruppare nei query Grafana.

---

### 6.2 Measurement: `soil_moisture`

Contiene tutte le letture di umidità del suolo dai 6 sensori WH51.

**Tag (indicizzati):**

| Tag | Tipo | Valori possibili | Descrizione |
|---|---|---|---|
| `sensor_id` | string | `WH51_01` … `WH51_06` | Identificatore univoco del sensore fisico |
| `aiuola` | string | `1`, `2`, `3` | Aiuola di appartenenza del sensore |
| `position` | string | `near`, `far` | Posizione relativa nell'aiuola (vicino/lontano all'ingresso acqua) |

**Field (valori misurati):**

| Field | Tipo | Unità | Range atteso | Descrizione |
|---|---|---|---|---|
| `value` | float | % | 0.0 – 100.0 | Umidità del suolo rilevata |
| `battery_voltage` | float | V | 0.0 – 1.6 | Tensione batteria AA del sensore |
| `battery_ok` | boolean | — | true/false | Derivato: false se `battery_voltage` < 1.1V |
| `rssi` | integer | dBm | -100 – 0 | Qualità segnale RF (se esposto dal GW3000) |

**Esempio di punto:**

```
measurement:  soil_moisture
timestamp:    2026-04-06T07:32:00Z
tags:         sensor_id=WH51_03, aiuola=2, position=near
fields:       value=42.5, battery_voltage=1.4, battery_ok=true
```

**Frequenza di scrittura attesa:** 1 punto per sensore ogni ~60 secondi → 6 punti/minuto → ~8.640 punti/giorno → ~1.036.800 punti in 120 giorni. Volume gestibile senza ottimizzazioni particolari.

---

### 6.3 Measurement: `irrigation_events`

Contiene il log storico di ogni evento di irrigazione (apertura e chiusura valvola).

**Tag:**

| Tag | Tipo | Valori possibili | Descrizione |
|---|---|---|---|
| `trigger` | string | `auto`, `manual` | Causa dell'evento |
| `valve_id` | string | `SWV_01` | Identificatore della valvola |

**Field:**

| Field | Tipo | Descrizione |
|---|---|---|
| `state` | string | `open` oppure `closed` |
| `duration_seconds` | integer | Secondi di apertura (solo sui record di chiusura) |
| `avg_moisture_at_trigger` | float | Umidità media delle 3 aiuole al momento dell'apertura |
| `reason` | string | Testo descrittivo (es. `"moisture below threshold 40%"`) |

**Esempio di sequenza:**

```
# Apertura
measurement:  irrigation_events
timestamp:    2026-04-06T06:15:00Z
tags:         trigger=auto, valve_id=SWV_01
fields:       state=open, avg_moisture_at_trigger=36.2, reason="moisture below threshold 40%"

# Chiusura
measurement:  irrigation_events
timestamp:    2026-04-06T06:30:00Z
tags:         trigger=auto, valve_id=SWV_01
fields:       state=closed, duration_seconds=900, avg_moisture_at_trigger=36.2
```

---

### 6.4 Measurement: `system_health`

Usato per monitorare lo stato dei componenti del sistema e alimentare gli alert Grafana.

**Tag:**

| Tag | Tipo | Valori possibili | Descrizione |
|---|---|---|---|
| `component` | string | `WH51_01`…`WH51_06`, `GW3000`, `SWV_01` | Componente monitorato |
| `component_type` | string | `sensor`, `gateway`, `valve` | Categoria del componente |

**Field:**

| Field | Tipo | Descrizione |
|---|---|---|
| `online` | boolean | true se il componente ha inviato dati negli ultimi N minuti |
| `last_seen_seconds_ago` | integer | Secondi dall'ultima ricezione dati |
| `battery_low` | boolean | true se la batteria è sotto soglia (solo per sensori) |
| `battery_voltage` | float | Tensione batteria corrente (solo per sensori) |

**Frequenza di scrittura:** ogni 5 minuti (allineato al polling di Node-RED).

**Logica di calcolo `online`:**

- Per i sensori WH51: `online = true` se `last_seen_seconds_ago < 180` (3 minuti — tolleranza doppia rispetto al periodo nominale di 60s)
- Per il GW3000: derivato dall'ultima ricezione su qualsiasi topic `ecowitt/#`

---

### 6.5 Measurement: `valve_state`

Stato corrente e storico della valvola, aggiornato ogni volta che Zigbee2MQTT pubblica un cambio di stato.

**Tag:**

| Tag | Tipo | Valori possibili |
|---|---|---|
| `valve_id` | string | `SWV_01` |

**Field:**

| Field | Tipo | Descrizione |
|---|---|---|
| `state` | string | `ON` (aperta) oppure `OFF` (chiusa) |
| `reachable` | boolean | true se Zigbee2MQTT segnala il dispositivo raggiungibile |
| `linkquality` | integer | Qualità del link Zigbee (0–255) |

---

### 6.6 Mappa completa: sensori → tag

| Sensore fisico | `sensor_id` | `aiuola` | `position` | Posizione fisica |
|---|---|---|---|---|
| WH51 A | `WH51_01` | `1` | `near` | Aiuola sinistra, 2m dall'ingresso acqua |
| WH51 B | `WH51_02` | `1` | `far` | Aiuola sinistra, 8m dall'ingresso acqua |
| WH51 C | `WH51_03` | `2` | `near` | Aiuola centro, 2m dall'ingresso acqua |
| WH51 D | `WH51_04` | `2` | `far` | Aiuola centro, 8m dall'ingresso acqua |
| WH51 E | `WH51_05` | `3` | `near` | Aiuola destra, 2m dall'ingresso acqua |
| WH51 F | `WH51_06` | `3` | `far` | Aiuola destra, 8m dall'ingresso acqua |

---

### 6.7 Query di riferimento (Flux)

Queste query sono quelle che Grafana e Node-RED utilizzeranno più frequentemente. Documentarle qui aiuta a validare lo schema prima dell'implementazione.

**Umidità media per aiuola nelle ultime 6 ore:**
- Bucket: `garden`
- Measurement: `soil_moisture`
- Filtro: `aiuola = "1"` (o 2 o 3)
- Aggregazione: media mobile su finestra di 5 minuti

**Sensori con batteria scarica (sotto 1.1V):**
- Bucket: `garden`
- Measurement: `soil_moisture`
- Filtro: `battery_voltage < 1.1`
- Window: ultimo punto per sensore

**Storico irrigazioni ultimo mese:**
- Bucket: `garden`
- Measurement: `irrigation_events`
- Filtro: `state = "open"`
- Range: `-30d`

**Componenti offline (nessun dato negli ultimi 3 minuti):**
- Bucket: `garden`
- Measurement: `system_health`
- Filtro: `online = false`
- Window: ultimo punto per componente

---

## 7. Docker Compose — Definizione dello stack

### 7.1 Servizi definiti in questo step

| Servizio | Image | Porta host:container | Volumi montati |
|---|---|---|---|
| `mosquitto` | `eclipse-mosquitto:latest` | `1883:1883` | `./mosquitto/config`, `./mosquitto/data`, `./mosquitto/log` |
| `influxdb` | `influxdb:2` | `8086:8086` | `./influxdb/data`, `./influxdb/config` |

> Usare tag `influxdb:2` (non `latest`) per evitare aggiornamenti automatici a versioni major che potrebbero introdurre breaking changes.

### 7.2 Restart policy

Entrambi i servizi devono avere `restart: always`. Questo garantisce il riavvio automatico dopo un reboot del RPi5 o in caso di crash del container.

### 7.3 Variabili d'ambiente (file `.env`)

Il file `.env` nella root del progetto centralizza tutte le credenziali e i parametri configurabili. Non va mai committato su repository pubblici.

| Variabile | Esempio valore | Usata da |
|---|---|---|
| `INFLUXDB_ADMIN_USER` | `admin` | InfluxDB init |
| `INFLUXDB_ADMIN_PASSWORD` | `<scegliere>` | InfluxDB init |
| `INFLUXDB_ORG` | `orto-digitale` | InfluxDB init + client |
| `INFLUXDB_BUCKET` | `garden` | InfluxDB init + client |
| `INFLUXDB_ADMIN_TOKEN` | `<generare>` | InfluxDB init + client |
| `MQTT_USER_GW3000` | `gw3000` | Mosquitto |
| `MQTT_USER_NODERED` | `nodered` | Mosquitto + Node-RED |

---

## 8. Networking tra container

### 8.1 Rete Docker interna

Tutti i container devono essere collegati a una rete Docker bridge dedicata (es. `iot-net`). Questo consente ai container di comunicare tra loro usando il nome del servizio come hostname, senza dipendere dagli IP host.

| Da → A | Hostname usato | Porta |
|---|---|---|
| Node-RED → Mosquitto | `mosquitto` | `1883` |
| Node-RED → InfluxDB | `influxdb` | `8086` |
| Grafana → InfluxDB | `influxdb` | `8086` |
| Zigbee2MQTT → Mosquitto | `mosquitto` | `1883` |

### 8.2 Porte esposte verso la LAN

| Porta | Servizio | Accessibile da |
|---|---|---|
| `1883` | Mosquitto MQTT | GW3000, client di debug in LAN |
| `8086` | InfluxDB UI + API | Browser in LAN, client di debug |

### 8.3 Firewall (opzionale ma consigliato)

Se `ufw` è abilitato sul RPi5, le regole minime da configurare sono:

| Porta | Protocollo | Azione | Motivo |
|---|---|---|---|
| `22` | TCP | Allow | SSH |
| `1883` | TCP | Allow | MQTT da LAN |
| `8086` | TCP | Allow | InfluxDB UI da LAN |
| `*` | * | Deny | Default deny tutto il resto |

---

## 9. Criteri di accettazione (verifica Step 1)

Lo Step 1 si considera completato solo quando **tutti** i seguenti criteri sono soddisfatti.

| # | Verifica | Metodo | Risultato atteso |
|---|---|---|---|
| 1 | OS a 64 bit | `uname -m` da SSH | `aarch64` |
| 2 | Docker Engine installato | `docker --version` | Versione 26.x o superiore |
| 3 | Compose v2 disponibile | `docker compose version` | Versione v2.x |
| 4 | Container Mosquitto running | `docker compose ps` | Status `Up` |
| 5 | Container InfluxDB running | `docker compose ps` | Status `Up` |
| 6 | Mosquitto raggiungibile da LAN | Connessione MQTT Explorer da PC → `<ip-rpi5>:1883` con credenziali `monitor` | Connessione stabilita |
| 7 | InfluxDB UI accessibile | Browser → `http://<ip-rpi5>:8086` | Schermata di login |
| 8 | Login InfluxDB funzionante | Accesso con utente admin | Dashboard InfluxDB visibile |
| 9 | Bucket `garden` presente | `Load Data → Buckets` nella UI | Bucket con retention `120d` |
| 10 | Token admin salvato | File `.env` aggiornato | Token presente e documentato |
| 11 | Publish/Subscribe MQTT funzionante | Publish manuale su topic `test/verifica` con client `monitor`, subscribe sullo stesso topic | Messaggio ricevuto |
| 12 | Riavvio automatico dopo reboot | `sudo reboot` → attendere 60s → `docker compose ps` | Entrambi i container `Up` |
| 13 | Log privi di errori critici | `docker compose logs mosquitto` e `docker compose logs influxdb` | Nessun `ERROR` o crash |

---

## 10. Rischi specifici di questo step

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| OS a 32 bit → InfluxDB non parte | Media (errore frequente) | Bloccante | Verificare `uname -m` prima di procedere |
| Password InfluxDB < 8 caratteri → restart loop | Alta | Bloccante | Leggere i log con `docker logs influxdb` prima di diagnosticare |
| Permission denied su volumi Mosquitto | Alta | Bloccante | Eseguire `chown 1883:1883` sulle directory prima di `docker compose up` |
| Token admin perso dopo setup | Bassa | Alta | Salvare immediatamente nel file `.env`; non c'è modo di recuperarlo |
| GW3000 rifiuta connessione MQTT autenticata | Media | Bloccante step 2 | Testare credenziali manualmente con mosquitto_pub prima di Step 2 |

---

## 11. Dipendenze verso gli step successivi

Questo step produce i prerequisiti che gli step successivi consumano. Documentarli esplicitamente evita ambiguità.

| Elemento prodotto | Consumato da | Step |
|---|---|---|
| Broker Mosquitto operativo su `1883` | GW3000, Node-RED, Zigbee2MQTT | 2, 3, 4 |
| Credenziali MQTT per ogni servizio | GW3000 (config web), Node-RED, Zigbee2MQTT | 2, 3, 4 |
| InfluxDB operativo su `8086` con bucket `garden` | Node-RED (scrittura), Grafana (lettura) | 2, 4, 5 |
| Token `token-nodered-rw` | Node-RED | 2 |
| Token `token-grafana-ro` | Grafana | 5 |
| Token `token-export-ro` | Job archivio CSV | 6 |
| Rete Docker `iot-net` | Tutti i container degli step successivi | 2, 3, 4, 5, 6 |
| Schema DB documentato (sezione 6) | Node-RED (scrittura punti), Grafana (query) | 2, 4, 5 |

---

## 12. Flusso operativo sul Raspberry Pi 5

Questa sezione descrive la sequenza ordinata di operazioni da eseguire sul RPi5 per portare lo Step 1 a completamento. Le operazioni sono organizzate in fasi sequenziali: ogni fase deve essere completata e verificata prima di procedere alla successiva. I riferimenti alle sezioni indicano dove trovare i dettagli di configurazione.

> **Convenzione:** ogni operazione riporta lo stato atteso al termine. Se lo stato osservato non corrisponde, non procedere alla fase successiva — diagnosticare prima di andare avanti.

---

### FASE A — Preparazione del sistema operativo

**Prerequisito:** RPi5 con Raspberry Pi OS Lite 64-bit già flashato sulla SD/SSD e raggiungibile via SSH.

---

**A.1 — Verifica architettura OS**

- Obiettivo: confermare che l'OS sia effettivamente a 64 bit
- Operazione: eseguire `uname -m` da SSH
- Stato atteso: output `aarch64`
- ⛔ Se l'output è `armv7l`: l'OS è a 32 bit — riflashare con la versione 64-bit prima di procedere. Nessun altro passo è possibile.

---

**A.2 — Aggiornamento del sistema**

- Obiettivo: portare tutti i pacchetti all'ultima versione disponibile e ridurre il rischio di conflitti
- Operazione: `sudo apt update` seguito da `sudo apt upgrade -y`
- Stato atteso: nessun errore, sistema aggiornato
- Nota: può richiedere 5–15 minuti su connessione standard

---

**A.3 — Installazione pacchetti prerequisiti**

- Obiettivo: installare le dipendenze necessarie per Docker e per la gestione della rete
- Pacchetti da installare: `curl`, `ca-certificates`, `gnupg`, `avahi-daemon`
- Operazione: `sudo apt install -y curl ca-certificates gnupg avahi-daemon`
- Stato atteso: tutti i pacchetti installati senza errori
- Verifica avahi: `systemctl is-active avahi-daemon` → `active`

---

**A.4 — Configurazione hostname**

- Obiettivo: assegnare un hostname fisso e identificativo al RPi5
- Operazione: modificare `/etc/hostname` con valore `rpi5-orto`, aggiornare `/etc/hosts` di conseguenza
- Stato atteso: `hostname` restituisce `rpi5-orto`; `ping rpi5-orto.local` da un altro dispositivo LAN riceve risposta
- Nota: richiede riavvio per essere effettivo

---

**A.5 — Configurazione IP statico (DHCP reservation)**

- Obiettivo: garantire che il RPi5 abbia sempre lo stesso IP in LAN
- Operazione: nel router di casa, creare una DHCP reservation abbinando il MAC address del RPi5 all'IP scelto (es. `192.168.1.50`)
- Stato atteso: `ip addr` mostra l'indirizzo IP atteso sull'interfaccia di rete attiva
- ⚠️ Effettuare questa configurazione prima di installare Docker: alcuni setup Docker memorizzano l'IP al momento dell'installazione

---

**A.6 — Riavvio post-configurazione OS**

- Obiettivo: applicare hostname, eventuali aggiornamenti kernel e DHCP reservation
- Operazione: `sudo reboot`
- Stato atteso dopo riavvio: accesso SSH funzionante con hostname `rpi5-orto`, IP corrispondente alla reservation

---

### FASE B — Installazione Docker Engine

**Prerequisito:** Fase A completata e verificata.

---

**B.1 — Aggiunta repository ufficiale Docker**

- Obiettivo: usare il repository Docker ufficiale invece dei pacchetti Debian (`docker.io` è obsoleto)
- Operazione: seguire la procedura ufficiale su [https://docs.docker.com/engine/install/debian/](https://docs.docker.com/engine/install/debian/) — sezione "Install using the apt repository"
- Le operazioni includono: aggiunta della chiave GPG Docker, aggiunta del repository, installazione di `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin`
- Stato atteso: `docker --version` restituisce versione 26.x o superiore

---

**B.2 — Abilitazione Docker al boot**

- Obiettivo: assicurarsi che il daemon Docker parta automaticamente ad ogni riavvio
- Operazione: `sudo systemctl enable docker` e `sudo systemctl start docker`
- Stato atteso: `systemctl is-enabled docker` → `enabled`; `systemctl is-active docker` → `active`

---

**B.3 — Aggiunta utente al gruppo docker**

- Obiettivo: poter eseguire comandi Docker senza `sudo`
- Operazione: `sudo usermod -aG docker $USER`
- Stato atteso dopo nuovo login: `groups` include `docker`; `docker ps` funziona senza `sudo`
- ⚠️ Richiede logout e nuovo login SSH per essere effettivo — non è sufficiente `su - $USER`

---

**B.4 — Configurazione log driver Docker**

- Obiettivo: evitare che i log dei container saturino lo storage
- Operazione: creare o modificare `/etc/docker/daemon.json` aggiungendo `log-driver: json-file` con `max-size: 10m` e `max-file: 3`
- Operazione: `sudo systemctl restart docker`
- Stato atteso: `docker info | grep "Logging Driver"` → `json-file`

---

**B.5 — Verifica Docker Compose v2**

- Obiettivo: confermare che il plugin Compose sia disponibile nella versione corretta
- Operazione: `docker compose version`
- Stato atteso: `Docker Compose version v2.x.x`
- ⛔ Se il comando non esiste o restituisce errore: installare manualmente il plugin `docker-compose-plugin`

---

### FASE C — Creazione struttura progetto

**Prerequisito:** Fase B completata. Docker funzionante senza sudo.

---

**C.1 — Creazione directory radice progetto**

- Obiettivo: creare la struttura di directory che conterrà tutta la configurazione del progetto (→ sezione 3)
- Operazione: creare `/opt/orto-digitale/` e le sottodirectory `mosquitto/config/`, `mosquitto/data/`, `mosquitto/log/`, `influxdb/data/`, `influxdb/config/`
- Stato atteso: `ls /opt/orto-digitale/` mostra le directory attese

---

**C.2 — Assegnazione ownership directory**

- Obiettivo: assegnare la ownership corretta alle directory che i container scrivono su disco (→ sezione 3.1)
- Operazione:
  - `sudo chown -R 1883:1883 /opt/orto-digitale/mosquitto/data/`
  - `sudo chown -R 1883:1883 /opt/orto-digitale/mosquitto/log/`
  - `sudo chown -R 1000:1000 /opt/orto-digitale/influxdb/data/`
- Stato atteso: `ls -la /opt/orto-digitale/mosquitto/` mostra ownership `1883:1883` su data e log
- ⛔ Se non eseguito: i container andranno in restart loop con errore "Permission denied" al primo avvio

---

**C.3 — Creazione file `.env`**

- Obiettivo: centralizzare tutte le credenziali e i parametri variabili (→ sezione 7.3)
- Operazione: creare `/opt/orto-digitale/.env` con le variabili descritte in sezione 7.3
- Scegliere password InfluxDB (min 8 caratteri), generare token admin (stringa casuale lunga ≥ 64 caratteri)
- Stato atteso: file `.env` presente, leggibile solo dall'utente corrente (`chmod 600 .env`)
- ⚠️ Il file `.env` non va mai condiviso né committato su repository

---

**C.4 — Creazione `mosquitto.conf`**

- Obiettivo: creare il file di configurazione del broker con i parametri definiti in sezione 4.1
- Operazione: creare `/opt/orto-digitale/mosquitto/config/mosquitto.conf` con i parametri della tabella in sezione 4.1
- Stato atteso: file presente e leggibile

---

**C.5 — Creazione `docker-compose.yml`**

- Obiettivo: definire lo stack Docker con i due servizi del presente step (→ sezione 7)
- Operazione: creare `/opt/orto-digitale/docker-compose.yml` con i servizi `mosquitto` e `influxdb`, la rete `iot-net` e i mount dei volumi
- Stato atteso: `docker compose config` eseguito dalla directory del progetto non restituisce errori

---

### FASE D — Creazione utenti MQTT

**Prerequisito:** Fase C completata. `mosquitto.conf` presente.

---

**D.1 — Avvio temporaneo container Mosquitto per generare password_file**

- Obiettivo: usare il tool `mosquitto_passwd` integrato nel container per creare il file degli utenti
- Operazione: avviare il container Mosquitto in modalità interattiva (senza `-d`) per eseguire `mosquitto_passwd -c /mosquitto/config/password_file gw3000`
- Il flag `-c` crea un nuovo file. Per gli utenti successivi usare solo `mosquitto_passwd` senza `-c` (altrimenti sovrascrive il file)
- Sequenza: creare nell'ordine `gw3000`, `nodered`, `zigbee2mqtt`, `monitor`
- Stato atteso: file `/opt/orto-digitale/mosquitto/config/password_file` presente con 4 entry

---

**D.2 — Verifica password_file**

- Obiettivo: confermare che il file contenga tutti e 4 gli utenti prima di avviare lo stack completo
- Operazione: `wc -l /opt/orto-digitale/mosquitto/config/password_file`
- Stato atteso: output `4` (una riga per utente)

---

### FASE E — Primo avvio stack Docker

**Prerequisito:** Fasi C e D completate. `docker-compose.yml`, `.env` e `password_file` presenti.

---

**E.1 — Avvio stack in foreground (prima volta)**

- Obiettivo: avviare lo stack in modalità foreground per osservare i log in tempo reale e individuare immediatamente eventuali errori di configurazione
- Operazione: dalla directory `/opt/orto-digitale/`, eseguire `docker compose up` (senza `-d`)
- Osservare i log: Mosquitto deve riportare "Opening ipv4 listen socket on port 1883"; InfluxDB deve riportare "Listening" sulla porta 8086
- ⛔ Se InfluxDB mostra "password must be between 8 and 72 characters": correggere il valore in `.env` e riavviare
- ⛔ Se Mosquitto mostra "Permission denied": tornare a C.2 e correggere la ownership
- Stato atteso: entrambi i container in stato running, nessun `ERROR` nei log
- Terminare con `Ctrl+C` dopo la verifica

---

**E.2 — Avvio stack in background**

- Obiettivo: avviare lo stack in modalità daemon (produzione)
- Operazione: `docker compose up -d`
- Stato atteso: `docker compose ps` mostra entrambi i servizi con stato `Up`

---

### FASE F — Inizializzazione InfluxDB (UI)

**Prerequisito:** Fase E completata. InfluxDB raggiungibile su porta 8086.

---

**F.1 — Accesso alla UI InfluxDB**

- Obiettivo: verificare che la UI sia accessibile e completare l'inizializzazione guidata se non già avvenuta via variabili d'ambiente
- Operazione: aprire browser → `http://<ip-rpi5>:8086`
- Stato atteso: schermata di login InfluxDB visibile
- Se le variabili `DOCKER_INFLUXDB_INIT_*` erano presenti nel `.env`, l'init è già avvenuto automaticamente al primo avvio — accedere direttamente con le credenziali configurate

---

**F.2 — Verifica bucket `garden`**

- Obiettivo: confermare che il bucket sia stato creato correttamente con la retention corretta
- Operazione: nella UI InfluxDB → `Load Data → Buckets`
- Stato atteso: bucket `garden` presente con retention `120d`
- ⛔ Se assente: il setup automatico non è avvenuto correttamente — verificare i log con `docker compose logs influxdb`

---

**F.3 — Creazione token dedicati**

- Obiettivo: creare token con permessi ridotti per i servizi client, invece di usare il token admin per tutto (→ sezione 5.2)
- Operazione nella UI: `Load Data → API Tokens → Generate API Token → Custom API Token`
- Creare nell'ordine:
  1. `token-nodered-rw` → Read + Write su bucket `garden` (servirà in Step 2)
  2. `token-grafana-ro` → Read only su bucket `garden` (servirà in Step 5)
  3. `token-export-ro` → Read only su bucket `garden` (servirà in Step 6)
- ⚠️ **Critico:** copiare ogni token immediatamente dopo la creazione e salvarlo nel file `.env` — non è possibile recuperarlo in seguito
- Stato atteso: 3 token custom presenti in lista, valori salvati nel `.env`

---

**F.4 — Rimozione variabile INIT_MODE dal `.env`**

- Obiettivo: evitare che InfluxDB tenti di reinizializzarsi ad ogni riavvio
- Operazione: nel file `.env`, commentare o rimuovere la riga `DOCKER_INFLUXDB_INIT_MODE=setup`
- Operazione: `docker compose restart influxdb`
- Stato atteso: InfluxDB riparte normalmente, dati e bucket intatti

---

### FASE G — Verifica connettività e test funzionali

**Prerequisito:** Fase F completata. Stack running, bucket e token configurati.

---

**G.1 — Test Mosquitto: publish e subscribe**

- Obiettivo: confermare che il broker accetti connessioni autenticate e ruoti i messaggi correttamente
- Tool consigliato: MQTT Explorer (GUI per Windows/macOS/Linux) oppure `mosquitto_sub` / `mosquitto_pub` da un altro PC in LAN
- Sequenza:
  1. Connettere client con utente `monitor` → `<ip-rpi5>:1883` → Subscribe a `test/#`
  2. Connettere secondo client con utente `nodered` → Publish su `test/verifica` con payload `{"ok": true}`
  3. Verificare che il messaggio appaia nel subscriber
- Stato atteso: messaggio ricevuto correttamente
- ⛔ Se la connessione è rifiutata: verificare che `password_file` sia correttamente montato nel container e che `allow_anonymous false` sia nel `mosquitto.conf`

---

**G.2 — Test InfluxDB: scrittura e lettura via API**

- Obiettivo: confermare che l'API HTTP di InfluxDB accetti scritture e ritorni letture correttamente
- Operazione: dalla UI InfluxDB → `Data Explorer`, eseguire una query sul bucket `garden`
- In alternativa: usare `curl` per inviare un punto di test all'API sulla porta 8086 con il token `token-nodered-rw` (autenticazione Bearer), poi verificare il punto nella UI
- Stato atteso: il punto scritto è visibile nel Data Explorer

---

**G.3 — Test connettività container → container**

- Obiettivo: verificare che i container possano comunicare tra loro sulla rete `iot-net` (sarà necessario per Node-RED in Step 2)
- Operazione: eseguire `docker compose exec influxdb ping mosquitto` (se ping disponibile) oppure verificare che la rete `iot-net` sia visibile con `docker network inspect iot-net`
- Stato atteso: rete `iot-net` presente, entrambi i container connessi ad essa

---

**G.4 — Test riavvio automatico**

- Obiettivo: confermare la restart policy `always` funzionante
- Operazione: `sudo reboot` → attendere 90 secondi → accesso SSH → `docker compose ps`
- Stato atteso: entrambi i container in stato `Up` senza intervento manuale
- Questo test è obbligatorio: un sistema di irrigazione che non si riavvia dopo un'interruzione di corrente non è affidabile

---

### FASE H — Hardening e configurazione finale

**Prerequisito:** Fase G completata. Tutti i test superati.

---

**H.1 — Configurazione firewall (opzionale ma consigliato)**

- Obiettivo: limitare l'esposizione dei servizi solo alle porte necessarie (→ sezione 8.3)
- Operazione: abilitare `ufw`, configurare le regole della tabella in sezione 8.3
- ⚠️ Abilitare sempre prima la regola per la porta 22 (SSH) per non perdere l'accesso remoto
- Stato atteso: `ufw status` mostra le regole attive; la connessione SSH rimane funzionante

---

**H.2 — Backup configurazione iniziale**

- Obiettivo: salvare uno snapshot della configurazione funzionante prima di procedere agli step successivi
- Operazione: copiare l'intera directory `/opt/orto-digitale/` (esclusa `influxdb/data/`) su un supporto esterno o condividerla in LAN
- Il backup deve includere: `docker-compose.yml`, `.env`, `mosquitto/config/mosquitto.conf`, `mosquitto/config/password_file`
- Stato atteso: copia presente e accessibile

---

**H.3 — Documentazione stato finale**

- Obiettivo: registrare i valori definitivi di IP, hostname, token e credenziali per riferimento negli step successivi
- Compilare la seguente tabella e conservarla in modo sicuro:

| Elemento | Valore |
|---|---|
| IP RPi5 in LAN | `192.168.1.46` |
| Hostname | `as` / `as.local` |
| MQTT broker porta | `1883` |
| InfluxDB UI porta | `8086` |
| InfluxDB organizzazione | `orto-digitale` |
| InfluxDB bucket | `garden` (retention 120d) |
| Token admin (conservare offline) | nel `.env` su RPi5 |
| Token nodered-rw | nel `.env` su RPi5 |
| Token grafana-ro | nel `.env` su RPi5 |
| Token export-ro | nel `.env` su RPi5 |
| Data completamento Step 1 | `2026-04-08` |

---

### Riepilogo flusso operativo

```
FASE A — Preparazione OS
  A.1 Verifica architettura 64-bit          ← GATE: blocca tutto se fallisce
  A.2 Aggiornamento sistema
  A.3 Installazione pacchetti prerequisiti
  A.4 Configurazione hostname
  A.5 Configurazione IP statico (router)
  A.6 Riavvio
        │
FASE B — Installazione Docker
  B.1 Aggiunta repository Docker ufficiale
  B.2 Abilitazione Docker al boot
  B.3 Aggiunta utente al gruppo docker
  B.4 Configurazione log driver
  B.5 Verifica Compose v2                   ← GATE: blocca tutto se fallisce
        │
FASE C — Struttura progetto
  C.1 Creazione directory
  C.2 Assegnazione ownership               ← GATE: blocca avvio container se manca
  C.3 Creazione .env
  C.4 Creazione mosquitto.conf
  C.5 Creazione docker-compose.yml
        │
FASE D — Utenti MQTT
  D.1 Generazione password_file            ← GATE: Mosquitto non parte senza di esso
  D.2 Verifica password_file (4 utenti)
        │
FASE E — Primo avvio stack
  E.1 Avvio foreground (osservare log)     ← GATE: nessun errore prima di procedere
  E.2 Avvio in background (-d)
        │
FASE F — Inizializzazione InfluxDB
  F.1 Accesso UI, verifica login
  F.2 Verifica bucket garden + retention   ← GATE: bucket deve esistere con 120d
  F.3 Creazione 3 token dedicati           ← GATE: salvare immediatamente nel .env
  F.4 Rimozione INIT_MODE dal .env
        │
FASE G — Test funzionali
  G.1 Test MQTT publish/subscribe
  G.2 Test InfluxDB scrittura/lettura
  G.3 Test connettività container-container
  G.4 Test riavvio automatico              ← GATE obbligatorio
        │
FASE H — Hardening
  H.1 Configurazione firewall
  H.2 Backup configurazione
  H.3 Documentazione stato finale

        ▼
   STEP 1 COMPLETATO
   → Pronto per Step 2 (GW3000 → MQTT → InfluxDB)
```

---

---

## 13. Stato di completamento

**Completato il 2026-04-08**

| Fase | Stato | Note |
|------|-------|------|
| A — Preparazione OS | COMPLETATA | A.4 hostname mantenuto `as` (non rinominato) |
| B — Docker Engine | COMPLETATA | Docker 29.4.0, Compose v5.1.1 |
| C — Struttura progetto | COMPLETATA | `/opt/orto-digitale/`, ownership corretta |
| D — Utenti MQTT | COMPLETATA | 4 utenti: gw3000, nodered, zigbee2mqtt, monitor |
| E — Primo avvio | COMPLETATA | Entrambi i container Up |
| F — Init InfluxDB | COMPLETATA | Bucket garden 120d, 3 token dedicati creati |
| G — Test funzionali | COMPLETATA | G.1/G.2/G.3/G.4 tutti superati |
| H — Hardening | COMPLETATA | ufw attivo (22/1883/8086), backup config in `/tmp/` |

### Criteri di accettazione verificati

| # | Verifica | Risultato |
|---|----------|-----------|
| 1 | OS 64-bit `aarch64` | PASS |
| 2 | Docker 29.4.0 | PASS |
| 3 | Compose v5.1.1 | PASS |
| 4 | Mosquitto Up | PASS |
| 5 | InfluxDB Up | PASS |
| 6 | MQTT LAN raggiungibile | PASS (verificato con mosquitto_sub/pub) |
| 7 | InfluxDB UI porta 8086 | PASS |
| 8 | Login admin funzionante | PASS |
| 9 | Bucket garden retention 120d | PASS |
| 10 | Token admin salvato | PASS (in `.env`) |
| 11 | Publish/Subscribe MQTT | PASS (test/verifica) |
| 12 | Riavvio automatico | PASS (G.4 superato) |
| 13 | Log privi di errori critici | PASS |

**Step 1 COMPLETATO — Pronto per Step 2**

---

*Specifica Step 1 — Orto Digitale v1.1 — Aprile 2026*
