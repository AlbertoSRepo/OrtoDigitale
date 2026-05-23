# Step 10 — Tracciamento idrico SWV: polling attivo + field anomalie

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Architettura](#3-architettura)
4. [Precheck — verifica supporto `get` su `flow`](#4-precheck--verifica-supporto-get-su-flow)
5. [Modifiche al flow Node-RED](#5-modifiche-al-flow-node-red)
6. [Modifiche allo schema InfluxDB](#6-modifiche-allo-schema-influxdb)
7. [Aggiornamento `irrigation_config.json`](#7-aggiornamento-irrigation_configjson)
8. [Calcolo dei litri — integrale trapezoidale](#8-calcolo-dei-litri--integrale-trapezoidale)
9. [Impatto batteria SWV](#9-impatto-batteria-swv)
10. [Verifica end-to-end](#10-verifica-end-to-end)
11. [Out of scope](#11-out-of-scope)

> Documenti propedeutici: [`step3_zigbee_swv.md`](./step3_zigbee_swv.md), [`step4_irrigazione_automatica.md`](./step4_irrigazione_automatica.md)

---

## 1. Obiettivo

Migliorare la qualità dei dati idrici registrati alla chiusura della valvola, oggi limitati a `duration_seconds`. Due interventi indipendenti ma complementari:

- **(A) Polling attivo del campo `flow`** del SWV ogni 60 s durante l'apertura, con accumulo numerico per ottenere una stima di **litri erogati** salvata in `irrigation_events.total_liters`.
- **(B) Promozione di `water_shortage` / `water_leakage`** da stringa enum (`current_device_status`) a **field booleani** dedicati su `valve_state`, per abilitare query/alert con un solo predicato Flux.

### Perché serve

- Oggi `irrigation_events.total_liters` è dichiarato nello schema ma vale **sempre 0** (vedi `flows.json` nodo `n-fn-valve-irrigation-event`: legge `global.get('last_flow_m3h')` ma nessun nodo lo scrive). È una field morta: il bug va chiuso, o rimuovendola, o popolandola — qui scegliamo la seconda.
- Il SWV pubblica `flow` (m³/h) solo al check-in (~30 min) o a cambio di stato. Un'irrigazione tipica di 5–15 min può chiudersi **senza aver mai ricevuto un solo aggiornamento di flow**. Senza forcing-read i litri restano inosservabili.
- Le anomalie `water_shortage` (rubinetto a monte chiuso) e `water_leakage` (perdita) sono già rilevate dal SWV ma sepolte in una stringa: un alert Grafana o un check `verify_rpi5.sh` deve fare string match invece di un boolean. Promuoverle a field rende triviali sia gli alert che le aggregazioni.

### Cosa **non** è questo step

- Non è una misura di volume **vera** (per quella serve un flussometro inline tipo YF-S201, o l'Hydro DUO con cumulato nativo — vedi `analysis/02_sonoff_hydro_duo.md`). L'accuracy attesa è ±20–30%, sufficiente come dato fattuale per affinare le soglie (coerente con [[feedback_complessita_proporzionata]]).
- Non aggiunge dashboard nuove: il consumo della nuova field `total_liters` da parte del frontend è demandato a un eventuale follow-up.

---

## 2. Stato di partenza

| Componente | Stato |
|---|---|
| `flows.json` → `n-fn-valve-parse` (tab `f-valve`) | Scrive `valve_state` con `flow` (m³/h) quando il payload SWV lo include; **non** aggiorna `global.last_flow_m3h`. |
| `flows.json` → `n-fn-valve-irrigation-event` | Legge `global.get('last_flow_m3h')` (sempre `undefined`) → `total_liters = 0` sempre. |
| Polling esplicito di `flow` | **Assente.** Nessun `zigbee2mqtt/SWV_valvola/get` viene mai pubblicato. |
| `valve_state` field `current_device_status` | Stringa enum: `normal_state` / `water_shortage` / `water_leakage`. |
| Field booleani anomalie | Assenti. |
| `irrigation_config.json` sezione `flow_tracking` | Non esiste. |

---

## 3. Architettura

```
┌──────────────────────────────────────────────────────────────────────┐
│  tab f-valve (esteso)                                                │
│                                                                      │
│  ┌─────────────────┐   tick 60s                                     │
│  │ inject 60s      ├──────┐                                          │
│  └─────────────────┘      │                                          │
│                           ▼                                          │
│                    ┌──────────────────────┐                          │
│                    │ fn: gate-by-progress │ if global.in_progress    │
│                    │  + flow_tracking.on  │    AND cfg.enabled       │
│                    └──────────┬───────────┘                          │
│                               │ msg.payload={flow:""}                │
│                               ▼                                      │
│                    ┌──────────────────────────────┐                  │
│                    │ mqtt out                     │                  │
│                    │ zigbee2mqtt/SWV_valvola/get  │                  │
│                    └──────────────────────────────┘                  │
│                                                                      │
│  ┌──────────────────────────┐                                        │
│  │ mqtt in                  │                                        │
│  │ zigbee2mqtt/SWV_valvola  │ (esistente)                            │
│  └────────────┬─────────────┘                                        │
│               ├──► n-fn-valve-parse (MOD)                            │
│               │      • estende fields: water_shortage, water_leakage │
│               │      • global.set('last_flow_m3h', p.flow)           │
│               │                                                      │
│               ├──► n-fn-valve-flow-accumulator (NEW)                 │
│               │      • mantiene flow_samples[] nel flow context      │
│               │      • push {ts, flow_m3h} ad ogni payload con flow  │
│               │      • su ON svuota; su OFF integra e scrive         │
│               │        global.last_irrigation_liters                 │
│               │                                                      │
│               └──► n-fn-valve-irrigation-event (MOD)                 │
│                      • legge global.last_irrigation_liters           │
│                        invece del calcolo basato su last_flow_m3h    │
│                      • fallback: 0 se < min_samples_for_volume       │
└──────────────────────────────────────────────────────────────────────┘
```

### Decisioni architetturali

- **Polling 60 s**: bilancia accuratezza (più campioni → integrale più stabile) e batteria. A 60 s, un'apertura di 10 min produce 10 campioni → integrale trapezoidale con incertezza < 10% sulla portata vera.
- **L'accumulator vive in un nodo function separato** (`n-fn-valve-flow-accumulator`) e non dentro `n-fn-valve-irrigation-event`. Motivo: il primo si triggera su **ogni** payload SWV (anche di solo flow), il secondo solo su transizioni `state`. Tenerli separati evita race condition tra "arriva il payload OFF" e "arriva l'ultimo flow update".
- **`global.last_irrigation_liters` come canale di passaggio**: l'accumulator chiude i conti e l'event tracker legge il risultato. Una volta scritto su Influx, viene azzerato.
- **Gate `flow_tracking.enabled`** in config: permette di disattivare il polling se la batteria SWV degrada o se si decide di migrare all'Hydro DUO.

---

## 4. Precheck — verifica supporto `get` su `flow`

Prima di toccare il flow, verificare manualmente che il SWV risponda al read on-demand.

Da `as@192.168.1.12`:

```bash
# 1) Sub al topic per vedere le risposte
mosquitto_sub -h localhost -u monitor -P "$MQTT_PASS_MONITOR" \
  -t 'zigbee2mqtt/SWV_valvola' -v &

# 2) Trigger read on-demand
mosquitto_pub -h localhost -u monitor -P "$MQTT_PASS_MONITOR" \
  -t 'zigbee2mqtt/SWV_valvola/get' -m '{"flow":""}'
```

**Atteso:** entro pochi secondi un payload contenente almeno `"flow": <numero>`. Se il SWV non risponde:
- È un EndDevice a batteria → potrebbe rispondere solo al prossimo poll-cycle interno (default ~250 ms con `genPollCtrl` bindato, vedi `step3_zigbee_swv.md` §6). Attendere 30 s.
- Se nemmeno dopo 30 s arriva risposta: il cluster `msFlowMeasurement` non supporta `read` on-demand su questo firmware (1.0.3, build 20240705) → fallback documentato in §11.

> ⚠️ **Bloccante.** Se il precheck fallisce, lo step si riduce alla sola parte (B) — promozione delle anomalie — e la parte (A) viene sostituita da un commento "field rimossa" nel codice.

---

## 5. Modifiche al flow Node-RED

### 5.1 Nodo `n-fn-valve-parse` (modifica — tab `f-valve`)

Aggiungere estrazione booleani e popolare `last_flow_m3h`:

```js
// ... dentro la funzione esistente, dopo: if (Number.isFinite(p.flow)) fields.flow = Number(p.flow);
if (Number.isFinite(p.flow)) {
    fields.flow = Number(p.flow);
    global.set('last_flow_m3h', Number(p.flow));
}
if (p.current_device_status) {
    fields.current_device_status = String(p.current_device_status);
    fields.water_shortage = p.current_device_status === 'water_shortage';
    fields.water_leakage = p.current_device_status === 'water_leakage';
}
```

### 5.2 Nuovo nodo `n-inject-flow-poll-tick` (inject — tab `f-valve`)

| Proprietà | Valore |
|---|---|
| Repeat | `interval` ogni 60 s |
| Topic | `flow-poll-tick` |
| Payload | (vuoto) |
| Once | false |

Wired → `n-fn-flow-poll-gate`.

### 5.3 Nuovo nodo `n-fn-flow-poll-gate` (function — tab `f-valve`)

```js
const cfg = global.get('irrigation_config') || {};
const ft = (cfg.flow_tracking) || {};
if (ft.enabled === false) return null;          // gate config
if (!global.get('in_progress')) return null;    // solo durante apertura

return {
    topic: 'zigbee2mqtt/SWV_valvola/get',
    payload: { flow: '' }
};
```

Wired → `n-mqtt-out-valve-set` (riusa il nodo MQTT esistente: stesso broker, topic differente).

> ⚠️ Verificare che il nodo `n-mqtt-out-valve-set` non abbia topic hard-codato. Se sì, creare un nodo MQTT out dedicato `n-mqtt-out-valve-get`.

### 5.4 Nuovo nodo `n-fn-valve-flow-accumulator` (function — tab `f-valve`)

Wired in **parallelo** a `n-fn-valve-parse` e `n-fn-valve-irrigation-event`, in uscita dal subscriber `zigbee2mqtt/SWV_valvola`.

```js
const cfg = global.get('irrigation_config') || {};
const ft = (cfg.flow_tracking) || {};
const min_samples = ft.min_samples_for_volume || 2;

const p = msg.payload;
if (!p || typeof p !== 'object') return null;

const now = Date.now();
let samples = context.get('flow_samples') || [];

// Reset su transizione ON.
if (p.state === 'ON') {
    context.set('flow_samples', []);
    return null;
}

// Push campione su payload con flow finito.
if (Number.isFinite(p.flow)) {
    samples.push({ ts: now, flow_m3h: Number(p.flow) });
    context.set('flow_samples', samples);
}

// Su OFF: integra trapezoidale e pubblica risultato.
if (p.state === 'OFF') {
    if (samples.length < min_samples) {
        global.set('last_irrigation_liters', null);
        context.set('flow_samples', []);
        return null;
    }
    // Integrale trapezoidale: sum( (f_i + f_{i+1})/2 * dt_i )
    // f in m³/h, dt in s → litri = (m³/h * 1000) * (s/3600)
    let liters = 0;
    for (let i = 1; i < samples.length; i++) {
        const dt_h = (samples[i].ts - samples[i-1].ts) / 3600000;
        const f_avg = (samples[i].flow_m3h + samples[i-1].flow_m3h) / 2;
        liters += f_avg * 1000 * dt_h;
    }
    global.set('last_irrigation_liters', Number(liters.toFixed(2)));
    global.set('last_irrigation_samples', samples.length);
    context.set('flow_samples', []);
}

return null;
```

### 5.5 Nodo `n-fn-valve-irrigation-event` (modifica — tab `f-valve`)

Sostituire il blocco `// total_liters: ...` con:

```js
const measured = global.get('last_irrigation_liters');
const sample_count = global.get('last_irrigation_samples') || 0;
const total_liters = (measured !== null && measured !== undefined) ? measured : 0;
const liters_method = (measured !== null && measured !== undefined) ? 'integrated' : 'unavailable';
// reset
global.set('last_irrigation_liters', null);
global.set('last_irrigation_samples', null);
```

Aggiungere ai field emessi: `total_liters`, `liters_sample_count: sample_count`, `liters_method`.

---

## 6. Modifiche allo schema InfluxDB

Nessuna migration: InfluxDB 2 accetta field nuovi al volo. Documentare in `CLAUDE.md` (sezione "Schema dati"):

### `valve_state` — field aggiunti

| Field | Tipo | Significato |
|---|---|---|
| `water_shortage` | bool | `true` se `current_device_status == "water_shortage"` |
| `water_leakage` | bool | `true` se `current_device_status == "water_leakage"` |

### `irrigation_events` — field modificati / aggiunti

| Field | Tipo | Significato |
|---|---|---|
| `total_liters` | float | Litri stimati per integrazione trapezoidale di `flow` (0 se < `min_samples_for_volume`) |
| `liters_sample_count` | int | Numero di campioni di flow accumulati durante l'apertura |
| `liters_method` | string | `"integrated"` se misurato, `"unavailable"` se sotto soglia campioni |

### Query Flux esempio (litri ultima settimana per trigger)

```flux
from(bucket:"garden")
  |> range(start: -7d)
  |> filter(fn:(r) => r._measurement == "irrigation_events" and r._field == "total_liters")
  |> filter(fn:(r) => r.trigger == "auto" or r.trigger == "manual")
  |> group(columns:["trigger"])
  |> sum()
```

### Query Flux esempio (alert leak)

```flux
from(bucket:"garden")
  |> range(start: -1h)
  |> filter(fn:(r) => r._measurement == "valve_state" and r._field == "water_leakage" and r._value == true)
  |> last()
```

---

## 7. Aggiornamento `irrigation_config.json`

Aggiungere sezione `flow_tracking`:

```json
{
  "irrigation": { /* invariato */ },
  "weather": { /* invariato */ },
  "valve": { /* invariato */ },
  "sensors": { /* invariato */ },
  "flow_tracking": {
    "enabled": true,
    "poll_interval_seconds": 60,
    "min_samples_for_volume": 2
  },
  "mode": "dry_run",
  "pause_until": null
}
```

> Il `poll_interval_seconds` qui è **documentale**: il valore effettivo è codificato nell'inject node `n-inject-flow-poll-tick`. Se si vuole il valore davvero config-driven serve un secondo step (sostituire inject con timer dinamico) — fuori scope.

---

## 8. Calcolo dei litri — integrale trapezoidale

Dato un set di campioni `(t_i, f_i)` con `f` in m³/h e `t` in ms:

```
litri = Σ (f_i + f_{i+1})/2 * 1000 * (t_{i+1} - t_i) / 3600000
```

### Edge case

| Caso | Comportamento |
|---|---|
| Apertura < 60 s | 0 o 1 campione → `total_liters = 0`, `liters_method = "unavailable"` |
| SWV unreachable durante l'apertura | I sample non vengono raccolti → fallback `unavailable` |
| Flow oscilla ma campioni costanti | Integrale trapezoidale = step rettangolare → sottostima/sovrastima locale, ma errore medio piccolo su 10+ campioni |
| Apertura termina su safety timeout (forced OFF) | Stesso flusso del OFF normale: ultimo campione raccolto poco prima del forced OFF |

### Stima accuratezza

Su un'apertura di 10 min con portata costante 1 m³/h (= 16,67 L/min):
- Volume teorico: 166,7 L
- Campioni a 60 s: 10
- Errore atteso dell'integrale trapezoidale a portata costante: < 1%
- Errore dominante: ritardo di risposta del SWV al `get` (~250 ms–2 s) → trascurabile rispetto a dt=60 s

L'incertezza vera è dominata dall'**accuratezza del flussimetro interno al SWV** (non dichiarata da SONOFF per il modello singolo): stima conservativa ±20–30%.

---

## 9. Impatto batteria SWV

Il SWV è un EndDevice 4× AA con autonomia dichiarata ~4 mesi. Durante l'apertura:

| Modalità attuale | Modalità step 10 |
|---|---|
| Wake-up su check-in (~30 min) | Wake-up su `get` ogni 60 s |
| ~ 2 wake-up / ora attiva | ~ 60 wake-up / ora attiva |

**Stima impatto:** un orto in finestra estiva fa ~2 aperture/giorno × ~10 min = 20 wake-up extra/giorno (20 messaggi). Su un mese: ~600 wake-up extra. È un ordine di grandezza inferiore al traffico Zigbee passivo (poll-cycle continuo). **Impatto atteso: < 5% sull'autonomia.**

Mitigazione se osserviamo degrado >10%:
- Aumentare `poll_interval_seconds` a 90 o 120
- Disattivare `flow_tracking.enabled` e riservare il polling alle aperture manuali (richiede ulteriore gate)

---

## 10. Verifica end-to-end

### Pre-deploy

```bash
# Su PC Windows
git checkout -b step/10-flow-tracking-swv
# (modifiche a flows.json + irrigation_config.json)
```

### Deploy

Usare la skill `nodered-deploy` per:
1. `scp` di `flows.json` e `irrigation_config.json` su `as@192.168.1.12:/opt/orto-digitale/nodered/data/`
2. Restart container `nodered`
3. Re-iniezione credenziali Node-RED via API REST (footgun §3 di CLAUDE.md)

### Verifica funzionale

```bash
# Sub a tutto il traffico SWV
mosquitto_sub -h 192.168.1.12 -u monitor -P "$MQTT_PASS_MONITOR" \
  -t 'zigbee2mqtt/SWV_valvola' -v

# In un altro terminale: apri valvola per 3 minuti
curl -X POST http://192.168.1.12:1880/api/valve/on \
  -H 'Content-Type: application/json' \
  -d '{"duration_seconds": 180}'
```

**Atteso:**
- Entro 60 s dall'apertura: arriva il primo payload con `"flow": <numero>` (in risposta al `get`)
- A 120 s: secondo payload
- A 180 s: payload `state: OFF` (safety/manual timer)
- Su Influx, query `irrigation_events` ultima riga:
  - `total_liters > 0`
  - `liters_sample_count >= 2`
  - `liters_method == "integrated"`

### Healthcheck

Estendere `verify_rpi5.sh` con un check #11 (opzionale, basso priority):

```bash
# Check 11: ultima irrigazione ha total_liters > 0?
last_liters=$(influx query "from(bucket:\"garden\") \
  |> range(start: -7d) \
  |> filter(fn:(r) => r._measurement == \"irrigation_events\" and r._field == \"total_liters\") \
  |> last()" --raw | tail -1 | awk -F',' '{print $6}')
[[ "$last_liters" != "0" ]] && echo "PASS: total_liters tracking attivo ($last_liters L)"
```

### Test anomalia (parte B)

```bash
# Forzare water_shortage chiudendo il rubinetto a monte, poi aprire valvola
# Atteso: in valve_state arriva water_shortage=true
influx query "from(bucket:\"garden\") \
  |> range(start: -10m) \
  |> filter(fn:(r) => r._measurement == \"valve_state\" and r._field == \"water_shortage\")"
```

---

## 11. Out of scope

- **Frontend**: nessuna modifica alla PWA. La visualizzazione di `total_liters` su `Waterflow.tsx` o un nuovo widget è un follow-up separato.
- **Migrazione Hydro DUO**: vedi `analysis/02_sonoff_hydro_duo.md`. Quando adottato, la parte (A) di questo step diventa ridondante (il DUO espone cumulato nativo).
- **Flussometro inline esterno** (YF-S201 + ESP32): alternativa hardware più accurata, non in scope.
- **Alert Grafana** su `water_leakage`: la field viene esposta qui, ma la configurazione del canale di notifica è demandata a uno step "alerting" separato.
- **Calibrazione del flussimetro SWV** rispetto a un riferimento esterno (secchio cronometrato): utile prima di considerare `total_liters` come metrica decisionale, ma fuori da questo step.

### Fallback se il precheck §4 fallisce

Se il SWV non risponde a `get {flow:""}`:
- Skippare nodi 5.2, 5.3, 5.4
- Skippare modifica a 5.5 (lasciare `total_liters = 0`)
- Rimuovere la field `total_liters` dallo schema documentato in `CLAUDE.md` (era già morta de facto)
- Procedere solo con parte (B): modifica 5.1 limitata a `water_shortage` / `water_leakage`
- Lo step si chiude come "COMPLETATO parzialmente — sola parte (B); flussimetria rimandata a Hydro DUO"
