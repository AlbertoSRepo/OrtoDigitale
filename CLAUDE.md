# Orto Digitale v1.1 — Guida Architetturale per Claude Code

## Contesto progetto
Sistema di irrigazione automatica completamente **locale** (no cloud) per un orto residenziale ~40 m² con 3 aiuole. Gira interamente su un Raspberry Pi 5. Sviluppo su PC Windows, deploy via SSH.

---

## Infrastruttura — NON modificare questi valori

| Risorsa | Valore |
|---|---|
| RPi hostname | `as` — **MAI rinominare in `rpi5-orto`** |
| RPi SSH | `ssh as@192.168.1.12` (Ethernet, primario) — se non risponde: `ssh as@192.168.1.46` (WiFi) |
| RPi OS | RPi OS Lite 64-bit, Debian Bookworm, ARM64/aarch64 |
| Docker | Engine 26.x+, Compose v2 |
| Root progetto RPi | `/opt/orto-digitale/` |
| Compose file | `rpi5/docker-compose.yml` |
| GW3000 IP | `192.168.1.5` |
| RPi IP Ethernet | `192.168.1.12` (statico via DHCP reservation — primario) |
| RPi IP WiFi | `192.168.1.46` (statico via DHCP reservation — fallback) |
| Password OS | `aru63` |

---

## Stack Docker (tutti su rete `iot-net`, `restart: always`)

| Container | Porta | Immagine | Ruolo |
|---|---|---|---|
| `mosquitto` | 1883 | `eclipse-mosquitto:latest` | Broker MQTT — autenticato, NO anonimo |
| `influxdb` | 8086 | `influxdb:2` | Time-series DB — org `orto-digitale`, bucket `garden` |
| `grafana` | 3000 | `grafana/grafana:latest` | Dashboard — admin/`OrtoDigitale2026` |
| `nodered` | 1880 | `nodered/node-red:latest` | Parsing payload + logica irrigazione |
| `zigbee2mqtt` | 8080 | `koenkk/zigbee2mqtt:latest` | Bridge Zigbee (non ancora attivo) |

## Accesso UI

| UI | URL | Credenziali |
|---|---|---|
| InfluxDB | `http://192.168.1.12:8086` | admin / `INFLUXDB_ADMIN_PASSWORD` (da `.env`) |
| Node-RED | `http://192.168.1.12:1880` | — |
| Grafana | `http://192.168.1.12:3000` | admin / `OrtoDigitale2026` |
| GW3000 | `http://192.168.1.5` | — |

> Se Ethernet non risponde, sostituire `192.168.1.12` con `192.168.1.46` (WiFi) in tutti gli URL sopra.

---

## ⚠️ FOOTGUN CRITICI — leggere prima di ogni modifica

### 1. Nomi variabili ambiente incongruenti
`docker-compose.yml` usa `INFLUX_TOKEN_NODERED_RW`
`.env.example` ha `INFLUXDB_TOKEN_NODERED_RW`
→ Sono lo **stesso token**, nomi diversi. Non aggiungere nuovi alias.

`DOCKER_INFLUXDB_INIT_ADMIN_TOKEN` = `INFLUXDB_ADMIN_TOKEN` → stesso valore, due chiavi.

`verify_rpi5.sh` accetta `MQTT_PASS_MONITOR` **oppure** `MQTT_PWD_MONITOR`.

### 2. Il file `.env` NON esiste nel repo
Vive solo su RPi5 in `/opt/orto-digitale/.env` (chmod 600).
Nel repo c'è solo `rpi5/.env.example`. **Non committare mai credenziali.**

### 3. Redeploy flows.json cancella le credenziali Node-RED
Ogni volta che si rideploya `flows.json`, i nodi credenziali vengono svuotati.
→ Ri-iniettare via API REST (vedi `docs/comandi_verifica.md §5.5`).

### 4. Sensori fisici attivi: WH51_01–04 (non 05–06)
I sensori WH51_05 e WH51_06 non sono ancora fisicamente installati.

### 5. Ownership volumi prima del primo `docker compose up`
I container crashano al primo avvio se i permessi non sono impostati **prima**:
```bash
sudo chown -R 1883:1883 /opt/orto-digitale/mosquitto/{data,log}
sudo chown -R 1000:1000 /opt/orto-digitale/influxdb/data
sudo chown -R 1000:1000 /opt/orto-digitale/nodered/data
```

---

## Credenziali MQTT
Utenti in `mosquitto/config/password_file`: `gw3000`, `nodered`, `zigbee2mqtt`, `monitor`

## Token InfluxDB (privilegi minimi)
- `token-nodered-rw` → Read + Write (usato da Node-RED)
- `token-grafana-ro` → Read only (usato da Grafana)
- `token-export-ro` → Read only (usato per export CSV)

---

## Schema dati InfluxDB — bucket `garden`

| Measurement | Tag | Field |
|---|---|---|
| `soil_moisture` | `sensor_id` (WH51_01–06), `aiuola` (1/2/3), `position` (near/far) | `value` (float %), `battery_voltage`, `battery_ok`, `rssi` |
| `irrigation_events` | `trigger` (auto/manual), `valve_id` | `state`, `duration_seconds`, `avg_moisture_at_trigger`, `reason`, `total_liters` (float, integrale flow), `liters_sample_count` (int), `liters_method` (`integrated`/`unavailable`) |
| `valve_state` | `valve_id` (SWV_01) | `state` (ON/OFF), `reachable`, `linkquality`, `flow` (m³/h), `water_shortage` (bool), `water_leakage` (bool) |
| `system_health` | `component`, `component_type` | `online`, `last_seen_seconds_ago`, `battery_low` |

## Mapping sensori → aiuole

| Sensore | Aiuola | Posizione | Luogo fisico |
|---|---|---|---|
| `WH51_01` | 1 | near | Aiuola sinistra, 2m dall'ingresso acqua |
| `WH51_02` | 1 | far | Aiuola sinistra, 8m dall'ingresso acqua |
| `WH51_03` | 2 | near | Aiuola centrale, 2m dall'ingresso acqua |
| `WH51_04` | 2 | far | Aiuola centrale, 8m dall'ingresso acqua |
| `WH51_05` | 3 | near | Aiuola destra, 2m dall'ingresso acqua *(non installato)* |
| `WH51_06` | 3 | far | Aiuola destra, 8m dall'ingresso acqua *(non installato)* |

> **Nota:** al termine di step 2, i tag sono ancora `aiuola=test, position=test`. La migrazione ai valori reali è prevista prima di step 5 (dashboard definitiva).

---

## Flusso dati

```
WH51×6 --RF 868MHz--> GW3000 --MQTT form-urlencoded--> mosquitto
                                                            |
                                                         Node-RED
                                               (parse + split per sensor_id)
                                                            |
                                                        InfluxDB (bucket: garden)
                                                            |
                                                         Grafana
Node-RED <--> zigbee2mqtt <--> SWV_valvola (step 3, non ancora attivo)
```

Il GW3000 pubblica **tutti i sensori** in un unico topic `ecowitt/gw3000` come stringa `form-urlencoded` (es. `soilmoisture1=33&soilbatt1=1.7&...`). Node-RED effettua il parsing.

---

## Logica irrigazione (step 4 — non ancora implementata)

| Parametro | Valore |
|---|---|
| Soglia apertura | < 40% umidità media |
| Soglia chiusura | > 65% umidità media |
| Durata max auto-irrigazione | 15 min (`safety_timeout_seconds = 900`) |
| Durata max apertura manuale | 1 h (`manual_max_duration_seconds = 3600`) |
| Cooldown | 4 ore tra irrigazioni |
| Finestre orarie | 06:00–08:00 e 19:00–21:00 |
| Polling | ogni 5 min |

> **Distinzione safety:** l'auto-irrigazione (decision loop) è limitata a `safety_timeout_seconds`; le aperture manuali da frontend/API accettano durate fino a `manual_max_duration_seconds`. I due cap sono in `rpi5/nodered/data/irrigation_config.json` → sezione `irrigation`.

---

## Stato avanzamento

| Step | Descrizione | Stato |
|---|---|---|
| 1 | Docker Compose: Mosquitto + InfluxDB + Grafana | ✅ |
| 1b | Dashboard Grafana + simulatore sintetico | ✅ (simulatore disabilitato) |
| 2 | GW3000 → MQTT → Node-RED → InfluxDB | ✅ (4/6 sensori) |
| 3 | SONOFF SWV + Zigbee2MQTT | ✅ |
| 4 | Logica irrigazione automatica | ✅ |
| 5 | Frontend PWA — backend API + Caddy HTTPS | ✅ |
| 6 | Frontend PWA — SPA Vite/React/Recharts | ✅ |
| 7 | Frontend PWA — installable + offline (Workbox) | ✅ |
| 8 | Meteo Open-Meteo nel frontend (no storicizzazione) | ✅ |
| 9 | Settings: statistiche di sistema RPi5 (disco / CPU / RAM) | ✅ |
| 10 | Tracciamento idrico SWV: polling attivo `flow` + field anomalie | ✅ |
| 11 | Archiviazione CSV su USB | ⏳ Prossimo |

---

## File chiave

| File | Contenuto |
|---|---|
| `docs/comandi_verifica.md` | Tutti i comandi ops (MQTT, InfluxDB, Node-RED, Grafana) — **cercare qui PRIMA di eseguire comandi manuali** |
| `docs/stepN_*.md` | Spec + diario implementazione per ogni step — **consultare PRIMA di implementare** |
| `docs/rpi5_info.md` | Credenziali OS iniziali RPi5 (attenzione: l'IP iniziale `192.168.1.46` è obsoleto, ora `192.168.1.12`) |
| `rpi5/docker-compose.yml` | Definizione container |
| `rpi5/.env.example` | Template credenziali (il `.env` reale è solo sul RPi5) |
| `rpi5/nodered/data/flows.json` | Flow Node-RED — source of truth |
| `rpi5/scripts/verify_rpi5.sh` | Healthcheck 10-check |
| `docs/frontend_dati_spec.md` | Spec dati per step 5 |

### Pattern obbligatorio per docs/stepN_*.md

Ogni file `docs/stepN_*.md` è sia la **spec originale** che il **diario di implementazione**.

> ⚠️ **REGOLA OBBLIGATORIA — nessuna eccezione:**
> Dopo aver applicato qualsiasi specifica, Claude Code **deve** aggiornare il file `docs/stepN_*.md`
> corrispondente aggiungendo la sezione `## Implementazione` con stato `COMPLETATO`.
> Questo passaggio non è opzionale e va eseguito **prima** del commit finale.

Il blocco da aggiungere in fondo al file:

```markdown
---
## Implementazione
**Stato:** ✅ COMPLETATO — YYYY-MM-DD
**Commit di riferimento:** `tipo(scope): descrizione` (hash breve)
**Note:** [cosa ha funzionato, cosa si è dovuto adattare rispetto alla spec]
**Deviazioni dalla spec:** [nessuna | descrizione della deviazione e motivazione]
```

Non creare cartelle o file separati per tenere traccia degli step: tutto resta in `docs/stepN_*.md`.

---

## Workflow di sviluppo

Le modifiche avvengono sul **PC Windows** (`C:\Users\user\Desktop\OrtoDigitale\dev\`), deploy via `scp` + `ssh`, nessuna CI.

### Ciclo completo per ogni evoluzione

```
1. PIANO (plan mode)
   └─ Analisi in plan mode su Claude Code
   └─ Output: sezione "## Spec" aggiornata in docs/stepN_*.md

2. SVILUPPO (branch dedicato)
   └─ git checkout -b step/N-nome-breve
   └─ Implementazione con Claude Code
   └─ Commit per ogni unità funzionale completata (vedi Convenzioni Git)

3. VERIFICA
   └─ Healthcheck verde: ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh'
   └─ Se Ethernet non risponde: ssh as@192.168.1.46 (WiFi fallback)
   └─ Test funzionale manuale sul campo

4. COMPLETAMENTO  ← in questo ordine preciso, nessun passo è saltabile
   └─ [1] Aggiorna docs/stepN_*.md → aggiungi "## Implementazione" con stato COMPLETATO
   └─ [2] git add docs/stepN_*.md
   └─ [3] git commit: docs(stepN): marca come COMPLETATO
   └─ [4] git checkout main && git merge step/N-nome-breve
   └─ [5] git push origin main
   └─ [6] git branch -d step/N-nome-breve
```

### Regole operative sempre valide
- Dopo ogni modifica a `flows.json` → **ri-iniettare le credenziali Node-RED** (vedi §5.5)
- Non fare mai `git add rpi5/.env` o `git add .env` — il file non deve mai entrare nel repo
- Branch `main` deve essere sempre deployabile sul RPi senza modifiche

---

## Convenzioni di naming

- Topic MQTT: snake_case italiano (es. `ecowitt/gw3000`, `zigbee2mqtt/SWV_valvola`)
- Variabili Node-RED: snake_case italiano
- Measurement InfluxDB: snake_case italiano
- ID sensori: `WH51_01` ... `WH51_06`
- ID valvola: `SWV_01`
- Aiuole: `aiuola_1`, `aiuola_2`, `aiuola_3`

---

## Convenzioni Git

### Formato commit (Conventional Commits)

```
tipo(scope): descrizione in italiano
```

**Tipi ammessi:**

| Tipo | Quando usarlo |
|---|---|
| `feat` | Nuova funzionalità o comportamento |
| `fix` | Correzione di un bug |
| `config` | Modifica a file di configurazione (compose, mosquitto, zigbee2mqtt) |
| `docs` | Aggiornamento documentazione o spec |
| `refactor` | Ristrutturazione senza cambio di comportamento |
| `chore` | Manutenzione (aggiornamento dipendenze, cleanup) |

**Scope ammessi:**

| Scope | Componente |
|---|---|
| `zigbee` | Zigbee2MQTT, SONOFF SWV, dongle |
| `nodered` | Flow Node-RED, logica irrigazione |
| `mosquitto` | Broker MQTT, utenti, ACL |
| `influxdb` | Schema dati, query Flux, retention |
| `grafana` | Dashboard, panel, datasource |
| `docker` | docker-compose.yml, reti, volumi |
| `scripts` | Script shell, verify_rpi5.sh |
| `docs` | Documentazione, spec step |

**Esempi corretti:**
```
feat(zigbee): aggiungi pairing SONOFF SWV_01 via ZBDongle-P
fix(nodered): correggi parsing campo soilmoisture vuoto nel payload GW3000
config(mosquitto): aggiungi utente zigbee2mqtt con ACL limitato
docs(step3): marca step come COMPLETATA, aggiungi note pairing
refactor(influxdb): normalizza valore tag aiuola da int a aiuola_N
chore(docker): aggiorna immagine zigbee2mqtt a latest
```

### Strategia branch

```
main              ← sempre stabile e deployabile sul RPi
step/3-zigbee     ← sviluppo step 3
step/4-irrigazione ← sviluppo step 4
step/5-dashboard  ← sviluppo step 5
step/6-csv-export ← sviluppo step 6
```

Merge su `main` **solo** quando l'healthcheck è verde sul RPi.

### File che non devono mai entrare nel repo

```
rpi5/.env
rpi5/nodered/data/flows_cred.json
rpi5/nodered/data/.config.*.json
rpi5/nodered/data/context/
rpi5/influxdb/data/
rpi5/grafana/data/
```

Verifica sempre con `git status` prima di `git add .`.
