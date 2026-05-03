# Orto Digitale v1.1 — Contesto Progetto

Sistema di irrigazione automatica **completamente locale** (no cloud) per un orto residenziale di ~40m² con 3 aiuole parallele. Tutto gira su un Raspberry Pi 5. Nomi di variabili, topic MQTT e documentazione sono in italiano.

---

## Infrastruttura hardware

| Componente | Dettaglio |
|---|---|
| SBC | Raspberry Pi 5, RPi OS Lite 64-bit Debian Bookworm (ARM64) |
| IP | `192.168.1.12` (DHCP reservation statica), hostname `as` |
| SSH | `ssh as@192.168.1.12`, password `aru63` (fallback) |
| Sensori umidità | 6× Ecowitt WH51 (RF 868 MHz) — attivi 4/6: WH51_01–04 |
| Gateway sensori | Ecowitt GW3000 (IP: `192.168.1.5`), firmware `GW3000A_V1.2.0` |
| Valvola | SONOFF SWV (Zigbee) — paired come `SWV_valvola` (IEEE `0x44e2f8fffe34026f`), fw 1.0.3 — **non ancora installata fisicamente sulla tubazione** |
| Dongle Zigbee | Sonoff ZBDongle-P (USB sul RPi5), ZStack3x0, `/dev/ttyUSB0` |

> **Nota hostname:** il progetto chiama il RPi `as` — NON rinominare in `rpi5-orto` nonostante la spec originale lo preveda.

---

## Stack software (Docker Compose)

Tutti i servizi girano come container Docker con `restart: always` sulla rete bridge `iot-net`. Root progetto sul RPi: `/opt/orto-digitale/`. Compose file: `rpi5/docker-compose.yml`.

| Container | Image | Porta | Ruolo |
|---|---|---|---|
| `mosquitto` | `eclipse-mosquitto:latest` | 1883 | Broker MQTT autenticato, no anonimo |
| `influxdb` | `influxdb:2` | 8086 | DB time-series, org `orto-digitale`, bucket `garden`, 120gg retention |
| `grafana` | `grafana/grafana:latest` | 3000 | Dashboard, admin/`OrtoDigitale2026` |
| `nodered` | `nodered/node-red:latest` | 1880 | Parsing payload + logica irrigazione |
| `zigbee2mqtt` | `koenkk/zigbee2mqtt:latest` | 8080 | Bridge Zigbee — attivo, `SWV_valvola` paired |

---

## Flusso dati

```
WH51 ×6 --RF 868MHz--> GW3000 --MQTT form-urlencoded--> Mosquitto
                                                            |
                                                         Node-RED
                                               (decode + split per sensor_id)
                                                            |
                                                        InfluxDB
                                                       bucket: garden
                                                            |
                                                         Grafana

Frontend/Grafana --HTTP POST /api/valve/:action--> Node-RED
                                                       |
                                              zigbee2mqtt/SWV_valvola/set
                                                       |
                                                  ZBDongle-P
                                                       |
                                               SWV_valvola (Zigbee)
                                                       |
                                           zigbee2mqtt/SWV_valvola (stato)
                                                       |
                                    Node-RED --> InfluxDB (valve_state + irrigation_events)
```

Il GW3000 pubblica **tutti i sensori** in un unico topic `ecowitt/gw3000` come stringa `form-urlencoded` (es. `soilmoisture1=33&soilbatt1=1.7&...`). Node-RED effettua il parsing e scrive un punto InfluxDB per ciascun sensore.

---

## Schema dati InfluxDB (bucket `garden`)

| Measurement | Tag principali | Field principali |
|---|---|---|
| `soil_moisture` | `sensor_id` (WH51_01–06), `aiuola` (1/2/3), `position` (near/far) | `value` (float %), `battery_voltage`, `battery_ok`, `rssi` |
| `valve_state` | `valve_id` (SWV_01) | `state` (ON/OFF), `reachable`, `linkquality`, `battery`, `current_device_status`, `flow` (m³/h) |
| `irrigation_events` | `trigger` (auto/manual), `valve_id` | `duration_seconds`, `avg_moisture_at_trigger`, `reason` — scritto ad ogni chiusura valvola |
| `system_health` | `component`, `component_type` | `online`, `last_seen_seconds_ago`, `battery_low` |

---

## Credenziali e variabili d'ambiente

Le credenziali reali vivono **solo** in `/opt/orto-digitale/.env` sul RPi5 (chmod 600, mai committato). Il repo include solo `rpi5/.env.example`.

**Footgun noti:**
- `docker-compose.yml` legge `INFLUX_TOKEN_NODERED_RW`, ma `.env.example` riporta `INFLUXDB_TOKEN_NODERED_RW` — nomi diversi, stesso token.
- `DOCKER_INFLUXDB_INIT_ADMIN_TOKEN` (usato in query Flux) = `INFLUXDB_ADMIN_TOKEN` — stesso valore, due nomi.
- `verify_rpi5.sh` accetta sia `MQTT_PASS_MONITOR` che `MQTT_PWD_MONITOR`.

**Utenti MQTT** in `mosquitto/config/password_file`: `gw3000`, `nodered`, `zigbee2mqtt`, `monitor`.

**Token InfluxDB** con privilegi minimi: `token-nodered-rw` (R+W), `token-grafana-ro` (R), `token-export-ro` (R).

---

## Logica di irrigazione (step 4, non ancora implementata)

| Parametro | Valore |
|---|---|
| Soglia apertura | < 40% umidità media |
| Soglia chiusura | > 65% umidità media |
| Durata massima | 15 min (safety timeout) |
| Cooldown | 4 ore tra irrigazioni |
| Finestre orarie | 06:00–08:00 e 19:00–21:00 |
| Polling | ogni 5 min |

---

## Stato avanzamento (6 step totali)

| Step | Descrizione | Stato |
|---|---|---|
| 1 | Docker Compose: Mosquitto + InfluxDB + Grafana | ✅ Completato |
| 1b | Dashboard Grafana + simulatore sensori sintetici | ✅ Completato (simulatore disabilitato) |
| 2 | GW3000 → MQTT → Node-RED → InfluxDB | ✅ Completato (4/6 sensori; WH51_05–06 non ancora fisici) |
| 3 | SONOFF SWV + Zigbee2MQTT — valvola via MQTT | ✅ Completato (sw) — installazione fisica su tubazione da fare |
| 4 | Logica irrigazione automatica in Node-RED | ⏳ Da fare |
| 5 | Dashboard Grafana definitiva (heatmap ortofoto, trend, stato valvola) | ⏳ Da fare |
| 6 | Archiviazione CSV su USB (export a 90gg, buffer 30gg prima dei 120gg) | ⏳ Da fare |

---

## Workflow di sviluppo

- Il codice vive sul **PC Windows** (`C:\Users\user\Desktop\OrtoDigitale\dev\`).
- Deploy sul RPi5 via `scp` + `ssh` — non esiste CI.
- `rpi5/nodered/data/flows.json` è la **source of truth** per i flow Node-RED.
- Ogni redeploy di `flows.json` cancella le credenziali embedded → vanno re-iniettate via API REST (snippet Python in `docs/comandi_verifica.md §5.5`).
- Healthcheck canonico (10 controlli): `ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh'`

---

## File di riferimento chiave

| File | Contenuto |
|---|---|
| `CLAUDE.md` | Guida architetturale completa per Claude Code |
| `docs/comandi_verifica.md` | Tutti i comandi ops pronti (MQTT, InfluxDB, Node-RED, Grafana) |
| `docs/stepN_*.md` | Spec dettagliata per ogni step — consultare PRIMA di implementare |
| `rpi5/docker-compose.yml` | Definizione container e variabili d'ambiente |
| `rpi5/.env.example` | Template credenziali (il `.env` reale è solo sul RPi5) |
| `rpi5/nodered/data/flows.json` | Flow Node-RED (source of truth su PC) |
| `rpi5/scripts/verify_rpi5.sh` | Script healthcheck 10-check |
| `docs/frontend_dati_spec.md` | Spec dati per il layer di visualizzazione (step 5) |
