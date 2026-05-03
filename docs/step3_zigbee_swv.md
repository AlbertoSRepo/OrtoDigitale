# Step 3 — SONOFF SWV + Zigbee2MQTT

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Hardware](#2-hardware)
3. [Architettura](#3-architettura)
4. [Configurazione Docker](#4-configurazione-docker)
5. [Configurazione Zigbee2MQTT](#5-configurazione-zigbee2mqtt)
6. [Dispositivo SWV_valvola](#6-dispositivo-swv_valvola)
7. [Topic MQTT pubblicati](#7-topic-mqtt-pubblicati)
8. [Pairing — cronologia](#8-pairing--cronologia)
9. [Stato attuale](#9-stato-attuale)
10. [Problemi noti e anomalie](#10-problemi-noti-e-anomalie)
11. [Dipendenze verso Step 4](#11-dipendenze-verso-step-4)

---

## 1. Obiettivo

Integrare la valvola irrigazione SONOFF SWV nel sistema tramite dongle Zigbee (ZBDongle-P) e Zigbee2MQTT, consentendo a Node-RED di comandare apertura/chiusura via MQTT e di ricevere lo stato della valvola in tempo reale.

---

## 2. Hardware

| Componente | Modello | Identificativo |
|---|---|---|
| Dongle Zigbee | SONOFF Zigbee 3.0 USB Dongle Plus (ZBDongle-P) | Serial `98d2565d30a1ef11bb7a906661ce3355` |
| Valvola | SONOFF SWV (Zigbee smart water valve) | IEEE `0x44e2f8fffe34026f` |

**Dongle — collegamento fisico:**
- USB sul RPi5 → compare come `/dev/ttyUSB0`
- Path persistente (by-id): `usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_98d2565d30a1ef11bb7a906661ce3355-if00-port0`
- Stack: ZStack3x0 (chip CC2652P), firmware `20210708`
- Coordinator IEEE: `0x00124b0038aa48c6`
- PAN ID: `1a62`

**Valvola SWV:**
- Firmware installato: `1.0.3` (build `20240705`)
- Firmware disponibile: `1.0.4` (OTA, aggiunge `auto_close_when_water_shortage`)
- Alimentazione: batteria (100% al momento del pairing)
- Checkin interval: 1800 s (30 min)

---

## 3. Architettura

```
SWV_valvola (Zigbee 868/915 MHz)
        |
        | Zigbee RF
        v
ZBDongle-P (/dev/ttyUSB0 su RPi5)
        |
        | seriale
        v
Container zigbee2mqtt (koenkk/zigbee2mqtt:latest, porta 8080)
        |
        | MQTT (rete iot-net, mqtt://mosquitto:1883)
        v
Container mosquitto
        |
   ┌────┴────┐
   v         v
Node-RED   (subscribe futuro per logica irrigazione)
```

---

## 4. Configurazione Docker

Sezione in `docker-compose.yml`:

```yaml
zigbee2mqtt:
  image: koenkk/zigbee2mqtt:latest
  container_name: zigbee2mqtt
  restart: always
  ports:
    - "8080:8080"
  volumes:
    - ./zigbee2mqtt/data:/app/data
    - ./zigbee2mqtt/configuration.yaml:/app/data/configuration.yaml
    - /run/udev:/run/udev:ro
  devices:
    - /dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_98d2565d30a1ef11bb7a906661ce3355-if00-port0:/dev/ttyUSB0
  environment:
    - TZ=Europe/Rome
    - ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD=${MQTT_PASS_ZIGBEE2MQTT}
  group_add:
    - dialout
  depends_on:
    - mosquitto
  networks:
    - iot-net
```

**Note:**
- Il device è mappato tramite path persistente `by-id` (non `/dev/ttyUSB0` diretto) per sopravvivere ai reboot.
- `/run/udev:ro` espone gli eventi udev per la discovery del dongle.
- `group_add: dialout` garantisce accesso alla porta seriale dall'interno del container.
- La password MQTT viene iniettata via variabile d'ambiente `$MQTT_PASS_ZIGBEE2MQTT` (nel `.env` su RPi5).
- Due mount: `./zigbee2mqtt/data` per il database e i log, `./zigbee2mqtt/configuration.yaml` come file di config principale (override del file in `/app/data`).

---

## 5. Configurazione Zigbee2MQTT

File: `/opt/orto-digitale/zigbee2mqtt/configuration.yaml` (montato in `/app/data/configuration.yaml`)

```yaml
version: 5
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://mosquitto:1883
  user: zigbee2mqtt
  password: <da .env via ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD>
serial:
  port: /dev/ttyUSB0
  adapter: zstack
frontend:
  port: 8080
homeassistant:
  enabled: false
devices:
  '0x44e2f8fffe34026f':
    friendly_name: SWV_valvola
```

**Versione software:** Zigbee2MQTT `2.9.2` (commit `2b485a98`)

**Migrazione config:** il file era originariamente in formato v4 (`configuration_backup_v4.yaml`); al primo avvio Zigbee2MQTT 2.x ha migrato automaticamente a v5 (log: `migration-4-to-5.log`).

**Frontend:** accessibile a `http://192.168.1.46:8080` (WiFi) / `http://192.168.1.12:8080` (Ethernet) — no autenticazione.

---

## 6. Dispositivo SWV_valvola

### Identità

| Campo | Valore |
|---|---|
| Friendly name | `SWV_valvola` |
| IEEE address | `0x44e2f8fffe34026f` |
| Network address | `0x01F8` (504) |
| Tipo | EndDevice (batteria) |
| Produttore | SONOFF (manufId 4742) |
| Modello | SWV |
| Firmware | 1.0.3 (build 20240705) |

### Campi esposti dal dispositivo

| Campo | Tipo | Unità | Accesso | Descrizione |
|---|---|---|---|---|
| `state` | binary | ON/OFF | R/W | Stato valvola (ON = aperta) |
| `flow` | numeric | m³/h | R | Portata istantanea |
| `battery` | numeric | % | R | Carica batteria |
| `linkquality` | numeric | lqi (0–255) | R | Qualità segnale Zigbee |
| `current_device_status` | enum | — | R | Stato operativo: `normal_state` / `water_shortage` / `water_leakage` |
| `auto_close_when_water_shortage` | binary | ENABLE/DISABLE | R/W | Chiusura automatica dopo 30 min di shortage (richiede fw 1.0.4) |
| `cyclic_timed_irrigation` | composite | — | R/W | Irrigazione ciclica a tempo |
| `cyclic_quantitative_irrigation` | composite | — | R/W | Irrigazione ciclica a volume |

### Binding configurati (dal database.db)

| Cluster | Bind verso |
|---|---|
| `genPollCtrl` (32) | Coordinator endpoint 1 |
| `genPowerCfg` (1) | Coordinator endpoint 1 |
| `genOnOff` (6) | Coordinator endpoint 1 |
| `msFlowMeasurement` (1028) | Coordinator endpoint 1 |

### Reporting configurato

`genOnOff` (cluster 6): `attrId=0` (onOff), `minRepIntval=1s`, `maxRepIntval=1800s`

---

## 7. Topic MQTT pubblicati

### Telemetria valvola
**Topic:** `zigbee2mqtt/SWV_valvola`
**Frequenza:** al check-in (ogni ~30 min) o a cambio di stato

Payload esempio:
```json
{
  "auto_close_when_water_shortage": "DISABLE",
  "battery": 100,
  "current_device_status": "water_shortage",
  "flow": 0,
  "linkquality": 42,
  "state": "OFF",
  "update": {
    "installed_version": 4099,
    "latest_version": 4100,
    "state": "available"
  }
}
```

### Comando valvola (da Node-RED)
**Topic set:** `zigbee2mqtt/SWV_valvola/set`
```json
{ "state": "ON" }   // apri valvola
{ "state": "OFF" }  // chiudi valvola
```

### Bridge health
**Topic:** `zigbee2mqtt/bridge/health`
**Frequenza:** ogni 10 minuti
Contiene uptime, memoria, statistiche MQTT, messaggi per dispositivo.

### Bridge events
**Topic:** `zigbee2mqtt/bridge/event`
Pubblica eventi di rete: `device_announce`, `device_joined`, `device_leave`.

---

## 8. Pairing — cronologia

| Ora (UTC+2) | Evento |
|---|---|
| 2026-04-18 18:39 | Primo avvio container Zigbee2MQTT 2.9.2, rete vuota (0 device) |
| 2026-04-18 18:39 | Connessione MQTT stabilita con Mosquitto |
| 2026-04-18 18:40 | `permit_join` abilitato (tempo: 254 s) |
| 2026-04-18 18:41:24 | Device `0x44e2f8fffe34026f` joined (primo tentativo) |
| 2026-04-18 18:41:43 | Device lascia la rete (disconnessione transitoria) |
| 2026-04-18 18:41:50 | Device joined di nuovo, interview avviata |
| 2026-04-18 18:41:53 | **Interview SUCCESSFUL** — identificato come `SONOFF SWV` |
| 2026-04-18 18:42 | Configurazione binding: `genPowerCfg` fallisce al tentativo 1 (timeout ZDO) |
| 2026-04-18 18:42 | Configurazione binding: `customClusterEwelink` fallisce al tentativo 2 (`UNSUPPORTED_ATTRIBUTE`) |
| 2026-04-18 18:42:28 | Dati telemetria iniziano ad arrivare normalmente |
| ≥ 2026-04-18 | Friendly name impostato manualmente a `SWV_valvola` tramite frontend |

**Errori durante il pairing (non bloccanti):**
- `genPowerCfg` bind timeout: errore noto su ZStack3x0 al primo pairing di EndDevice a batteria — si risolve automaticamente al secondo tentativo di configure.
- `customClusterEwelink` `UNSUPPORTED_ATTRIBUTE 20497`: il firmware 1.0.3 non espone questo attributo (introdotto in 1.0.4). Non impatta il funzionamento.

---

## 9. Stato attuale

| Aspetto | Valore |
|---|---|
| Container | `Up` (21+ ore di uptime continuo) |
| Device connesso | ✅ SWV_valvola — check-in ogni ~30 min |
| Segnale Zigbee | variabile 18–75 lqi (linkquality) |
| Stato valvola | `OFF` (chiusa) |
| Batteria | 100% |
| `current_device_status` | `water_shortage` ⚠️ |
| OTA disponibile | fw 1.0.4 (da installare prima di Step 4) |
| Messaggi pubblicati | ~590 in 21h (uptime attuale) |

**Nota sull'allarme `water_shortage`:** il sensore di shortage è probabilmente attivato perché la valvola non è attualmente collegata alla tubazione idrica in fase di test. Quando verrà installata in campo, lo stato dovrebbe tornare a `normal_state`. Se persiste, verificare il raccordo fisico.

---

## 10. Problemi noti e anomalie

### 10.1 `current_device_status: water_shortage`
Il dispositivo segnala mancanza d'acqua in modo persistente. Cause possibili:
1. Non collegato alla tubazione durante il setup (più probabile)
2. Sensore difettoso
3. Raccordo non serrato

**Azione:** verificare al momento dell'installazione in campo.

### 10.2 OTA firmware 1.0.4 disponibile
Il firmware 1.0.4 aggiunge il controllo nativo `auto_close_when_water_shortage`.  
**Raccomandazione:** aggiornare via frontend Zigbee2MQTT (`http://192.168.1.12:8080`) prima di implementare la logica Step 4, così da avere il fallback hardware di sicurezza attivo.

### 10.3 Binding `genPowerCfg` non configurato
Al pairing il bind non è andato a buon fine (timeout ZDO). Il dispositivo funziona correttamente ma il reporting della batteria potrebbe essere meno preciso.  
**Azione:** forzare `reconfigure` dal frontend Z2M se il dato batteria risulta assente o bloccato.

### 10.4 Segnale Zigbee variabile (lqi 18–75)
La rete Zigbee è composta da un solo nodo + coordinator (no mesh). La qualità del segnale varia nel range 18–75, il che è accettabile ma basso. Se la distanza fisica è > 10 m o ci sono pareti/ostacoli, valutare un router Zigbee intermedio.

---

## 11. Dipendenze verso Step 4

Per implementare la logica di irrigazione automatica (Step 4) tramite Node-RED, questo step deve fornire:

| Requisito | Stato |
|---|---|
| Container `zigbee2mqtt` up e stabile | ✅ |
| Device `SWV_valvola` paired e raggiungibile | ✅ |
| Topic `zigbee2mqtt/SWV_valvola` pubblica stato | ✅ |
| Topic `zigbee2mqtt/SWV_valvola/set` accetta comandi | ✅ (non ancora testato da Node-RED) |
| Firmware 1.0.4 installato (safety timeout) | ⏳ consigliato |
| `current_device_status` = `normal_state` | ⏳ da verificare in campo |
| Flow Node-RED per subscribe/publish SWV | ⏳ Step 4 |

---

## Implementazione
**Stato:** ✅ COMPLETATO (pairing e configurazione) — 2026-05-03
**Commit di riferimento:** da creare
**Note:** Il pairing del SONOFF SWV è avvenuto il 2026-04-18. Il container è in esecuzione continua da allora. La configurazione è stata ricostruita retroattivamente dal vivo sul RPi5 (nessun file era presente nel repo). Il file `configuration.yaml` vive in `/opt/orto-digitale/zigbee2mqtt/configuration.yaml` (montato nel container) anziché in `zigbee2mqtt/data/` come per gli altri servizi.
**Deviazioni dalla spec:** La spec originale non era presente — questo documento è sia la spec ricostruita che il diario. Manca ancora l'integrazione Node-RED (Step 4) e l'aggiornamento firmware OTA.
