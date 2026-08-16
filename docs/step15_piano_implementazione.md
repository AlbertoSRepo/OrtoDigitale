# Step 15 — Piano di implementazione

> **Per chi esegue:** SKILL RICHIESTA — usare `superpowers:subagent-driven-development`
> (consigliata) oppure `superpowers:executing-plans` per eseguire questo piano task
> per task. I passi usano caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** esporre in app la previsione della prossima irrigazione, con fascia di
incertezza e regola limitante, simulando in avanti la catena di regole del decision
loop su un orizzonte di 72 h.

**Architettura:** tutto dentro Node-RED. La catena di regole viene estratta in un
function node che la registra in `global.orto_rules`, letta sia da `decision logic`
sia dal nuovo simulatore. L'asciugatura è stimata come `k · ET0` dalla previsione
oraria Open-Meteo, con fallback a media mobile. Frontend: una card su Waterflow che
legge un endpoint che risponde da context.

**Stack:** Node-RED 4 (function node, JavaScript), InfluxDB 2 (Flux), React 18 +
TypeScript + React Query, test con script `.mjs` su `node` nudo.

**Spec:** [`docs/step15_previsione_prossima_irrigazione.md`](./step15_previsione_prossima_irrigazione.md)

---

## Vincoli globali

Valori copiati dalla spec e dal `CLAUDE.md`. Valgono per **ogni** task.

- **Branch:** `step/15-previsione`. `main` deve restare deployabile in ogni momento.
- **`flows.json` è la sorgente di verità** del codice Node-RED. Nessuna copia del
  codice altrove: i test leggono i corpi delle funzioni **da** `flows.json`.
- **Mai duplicare la catena di regole.** Chi ha bisogno di decidere legge
  `global.orto_rules`. Se è assente: warn e nessuna decisione. Mai un fallback che
  reimplementi le regole in proprio.
- **Ogni modifica a `flows.json` richiede la ri-iniezione delle credenziali
  Node-RED** dopo il deploy — procedura in `docs/comandi_verifica.md §5.5`.
- **Non committare mai** `rpi5/.env`, `flows_cred.json`, `rpi5/nodered/data/context/`.
- **`rpi5/nodered/data/node_modules/` è in `.gitignore`**: non metterci nulla che
  debba sopravvivere.
- **Commit in italiano**, formato Conventional Commits, scope fra `nodered`,
  `influxdb`, `docs`, `scripts`. Esempio: `feat(nodered): simulatore previsione`.
- **Naming:** snake_case italiano per variabili Node-RED e measurement InfluxDB.
- **Su InfluxDB si scrivono solo aggregati meteo**, mai la curva oraria (spec D5).
- **Nomi dei parametri di config esatti:** `forecast.enabled`, `horizon_hours`,
  `step_minutes`, `recompute_interval_seconds`, `stats_refresh_interval_seconds`,
  `stats_window_days`, `k_pct_per_mm`, `k_pct_per_mm_p10`, `k_pct_per_mm_p90`,
  `rain_gain_pct_per_mm`, `fallback_drying_rate_pct_h`.
- **Deploy:** `scp` verso `as@192.168.1.12` (fallback WiFi `as@192.168.1.46`),
  root progetto `/opt/orto-digitale/`.

### Come si esegue un test di questo piano

```bash
node rpi5/nodered/test/<nome>.test.mjs
```

Esce con codice 0 se tutto passa, 1 altrimenti. Non esiste `npm test` per Node-RED:
gli script sono autonomi e non hanno dipendenze.

### Il banco di prova (pattern esistente, da riusare)

Ogni test compila il corpo di un function node letto da `flows.json`:

```js
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nodo = flows.find((n) => n.id === '<id>');
const run = new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
```

e lo esegue contro un banco che simula `global`, `node`, `env`, `fs`. Vedi
`rpi5/nodered/test/registro_sensori.test.mjs` per l'esemplare di riferimento.

---

## Struttura dei file

| File | Responsabilità |
|---|---|
| `rpi5/nodered/data/flows.json` | tutto il codice runtime: libreria regole, simulatore, job statistiche, API, meteo |
| `rpi5/nodered/data/irrigation_config.json` | sezione `forecast` con i parametri del modello |
| `rpi5/nodered/test/meteo_parsing.test.mjs` | indicizzazione oraria e curve in cache |
| `rpi5/nodered/test/regole_irrigazione.test.mjs` | fotografia del decision loop + regole pure |
| `rpi5/nodered/test/previsione.test.mjs` | proiezione, simulazione, confidenza, contratto API |
| `analysis/stima_k.mjs` | script una-tantum: stima `k` e tabella degli errori |
| `analysis/03_stima_asciugatura.md` | esito del fitting, con i numeri |
| `rpi5/frontend/src/api/forecast.ts` | hook React Query |
| `rpi5/frontend/src/api/types.ts` | tipi della risposta |
| `rpi5/frontend/src/components/NextIrrigationCard.tsx` | la card |
| `rpi5/frontend/src/pages/Waterflow.tsx` | inserimento della card |
| `rpi5/frontend/src/helpers/formatDuration.ts` | `fmtFraQuanto`: distanza verso il **futuro** |
| `rpi5/frontend/src/helpers/formatDuration.test.ts` | test dell'helper |

---

## Task 0: Branch

- [ ] **Passo 1: creare il branch**

```bash
cd rpi5/../  # radice del repo (dev/)
git checkout main
git pull
git checkout -b step/15-previsione
```

---

## Task 1: Correggere l'indicizzazione oraria del meteo ed esporre le curve

Corregge un bug attivo in produzione (spec §2) e produce il dato che serve al
simulatore. È il prerequisito di tutto il resto.

**File:**
- Modifica: `rpi5/nodered/data/flows.json` — nodi `nw-fn-scheduler`, `nw-fn-parse-cache`
- Crea: `rpi5/nodered/test/meteo_parsing.test.mjs`

**Interfacce:**
- Produce: `global.weather_cache` con i campi già esistenti
  (`precip_next_24h_mm`, `precip_next_6h_mm`, `temp_max_next_12h_c`,
  `humidity_now_pct`, `api_latency_ms`, `fetched_at`) **più** `hourly`:
  `{ time: number[] (epoch secondi), precipitation: number[] (mm/h), et0: number[] (mm/h) }`.
  Consumato dai Task 4 e 5.

- [ ] **Passo 1: scrivere il test che fallisce**

Crea `rpi5/nodered/test/meteo_parsing.test.mjs`:

```js
// Banco di prova del parsing meteo (step 15, Task 1).
//
//   node rpi5/nodered/test/meteo_parsing.test.mjs
//
// Il corpo della funzione viene letto DA flows.json, non da una copia.
// Verifica che gli aggregati partano dall'ora corrente e non dalla posizione 0
// dell'array, che in Open-Meteo e' mezzanotte del giorno in corso.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(id) {
  const nodo = flows.find((n) => n.id === id);
  assert.ok(nodo, `nodo ${id} non trovato in flows.json`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
}

const parse = compila('nw-fn-parse-cache');
const scheduler = compila('nw-fn-scheduler');

function banco() {
  const store = {};
  const warns = [];
  return {
    store, warns,
    node: { warn: (m) => warns.push(m), log: () => {}, status: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

// Payload sintetico: 96 ore che partono 12 ore PRIMA di adesso, allineate all'ora.
// Le posizioni 0..11 sono passato, la 12 contiene l'istante corrente.
function payload() {
  const oraCorrente = Math.floor(Date.now() / 3600000) * 3600;
  const t0 = oraCorrente - 12 * 3600;
  const time = Array.from({ length: 96 }, (_, i) => t0 + i * 3600);
  const precipitation = new Array(96).fill(0);
  precipitation[0] = 10;   // gia' caduta stamattina: NON deve contare
  precipitation[20] = 3;   // fra 8 ore: deve contare
  precipitation[40] = 7;   // fra 28 ore: fuori dalla finestra 24h
  const temperature_2m = new Array(96).fill(15);
  temperature_2m[5] = 40;  // picco nel passato: NON deve contare
  temperature_2m[15] = 28; // picco futuro entro 12h: deve contare
  const relative_humidity_2m = new Array(96).fill(50);
  relative_humidity_2m[0] = 99;   // mezzanotte
  relative_humidity_2m[12] = 42;  // adesso
  const et0_fao_evapotranspiration = new Array(96).fill(0.1);
  return { hourly: { time, precipitation, temperature_2m, relative_humidity_2m, et0_fao_evapotranspiration } };
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

await t('la pioggia gia caduta oggi non entra in precip_next_24h_mm', async () => {
  const h = banco();
  await parse({ payload: payload(), statusCode: 200, _t0: Date.now() }, h.node, h.global, h.env, h.fs);
  const wc = h.store.weather_cache;
  assert.ok(wc, 'weather_cache non scritta');
  assert.equal(wc.precip_next_24h_mm, 3, 'deve contare solo i 3mm futuri entro 24h');
});

await t('humidity_now_pct e l ora corrente, non mezzanotte', async () => {
  const h = banco();
  await parse({ payload: payload(), statusCode: 200, _t0: Date.now() }, h.node, h.global, h.env, h.fs);
  assert.equal(h.store.weather_cache.humidity_now_pct, 42);
});

await t('temp_max_next_12h_c ignora il picco passato', async () => {
  const h = banco();
  await parse({ payload: payload(), statusCode: 200, _t0: Date.now() }, h.node, h.global, h.env, h.fs);
  assert.equal(h.store.weather_cache.temp_max_next_12h_c, 28);
});

await t('la curva oraria finisce in cache per il simulatore', async () => {
  const h = banco();
  await parse({ payload: payload(), statusCode: 200, _t0: Date.now() }, h.node, h.global, h.env, h.fs);
  const hourly = h.store.weather_cache.hourly;
  assert.ok(hourly, 'manca weather_cache.hourly');
  assert.equal(hourly.time.length, 96);
  assert.equal(hourly.precipitation.length, 96);
  assert.equal(hourly.et0.length, 96);
});

await t('il point InfluxDB contiene solo aggregati, mai la curva', async () => {
  const h = banco();
  const out = await parse({ payload: payload(), statusCode: 200, _t0: Date.now() }, h.node, h.global, h.env, h.fs);
  assert.equal(out.measurement, 'weather_forecast');
  assert.equal(out.payload[0].hourly, undefined, 'la curva non deve finire su InfluxDB');
  assert.equal(out.payload[0].time, undefined);
});

await t('risposta non valida non svuota la cache esistente', async () => {
  const h = banco();
  h.store.weather_cache = { precip_next_24h_mm: 1, fetched_at: 123 };
  const out = await parse({ payload: null, statusCode: 500 }, h.node, h.global, h.env, h.fs);
  assert.equal(out, null);
  assert.equal(h.store.weather_cache.precip_next_24h_mm, 1, 'cache preesistente persa');
});

await t('l URL chiede et0, 4 giorni e unixtime', async () => {
  const h = banco();
  h.store.irrigation_config = {
    weather: { polling_interval_seconds: 1800, api_url: 'https://api.open-meteo.com/v1/forecast', lat: 45.7, lon: 9.7 },
  };
  const msg = await scheduler({}, h.node, h.global, h.env, h.fs);
  assert.ok(msg && msg.url, 'lo scheduler non ha prodotto un URL');
  assert.ok(msg.url.includes('et0_fao_evapotranspiration'), 'manca et0');
  assert.ok(msg.url.includes('forecast_days=4'), 'servono 4 giorni per la finestra pioggia a +72h');
  assert.ok(msg.url.includes('timeformat=unixtime'), 'manca timeformat=unixtime');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

```bash
node rpi5/nodered/test/meteo_parsing.test.mjs
```

Atteso: FALLISCE. I primi tre casi falliscono perché il codice attuale indicizza da
0; `la curva oraria finisce in cache` fallisce perché `hourly` non esiste;
`l URL chiede et0` fallisce perché l'URL attuale ha `forecast_days=2` e non chiede
ET0.

- [ ] **Passo 3: aggiornare l'URL nello scheduler**

In `flows.json`, nodo `nw-fn-scheduler`, sostituire la riga che costruisce `url`:

```js
const url = `${cfg.weather.api_url}?latitude=${lat}&longitude=${lon}` +
    `&hourly=precipitation,temperature_2m,relative_humidity_2m,et0_fao_evapotranspiration` +
    `&forecast_days=4&timeformat=unixtime&timezone=Europe%2FRome`;
```

Il resto del nodo non si tocca.

- [ ] **Passo 4: riscrivere il parsing**

In `flows.json`, nodo `nw-fn-parse-cache`, sostituire il corpo con:

```js
// Parse risposta Open-Meteo, calcola scalari, aggiorna cache, prepara point.
// Gli array orari partono da mezzanotte del giorno corrente: si indicizza a
// partire dall'ora che contiene "adesso", non dalla posizione 0.
const body = msg.payload;
const t0 = msg._t0 || Date.now();
const latency_ms = Date.now() - t0;

if (msg.statusCode !== 200 || !body || !body.hourly) {
    node.warn(`Open-Meteo fail: status=${msg.statusCode}`);
    node.status({ fill: 'red', shape: 'ring', text: `fail ${msg.statusCode || '-'}` });
    return null;
}

const h = body.hourly;
const arr = (v) => (Array.isArray(v) ? v : []);
const time = arr(h.time);
const precip = arr(h.precipitation);
const temp = arr(h.temperature_2m);
const hum = arr(h.relative_humidity_2m);
const et0 = arr(h.et0_fao_evapotranspiration);

const now_s = Math.floor(Date.now() / 1000);
const i0 = time.findIndex((t) => t <= now_s && now_s < t + 3600);
if (i0 < 0) {
    node.warn('Open-Meteo: nessuna ora contiene l istante corrente, cache non aggiornata');
    node.status({ fill: 'red', shape: 'ring', text: 'indice orario non trovato' });
    return null;
}

const sumFrom = (a, from, n) => a.slice(from, from + n).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
const maxFrom = (a, from, n) => {
    const s = a.slice(from, from + n).filter(Number.isFinite);
    return s.length ? Math.max(...s) : 0;
};

const data = {
    precip_next_24h_mm: Number(sumFrom(precip, i0, 24).toFixed(2)),
    precip_next_6h_mm: Number(sumFrom(precip, i0, 6).toFixed(2)),
    temp_max_next_12h_c: Number(maxFrom(temp, i0, 12).toFixed(1)),
    humidity_now_pct: Number((Number.isFinite(hum[i0]) ? hum[i0] : 0).toFixed(1)),
    api_latency_ms: latency_ms,
    fetched_at: Date.now(),
    // Curva oraria per il simulatore (spec D5): vive solo in memoria.
    hourly: { time, precipitation: precip, et0 }
};

global.set('weather_cache', data);
node.status({ fill: 'green', shape: 'dot', text: `rain24h=${data.precip_next_24h_mm}mm @ ${new Date().toISOString().substr(11, 5)}` });

return {
    payload: [
        {
            precip_next_24h_mm: data.precip_next_24h_mm,
            precip_next_6h_mm: data.precip_next_6h_mm,
            temp_max_next_12h_c: data.temp_max_next_12h_c,
            humidity_now_pct: data.humidity_now_pct,
            api_latency_ms: data.api_latency_ms
        },
        { source: 'openmeteo', location: 'orto' }
    ],
    measurement: 'weather_forecast'
};
```

- [ ] **Passo 5: eseguire il test e verificare che passi**

```bash
node rpi5/nodered/test/meteo_parsing.test.mjs
```

Atteso: `7 passati, 0 falliti`.

- [ ] **Passo 6: commit**

```bash
git add rpi5/nodered/data/flows.json rpi5/nodered/test/meteo_parsing.test.mjs
git commit -m "fix(nodered): il meteo indicizzava da mezzanotte invece che dall ora corrente

Gli array orari di Open-Meteo partono da 00:00 del giorno in corso nel fuso
richiesto. Il parsing usava slice(0,24) e hum[0], quindi precip_next_24h_mm
era la pioggia gia caduta oggi, humidity_now_pct l umidita di mezzanotte e
temp_max_next_12h_c la massima del solo mattino. La regola rain_delay del
decision loop decideva percio sulla pioggia passata.

Si indicizza ora dall ora che contiene l istante corrente, trovata su
hourly.time. La query passa a forecast_days=4 e timeformat=unixtime, e la
curva oraria di precipitazione ed ET0 resta in cache per il simulatore
(step 15). Su InfluxDB continuano ad andare solo gli aggregati."
```

---

## Task 2: Sezione `forecast` nella configurazione

**File:**
- Modifica: `rpi5/nodered/data/irrigation_config.json`
- Modifica: `rpi5/nodered/data/flows.json` — nodi `nc-fn-validate-http` e `nc-fn-validate-mqtt`

**Interfacce:**
- Produce: `cfg.forecast` con i campi elencati nei vincoli globali. Consumato dai
  Task 4, 5, 6.

> **Attenzione:** i due nodi di validazione contengono **ciascuno la propria copia**
> della mappa `PATHS`. Vanno aggiornati entrambi, altrimenti il canale MQTT rifiuta
> parametri che l'HTTP accetta.

- [ ] **Passo 1: scrivere il test che fallisce**

Aggiungi in coda a `rpi5/nodered/test/meteo_parsing.test.mjs`… **no**: crea un file
dedicato `rpi5/nodered/test/config_forecast.test.mjs`:

```js
// Banco di prova della sezione forecast del config store (step 15, Task 2).
//
//   node rpi5/nodered/test/config_forecast.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const CFG = JSON.parse(readFileSync(QUI + '../data/irrigation_config.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compila(id) {
  const nodo = flows.find((n) => n.id === id);
  assert.ok(nodo, `nodo ${id} non trovato`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', nodo.func);
}
const validaHttp = compila('nc-fn-validate-http');
const validaMqtt = compila('nc-fn-validate-mqtt');

function banco(cfg) {
  const store = { irrigation_config: JSON.parse(JSON.stringify(cfg)) };
  return {
    store,
    node: { warn: () => {}, log: () => {}, status: () => {}, error: () => {} },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

const setHttp = async (h, dotPath, value) => {
  const [msg] = await validaHttp(
    { req: { params: { 0: dotPath } }, payload: { value } },
    h.node, h.global, h.env, h.fs,
  );
  return msg;
};

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

await t('il file di config ha la sezione forecast completa', async () => {
  assert.ok(CFG.forecast, 'sezione forecast assente');
  for (const k of ['enabled', 'horizon_hours', 'step_minutes', 'recompute_interval_seconds',
    'stats_refresh_interval_seconds', 'stats_window_days', 'k_pct_per_mm',
    'k_pct_per_mm_p10', 'k_pct_per_mm_p90', 'rain_gain_pct_per_mm',
    'fallback_drying_rate_pct_h']) {
    assert.ok(k in CFG.forecast, `manca forecast.${k}`);
  }
  assert.equal(CFG.forecast.k_pct_per_mm, null, 'k deve partire null finche non e stimato');
});

await t('si puo impostare forecast.horizon_hours via HTTP', async () => {
  const h = banco(CFG);
  const msg = await setHttp(h, 'forecast.horizon_hours', 48);
  assert.equal(msg.statusCode, 200);
  assert.equal(h.store.irrigation_config.forecast.horizon_hours, 48);
});

await t('un orizzonte fuori scala viene rifiutato', async () => {
  const h = banco(CFG);
  const msg = await setHttp(h, 'forecast.horizon_hours', 500);
  assert.equal(msg.statusCode, 400);
});

await t('k puo essere rimesso a null', async () => {
  const h = banco(CFG);
  const msg = await setHttp(h, 'forecast.k_pct_per_mm', null);
  assert.equal(msg.statusCode, 200);
  assert.equal(h.store.irrigation_config.forecast.k_pct_per_mm, null);
});

await t('lo stesso path e accettato anche via MQTT', async () => {
  const h = banco(CFG);
  const out = await validaMqtt(
    { topic: 'orto/config/set/forecast/step_minutes', payload: '30' },
    h.node, h.global, h.env, h.fs,
  );
  const res = Array.isArray(out) ? out[0] : out;
  assert.equal(res.payload.ok, true, `MQTT ha rifiutato: ${JSON.stringify(res.payload)}`);
  assert.equal(h.store.irrigation_config.forecast.step_minutes, 30);
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

```bash
node rpi5/nodered/test/config_forecast.test.mjs
```

Atteso: FALLISCE, `sezione forecast assente`.

- [ ] **Passo 3: aggiungere la sezione al file di configurazione**

In `rpi5/nodered/data/irrigation_config.json`, inserire fra la sezione
`flow_tracking` e la chiave `mode`:

```json
  "forecast": {
    "enabled": true,
    "horizon_hours": 72,
    "step_minutes": 15,
    "recompute_interval_seconds": 300,
    "stats_refresh_interval_seconds": 3600,
    "stats_window_days": 7,
    "k_pct_per_mm": null,
    "k_pct_per_mm_p10": null,
    "k_pct_per_mm_p90": null,
    "rain_gain_pct_per_mm": 1.2,
    "fallback_drying_rate_pct_h": 0.5
  },
```

- [ ] **Passo 4: aggiungere i path validati in entrambi i nodi**

Dentro l'oggetto `PATHS`, sia in `nc-fn-validate-http` sia in `nc-fn-validate-mqtt`,
aggiungere dopo le voci `weather.*`:

```js
        'forecast.enabled': v => typeof v === 'boolean',
        'forecast.horizon_hours': v => Number.isInteger(v) && v >= 6 && v <= 96,
        'forecast.step_minutes': v => Number.isInteger(v) && v >= 5 && v <= 60,
        'forecast.recompute_interval_seconds': v => Number.isFinite(v) && v >= 60,
        'forecast.stats_refresh_interval_seconds': v => Number.isFinite(v) && v >= 300,
        'forecast.stats_window_days': v => Number.isInteger(v) && v >= 2 && v <= 60,
        'forecast.k_pct_per_mm': v => v === null || (Number.isFinite(v) && v > 0 && v < 20),
        'forecast.k_pct_per_mm_p10': v => v === null || (Number.isFinite(v) && v > 0 && v < 20),
        'forecast.k_pct_per_mm_p90': v => v === null || (Number.isFinite(v) && v > 0 && v < 20),
        'forecast.rain_gain_pct_per_mm': v => Number.isFinite(v) && v >= 0 && v <= 20,
        'forecast.fallback_drying_rate_pct_h': v => Number.isFinite(v) && v > 0 && v < 20,
```

> `horizon_hours` è limitato a 96 perché la query meteo chiede 4 giorni: oltre non
> ci sarebbero dati.

- [ ] **Passo 5: eseguire il test e verificare che passi**

```bash
node rpi5/nodered/test/config_forecast.test.mjs
```

Atteso: `5 passati, 0 falliti`.

- [ ] **Passo 6: commit**

```bash
git add rpi5/nodered/data/irrigation_config.json rpi5/nodered/data/flows.json rpi5/nodered/test/config_forecast.test.mjs
git commit -m "feat(nodered): sezione forecast nella configurazione

Parametri del modello di previsione, validati su entrambi i canali (HTTP e
MQTT, che tengono copie separate della mappa PATHS). I coefficienti k
partono a null: finche non sono stimati il modello usa il fallback empirico."
```

---

## Task 3: Estrarre la catena di regole, senza cambiarne il comportamento

Il refactor più delicato del piano: tocca la logica che governa una valvola vera, in
`mode=auto`. L'ordine dei passi non è negoziabile — **prima la fotografia, poi
l'estrazione**.

**File:**
- Crea: `rpi5/nodered/test/regole_irrigazione.test.mjs`
- Modifica: `rpi5/nodered/data/flows.json` — nuovo nodo `nr-fn-lib` + nuovo inject
  `nr-inject-boot`; riscrittura di `decision logic`

**Interfacce:**
- Produce: `global.orto_rules = { valutaRegole }` con
  `valutaRegole(stato) → { azione: 'apri'|'attendi', regola: string, motivo: string, trigger?: 'auto'|'emergency' }`.
  Campi di `stato`: `now` (ms), `moisture_mean` (number|null), `sensor_count` (int),
  `last_irrigation_at` (ms), `weather` (`{available: bool, rain_24h: number}`),
  `valve_reachable` (bool), `mode` (string), `pause_until` (ISO|null), `cfg`.
  Valori di `regola`: `paused`, `no_quorum`, `moisture_sufficient`, `out_of_window`,
  `cooldown`, `rain_delay`, `valve_unreachable`, `open`. Consumato dal Task 5.

- [ ] **Passo 1: scrivere il test di fotografia sul decision loop attuale**

Crea `rpi5/nodered/test/regole_irrigazione.test.mjs`. Questo test gira **prima**
dell'estrazione e deve continuare a passare **dopo**, senza modifiche: è ciò che
dimostra che il comportamento non è cambiato. Si appoggia a
`global.last_decision_outcome`, che il nodo già scrive.

```js
// Fotografia della catena di regole del decision loop (step 15, Task 3).
//
//   node rpi5/nodered/test/regole_irrigazione.test.mjs
//
// Questo file NON va modificato durante l'estrazione in `libreria regole`:
// e' la prova che il comportamento non e' cambiato. La seconda meta' esercita
// direttamente valutaRegole, e ha senso solo dopo l'estrazione.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function nodoPerNome(nome) {
  const n = flows.find((x) => x.name === nome);
  assert.ok(n, `nodo "${nome}" non trovato in flows.json`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', n.func);
}
function nodoPerId(id) {
  const n = flows.find((x) => x.id === id);
  return n ? new AsyncFunction('msg', 'node', 'global', 'env', 'fs', n.func) : null;
}

const decisione = nodoPerNome('decision logic');

const CFG = {
  irrigation: {
    soglia_apertura_pct: 40, soglia_chiusura_pct: 65, soglia_emergenza_pct: 25,
    cooldown_seconds: 7200, safety_timeout_seconds: 900,
    manual_max_duration_seconds: 3600, emergency_duration_seconds: 300,
    finestra_mattina: ['06:00', '08:00'], finestra_sera: ['19:00', '01:00'],
    polling_interval_seconds: 300, monitoring_interval_seconds: 60,
  },
  weather: { polling_interval_seconds: 1800, cache_max_age_seconds: 5400, rain_threshold_mm: 5, rain_window_hours: 24 },
  valve: { command_timeout_seconds: 30, max_retries: 1, unreachable_alert_after: 3 },
  sensors: { max_age_seconds: 1800, min_quorum: 2, stddev_warning_pct: 25 },
  mode: 'auto', pause_until: null,
};

// Costruisce un istante di oggi all'ora voluta, in fuso locale (come fa inWindow).
function oggiAlle(hh, mm = 0) {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function banco({ umidita = [], now = oggiAlle(6, 30), cfg = CFG, meteo = null,
                 last_irrigation_at = 0, reachable = true } = {}) {
  const store = {
    irrigation_config: JSON.parse(JSON.stringify(cfg)),
    soil_moisture_cache: Object.fromEntries(umidita.map((v, i) => [`WH51_0${i + 1}`, { value: v, ts: now - 60000 }])),
    last_irrigation_at,
    valve_reachable: reachable,
    weather_cache: meteo,
  };
  const warns = [];
  return {
    store, warns,
    node: { warn: (m) => warns.push(m), log: () => {}, status: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

// Il nodo legge Date.now(): si congela il tempo per la durata della chiamata.
async function decidi(h, now) {
  const vero = Date.now;
  Date.now = () => now;
  try {
    return await decisione({}, h.node, h.global, h.env, h.fs);
  } finally {
    Date.now = vero;
  }
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('— fotografia del decision loop —');

await t('umidita sufficiente: nessun evento, esito ok', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [50, 52, 48, 51], now });
  const out = await decidi(h, now);
  assert.equal(out, null, 'non deve produrre alcun messaggio');
  assert.match(h.store.last_decision_outcome, /^ok:moist=/);
});

await t('quorum insufficiente blocca prima di tutto il resto', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [10], now });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:no_quorum');
});

await t('sistema in pausa: skip:paused anche con terreno secco', async () => {
  const now = oggiAlle(6, 30);
  const cfg = JSON.parse(JSON.stringify(CFG)); cfg.mode = 'paused';
  const h = banco({ umidita: [10, 12], now, cfg });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:paused');
});

await t('secco ma fuori finestra: skip:out_of_window', async () => {
  const now = oggiAlle(14, 0);
  const h = banco({ umidita: [30, 32], now });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:out_of_window');
});

await t('sotto soglia emergenza la finestra oraria viene scavalcata', async () => {
  const now = oggiAlle(14, 0);
  const h = banco({ umidita: [20, 22], now });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:emergency@/);
});

await t('finestra serale che attraversa la mezzanotte: alle 23 si e dentro', async () => {
  const now = oggiAlle(23, 0);
  const h = banco({ umidita: [30, 32], now });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

await t('finestra serale che attraversa la mezzanotte: alle 00:30 si e ancora dentro', async () => {
  const now = oggiAlle(0, 30);
  const h = banco({ umidita: [30, 32], now });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

await t('cooldown non scaduto: skip:cooldown', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, last_irrigation_at: now - 3600_000 });
  await decidi(h, now);
  assert.equal(h.store.last_decision_outcome, 'skip:cooldown');
});

await t('pioggia prevista sopra soglia: skip:rain_delay', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, meteo: { fetched_at: now - 60000, precip_next_24h_mm: 12 } });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^skip:rain_delay/);
});

await t('meteo stantio: la pioggia non blocca', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, meteo: { fetched_at: now - 6 * 3600_000, precip_next_24h_mm: 12 } });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

await t('valvola irraggiungibile: skip e contatore che sale', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now, reachable: false });
  await decidi(h, now);
  assert.match(h.store.last_decision_outcome, /^skip:valve_unreachable/);
  assert.equal(h.store.valve_unreachable_consecutive, 1);
});

await t('condizioni piene: apre in auto', async () => {
  const now = oggiAlle(6, 30);
  const h = banco({ umidita: [30, 32], now });
  const out = await decidi(h, now);
  assert.ok(Array.isArray(out), 'attesi tre output');
  assert.equal(out[0].payload.state, 'ON');
  assert.match(h.store.last_decision_outcome, /^open:auto@/);
});

console.log('\n— regole pure (valgono solo dopo l estrazione) —');

const libreria = nodoPerId('nr-fn-lib');

await t('la libreria registra valutaRegole in global', async () => {
  assert.ok(libreria, 'nodo nr-fn-lib non ancora presente in flows.json');
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  assert.equal(typeof h.store.orto_rules.valutaRegole, 'function');
});

await t('valutaRegole e pura: stessi ingressi, stessa uscita', async () => {
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  const { valutaRegole } = h.store.orto_rules;
  const stato = {
    now: oggiAlle(6, 30), moisture_mean: 30, sensor_count: 4, last_irrigation_at: 0,
    weather: { available: false, rain_24h: 0 }, valve_reachable: true,
    mode: 'auto', pause_until: null, cfg: CFG,
  };
  const a = valutaRegole(stato);
  const b = valutaRegole(stato);
  assert.deepEqual(a, b);
  assert.equal(a.azione, 'apri');
  assert.equal(a.trigger, 'auto');
});

await t('valutaRegole non tocca global ne l orologio', async () => {
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  const { valutaRegole } = h.store.orto_rules;
  const chiaviPrima = Object.keys(h.store).sort().join(',');
  valutaRegole({
    now: oggiAlle(14, 0), moisture_mean: 30, sensor_count: 4, last_irrigation_at: 0,
    weather: { available: false, rain_24h: 0 }, valve_reachable: true,
    mode: 'auto', pause_until: null, cfg: CFG,
  });
  assert.equal(Object.keys(h.store).sort().join(','), chiaviPrima, 'ha scritto su global');
});

await t('valutaRegole riporta la regola bloccante, non solo l azione', async () => {
  const h = banco({});
  await libreria({}, h.node, h.global, h.env, h.fs);
  const { valutaRegole } = h.store.orto_rules;
  const r = valutaRegole({
    now: oggiAlle(14, 0), moisture_mean: 30, sensor_count: 4, last_irrigation_at: 0,
    weather: { available: false, rain_24h: 0 }, valve_reachable: true,
    mode: 'auto', pause_until: null, cfg: CFG,
  });
  assert.equal(r.azione, 'attendi');
  assert.equal(r.regola, 'out_of_window');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
```

- [ ] **Passo 2: eseguire il test e verificare che la fotografia passi già ora**

```bash
node rpi5/nodered/test/regole_irrigazione.test.mjs
```

Atteso: i 12 casi della sezione «fotografia» **passano** (descrivono il codice
attuale); i 4 della sezione «regole pure» **falliscono** con `nodo nr-fn-lib non
ancora presente`.

> Se un caso della fotografia fallisce, **fermarsi**: significa che il
> comportamento reale non è quello descritto qui, e va capito prima di toccare
> qualsiasi cosa. Non aggiustare il test per farlo passare.

- [ ] **Passo 3: commit della sola fotografia**

```bash
git add rpi5/nodered/test/regole_irrigazione.test.mjs
git commit -m "test(nodered): fotografia della catena di regole prima dell estrazione"
```

- [ ] **Passo 4: aggiungere il nodo `libreria regole` a `flows.json`**

Nel tab *Decision Loop (step 4)*, aggiungere due nodi. L'`inject` con `once: true`
esegue la registrazione all'avvio del flow.

```json
{
  "id": "nr-inject-boot",
  "type": "inject",
  "z": "f-decision",
  "name": "boot: registra regole",
  "props": [{ "p": "payload" }],
  "once": true,
  "onceDelay": "1",
  "topic": "",
  "payload": "",
  "payloadType": "date",
  "x": 160, "y": 60,
  "wires": [["nr-fn-lib"]]
},
{
  "id": "nr-fn-lib",
  "type": "function",
  "z": "f-decision",
  "name": "libreria regole",
  "func": "<corpo indicato al passo 5>",
  "outputs": 0,
  "noerr": 0,
  "initialize": "", "finalize": "", "libs": [],
  "x": 400, "y": 60,
  "wires": []
}
```

- [ ] **Passo 5: scrivere il corpo di `libreria regole`**

```js
// UNICA sede della catena di regole di irrigazione.
// La leggono `decision logic` (decide davvero) e il simulatore (previsione).
// Non reimplementarla altrove: due copie divergono e la previsione mente.
function inWindow(date, win) {
    const hh = date.getHours().toString().padStart(2, '0');
    const mm = date.getMinutes().toString().padStart(2, '0');
    const cur = `${hh}:${mm}`;
    // win[0] > win[1] = finestra che attraversa la mezzanotte (es. 19:00-01:00)
    if (win[0] <= win[1]) return cur >= win[0] && cur < win[1];
    return cur >= win[0] || cur < win[1];
}

function valutaRegole(stato) {
    const cfg = stato.cfg;
    const now = stato.now;

    // 1) Pausa / mode
    if (stato.mode === 'paused' || (stato.pause_until && new Date(stato.pause_until).getTime() > now)) {
        return { azione: 'attendi', regola: 'paused', motivo: 'sistema in pausa' };
    }

    // 2) Quorum sensori
    if (stato.sensor_count < cfg.sensors.min_quorum) {
        return { azione: 'attendi', regola: 'no_quorum', motivo: `sonde valide ${stato.sensor_count} < ${cfg.sensors.min_quorum}` };
    }

    // 3) Umidita sufficiente
    if (stato.moisture_mean >= cfg.irrigation.soglia_apertura_pct) {
        return { azione: 'attendi', regola: 'moisture_sufficient', motivo: `umidita ${stato.moisture_mean}% >= ${cfg.irrigation.soglia_apertura_pct}%` };
    }

    const emergenza = stato.moisture_mean < cfg.irrigation.soglia_emergenza_pct;

    // 4) Orario (saltato se emergenza)
    if (!emergenza) {
        const d = new Date(now);
        const dentro = inWindow(d, cfg.irrigation.finestra_mattina) || inWindow(d, cfg.irrigation.finestra_sera);
        if (!dentro) return { azione: 'attendi', regola: 'out_of_window', motivo: 'fuori dalle finestre orarie' };
    }

    // 5) Cooldown
    if ((now - (stato.last_irrigation_at || 0)) < cfg.irrigation.cooldown_seconds * 1000) {
        return { azione: 'attendi', regola: 'cooldown', motivo: 'cooldown non scaduto' };
    }

    // 6) Pioggia (solo se il dato meteo e utilizzabile)
    if (stato.weather && stato.weather.available && stato.weather.rain_24h >= cfg.weather.rain_threshold_mm) {
        return { azione: 'attendi', regola: 'rain_delay', motivo: `pioggia prevista ${stato.weather.rain_24h}mm` };
    }

    // 7) Valvola raggiungibile
    if (stato.valve_reachable === false) {
        return { azione: 'attendi', regola: 'valve_unreachable', motivo: 'valvola non raggiungibile' };
    }

    // 8) Apre
    const trigger = emergenza ? 'emergency' : 'auto';
    return { azione: 'apri', regola: 'open', motivo: trigger, trigger };
}

global.set('orto_rules', { valutaRegole });
node.status({ fill: 'green', shape: 'dot', text: 'regole registrate' });
return null;
```

- [ ] **Passo 6: riscrivere `decision logic` perché usi la libreria**

Sostituire, nel corpo di `decision logic`, tutto ciò che segue la definizione di
`skipEvent` (dalla riga `const sensors = sensorStats();` fino alla fine del blocco
di regole, **lasciando intatta** la parte che costruisce `openMsg` e il ramo
`dry_run`) con:

```js
const sensors = sensorStats();
const weather = weatherInfo();
const ctx = { sensors, weather };

const rules = global.get('orto_rules');
if (!rules || typeof rules.valutaRegole !== 'function') {
    node.warn('[DECISION] orto_rules non registrate: nessuna decisione presa');
    node.status({ fill: 'red', shape: 'ring', text: 'regole mancanti' });
    return null;
}

const esito = rules.valutaRegole({
    now,
    moisture_mean: sensors.mean,
    sensor_count: sensors.count,
    last_irrigation_at: global.get('last_irrigation_at') || 0,
    weather: { available: weather.available, rain_24h: weather.rain_24h },
    valve_reachable: global.get('valve_reachable') !== false,
    mode: cfg.mode,
    pause_until: cfg.pause_until,
    cfg
});

if (esito.regola === 'moisture_sufficient') {
    global.set('last_decision_outcome', `ok:moist=${sensors.mean}`);
    node.status({ fill: 'green', shape: 'dot', text: `moist=${sensors.mean}% (>=${cfg.irrigation.soglia_apertura_pct})` });
    return null;
}

if (esito.regola === 'valve_unreachable') {
    const counter = (global.get('valve_unreachable_consecutive') || 0) + 1;
    global.set('valve_unreachable_consecutive', counter);
    if (counter >= cfg.valve.unreachable_alert_after) {
        node.warn(`[ALERT] valve unreachable for ${counter} consecutive ticks`);
    }
    global.set('last_decision_outcome', `skip:valve_unreachable(${counter})`);
    node.status({ fill: 'red', shape: 'dot', text: `unreachable x${counter}` });
    return [null, skipEvent('valve_unreachable', ctx), null];
}

if (esito.azione === 'attendi') {
    const etichetta = esito.regola === 'rain_delay'
        ? `skip:rain_delay(${weather.rain_24h}mm)`
        : `skip:${esito.regola}`;
    global.set('last_decision_outcome', etichetta);
    const colore = esito.regola === 'no_quorum' ? 'red' : (esito.regola === 'rain_delay' ? 'blue' : 'grey');
    const forma = esito.regola === 'no_quorum' ? 'ring' : 'dot';
    const testo = esito.regola === 'no_quorum'
        ? `no_quorum (${sensors.count})`
        : (esito.regola === 'rain_delay' ? `rain_delay (${weather.rain_24h}mm)` : esito.regola);
    node.status({ fill: colore, shape: forma, text: testo });
    return [null, skipEvent(esito.regola, ctx), null];
}

const trigger = esito.trigger;
const is_emergency = trigger === 'emergency';
```

Da qui in avanti il codice esistente prosegue **immutato**, a partire da
`const target_duration = is_emergency ? ...`.

- [ ] **Passo 7: eseguire il test e verificare che passi tutto**

```bash
node rpi5/nodered/test/regole_irrigazione.test.mjs
```

Atteso: `16 passati, 0 falliti`. **I 12 casi della fotografia devono passare senza
che il file di test sia stato toccato.** Se uno di essi ora fallisce, il refactor ha
cambiato il comportamento: correggere `decision logic`, mai il test.

- [ ] **Passo 8: verificare che nessun altro test sia stato rotto**

```bash
node rpi5/nodered/test/put_layout.test.mjs
node rpi5/nodered/test/registro_sensori.test.mjs
node rpi5/nodered/test/meteo_parsing.test.mjs
node rpi5/nodered/test/config_forecast.test.mjs
```

Atteso: tutti a 0 falliti.

- [ ] **Passo 9: commit**

```bash
git add rpi5/nodered/data/flows.json
git commit -m "refactor(nodered): catena di regole estratta in libreria condivisa

Le regole vivono ora in un solo nodo, che le registra in global.orto_rules.
decision logic le legge da li invece di implementarle in proprio, e il
simulatore della previsione (step 15) usera le stesse.

I 12 casi di fotografia scritti prima del refactor passano immutati: il
comportamento non e cambiato. Se orto_rules manca, decision logic non decide
e logga un warn: nessun fallback che reimplementi le regole."
```

---

## Task 4: Job orario delle statistiche di asciugatura

Produce la stima empirica usata come fallback e come sorgente della fascia quando il
meteo non è disponibile.

**File:**
- Modifica: `rpi5/nodered/data/flows.json` — nuovo tab `Previsione irrigazione (step 15)`

**Interfacce:**
- Produce: `global.drying_stats = { rate_pct_h: number, p10: number, p90: number, samples: int, computed_at: ms }`.
  Consumato dal Task 5. `rate_pct_h` è una velocità (%/h), **non** un coefficiente
  per ET0: le due grandezze non sono intercambiabili.

- [ ] **Passo 1: creare il tab e la catena di query**

Nuovo tab con `id` `ntab-forecast`, label `Previsione irrigazione (step 15)`.
Catena: `inject tick 60s` → `scheduler statistiche` → `influxdb in` (umidità) →
`influxdb in` (eventi) → `calcola statistiche asciugatura`.

Il nodo `scheduler statistiche` (id `nf-fn-sched-stats`):

```js
// Decide se e ora di ricalcolare le statistiche di asciugatura.
const cfg = global.get('irrigation_config');
if (!cfg || !cfg.forecast || cfg.forecast.enabled === false) return null;
const now = Date.now();
const last = global.get('last_drying_stats_at') || 0;
if ((now - last) < cfg.forecast.stats_refresh_interval_seconds * 1000) return null;
global.set('last_drying_stats_at', now);

const giorni = cfg.forecast.stats_window_days;
msg.query = `
from(bucket:"garden")
  |> range(start: -${giorni}d)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> group()
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> keep(columns:["_time","_value"])
  |> sort(columns:["_time"])`;
node.status({ fill: 'blue', shape: 'dot', text: 'stats: query umidita' });
return msg;
```

Il nodo successivo (`influxdb in`, id `nf-influx-moisture`) esegue `msg.query`. Poi
un function node `nf-fn-query-eventi`:

```js
// Conserva la serie di umidita e chiede gli eventi di irrigazione della finestra.
global.set('tmp_moisture_series', msg.payload || []);
const cfg = global.get('irrigation_config');
const giorni = cfg.forecast.stats_window_days;
msg.query = `
from(bucket:"garden")
  |> range(start: -${giorni}d)
  |> filter(fn: (r) => r._measurement == "irrigation_events" and r._field == "duration_seconds" and r._value > 0)
  |> keep(columns:["_time","_value"])
  |> sort(columns:["_time"])`;
return msg;
```

- [ ] **Passo 2: scrivere il test che fallisce**

Crea `rpi5/nodered/test/previsione.test.mjs` con la prima sezione (il resto arriva
nel Task 5):

```js
// Banco di prova della previsione (step 15, Task 4 e 5).
//
//   node rpi5/nodered/test/previsione.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const QUI = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const flows = JSON.parse(readFileSync(QUI + '../data/flows.json', 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function compila(id) {
  const n = flows.find((x) => x.id === id);
  assert.ok(n, `nodo ${id} non trovato in flows.json`);
  return new AsyncFunction('msg', 'node', 'global', 'env', 'fs', n.func);
}

const statistiche = compila('nf-fn-stats');

export const CFG = {
  irrigation: {
    soglia_apertura_pct: 40, soglia_chiusura_pct: 65, soglia_emergenza_pct: 25,
    cooldown_seconds: 7200, safety_timeout_seconds: 900, emergency_duration_seconds: 300,
    finestra_mattina: ['06:00', '08:00'], finestra_sera: ['19:00', '01:00'],
  },
  weather: { cache_max_age_seconds: 5400, rain_threshold_mm: 5, rain_window_hours: 24 },
  valve: { unreachable_alert_after: 3 },
  sensors: { max_age_seconds: 1800, min_quorum: 2, stddev_warning_pct: 25 },
  forecast: {
    enabled: true, horizon_hours: 72, step_minutes: 15,
    recompute_interval_seconds: 300, stats_refresh_interval_seconds: 3600,
    stats_window_days: 7, k_pct_per_mm: null, k_pct_per_mm_p10: null,
    k_pct_per_mm_p90: null, rain_gain_pct_per_mm: 1.2, fallback_drying_rate_pct_h: 0.5,
  },
  mode: 'auto', pause_until: null,
};

export function banco(extra = {}) {
  const store = { irrigation_config: JSON.parse(JSON.stringify(CFG)), ...extra };
  const warns = [];
  return {
    store, warns,
    node: { warn: (m) => warns.push(m), log: () => {}, status: () => {}, error: (m) => warns.push('ERR ' + m) },
    global: { set: (k, v) => { store[k] = v; }, get: (k) => store[k] },
    env: { get: () => undefined },
    fs: {},
  };
}

let ok = 0, ko = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ✓ ' + nome); ok++; }
  catch (e) { console.log('  ✗ ' + nome + '\n      ' + e.message); ko++; }
};

console.log('— statistiche di asciugatura —');

// Serie sintetica: cala 0.5 punti ogni 15 min (= 2 %/h) per 24 ore.
function serieInCalo(oreDaOra = 24, caloPer15min = 0.125) {
  const fine = Date.now();
  const punti = [];
  const n = oreDaOra * 4;
  for (let i = 0; i < n; i++) {
    punti.push({ _time: new Date(fine - (n - i) * 15 * 60000).toISOString(), _value: 60 - i * caloPer15min });
  }
  return punti;
}

await t('da una discesa costante ricava la velocita giusta', async () => {
  const h = banco({ tmp_moisture_series: serieInCalo() });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s, 'drying_stats non scritte');
  assert.ok(Math.abs(s.rate_pct_h - 0.5) < 0.05, `attesa ~0.5 %/h, ottenuta ${s.rate_pct_h}`);
  assert.ok(s.samples > 50);
});

await t('le finestre sporcate da irrigazione sono escluse', async () => {
  const serie = serieInCalo();
  // Salto verso l alto a meta serie: se non fosse escluso, falserebbe la media.
  const meta = Math.floor(serie.length / 2);
  for (let i = meta; i < meta + 12; i++) serie[i]._value += 15;
  const chiusura = new Date(serie[meta]._time).toISOString();
  const h = banco({ tmp_moisture_series: serie });
  await statistiche({ payload: [{ _time: chiusura, _value: 900 }] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(Math.abs(s.rate_pct_h - 0.5) < 0.15, `l irrigazione ha inquinato la stima: ${s.rate_pct_h}`);
});

await t('serie troppo corta: nessuna statistica, nessun crash', async () => {
  const h = banco({ tmp_moisture_series: serieInCalo(1) });
  await statistiche({ payload: [] }, h.node, h.global, h.env, h.fs);
  const s = h.store.drying_stats;
  assert.ok(s === undefined || s.samples < 10, 'con pochi dati non deve pubblicare una stima');
});

console.log(`\n${ok} passati, ${ko} falliti`);
process.exit(ko ? 1 : 0);
```

- [ ] **Passo 3: eseguire il test e verificare che fallisca**

```bash
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: FALLISCE, `nodo nf-fn-stats non trovato in flows.json`.

- [ ] **Passo 4: implementare `calcola statistiche asciugatura` (id `nf-fn-stats`)**

```js
// Stima empirica della velocita di asciugatura dalla serie di umidita media.
// Esclude le finestre contaminate dall irrigazione: da 30 min prima
// dell apertura a 3 h dopo la chiusura (il picco di risposta arriva a ~90 min).
const cfg = global.get('irrigation_config');
if (!cfg || !cfg.forecast) return null;

const serie = global.get('tmp_moisture_series') || [];
global.set('tmp_moisture_series', null);
const eventi = msg.payload || [];

const MIN_CAMPIONI = 10;
const PRIMA_MS = 30 * 60000;
const DOPO_MS = 3 * 3600000;

const finestre = eventi.map((e) => {
    const chiusura = new Date(e._time).getTime();
    const durata = (Number(e._value) || 0) * 1000;
    return [chiusura - durata - PRIMA_MS, chiusura + DOPO_MS];
});
const contaminato = (ts) => finestre.some(([a, b]) => ts >= a && ts <= b);

const punti = serie
    .map((p) => ({ ts: new Date(p._time).getTime(), v: Number(p._value) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
    .sort((a, b) => a.ts - b.ts);

const velocita = [];
for (let i = 1; i < punti.length; i++) {
    const a = punti[i - 1], b = punti[i];
    const dt_h = (b.ts - a.ts) / 3600000;
    if (dt_h <= 0 || dt_h > 0.5) continue;          // buchi nella serie: salta
    if (contaminato(a.ts) || contaminato(b.ts)) continue;
    const delta = b.v - a.v;
    if (delta > 0) continue;                         // sale: pioggia o irrigazione non tracciata
    velocita.push(-delta / dt_h);
}

if (velocita.length < MIN_CAMPIONI) {
    node.warn(`drying_stats: solo ${velocita.length} campioni puliti, stima non pubblicata`);
    node.status({ fill: 'yellow', shape: 'ring', text: `campioni ${velocita.length}` });
    return null;
}

velocita.sort((a, b) => a - b);
const perc = (p) => velocita[Math.min(velocita.length - 1, Math.floor(velocita.length * p))];

const stats = {
    rate_pct_h: Number(perc(0.5).toFixed(3)),
    p10: Number(perc(0.1).toFixed(3)),
    p90: Number(perc(0.9).toFixed(3)),
    samples: velocita.length,
    computed_at: Date.now()
};
global.set('drying_stats', stats);
node.status({ fill: 'green', shape: 'dot', text: `${stats.rate_pct_h} %/h (n=${stats.samples})` });
return null;
```

- [ ] **Passo 5: eseguire il test e verificare che passi**

```bash
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: `3 passati, 0 falliti`.

- [ ] **Passo 6: commit**

```bash
git add rpi5/nodered/data/flows.json rpi5/nodered/test/previsione.test.mjs
git commit -m "feat(nodered): job orario delle statistiche di asciugatura

Stima la velocita di asciugatura dalla serie di umidita degli ultimi giorni,
escludendo le finestre contaminate dall irrigazione (da 30 min prima
dell apertura a 3h dopo la chiusura, perche il picco di risposta del terreno
arriva a ~90 min) e i tratti in salita. Pubblica mediana e percentili 10/90,
usati come fallback e come fascia quando il meteo non e disponibile."
```

---

## Task 5: Proiezione e simulazione

Il cuore dello step.

**File:**
- Modifica: `rpi5/nodered/data/flows.json` — tab `Previsione irrigazione (step 15)`
- Modifica: `rpi5/nodered/test/previsione.test.mjs`

**Interfacce:**
- Consuma: `global.orto_rules.valutaRegole` (Task 3), `global.weather_cache.hourly`
  (Task 1), `global.drying_stats` (Task 4), `cfg.forecast` (Task 2).
- Produce: `global.irrigation_forecast`, oggetto con la forma esatta del contratto
  API (spec §7). Consumato dal Task 6.

- [ ] **Passo 1: scrivere i test che falliscono**

Inserisci in `rpi5/nodered/test/previsione.test.mjs`, **prima** della riga finale
`console.log(...)`, questa sezione:

```js
console.log('\n— proiezione e simulazione —');

const simulatore = compila('nf-fn-simula');
const libreria = compila('nr-fn-lib');

function oggiAlle(hh, mm = 0) {
  const d = new Date(); d.setHours(hh, mm, 0, 0); return d.getTime();
}

// Curva meteo sintetica: 96 ore dall ora corrente all indietro di 1,
// ET0 costante di giorno e nulla di notte, pioggia a scelta.
function curva({ et0Giorno = 0.25, pioggiaOra = {} } = {}) {
  const oraCorrente = Math.floor(Date.now() / 3600000) * 3600;
  const t0 = oraCorrente - 3600;
  const time = Array.from({ length: 96 }, (_, i) => t0 + i * 3600);
  const et0 = time.map((s) => {
    const ora = new Date(s * 1000).getHours();
    return ora >= 7 && ora < 20 ? et0Giorno : 0;
  });
  const precipitation = time.map((_, i) => pioggiaOra[i] || 0);
  return { time, precipitation, et0 };
}

// Config con k gia stimato: la maggior parte dei casi esercita il modello ET0.
// Chi vuole il fallback empirico passa meteo:false o un cfg senza k.
const CFG_K = JSON.parse(JSON.stringify(CFG));
CFG_K.forecast.k_pct_per_mm = 2.0;
CFG_K.forecast.k_pct_per_mm_p10 = 1.2;
CFG_K.forecast.k_pct_per_mm_p90 = 3.0;

function bancoSim({ umidita = [30, 32], now = Date.now(), meteo = true, cfg = CFG_K,
                    last_irrigation_at = 0, stats = { rate_pct_h: 0.5, p10: 0.3, p90: 0.8, samples: 200, computed_at: Date.now() },
                    pioggiaOra = {} } = {}) {
  const h = banco({
    soil_moisture_cache: Object.fromEntries(umidita.map((v, i) => [`WH51_0${i + 1}`, { value: v, ts: now - 60000 }])),
    last_irrigation_at,
    valve_reachable: true,
    drying_stats: stats,
    weather_cache: meteo ? { fetched_at: now - 60000, precip_next_24h_mm: 0, hourly: curva({ pioggiaOra }) } : null,
  });
  h.store.irrigation_config = JSON.parse(JSON.stringify(cfg));
  return h;
}

async function simula(h, now = Date.now()) {
  await libreria({}, h.node, h.global, h.env, h.fs);
  const vero = Date.now;
  Date.now = () => now;
  try { return await simulatore({}, h.node, h.global, h.env, h.fs); }
  finally { Date.now = vero; }
}

await t('terreno secco dentro la finestra: apre subito', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30, 32], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation, 'nessuna previsione prodotta');
  assert.ok(Math.abs(new Date(f.next_irrigation.predicted_at).getTime() - now) < 20 * 60000);
  assert.equal(f.next_irrigation.expected_duration_seconds, 900);
});

await t('secco ma fuori finestra: la regola limitante e out_of_window', async () => {
  const now = oggiAlle(14, 0);
  const h = bancoSim({ umidita: [30, 32], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation);
  assert.equal(f.next_irrigation.limiting_rule, 'out_of_window');
  const previsto = new Date(f.next_irrigation.predicted_at);
  assert.equal(previsto.getHours(), 19, 'attesa apertura alla finestra serale');
});

await t('terreno bagnato: si asciuga e apre piu avanti', async () => {
  const now = oggiAlle(6, 30);
  // 50% con ET0 diurna 0.25 mm/h e k=2.0 -> ~0.5 %/h di giorno: ~1.5 giorni
  // per scendere sotto 40, dentro l orizzonte di 72h.
  const h = bancoSim({ umidita: [50, 50], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.next_irrigation, 'con ET0 positiva deve prima o poi scendere sotto soglia');
  assert.ok(new Date(f.next_irrigation.predicted_at).getTime() > now + 6 * 3600000);
});

await t('di notte la curva e piatta: nessun attraversamento notturno', async () => {
  const now = oggiAlle(1, 0);
  const h = bancoSim({ umidita: [41, 41], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  if (f.next_irrigation) {
    const ora = new Date(f.next_irrigation.predicted_at).getHours();
    assert.ok(ora >= 6, `previsione alle ${ora}: con ET0 nulla non puo scendere di notte`);
  }
});

await t('pioggia abbondante nell orizzonte: nessuna irrigazione, motivo rain_forecast', async () => {
  const now = oggiAlle(6, 30);
  const pioggia = {}; for (let i = 2; i < 30; i++) pioggia[i] = 2;
  const h = bancoSim({ umidita: [39, 39], now, pioggiaOra: pioggia });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'rain_forecast');
});

await t('la pioggia vince sull umidita alta nel riportare il motivo', async () => {
  const now = oggiAlle(6, 30);
  // Piove per tutto l orizzonte: l umidita sale sopra soglia, quindi entrambe
  // le regole bloccano. Deve essere riportata rain_forecast, che spiega di piu.
  const pioggia = {}; for (let i = 0; i < 96; i++) pioggia[i] = 2;
  const h = bancoSim({ umidita: [30, 30], now, pioggiaOra: pioggia });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'rain_forecast');
});

await t('umidita alta e stabile: motivo moisture_sufficient', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [80, 80], now, meteo: true });
  h.store.weather_cache.hourly.et0 = h.store.weather_cache.hourly.et0.map(() => 0);
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'moisture_sufficient');
});

await t('senza meteo passa a empirical e abbassa la confidenza', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [45, 45], now, meteo: false });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.model.method, 'empirical');
  assert.ok(f.confidence.level < 4);
  assert.ok(f.confidence.reasons.some((r) => /meteo/i.test(r)));
});

await t('senza regole registrate non inventa nulla', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30, 32], now });
  const vero = Date.now; Date.now = () => now;
  try { await simulatore({}, h.node, h.global, h.env, h.fs); } finally { Date.now = vero; }
  assert.equal(h.store.irrigation_forecast, undefined);
  assert.ok(h.warns.some((w) => /orto_rules/.test(w)));
});

await t('quorum insufficiente: nessuna previsione, motivo no_quorum', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.equal(f.next_irrigation, null);
  assert.equal(f.no_irrigation_reason, 'no_quorum');
});

await t('sistema in pausa: motivo paused', async () => {
  const now = oggiAlle(6, 30);
  const cfg = JSON.parse(JSON.stringify(CFG)); cfg.mode = 'paused';
  const h = bancoSim({ umidita: [30, 32], now, cfg });
  await simula(h, now);
  assert.equal(h.store.irrigation_forecast.no_irrigation_reason, 'paused');
});

await t('la fascia contiene la stima centrale ed e ordinata', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [55, 55], now });
  await simula(h, now);
  const n = h.store.irrigation_forecast.next_irrigation;
  if (n) {
    const a = new Date(n.band_start).getTime();
    const c = new Date(n.predicted_at).getTime();
    const b = new Date(n.band_end).getTime();
    assert.ok(a <= c && c <= b, `fascia incoerente: ${n.band_start} / ${n.predicted_at} / ${n.band_end}`);
  }
});

await t('sonde in disaccordo: confidenza piu bassa', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [10, 70], now });
  await simula(h, now);
  const f = h.store.irrigation_forecast;
  assert.ok(f.confidence.reasons.some((r) => /disaccordo/i.test(r)));
});

await t('il point per InfluxDB esce come secondo output', async () => {
  const now = oggiAlle(6, 30);
  const h = bancoSim({ umidita: [30, 32], now });
  const out = await simula(h, now);
  assert.ok(Array.isArray(out), 'attesi due output');
  assert.equal(out[1].measurement, 'irrigation_forecast');
  assert.equal(out[1].payload[1].method, 'et0');
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

```bash
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: FALLISCE, `nodo nf-fn-simula non trovato in flows.json`.

- [ ] **Passo 3: aggiungere la catena del simulatore**

Nel tab `Previsione irrigazione (step 15)`: `inject tick 60s` →
`nf-fn-simula` (2 uscite) → uscita 1 non collegata (solo context), uscita 2 →
`influxdb out` verso `garden/irrigation_forecast`.

- [ ] **Passo 4: implementare `nf-fn-simula`**

```js
// Proietta l umidita in avanti e rigioca la catena di regole a ogni passo.
// Si ferma al primo evento previsto (spec D2): non serve il modello di bagnatura.
const cfg = global.get('irrigation_config');
if (!cfg || !cfg.forecast || cfg.forecast.enabled === false) return null;

const now = Date.now();
const ultimo = global.get('last_forecast_at') || 0;
if ((now - ultimo) < cfg.forecast.recompute_interval_seconds * 1000) return null;
global.set('last_forecast_at', now);

const rules = global.get('orto_rules');
if (!rules || typeof rules.valutaRegole !== 'function') {
    node.warn('[FORECAST] orto_rules non registrate: previsione saltata');
    node.status({ fill: 'red', shape: 'ring', text: 'regole mancanti' });
    return null;
}

const fc = cfg.forecast;
const passoMs = fc.step_minutes * 60000;
const orizzonteMs = fc.horizon_hours * 3600000;
const dt_h = fc.step_minutes / 60;

// --- stato sonde: stessa media che usa decision logic ---
const cache = global.get('soil_moisture_cache') || {};
const maxAge = cfg.sensors.max_age_seconds * 1000;
const valide = Object.values(cache).filter((e) => (now - e.ts) < maxAge).map((e) => e.value);
const conta = valide.length;
let media = null, scarto = 0;
if (conta) {
    media = valide.reduce((a, b) => a + b, 0) / conta;
    scarto = Math.sqrt(valide.reduce((s, v) => s + (v - media) ** 2, 0) / conta);
}

// --- meteo ---
const wc = global.get('weather_cache');
const meteoFresco = !!(wc && wc.fetched_at && (now - wc.fetched_at) < cfg.weather.cache_max_age_seconds * 1000);
const curva = (meteoFresco && wc.hourly && Array.isArray(wc.hourly.time) && wc.hourly.time.length) ? wc.hourly : null;
const metodo = curva ? 'et0' : 'empirical';

function indiceOra(ts) {
    if (!curva) return -1;
    const s = Math.floor(ts / 1000);
    for (let i = 0; i < curva.time.length; i++) {
        if (curva.time[i] <= s && s < curva.time[i] + 3600) return i;
    }
    return -1;
}
function et0A(ts) {
    const i = indiceOra(ts);
    if (i < 0) return null;
    return Number.isFinite(curva.et0[i]) ? curva.et0[i] : 0;
}
function pioggiaA(ts) {
    const i = indiceOra(ts);
    if (i < 0) return 0;
    return Number.isFinite(curva.precipitation[i]) ? curva.precipitation[i] : 0;
}
function pioggia24A(ts) {
    const i = indiceOra(ts);
    const ore = cfg.weather.rain_window_hours;
    if (i < 0 || i + ore > curva.precipitation.length) return { available: false, mm: 0 };
    let s = 0;
    for (let j = i; j < i + ore; j++) s += Number.isFinite(curva.precipitation[j]) ? curva.precipitation[j] : 0;
    return { available: true, mm: Number(s.toFixed(2)) };
}

// --- coefficienti ---
const stats = global.get('drying_stats');
const kStimato = Number.isFinite(fc.k_pct_per_mm);
const kCentrale = kStimato ? fc.k_pct_per_mm : null;
const kBasso = Number.isFinite(fc.k_pct_per_mm_p10) ? fc.k_pct_per_mm_p10 : kCentrale;
const kAlto = Number.isFinite(fc.k_pct_per_mm_p90) ? fc.k_pct_per_mm_p90 : kCentrale;
const empCentrale = stats ? stats.rate_pct_h : fc.fallback_drying_rate_pct_h;
const empBasso = stats ? stats.p10 : fc.fallback_drying_rate_pct_h;
const empAlto = stats ? stats.p90 : fc.fallback_drying_rate_pct_h;

// In modalita et0 il coefficiente moltiplica l ET0 (%/mm); in empirica e gia %/h.
function velocita(ts, coeff, usaEt0) {
    if (usaEt0) {
        const e = et0A(ts);
        return e === null ? empCentrale : coeff * e;
    }
    return coeff;
}

const usaEt0 = !!curva && kStimato;
const metodoEffettivo = usaEt0 ? 'et0' : 'empirical';

// Quando non si irriga entro l orizzonte piu regole possono aver bloccato in
// momenti diversi. Si riporta la piu informativa, non l ultima incontrata:
// l ordine dell array e la priorita.
const PRIORITA = ['paused', 'no_quorum', 'rain_delay', 'moisture_sufficient', 'cooldown', 'out_of_window'];

function simula(coeff, m0) {
    let m = m0;
    const ultimaIrrigazione = global.get('last_irrigation_at') || 0;
    let bloccante = null;
    const incontrate = new Set();
    for (let t = now; t <= now + orizzonteMs; t += passoMs) {
        const r24 = curva ? pioggia24A(t) : { available: false, mm: 0 };
        const esito = rules.valutaRegole({
            now: t,
            moisture_mean: Number(m.toFixed(2)),
            sensor_count: conta,
            last_irrigation_at: ultimaIrrigazione,
            weather: r24,
            valve_reachable: true,
            mode: cfg.mode,
            pause_until: cfg.pause_until,
            cfg
        });
        if (esito.azione === 'apri') {
            return { at: t, trigger: esito.trigger, limiting: bloccante || esito.regola };
        }
        bloccante = esito.regola;
        incontrate.add(esito.regola);
        m = m - velocita(t, coeff, usaEt0) * dt_h + fc.rain_gain_pct_per_mm * pioggiaA(t) * dt_h;
        m = Math.max(0, Math.min(100, m));
    }
    const prevalente = PRIORITA.find((r) => incontrate.has(r)) || bloccante;
    return { at: null, limiting: prevalente };
}

let risultato = { next_irrigation: null, no_irrigation_reason: null };
if (media === null || conta < cfg.sensors.min_quorum) {
    risultato.no_irrigation_reason = 'no_quorum';
} else {
    const centrale = simula(usaEt0 ? kCentrale : empCentrale, media);
    if (centrale.at === null) {
        const mappa = { moisture_sufficient: 'moisture_sufficient', rain_delay: 'rain_forecast', paused: 'paused', no_quorum: 'no_quorum' };
        risultato.no_irrigation_reason = mappa[centrale.limiting] || 'moisture_sufficient';
    } else {
        // Ottimistico: asciuga piano e parte da piu bagnato -> irriga piu tardi.
        const ottimistico = simula(usaEt0 ? kBasso : empBasso, media + scarto);
        const pessimistico = simula(usaEt0 ? kAlto : empAlto, Math.max(0, media - scarto));
        const estremi = [ottimistico.at, pessimistico.at, centrale.at].filter((v) => v !== null);
        const iso = (ms) => new Date(ms).toISOString();
        risultato.next_irrigation = {
            predicted_at: iso(centrale.at),
            band_start: iso(Math.min(...estremi)),
            band_end: iso(Math.max(...estremi)),
            expected_duration_seconds: centrale.trigger === 'emergency'
                ? cfg.irrigation.emergency_duration_seconds
                : cfg.irrigation.safety_timeout_seconds,
            trigger: centrale.trigger,
            limiting_rule: centrale.limiting
        };
    }
}

// --- confidenza ---
let livello = 4;
const motivi = [];
if (!curva) { livello--; motivi.push('meteo non disponibile'); }
if (!kStimato) { livello--; motivi.push('coefficiente k non ancora stimato'); }
if (scarto > cfg.sensors.stddev_warning_pct) { livello--; motivi.push(`sonde in disaccordo (stddev ${scarto.toFixed(1)}%)`); }
if (stats && (now - stats.computed_at) > 3 * fc.stats_refresh_interval_seconds * 1000) {
    livello--; motivi.push('statistiche di asciugatura non aggiornate');
}
if (!stats) { livello--; motivi.push('statistiche di asciugatura non ancora calcolate'); }
livello = Math.max(1, livello);
if (!motivi.length) motivi.push('tutti gli ingressi disponibili');

const previsione = {
    generated_at: new Date(now).toISOString(),
    mode: cfg.mode,
    next_irrigation: risultato.next_irrigation,
    current: {
        moisture_mean: media === null ? null : Number(media.toFixed(1)),
        sensor_count: conta,
        drying_rate_pct_h: Number((usaEt0 ? (kCentrale * (et0A(now) || 0)) : empCentrale).toFixed(2))
    },
    model: {
        method: metodoEffettivo,
        k_pct_per_mm: kStimato ? kCentrale : null,
        weather_available: !!curva
    },
    confidence: { level: livello, reasons: motivi },
    no_irrigation_reason: risultato.no_irrigation_reason
};

global.set('irrigation_forecast', previsione);
node.status({
    fill: risultato.next_irrigation ? 'green' : 'grey',
    shape: 'dot',
    text: risultato.next_irrigation ? `next ${previsione.next_irrigation.predicted_at.substr(11, 5)}` : (risultato.no_irrigation_reason || 'nessuna')
});

const secondi = risultato.next_irrigation
    ? Math.round((new Date(risultato.next_irrigation.predicted_at).getTime() - now) / 1000)
    : null;
const point = {
    payload: [
        {
            seconds_until_next: secondi,
            band_low_seconds: risultato.next_irrigation ? Math.round((new Date(risultato.next_irrigation.band_start).getTime() - now) / 1000) : null,
            band_high_seconds: risultato.next_irrigation ? Math.round((new Date(risultato.next_irrigation.band_end).getTime() - now) / 1000) : null,
            moisture_mean: previsione.current.moisture_mean,
            drying_rate_pct_h: previsione.current.drying_rate_pct_h,
            confidence_level: livello
        },
        { method: metodoEffettivo }
    ],
    measurement: 'irrigation_forecast'
};

return [null, point];
```

> **Nota sul `metodo` dichiarato:** `method` vale `et0` solo se **sia** la curva
> meteo **sia** `k` sono disponibili. Con la curva ma senza `k` il modello resta
> empirico, e dirlo diversamente sarebbe una bugia nel contratto.

- [ ] **Passo 5: eseguire il test e verificare che passi**

```bash
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: `17 passati, 0 falliti` (3 del Task 4 + 14 nuovi).

- [ ] **Passo 6: commit**

```bash
git add rpi5/nodered/data/flows.json rpi5/nodered/test/previsione.test.mjs
git commit -m "feat(nodered): simulatore della prossima irrigazione

Proietta l umidita media a passi di 15 min su 72h con velocita k*ET0 dalla
curva oraria Open-Meteo, e a ogni passo rigioca la catena di regole condivisa
con il decision loop. Si ferma al primo evento. La fascia di incertezza nasce
dai percentili di k e dalla dispersione fra le sonde. Senza meteo o senza k
degrada a stima empirica e lo dichiara nella risposta."
```

---

## Task 6: Endpoint API

**File:**
- Modifica: `rpi5/nodered/data/flows.json` — tab `Previsione irrigazione (step 15)`
- Modifica: `rpi5/nodered/test/previsione.test.mjs`

**Interfacce:**
- Produce: `GET /api/irrigation/forecast` che risponde con l'oggetto della spec §7.
  Consumato dal Task 8.

- [ ] **Passo 1: scrivere i test che falliscono**

Aggiungi in `previsione.test.mjs`, prima della riga finale:

```js
console.log('\n— endpoint API —');

const risposta = compila('nf-fn-http');

await t('risponde 200 con la previsione in context', async () => {
  const h = banco({ irrigation_forecast: { generated_at: 'x', mode: 'auto', next_irrigation: null, no_irrigation_reason: 'moisture_sufficient' } });
  const msg = await risposta({}, h.node, h.global, h.env, h.fs);
  assert.equal(msg.statusCode, 200);
  assert.equal(msg.payload.no_irrigation_reason, 'moisture_sufficient');
  assert.equal(msg.headers['Content-Type'], 'application/json');
});

await t('senza previsione ancora calcolata risponde 503, non 200 con dati finti', async () => {
  const h = banco({});
  const msg = await risposta({}, h.node, h.global, h.env, h.fs);
  assert.equal(msg.statusCode, 503);
  assert.equal(msg.payload.ok, false);
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

```bash
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: FALLISCE, `nodo nf-fn-http non trovato`.

- [ ] **Passo 3: aggiungere la catena HTTP**

`http in` (`GET /api/irrigation/forecast`, id `nf-http-in`) → `nf-fn-http` →
`http response`.

- [ ] **Passo 4: implementare `nf-fn-http`**

```js
// Risponde dalla previsione in context: nessuna query, nessuna chiamata esterna.
msg.headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const f = global.get('irrigation_forecast');
if (!f) {
    msg.statusCode = 503;
    msg.payload = { ok: false, error: 'previsione non ancora calcolata' };
    return msg;
}
msg.statusCode = 200;
msg.payload = f;
return msg;
```

- [ ] **Passo 5: eseguire il test e verificare che passi**

```bash
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: `19 passati, 0 falliti`.

- [ ] **Passo 6: commit**

```bash
git add rpi5/nodered/data/flows.json rpi5/nodered/test/previsione.test.mjs
git commit -m "feat(nodered): endpoint GET /api/irrigation/forecast

Risponde dalla previsione in context, senza query ne chiamate esterne.
Finche non c e una previsione calcolata risponde 503 invece di inventare
una risposta vuota che il frontend interpreterebbe come dato valido."
```

---

## Task 7: Stima di `k` e validazione — cancello di accettazione

Questo task può **bocciare** lo step. Va eseguito prima di pubblicare la card.

**File:**
- Crea: `analysis/stima_k.mjs`
- Crea: `analysis/03_stima_asciugatura.md`
- Modifica: `rpi5/nodered/data/irrigation_config.json` (i tre `k_*`)

**Interfacce:**
- Produce: i valori `forecast.k_pct_per_mm`, `k_pct_per_mm_p10`, `k_pct_per_mm_p90`.

- [ ] **Passo 1: esportare i dati grezzi dal RPi**

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -120d)
  |> filter(fn: (r) => r._measurement == \"soil_moisture\" and r._field == \"value\")
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> group()
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> keep(columns:[\"_time\",\"_value\"])
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" --raw' > analysis/umidita.csv

ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -120d)
  |> filter(fn: (r) => r._measurement == \"irrigation_events\" and r._field == \"duration_seconds\" and r._value > 0)
  |> keep(columns:[\"_time\",\"_value\"])
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" --raw' > analysis/eventi.csv
```

> Se `192.168.1.12` non risponde, usare `192.168.1.46` (WiFi).
> I due CSV sono file di lavoro: **non committarli**.

- [ ] **Passo 2: scrivere `analysis/stima_k.mjs`**

```js
// Stima del coefficiente di asciugatura k (%/mm) per lo step 15.
//
//   node analysis/stima_k.mjs
//
// Ingressi: analysis/umidita.csv e analysis/eventi.csv esportati da InfluxDB.
// L ET0 storica arriva dall archivio Open-Meteo. Nessuna scrittura: stampa e basta.
import { readFileSync } from 'node:fs';

const LAT = 45.71722434055733;
const LON = 9.733793667999565;
const PRIMA_MS = 30 * 60000;
const DOPO_MS = 3 * 3600000;

function leggiCsv(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((r) => r.startsWith(',,'))
    .map((r) => r.split(','))
    .map((c) => ({ ts: Date.parse(c[c.length - 2]), v: Number(c[c.length - 1]) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
    .sort((a, b) => a.ts - b.ts);
}

const umidita = leggiCsv('analysis/umidita.csv');
const eventi = leggiCsv('analysis/eventi.csv');
if (umidita.length < 100) { console.error('serie di umidita troppo corta'); process.exit(1); }

const finestre = eventi.map((e) => [e.ts - e.v * 1000 - PRIMA_MS, e.ts + DOPO_MS]);
const contaminato = (ts) => finestre.some(([a, b]) => ts >= a && ts <= b);

const da = new Date(umidita[0].ts).toISOString().slice(0, 10);
const a = new Date(umidita[umidita.length - 1].ts).toISOString().slice(0, 10);
const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}` +
  `&start_date=${da}&end_date=${a}&hourly=et0_fao_evapotranspiration,precipitation` +
  `&timeformat=unixtime&timezone=Europe%2FRome`;
const meteo = await (await fetch(url)).json();
const tempo = meteo.hourly.time;
const et0 = meteo.hourly.et0_fao_evapotranspiration;
const pioggia = meteo.hourly.precipitation;

const oraDi = (ts) => {
  const s = Math.floor(ts / 1000);
  let lo = 0, hi = tempo.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (tempo[m] <= s && s < tempo[m] + 3600) return m;
    if (tempo[m] > s) hi = m - 1; else lo = m + 1;
  }
  return -1;
};

const campioni = [];
for (let i = 1; i < umidita.length; i++) {
  const p = umidita[i - 1], q = umidita[i];
  const dt_h = (q.ts - p.ts) / 3600000;
  if (dt_h <= 0 || dt_h > 0.5) continue;
  if (contaminato(p.ts) || contaminato(q.ts)) continue;
  const h = oraDi(p.ts);
  if (h < 0) continue;
  if ((pioggia[h] || 0) > 0) continue;
  const calo = p.v - q.v;
  if (calo <= 0) continue;
  const et0Passo = (et0[h] || 0) * dt_h;
  if (et0Passo <= 0.001) continue;
  campioni.push(calo / et0Passo);
}

if (campioni.length < 50) { console.error(`solo ${campioni.length} campioni puliti`); process.exit(1); }
campioni.sort((x, y) => x - y);
const perc = (p) => campioni[Math.floor(campioni.length * p)];
const k = perc(0.5), k10 = perc(0.1), k90 = perc(0.9);

console.log(`campioni puliti: ${campioni.length}`);
console.log(`k    = ${k.toFixed(3)} %/mm`);
console.log(`k p10= ${k10.toFixed(3)}   k p90= ${k90.toFixed(3)}`);

// --- backtest della proiezione: errore a 6, 12, 24 ore ---
console.log('\norizzonte | campioni | errore mediano | errore p90');
for (const ore of [6, 12, 24]) {
  const errori = [];
  for (let i = 0; i < umidita.length; i++) {
    const p = umidita[i];
    const bersaglio = p.ts + ore * 3600000;
    const j = umidita.findIndex((x) => x.ts >= bersaglio);
    if (j < 0) continue;
    const reale = umidita[j];
    if (Math.abs(reale.ts - bersaglio) > 30 * 60000) continue;
    let sporco = false;
    for (let t = p.ts; t <= reale.ts; t += 900000) if (contaminato(t)) { sporco = true; break; }
    if (sporco) continue;
    let m = p.v;
    for (let t = p.ts; t < reale.ts; t += 900000) {
      const h = oraDi(t);
      if (h < 0) { m = NaN; break; }
      m -= k * (et0[h] || 0) * 0.25;
      m += 1.2 * (pioggia[h] || 0) * 0.25;
    }
    if (Number.isFinite(m)) errori.push(Math.abs(m - reale.v));
  }
  errori.sort((x, y) => x - y);
  const med = errori.length ? errori[Math.floor(errori.length / 2)] : NaN;
  const p90 = errori.length ? errori[Math.floor(errori.length * 0.9)] : NaN;
  console.log(`${String(ore).padStart(8)}h | ${String(errori.length).padStart(8)} | ${med.toFixed(2).padStart(14)} | ${p90.toFixed(2).padStart(10)}`);
}
```

- [ ] **Passo 3: eseguire e leggere il risultato**

```bash
node analysis/stima_k.mjs
```

**Cancello di accettazione:** l'errore mediano a 12 h deve essere **sotto 3 punti
percentuali**.

- Se il criterio è rispettato → passo 4.
- Se **non** è rispettato → **fermarsi e riferire**. Non alzare la soglia, non
  pubblicare la card. Le opzioni da discutere sono: separare `k` per fascia oraria,
  passare a un `k` per aiuola, o rivedere il modello. È la decisione che la spec
  §11 riserva esplicitamente a questo punto.

- [ ] **Passo 4: scrivere la nota di analisi**

Crea `analysis/03_stima_asciugatura.md` con: data di esecuzione, periodo coperto,
numero di campioni puliti, i tre valori di `k`, la tabella degli errori stampata dallo
script, e una riga di commento su come il risultato si colloca rispetto al criterio.
Segui lo stile delle note già presenti in `analysis/`.

- [ ] **Passo 5: scrivere i coefficienti in configurazione**

In `rpi5/nodered/data/irrigation_config.json`, sostituire i tre `null` con i valori
ottenuti.

- [ ] **Passo 6: commit**

```bash
git add analysis/stima_k.mjs analysis/03_stima_asciugatura.md rpi5/nodered/data/irrigation_config.json
git commit -m "feat(scripts): stima del coefficiente di asciugatura k

Fitting sui dati grezzi di umidita e sull ET0 storica di Open-Meteo,
escludendo le finestre contaminate da irrigazione e le ore con pioggia.
Include il backtest della proiezione a 6/12/24h, che e l unica validazione
possibile: lo storico degli eventi e tutto manuale, quindi non esiste una
verita con cui confrontare la previsione dell evento."
```

---

## Task 8: Frontend — hook, tipi e card

**File:**
- Crea: `rpi5/frontend/src/api/forecast.ts`
- Crea: `rpi5/frontend/src/components/NextIrrigationCard.tsx`
- Modifica: `rpi5/frontend/src/api/types.ts`
- Modifica: `rpi5/frontend/src/pages/Waterflow.tsx`

**Interfacce:**
- Consuma: `GET /api/irrigation/forecast` (Task 6).

> **Nota su un helper mancante.** `fmtRelative` in `helpers/formatDate.ts` guarda
> **al passato** (`'5m fa'`) e per un istante futuro restituisce `'in arrivo'`. Serve
> il verso opposto, quindi il passo 1 aggiunge `fmtFraQuanto` a
> `helpers/formatDuration.ts`. Non riusare `fmtRelative` per la previsione.

- [ ] **Passo 0: aggiungere e testare `fmtFraQuanto`**

In coda a `rpi5/frontend/src/helpers/formatDuration.ts`:

```ts
export function fmtFraQuanto(iso: string | null | undefined, ora: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((t - ora) / 1000);
  if (s <= 0) return 'ora';
  if (s < 3600) return `fra ${Math.round(s / 60)} min`;
  const h = Math.round(s / 3600);
  if (h < 48) return `fra ${h} h`;
  return `fra ${Math.round(h / 24)} giorni`;
}
```

Crea `rpi5/frontend/src/helpers/formatDuration.test.ts` (non esiste ancora: gli
unici test negli helper sono `layoutOps`, `moistureBands`, `ortoMetrics`,
`registryOps`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtFraQuanto } from './formatDuration';

const ORA = Date.parse('2026-08-16T18:00:00Z');
const fra = (ms: number) => new Date(ORA + ms).toISOString();

test('fmtFraQuanto: minuti', () => {
  assert.equal(fmtFraQuanto(fra(25 * 60_000), ORA), 'fra 25 min');
});

test('fmtFraQuanto: ore', () => {
  assert.equal(fmtFraQuanto(fra(11 * 3600_000), ORA), 'fra 11 h');
});

test('fmtFraQuanto: giorni', () => {
  assert.equal(fmtFraQuanto(fra(3 * 86400_000), ORA), 'fra 3 giorni');
});

test('fmtFraQuanto: istante passato non dice "fa"', () => {
  assert.equal(fmtFraQuanto(fra(-60_000), ORA), 'ora');
});

test('fmtFraQuanto: valore assente', () => {
  assert.equal(fmtFraQuanto(null, ORA), '—');
});
```

Eseguire:

```bash
cd rpi5/frontend && npm test && cd ../..
```

Atteso: i cinque casi nuovi passano.

- [ ] **Passo 1: aggiungere i tipi**

In coda a `rpi5/frontend/src/api/types.ts`:

```ts
export interface NextIrrigation {
  predicted_at: string;
  band_start: string;
  band_end: string;
  expected_duration_seconds: number;
  trigger: 'auto' | 'emergency';
  limiting_rule: string;
}

export interface IrrigationForecast {
  generated_at: string;
  mode: string;
  next_irrigation: NextIrrigation | null;
  current: { moisture_mean: number | null; sensor_count: number; drying_rate_pct_h: number };
  model: { method: 'et0' | 'empirical'; k_pct_per_mm: number | null; weather_available: boolean };
  confidence: { level: number; reasons: string[] };
  no_irrigation_reason: string | null;
}
```

- [ ] **Passo 2: creare l'hook**

`rpi5/frontend/src/api/forecast.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { IrrigationForecast } from './types';

export function useIrrigationForecast() {
  return useQuery({
    queryKey: ['irrigation', 'forecast'],
    queryFn: () => apiGet<IrrigationForecast>('/irrigation/forecast'),
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
  });
}
```

- [ ] **Passo 3: creare la card**

`rpi5/frontend/src/components/NextIrrigationCard.tsx`:

```tsx
import type { IrrigationForecast } from '../api/types';
import { fmtFraQuanto } from '../helpers/formatDuration';

interface Props {
  forecast: IrrigationForecast | undefined;
  loading?: boolean;
}

const REGOLE: Record<string, string> = {
  out_of_window: 'attende la finestra oraria',
  cooldown: 'attende la fine del cooldown',
  moisture_sufficient: 'attende che il terreno si asciughi',
  rain_delay: 'attende che passi la pioggia prevista',
  no_quorum: 'sonde insufficienti',
  valve_unreachable: 'valvola non raggiungibile',
  paused: 'sistema in pausa',
};

const NIENTE: Record<string, string> = {
  moisture_sufficient: 'Il terreno resta sopra soglia',
  rain_forecast: 'Pioggia prevista nei prossimi giorni',
  paused: 'Sistema in pausa',
  no_quorum: 'Sonde insufficienti per decidere',
};

function orario(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function NextIrrigationCard({ forecast, loading }: Props) {
  if (loading || !forecast) {
    return (
      <div className="card span-12">
        <div className="card-head"><h3>Prossima irrigazione</h3></div>
        <div className="metric" style={{ padding: '8px 0' }}><span className="num">…</span></div>
      </div>
    );
  }

  const n = forecast.next_irrigation;
  const pallini = '●'.repeat(forecast.confidence.level) + '○'.repeat(4 - forecast.confidence.level);

  return (
    <div className="card span-12">
      <div className="card-head">
        <h3>Prossima irrigazione</h3>
        <span className="eyebrow">{forecast.mode === 'auto' ? 'stima' : `modo ${forecast.mode}`}</span>
      </div>

      {n ? (
        <>
          <div className="metric" style={{ padding: '8px 0' }}>
            <span className="num">{orario(n.predicted_at)}</span>
            <span className="lbl">{fmtFraQuanto(n.predicted_at)}</span>
          </div>
          <p style={{ margin: '4px 0', opacity: 0.8 }}>
            fra {orario(n.band_start)} e {orario(n.band_end)}
          </p>
          <p style={{ margin: '4px 0' }}>
            <span title={forecast.confidence.reasons.join(' · ')}>{pallini}</span>{' '}
            {forecast.confidence.level >= 3 ? 'stima attendibile' : 'stima indicativa'}
          </p>
          <p style={{ margin: '4px 0', opacity: 0.8 }}>
            Apertura prevista ~{Math.round(n.expected_duration_seconds / 60)} min · {REGOLE[n.limiting_rule] ?? n.limiting_rule}
          </p>
        </>
      ) : (
        <>
          <div className="metric" style={{ padding: '8px 0' }}>
            <span className="num">Non prevista</span>
            <span className="lbl">nei prossimi 3 giorni</span>
          </div>
          <p style={{ margin: '4px 0', opacity: 0.8 }}>
            {NIENTE[forecast.no_irrigation_reason ?? ''] ?? 'Nessuna condizione di apertura'}
          </p>
        </>
      )}

      <p style={{ margin: '8px 0 0', opacity: 0.7, fontSize: '0.85em' }}>
        Umidità {forecast.current.moisture_mean ?? '—'}% · cala ~{forecast.current.drying_rate_pct_h} %/h
        {forecast.model.method === 'empirical' && ' · stima senza meteo'}
      </p>
    </div>
  );
}
```

- [ ] **Passo 4: inserire la card in Waterflow**

In `rpi5/frontend/src/pages/Waterflow.tsx`, aggiungere gli import:

```tsx
import { useIrrigationForecast } from '../api/forecast';
import { NextIrrigationCard } from '../components/NextIrrigationCard';
```

dentro il componente, accanto agli altri hook:

```tsx
  const forecastQ = useIrrigationForecast();
```

e come **prima** `<section>` dentro `<div className="tab-panel">`, sopra quella che
contiene `ValveCard`:

```tsx
      <section className="grid" style={{ marginBottom: 18 }}>
        <NextIrrigationCard forecast={forecastQ.data} loading={forecastQ.isLoading} />
      </section>
```

- [ ] **Passo 5: verificare compilazione e test frontend**

```bash
cd rpi5/frontend
npm run typecheck
npm test
npm run build
cd ../..
```

Atteso: nessun errore TypeScript, test esistenti verdi, build completata.

- [ ] **Passo 6: commit**

```bash
git add rpi5/frontend/src/api/forecast.ts rpi5/frontend/src/api/types.ts rpi5/frontend/src/components/NextIrrigationCard.tsx rpi5/frontend/src/pages/Waterflow.tsx rpi5/frontend/src/helpers/formatDuration.ts rpi5/frontend/src/helpers/formatDuration.test.ts
git commit -m "feat(frontend): card della prossima irrigazione su Waterflow

Mostra istante previsto, fascia di incertezza, pallini di confidenza, durata
prevista dell apertura e la regola che determina quel momento. Sta su
Waterflow perche e li che si decide se aprire a mano."
```

---

## Task 9: Deploy, verifica in campo, documentazione

- [ ] **Passo 1: eseguire tutta la suite**

```bash
node rpi5/nodered/test/put_layout.test.mjs
node rpi5/nodered/test/registro_sensori.test.mjs
node rpi5/nodered/test/meteo_parsing.test.mjs
node rpi5/nodered/test/config_forecast.test.mjs
node rpi5/nodered/test/regole_irrigazione.test.mjs
node rpi5/nodered/test/previsione.test.mjs
```

Atteso: `0 falliti` ovunque.

- [ ] **Passo 2: mettere il sistema in `dry_run` prima del deploy**

Il refactor del Task 3 tocca la logica che apre la valvola. Si deploya in `dry_run`,
si verifica, poi si torna in `auto`.

```bash
curl -k -X POST https://192.168.1.12/api/config/mode \
  -H 'Content-Type: application/json' -d '{"value":"dry_run"}'
```

- [ ] **Passo 3: deploy**

```bash
scp rpi5/nodered/data/flows.json as@192.168.1.12:/opt/orto-digitale/nodered/data/flows.json
scp rpi5/nodered/data/irrigation_config.json as@192.168.1.12:/opt/orto-digitale/nodered/data/irrigation_config.json
ssh as@192.168.1.12 'cd /opt/orto-digitale && docker compose restart nodered'
```

Poi il frontend, con lo script già esistente (build + rsync + reload Caddy):

```bash
bash rpi5/scripts/deploy_frontend.sh
# se l Ethernet non risponde:
RPI_HOST=as@192.168.1.46 bash rpi5/scripts/deploy_frontend.sh
```

- [ ] **Passo 4: ri-iniettare le credenziali Node-RED**

Obbligatorio dopo ogni redeploy di `flows.json`. Procedura in
`docs/comandi_verifica.md §5.5`.

- [ ] **Passo 5: healthcheck**

```bash
ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh'
```

Atteso: verde su tutti i controlli.

- [ ] **Passo 6: verifiche funzionali**

```bash
# la previsione risponde ed e fresca
curl -sk https://192.168.1.12/api/irrigation/forecast | head -40

# i punti arrivano su InfluxDB
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\") |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == \"irrigation_forecast\")
  |> count()
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN"'
```

Controllare inoltre, nell'editor Node-RED, che il nodo `libreria regole` mostri lo
stato `regole registrate` e che `decision logic` **non** riporti `regole mancanti`.

- [ ] **Passo 7: prova di degradazione**

Interrompere temporaneamente la raggiungibilità di Open-Meteo dal container (o
impostare `weather.api_url` a un host inesistente), attendere che la cache invecchi
oltre `cache_max_age_seconds`, e verificare che:

- `GET /api/irrigation/forecast` continui a rispondere con `model.method` a
  `empirical` e confidenza ridotta;
- `decision logic` continui a decidere (nessun blocco).

Poi ripristinare `weather.api_url`.

- [ ] **Passo 8: tornare in `auto` e osservare**

```bash
curl -k -X POST https://192.168.1.12/api/config/mode \
  -H 'Content-Type: application/json' -d '{"value":"auto"}'
```

Per una settimana, confrontare i punti `irrigation_forecast` con gli
`irrigation_events` reali.

- [ ] **Passo 9: aggiornare `CLAUDE.md`**

- Schema dati InfluxDB: aggiungere il measurement `irrigation_forecast`.
- Stato avanzamento: aggiungere la riga `15 | Previsione prossima irrigazione | ✅`.
- File chiave: aggiungere il nodo `libreria regole` come sede autoritativa della
  catena di regole, con la nota che `decision logic` non deve tornare a
  implementarla in proprio.
- Correggere, se presente, ogni riferimento al vecchio comportamento del parsing
  meteo.

- [ ] **Passo 10: marcare lo step come completato**

In coda a `docs/step15_previsione_prossima_irrigazione.md`:

```markdown
---
## Implementazione
**Stato:** ✅ COMPLETATO — <data>
**Commit di riferimento:** `<tipo(scope): descrizione>` (<hash breve>)
**Note:** [cosa ha funzionato, cosa si e dovuto adattare rispetto alla spec]
**Deviazioni dalla spec:** [nessuna | descrizione e motivazione]
```

Nelle note vanno riportati almeno: il valore di `k` ottenuto, l'errore mediano a
12 h, e l'esito della prova di degradazione.

- [ ] **Passo 11: merge**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(step15): marca come COMPLETATO"
git checkout main
git merge step/15-previsione
git push origin main
git branch -d step/15-previsione
```

---

## Verifica di copertura della spec

| Sezione spec | Task |
|---|---|
| §2 bug parsing meteo | 1 |
| §3 D1 modello ET0 | 5, 7 |
| §3 D2 stop al primo evento | 5 |
| §3 D3 fascia da dati | 5 |
| §3 D4 regole condivise | 3 |
| §3 D5 curva in memoria, non su Influx | 1 |
| §3 D6 degradazione | 5, 9 |
| §3 D7 scrittura su InfluxDB | 5 |
| §3 D8 API da context | 6 |
| §4 equazione, `k`, `r` | 5, 7 |
| §5 modulo regole e assunzioni | 3, 5 |
| §6 architettura del flow | 4, 5, 6 |
| §7 contratto API | 5, 6 |
| §8 degradazione e confidenza | 5, 9 |
| §9 configurazione | 2 |
| §10 interfaccia | 8 |
| §11 test e validazione | 1–7, 9 |
| §14 verifica end-to-end | 9 |
| §15 aggiornamenti a CLAUDE.md | 9 |
