# Analisi Completezza Logica Irrigazione — Pre-implementazione Step 4

**Data:** 2026-05-03
**Documenti padre:**
- [analisi_logica_irrigazione.md](./analisi_logica_irrigazione.md) — algoritmo decisionale base
- [analisi_integrazione_meteo.md](./analisi_integrazione_meteo.md) — integrazione Open-Meteo

**Scope:** verificare se la logica come oggi specificata è completa e implementabile, identificare lacune.

---

## 1. Errori e imprecisioni nella logica esistente

### 1.1 Cooldown 4h ridondante per i trigger automatici ✅ DECISA: ridotto a 2h

Tra fine finestra mattina (08:00) e inizio finestra sera (19:00) passano **11 ore**. Il cooldown a 4h non scattava mai contro un trigger automatico, perché le finestre sono già più distanti del cooldown stesso.

**Decisione:** ridotto a **2h** (default `cooldown_seconds: 7200`, configurabile). Mantenuto **attivo anche in emergenza**: se un'irrigazione di emergenza non riesce a portare l'umidità sopra il 25%, c'è un problema sistemico (sensore guasto, perdita) che richiede intervento umano, non più acqua.

A 2h il sistema risponde meglio dopo un'apertura manuale: utente apre alle 17:30 → finestra automatica delle 19:30 utilizzabile (con 4h sarebbe stata bloccata fino alle 21:30, fuori finestra serale).

### 1.2 Soglia di emergenza fuori-finestra ✅ DECISA

**Decisione:** soglia di emergenza al **25%** (default, configurabile da frontend), durata ridotta a **5 min**, bypass **solo dell'orario** (cooldown e rain delay restano attivi). Vedi `analisi_logica_irrigazione.md` §"Soglia di emergenza" per la specifica completa.

Il bypass parziale (solo orario) evita comportamenti "panico" — a 24% non si scatenano 3 irrigazioni di fila — e mantiene il sistema prevedibile.

### 1.3 Edge case: irrigazione che attraversa la fine finestra ✅ DECISA

**Decisione:** la finestra orario governa **solo l'apertura**. Una volta aperta, l'irrigazione prosegue fino a soglia di chiusura o safety timeout, indipendentemente dall'orario corrente.

Esempio: apertura alle 20:55 con finestra che chiude alle 21:00 → l'irrigazione continua fino al raggiungimento del 65% o dei 15 min di timeout, anche dopo le 21:00.

Algoritmo aggiornato in `analisi_logica_irrigazione.md` §"Algoritmo decisionale completo" (passo 6 del flow).

### 1.4 Source of truth dello stato ✅ DECISA: hybrid

**Decisione adottata** — schema ibrido:

| Tipo di stato | Source | Aggiornamento |
|---|---|---|
| `valve_state_runtime` (ON/OFF/OPENING/CLOSING) | MQTT subscribe `zigbee2mqtt/SWV_01` | Realtime, ground truth |
| `last_irrigation_at` (timestamp) | `global.context` Node-RED | Aggiornato a fine di ogni evento |
| `in_progress` (bool) | `global.context` Node-RED | Aggiornato all'apertura/chiusura |

**Recovery al boot:**
- Query Flux su `irrigation_events` (ultimo evento) → ricostruisce `last_irrigation_at`
- Query Flux su `valve_state` (ultima riga) → ricostruisce `valve_state_runtime`
- Confronto coerenza: se `valve_state=ON` ma nessun evento aperto → forza chiusura (vedi §2.2)

Vantaggi: nessuna query Flux durante decisioni runtime (latenza zero), recovery automatico dopo crash, ground truth della valvola sempre allineato con MQTT.

---

## 2. Componenti mancanti per arrivare a un'implementazione completa

### 2.1 State machine della valvola con conferma zigbee2mqtt

L'algoritmo dice "APRI VALVOLA" come fosse atomico. In realtà:

```
Node-RED publish: zigbee2mqtt/SWV_01/set {"state":"ON"}
                            │
                            ▼
                   zigbee2mqtt → comando radio Zigbee
                            │
                            ▼
                   SWV_01 esegue → pubblica conferma
                            │
                            ▼
Node-RED riceve: zigbee2mqtt/SWV_01 {"state":"ON","linkquality":...}
```

State machine: `IDLE → OPENING → OPEN → CLOSING → IDLE`.

**Defaults adottati ✅** (configurabili sotto chiave `valve.*`):

| Parametro | Default | Significato |
|---|---|---|
| `command_timeout_seconds` | 30 | Tempo max per ricevere conferma da zigbee2mqtt |
| `max_retries` | 1 | Numero retry dopo timeout (totale 2 tentativi) |
| `unreachable_alert_after` | 3 | Decisioni consecutive con valvola unreachable prima di alert |

**Comportamento:**
- Su timeout conferma → 1 retry. Se anche il retry fallisce: log error, scrive evento `valve_failure` su `irrigation_events` con `reason="no_confirmation"`, lascia state machine in `IDLE`
- Su `reachable=false` da `valve_state`: skip immediato con `skip_reason="valve_unreachable"`. Dopo 3 fallimenti consecutivi (= 15 min di valvola persa) → log warning per intervento umano
- Conferma con stato inatteso (es. richiesto ON, ricevuto OFF) → log error + retry una volta + se persiste, evento `valve_failure`

### 2.2 Recovery al riavvio Node-RED durante un'irrigazione

Caso reale: container Node-RED riparte (deploy, crash, reboot) mentre la valvola è aperta. Senza recovery esplicito, il sistema dimentica di chiudere → valvola aperta indefinitamente fino al safety timeout della valvola stessa (se ne ha uno) o all'intervento manuale.

**Logica di boot adottata ✅:**

```
on Node-RED start:
  1. subscribe zigbee2mqtt/SWV_01
  2. attendi primo messaggio di stato (max 60s)
  3. query Flux su irrigation_events → ultimo evento (chiuso o aperto)
     query Flux su valve_state → ultimo stato valvola
  4. risolvi scenario (vedi tabella)
```

| Scenario | Stato MQTT | Ultimo evento | Azione |
|---|---|---|---|
| **Normale** | OFF | chiuso o assente | `in_progress=false`, riprendi normale |
| **Recovery in corso** | ON | aperto, durata < safety_timeout | Riprendi monitoring (`opened_at=ts evento`, `in_progress=true`) |
| **Anomalia: valvola ON oltre timeout** | ON | aperto da > safety_timeout | Forza chiusura + chiudi evento con `reason="recovery_timeout"` + log warning |
| **Anomalia: valvola ON senza evento** | ON | nessun evento aperto | Forza chiusura + log warning + scrive evento orfano `trigger="orphan_recovery"` |
| **Anomalia: evento aperto senza valvola ON** | OFF | aperto | Chiudi evento con `reason="recovery_lost"` (perdita di tracking) |

Le anomalie non vengono "normalizzate silenziosamente": tutte vanno a `irrigation_events` per audit.

### 2.3 Quorum sensori e gestione outlier

L'algoritmo usa `media(WH51_01..04)` ma non gestisce:
- Tutti i sensori offline → cosa fare? Skip irrigazione + alert (non aprire alla cieca)
- Solo 1 sensore vivo → quorum insufficiente per decidere?
- Un sensore impazzito (es. legge 0% mentre altri leggono 50%) → outlier va escluso

**Regola adottata ✅:** servono almeno `min_quorum` sensori (default **2**) con dati freschi entro `sensors.max_age_seconds` (default **30 min**) per prendere una decisione. Se non c'è quorum → skip con `skip_reason="no_quorum"`.

Se la deviazione standard tra i sensori validi è > `stddev_warning_pct` (default **25**):
- log warning
- procedi comunque con la decisione
- aggiungi field `sensors_high_variance=true` su `irrigation_events` (per filtraggio dashboard futuro)

La varianza alta è un fatto del campo (es. distribuzione gocciolatori non uniforme), non un errore software. Tutti i parametri configurabili a runtime — vedi §2.7.

### 2.4 Manual override e modalità pausa ✅ DECISA: scope MVP ridotto

Casi d'uso reali:
- "Sono in vacanza, non bagnare per una settimana" → modalità pausa
- "Sto facendo manutenzione" → kill switch totale
- "Ho appena seminato, voglio bagnare ora" → manual trigger UI (rimandato a step 4+)

**MVP step 4 include:**
- `mode`: `auto` | `paused` | `dry_run` (default `dry_run` per le prime 2 settimane)
- `pause_until`: timestamp ISO o null. Se settato e `now() < pause_until` → skip con `skip_reason="paused"`. Quando passa la deadline, `mode` torna automaticamente a `auto`

**Rimandato a step 4+:**
- `force_irrigate` (one-shot): aggiunge complessità (validazione stato valvola, race con tick decisionale) — meglio rimandare. Frattanto si può aprire manualmente pubblicando direttamente su `zigbee2mqtt/SWV_01/set` (irrigazione manuale già tracciata su `irrigation_events` con `trigger=manual`).

Settabili via endpoint config (vedi §2.7) o publish MQTT su `orto/config/set/mode` e `orto/config/set/pause_until`.

### 2.5 Migrazione tag `aiuola=test` → valori reali ✅ DECISA: rimandata

**Decisione:** la migrazione resta posticipata (a prima di step 5, come da `CLAUDE.md`). Step 4 sarà **agnostico al tag aiuola**: la logica decisionale opera direttamente su `sensor_id`, calcolando la media sui sensori validi senza assunzioni sulla loro localizzazione logica.

Conseguenze pratiche per step 4:
- Le query Flux per la media usano `filter((r) => r._measurement == "soil_moisture")` senza filtri sul tag `aiuola`
- Niente segmentazione per aiuola (irrigazione totale comunque, valvola unica)
- La dashboard di analisi varianza tra aiuole arriva in step 5, dopo la migrazione tag

### 2.6 Schema `irrigation_events` esteso ✅ DECISA: tutti i campi approvati

| Field | Tipo | Origine | Note |
|---|---|---|---|
| `state` | string | start/end | esistente |
| `trigger` | tag | `auto` / `manual` / `emergency` / `orphan_recovery` | esteso |
| `duration_seconds` | float | misurato | esistente |
| `avg_moisture_at_trigger` | float | calcolato | esistente |
| `avg_moisture_at_close` | float | calcolato | **nuovo** |
| `delta_moisture` | float | calcolato | **nuovo** (per query veloci) |
| `reason` | string | "scheduled" / "emergency" / "recovery_timeout" / "recovery_lost" | esteso |
| `skip_reason` | string | "rain_delay" / "cooldown" / "no_quorum" / "out_of_window" / "paused" / "valve_unreachable" / null | **nuovo** — logga anche le **non-aperture** |
| `rain_forecast_mm` | float | snapshot meteo | **nuovo** |
| `weather_data_age_seconds` | int | snapshot meteo | **nuovo** |
| `weather_available` | bool | snapshot meteo | **nuovo** |
| `sensor_count` | int | sensori validi al trigger | **nuovo** |
| `sensors_high_variance` | bool | true se stddev > soglia | **nuovo** |
| `total_liters` | float | duration × flow rate | **nuovo** (consumo) |
| `dry_run` | bool | true se mode=dry_run | **nuovo** |

Lo `skip_reason` è cruciale: senza, "perché non ha irrigato ieri sera?" resta senza risposta. Va loggato per ogni tick decisionale che non apre la valvola, anche quando il motivo è banale (`out_of_window`).

### 2.7 Configurabilità dei parametri ✅ DECISA: tutto configurabile a runtime

**Decisione:** **nessun parametro hardcoded.** Ogni soglia, intervallo, finestra deve essere modificabile dal frontend (step 5) senza redeploy. Step 4 deve esporre già da subito gli endpoint per leggere/scrivere la config.

#### Architettura del config store

```
                    ┌────────────────────────────────┐
                    │  config.json (persistente)     │
                    │  /data/irrigation_config.json  │
                    └────────────┬───────────────────┘
                                 │ read at boot
                                 ▼
┌──────────────────────────────────────────────────┐
│  Node-RED global.context.irrigation_config       │
│  (single source of truth a runtime)              │
└──────┬───────────────────────────────────┬───────┘
       │                                   │
   read on every                       write via
   decision tick                       API/MQTT
       │                                   │
       ▼                                   │
  [logica step 4]                          │
                                           │
        ┌──────────────────────────────────┴──────────┐
        │                                             │
   ┌────▼────────┐                       ┌────────────▼──────┐
   │ MQTT topic  │                       │ HTTP POST /config │
   │ orto/config │                       │ (Node-RED endpoint)│
   │ /set/<key>  │                       │                   │
   └─────────────┘                       └───────────────────┘
        ▲                                          ▲
        │                                          │
   CLI / mosquitto_pub               frontend step 5 (PUT JSON)
```

#### Schema config completo (unione dei tre documenti)

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

#### Validazione al set

Ogni write deve validare:
- **Tipo:** numero, stringa orario `"HH:MM"`, lista di 2 stringhe orario
- **Range:** percentuali 0–100, intervalli > 0
- **Vincoli di consistenza:**
  - `soglia_emergenza < soglia_apertura < soglia_chiusura`
  - `emergency_duration < safety_timeout`
  - `finestra_*[0] < finestra_*[1]`
  - `weather.cache_max_age > weather.polling_interval`

Set non validi vengono rifiutati con errore dettagliato. Lo stato precedente non viene modificato.

#### Atomicità delle modifiche

Tutte le modifiche prendono effetto al successivo tick decisionale (max 5 min). Una modifica durante un'irrigazione in corso **non interrompe** l'evento corrente — i nuovi valori si applicano al prossimo trigger.

#### Boot e fallback

- Al boot, Node-RED legge `config.json`. Se mancante o corrotto → carica defaults hardcoded e logga warning
- I defaults sono il fallback di emergenza, **non** il source of truth normale
- Ogni write ha effetto immediato sulla context + persistente sul file

#### Esempio set via MQTT

```bash
# Modifica soglia emergenza a 22%
mosquitto_pub -h 192.168.1.12 -u monitor -P <pwd> \
  -t orto/config/set/irrigation/soglia_emergenza_pct \
  -m '22'

# Risposta su orto/config/result
# → {"ok": true, "key": "irrigation.soglia_emergenza_pct", "value": 22}
```

#### Validazione: backend authoritative

Il **backend Node-RED è autoritativo**: ogni write passa per la validazione server-side e può essere rifiutato. Il frontend (step 5) può fare check pre-flight per UX, ma il rifiuto definitivo è sempre lato server.

```
client → POST /api/config { ... }
         ↓
       Node-RED valida
         ↓
       valido?
         ├─ sì → applica + persisti + risposta {ok:true}
         └─ no → rifiuta + risposta {ok:false, error:"..."}, stato non modificato
```

#### Endpoint HTTP

Endpoint Node-RED custom su porta 1880:
- `GET /api/config` → ritorna il JSON completo della config corrente
- `POST /api/config/<path>` → modifica una chiave (es. `POST /api/config/irrigation/soglia_emergenza_pct` con body `{"value": 22}`)
- `GET /api/state` → stato runtime (valvola, last_irrigation, in_progress, mode)

**No autenticazione in step 4** (rete locale only). In step 5, quando il frontend è esposto, va aggiunta auth (token Bearer o basic auth).

#### Buffer scrittura InfluxDB

Se la scrittura su InfluxDB fallisce durante un tick decisionale:
- La decisione **procede comunque** (l'irrigazione non è bloccata da un DB temporaneamente down)
- Il record viene messo in un buffer `flow.context.influx_pending` (max 100 eventi)
- Al prossimo write riuscito, il buffer viene drainato in ordine FIFO
- Se il buffer satura (>100): scarta i più vecchi e log warning (DB persistentemente unavailable)

### 2.8 Test mode / dry-run ✅ DECISA

Prima di lasciare il sistema autonomo, serve un modo per **simulare la decisione senza aprire la valvola**.

**Comportamento adottato (`mode = "dry_run"`):**

1. La logica decisionale gira normalmente (umidità, orario, cooldown, meteo, quorum, ecc.)
2. Invece di publish su `zigbee2mqtt/SWV_01/set`, publish su **topic mock** `orto/dryrun/valve/set`
3. Scrive comunque su `irrigation_events` con field `dry_run=true`
4. La dashboard di step 5 può subscrivere al topic mock per testare visualizzazioni senza azione fisica

**Default:** `mode=dry_run` per le **prime 2 settimane** dopo deploy. Switch manuale a `auto` dopo verifica del pattern di decisioni nei log.

---

## 3. Roadmap di implementazione

### 3.1 Pre-requisiti bloccanti
- ⚠️ Step 3 completo (zigbee2mqtt + SWV_01 paired) — **unico blocker rimasto**
- ✅ Migrazione tag `aiuola=test` → posticipata, step 4 agnostico
- ✅ Soglia emergenza → 25% default, configurabile, bypass solo orario
- ✅ Comportamento at-end-of-window → finestra governa solo l'apertura
- ✅ Configurabilità → tutti i parametri modificabili a runtime (vedi §2.7)
- ✅ Cooldown → 2h, attivo anche in emergenza
- ✅ Coordinate GPS orto → `45.71722434055733, 9.733793667999565`
- ✅ State machine valvola → timeout 30s, retry 1, alert dopo 3 fallimenti
- ✅ Boot recovery → 5 scenari mappati (vedi §2.2)
- ✅ Dry_run → topic mock + flag InfluxDB, default per prime 2 settimane

### 3.2 Step 4 — MVP minimo deployabile

Ordine consigliato:
1. **Config store** in Node-RED context + persistenza file + endpoint MQTT/HTTP (è il prerequisito, va per primo)
2. **Schema InfluxDB esteso** (`irrigation_events` + `weather_forecast`)
3. **Polling Open-Meteo** + cache + scrittura `weather_forecast` (vedi analisi_integrazione_meteo)
4. **State machine valvola** con conferma zigbee2mqtt + recovery al boot
5. **Algoritmo decisionale** in Node-RED function node (umidità → emergenza → orario → cooldown → meteo → quorum)
6. **Logging completo** (incluso `skip_reason` per non-aperture)
7. **Modalità `dry_run`** attiva di default per le prime 1–2 settimane (settabile via `config.mode`)

### 3.3 Step 4+ — incrementi successivi
- Manual override / pause mode
- Soglia emergenza (se decisa di sì)
- Dashboard Node-RED minimale (start/stop/pause)
- Notifica Telegram / e-mail su anomalia (opzionale)

### 3.4 Demando a step 5/6
- Dashboard Grafana decisioni (con `weather_forecast` sovrapposto)
- Configurabilità via topic MQTT
- Calibrazione adattiva durata in base a `delta_moisture` storico
- Modello evapotraspirazione

---

## 4. Sintesi finale: tutte le decisioni chiuse

**Decisioni di prodotto chiuse:**
- ✅ Soglia emergenza: 25% default, configurabile, bypassa solo orario
- ✅ Migrazione tag `aiuola`: rimandata a pre-step 5, step 4 agnostico
- ✅ Finestra orario: governa solo l'apertura, non interrompe
- ✅ Configurabilità: tutti i parametri modificabili a runtime via MQTT/HTTP, no hardcoded
- ✅ Cooldown: 2h (era 4h), attivo anche in emergenza
- ✅ Modalità pausa (`mode` + `pause_until`) in MVP; `force_irrigate` rimandato a step 4+
- ✅ Coordinate GPS orto: `45.71722434055733, 9.733793667999565`

**Decisioni tecniche chiuse:**
- ✅ Source of truth: hybrid (MQTT subscribe + context + Flux al boot)
- ✅ Schema `irrigation_events` esteso: 15 campi totali approvati
- ✅ State machine valvola: timeout 30s, retry 1, alert dopo 3 fallimenti consecutivi
- ✅ Boot recovery: 5 scenari coperti (incluse anomalie tracciate su `irrigation_events`)
- ✅ Monitoring durante irrigazione: 60s (era 5 min)
- ✅ Endpoint config: Node-RED custom `/api/config`, no auth in step 4 (rete locale)
- ✅ Validazione: backend authoritative
- ✅ Buffer InfluxDB: 100 eventi max in `flow.context` su DB down (FIFO)
- ✅ Dry_run: publish su topic mock `orto/dryrun/valve/set` + flag su InfluxDB
- ✅ Varianza sensori > 25%: log + flag `sensors_high_variance` su evento

**Unico blocker rimasto per partire con step 4:** completamento step 3 (zigbee2mqtt + pairing SWV_01).

L'implementazione può procedere nell'ordine di §3.2 con i default applicati. Il `dry_run` mode iniziale (2 settimane) è il safety net finale per scoprire eventuali buchi non identificati su questa carta.
