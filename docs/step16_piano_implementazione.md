# Step 16 (fase 1) — Modello di bagnatura: analisi offline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stimare da storico reale due coefficienti — `w_irr` (%/L, quanto sale l'umidità per litro d'acqua erogato) e `w_rain` (%/mm, quanto sale per mm di pioggia) — pulendo lo storico manuale (che mescola vera irrigazione orto e altri usi dello sblocco manuale) tramite un modello contro-fattuale basato sull'asciugatura già validata nello step 15.

**Architecture:** estensione mirata di `analysis/stima_k.mjs` (stesso script one-shot, stessa aritmetica dei percentili, stessa fonte dati Open-Meteo `/archive` già usata per ET0 e precipitazione). Nessuna pipeline nuova, nessun container nuovo, nessuna modifica a `flows.json`/config/frontend: fase 1 è analisi pura, e produce solo un report (`analysis/04_modello_bagnatura.md`) e uno script (`analysis/stima_bagnatura.mjs`).

**Tech Stack:** Node.js nudo (`node analysis/stima_bagnatura.mjs`, nessuna dipendenza npm), InfluxDB 2 (Flux, query di sola lettura), Open-Meteo `/archive` (fetch nativo).

**Spec:** [`docs/step16_modello_bagnatura.md`](./step16_modello_bagnatura.md)

## Global Constraints

Valori copiati dalla spec. Valgono per **ogni** task.

- **Branch:** `step/16-bagnatura-fase1`. `main` deve restare deployabile in ogni momento (questa fase non tocca produzione, quindi il rischio è comunque nullo, ma la disciplina resta).
- **Fase 1 è analisi pura**: nessuna modifica a `flows.json`, `irrigation_config.json` o al frontend. Nessun deploy sul RPi.
- **`k` non si ristima**: è già in produzione (step 15). Costante fissa nello script: `K = 1.296`.
- **Costanti geografiche e finestra di contaminazione**, identiche a `stima_k.mjs`: `LAT = 45.71722434055733`, `LON = 9.733793667999565`, `PRIMA_MS = 30*60000`, `DOPO_MS = 3*3600000`.
- **Portata valvola nota**: 0.8–0.9 m³/h, adottata come **14 L/min** (`FLOW_L_PER_MIN`). `total_liters` è **inaffidabile** (bug noto, step15 §2): mai usarlo come covariata.
- **Guardia minima campioni**: 15 candidati (irrigazione e pioggia separatamente) sotto cui il coefficiente non si fitta — dati insufficienti è un esito valido, non un fallimento (spec §5).
- **Niente banco di prova stile Node-RED**: `analysis/stima_bagnatura.mjs`, come `stima_k.mjs`, è uno script una-tantum che stampa e basta. Si valida con guard-rail interni (soglie minime, tabelle di sensibilità) ed esecuzione manuale, non con `.test.mjs`.
- **CSV in `analysis/*.csv` sono gitignored**: mai `git add` su `analysis/umidita.csv` o `analysis/eventi.csv`.
- **Percentile**: sempre "nearest-rank", stessa funzione `perc(arr, p)` di `stima_k.mjs` — due percentili nello stesso progetto devono significare la stessa cosa.
- **Deploy/accesso RPi**: `ssh as@192.168.1.12` (Ethernet, primario) — se non risponde, fallback `ssh as@192.168.1.46` (WiFi). Alla data di scrittura di questo piano l'Ethernet non rispondeva: usare `.46` se `.12` va in timeout.
- **Commit in italiano**, Conventional Commits, scope `scripts` o `docs`. Esempio: `feat(scripts): pavimento di rumore per il modello di bagnatura`.

---

## Struttura dei file

| File | Responsabilità |
|---|---|
| `analysis/eventi.csv` | export grezzo (gitignored) — ora con la tag `trigger` |
| `analysis/umidita.csv` | export grezzo (gitignored) — invariato rispetto allo step 15 |
| `analysis/stima_bagnatura.mjs` | tutto lo script: lettura CSV, fetch meteo storico, pavimento di rumore, contro-fattuale, attribuzione, fitting, backtest esteso |
| `analysis/04_modello_bagnatura.md` | risultati, riserve, raccomandazione su una fase 2 |
| `docs/step16_modello_bagnatura.md` | riceve la sezione `## Implementazione` a fine lavoro |
| `CLAUDE.md` | riga di stato avanzamento per lo step 16 |

---

## Task 0: Branch

- [ ] **Passo 1: creare il branch**

```bash
cd /c/Users/user/Desktop/Workspace/OrtoDigitale/dev
git checkout main
git pull
git checkout -b step/16-bagnatura-fase1
```

---

## Task 1: Esportare i dati grezzi (con la tag `trigger`)

**File:**
- Crea (gitignored, non committare): `analysis/eventi.csv`, `analysis/umidita.csv`

**Interfacce:**
- Produce: i due CSV su disco, letti da tutti i task successivi.

- [ ] **Passo 1: esportare dal RPi**

```bash
ssh -o ConnectTimeout=5 as@192.168.1.12 'echo ok' || echo "Ethernet non risponde, uso .46"
```

Con l'host che risponde (sostituire `HOST` sotto con `192.168.1.12` o `192.168.1.46`):

```bash
HOST=192.168.1.46   # o 192.168.1.12 se risponde

ssh "as@$HOST" 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -120d)
  |> filter(fn: (r) => r._measurement == \"soil_moisture\" and r._field == \"value\")
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> group()
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
  |> keep(columns:[\"_time\",\"_value\"])
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" --raw' > analysis/umidita.csv

ssh "as@$HOST" 'set -a; . /opt/orto-digitale/.env; set +a; \
  docker exec influxdb influx query "
from(bucket:\"garden\")
  |> range(start: -120d)
  |> filter(fn: (r) => r._measurement == \"irrigation_events\" and r._field == \"duration_seconds\" and r._value > 0)
  |> keep(columns:[\"_time\",\"_value\",\"trigger\"])
" --org orto-digitale --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" --raw' > analysis/eventi.csv
```

- [ ] **Passo 2: verificare a occhio le prime righe**

```bash
head -6 analysis/umidita.csv
head -6 analysis/eventi.csv
```

Atteso per `umidita.csv` (invariato rispetto allo step 15):

```
#group,false,false,false,false
#datatype,string,long,dateTime:RFC3339,double
#default,_result,,,
,result,table,_time,_value
,,0,...
```

Per `eventi.csv`, la riga di intestazione deve iniziare con `,result,table,` e contenere
`_time`, `_value` e `trigger` (l'ordine esatto delle colonne non è garantito — lo
script del Task 2 legge l'intestazione invece di assumere una posizione fissa).
Se `trigger` non compare nell'intestazione, la query non è quella del Passo 1:
ripetere il passo.

Non committare questi due file (`.gitignore` li esclude già: `analysis/*.csv`).

---

## Task 2: Scheletro dello script + pavimento di rumore (Fase A)

**File:**
- Crea: `analysis/stima_bagnatura.mjs`

**Interfacce:**
- Produce: `erroreProiezione(orizzonte_h, { wIrr, wRain })` → `{ puliti: {n,med,p90}, contaminati: {n,med,p90} }`. Consumato dai Task 3, 4, 6.
- Produce: `finestreIrrigazione` (array di `{inizio, fine, chiusura, durata_s, trigger, litri, tPicco}`, `tPicco` assente finché il Task 4 non lo valorizza). Consumato dai Task 3, 4, 6.
- Produce: `umidita`, `eventi`, `et0`, `pioggia`, `oraDi`, `contaminato`, `perc`, `K`. Consumati da tutti i task successivi.

- [ ] **Passo 1: scrivere lo scheletro e la Fase A**

```js
// Stima dei coefficienti di bagnatura w_irr (%/L) e w_rain (%/mm) — step 16 fase 1.
//
//   node analysis/stima_bagnatura.mjs
//
// Ingressi: analysis/umidita.csv (stesso formato di stima_k.mjs) e
// analysis/eventi.csv (esteso con la tag `trigger`, vedi Task 1 del piano).
// L'ET0 e la precipitazione storiche arrivano dall'archivio Open-Meteo, stessa
// chiamata di stima_k.mjs. k e' gia' fittato e in produzione (step 15): non si
// ristima qui, e' una costante. Nessuna scrittura: questo script stampa e basta.
//
// Script una-tantum: si esegue a mano, produce i numeri per il report, e resta
// come traccia di come ci si e' arrivati. Non e' richiamato da nulla.
import { readFileSync } from 'node:fs';

const LAT = 45.71722434055733;
const LON = 9.733793667999565;
const PRIMA_MS = 30 * 60000;
const DOPO_MS = 3 * 3600000;
const FLOW_L_PER_MIN = 14; // portata misurata stabile, step15 spec §2
const K = 1.296; // gia' in produzione (rpi5/nodered/data/irrigation_config.json)

// Percentile "nearest-rank", stessa aritmetica di stima_k.mjs: due percentili
// nello stesso progetto devono significare la stessa cosa.
const perc = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1))];

function leggiUmiditaCsv(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((r) => r.startsWith(',,'))
    .map((r) => r.split(','))
    .map((c) => ({ ts: Date.parse(c[c.length - 2]), v: Number(c[c.length - 1]) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
    .sort((a, b) => a.ts - b.ts);
}

// Parser dedicato per eventi.csv: a differenza di umidita.csv, ora porta anche
// la tag `trigger`, che sposta l'ordine delle colonne nell'output annotato di
// Influx. Si legge l'intestazione reale (riga che inizia con ",result,table,")
// invece di assumere una posizione fissa. Le righe di intestazione/annotazione
// di eventuali blocchi successivi (se la query restituisce piu' tabelle, una
// per valore di trigger) vengono scartate automaticamente dal filtro
// Number.isFinite qui sotto: non sono date ne' numeri validi.
function leggiEventiCsv(path) {
  const righe = readFileSync(path, 'utf8').split('\n').filter((r) => r.trim().length > 0);
  const idxHeader = righe.findIndex((r) => r.startsWith(',result,table,'));
  if (idxHeader < 0) throw new Error('header non trovato in eventi.csv (atteso ,result,table,...)');
  const colonne = righe[idxHeader].split(',');
  const iTime = colonne.indexOf('_time');
  const iValue = colonne.indexOf('_value');
  const iTrigger = colonne.indexOf('trigger');
  if (iTime < 0 || iValue < 0 || iTrigger < 0) {
    throw new Error(`colonne mancanti in eventi.csv: _time=${iTime} _value=${iValue} trigger=${iTrigger}`);
  }
  return righe.slice(idxHeader + 1)
    .map((r) => r.split(','))
    .map((c) => ({ ts: Date.parse(c[iTime]), durata_s: Number(c[iValue]), trigger: (c[iTrigger] || '').trim() }))
    .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.durata_s) && e.durata_s > 0)
    .sort((a, b) => a.ts - b.ts);
}

const umidita = leggiUmiditaCsv('analysis/umidita.csv');
const eventi = leggiEventiCsv('analysis/eventi.csv');
if (umidita.length < 100) { console.error('serie di umidita troppo corta'); process.exit(1); }
if (eventi.length < 1) { console.error('nessun evento di irrigazione trovato'); process.exit(1); }

// Finestre di irrigazione: [inizio evento, chiusura + DOPO_MS]. tPicco viene
// valorizzato dal Task 4 (Fase D) sui soli eventi classificati "irrigazione".
const finestreIrrigazione = eventi.map((e) => ({
  inizio: e.ts - e.durata_s * 1000,
  fine: e.ts + DOPO_MS,
  chiusura: e.ts,
  durata_s: e.durata_s,
  trigger: e.trigger,
  litri: e.durata_s * (FLOW_L_PER_MIN / 60),
  tPicco: null,
}));
const contaminato = (ts) => finestreIrrigazione.some((f) => ts >= f.inizio - PRIMA_MS && ts <= f.fine);

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

console.log(`periodo: ${da} .. ${a}`);
console.log(`eventi valvola: ${eventi.length} (trigger: ${[...new Set(eventi.map((e) => e.trigger))].join(', ')})`);

// ============================================================
// erroreProiezione: proietta "asciugatura (+ eventuale bagnatura)"
// dal punto p fino a p.ts + orizzonte_h, confronta col valore reale.
// Riporta separatamente gli intervalli "puliti" (nessuna finestra di
// irrigazione attraversata) e "contaminati" (almeno una attraversata).
// Con wIrr=wRain=0 e nessun tPicco valorizzato, "contaminati" e "puliti"
// coincidono col comportamento di sola asciugatura di stima_k.mjs.
// Riusata dal Task 2 (Fase A, orizzonte corto, solo puliti) e dal Task 6
// (Fase F, orizzonti lunghi, entrambi i bucket, coefficienti fittati).
// ============================================================
function erroreProiezione(orizzonte_h, { wIrr = 0, wRain = 0 } = {}) {
  const puliti = [];
  const contaminati = [];
  for (let i = 0; i < umidita.length; i++) {
    const p = umidita[i];
    const bersaglio = p.ts + orizzonte_h * 3600000;
    const j = umidita.findIndex((x) => x.ts >= bersaglio);
    if (j < 0) continue;
    const reale = umidita[j];
    if (Math.abs(reale.ts - bersaglio) > 30 * 60000) continue;
    let sporco = false;
    for (let t = p.ts; t <= reale.ts; t += 900000) if (contaminato(t)) { sporco = true; break; }
    let m = p.v;
    for (let t = p.ts; t < reale.ts; t += 900000) {
      const h = oraDi(t);
      if (h < 0) { m = NaN; break; }
      m -= K * (et0[h] || 0) * 0.25;
      m += wRain * (pioggia[h] || 0) * 0.25;
      for (const f of finestreIrrigazione) {
        if (f.tPicco != null && t <= f.tPicco && f.tPicco < t + 900000) m += wIrr * f.litri;
      }
    }
    if (!Number.isFinite(m)) continue;
    (sporco ? contaminati : puliti).push(Math.abs(m - reale.v));
  }
  const riassumi = (arr) => {
    arr.sort((x, y) => x - y);
    return { n: arr.length, med: arr.length ? perc(arr, 0.5) : NaN, p90: arr.length ? perc(arr, 0.9) : NaN };
  };
  return { puliti: riassumi(puliti), contaminati: riassumi(contaminati) };
}

console.log('\n--- FASE A: pavimento di rumore (modello di sola asciugatura, orizzonte 2h) ---');
const pavimento = erroreProiezione(2, {}).puliti;
console.log(`campioni: ${pavimento.n} | errore mediano: ${pavimento.med.toFixed(2)} pp | errore p90: ${pavimento.p90.toFixed(2)} pp`);
if (pavimento.n < 30) { console.error('troppo pochi campioni puliti per stimare il pavimento di rumore'); process.exit(1); }
```

- [ ] **Passo 2: eseguire e verificare**

```bash
node analysis/stima_bagnatura.mjs
```

Atteso: stampa il periodo coperto, il numero di eventi valvola coi trigger distinti
trovati, e la riga della Fase A con un numero di campioni ≥ 30 e due errori in
punti percentuali. Se lo script termina con `nessun evento di irrigazione trovato`
o `header non trovato in eventi.csv`, tornare al Task 1.

- [ ] **Passo 3: commit**

```bash
git add analysis/stima_bagnatura.mjs
git commit -m "feat(scripts): pavimento di rumore per il modello di bagnatura

Scheletro di analysis/stima_bagnatura.mjs (step 16 fase 1): lettura CSV,
fetch ET0+precipitazione storica da Open-Meteo /archive, e la funzione
erroreProiezione condivisa da tutte le fasi successive. La Fase A misura
l errore naturale del modello di sola asciugatura (k gia fittato dallo
step 15) su un orizzonte di 2h: e il pavimento di rumore sotto cui un
residuo non conta come sorpresa (Fase C, prossimo task)."
```

---

## Task 3: Contro-fattuale continua e rilevazione delle sorprese (Fase B/C)

**File:**
- Modifica: `analysis/stima_bagnatura.mjs`

**Interfacce:**
- Produce: `residuoDiPicco(inizio, fine)` → `{ts, residuo, controFattuale, osservato}` o `null`. Consumato dal Task 4.
- Produce: `finestrePioggia` (array di `{inizio, fine, fineFinestra, mm}`, eventi di pioggia raggruppati da ore consecutive). Consumato dai Task 4, 6.

- [ ] **Passo 1: aggiungere la contro-fattuale continua e il raggruppamento delle piogge**

Aggiungere in coda al file (dopo il blocco della Fase A del Task 2):

```js
// ============================================================
// FASE B — contro-fattuale continua attraverso una finestra (a
// differenza di erroreProiezione, che nella modalita "puliti" la
// finestra la esclude): riparte dall'ultimo campione pulito prima
// dell'inizio finestra e proietta "solo asciugatura" fino alla fine,
// campione per campione. Il residuo (osservato - contro-fattuale) e
// la "sorpresa": quanto la realta si scosta da cio che l'asciugatura
// da sola avrebbe prodotto.
// ============================================================

// Ultimo campione di umidita, a o prima di ts, che non cade in nessuna
// finestra di irrigazione.
function ultimoCampionePulito(ts) {
  for (let i = umidita.length - 1; i >= 0; i--) {
    if (umidita[i].ts > ts) continue;
    if (!contaminato(umidita[i].ts)) return umidita[i];
  }
  return null;
}

// Residuo di picco in (inizio, fine]: il campione dove osservato meno
// contro-fattuale e' massimo. Ritorna null se manca un punto di partenza
// pulito o se la finestra non contiene campioni.
function residuoDiPicco(inizio, fine) {
  const base = ultimoCampionePulito(inizio);
  if (!base) return null;
  const campioniFinestra = umidita.filter((s) => s.ts > inizio && s.ts <= fine);
  if (campioniFinestra.length === 0) return null;
  let controFattuale = base.v;
  let tPrec = base.ts;
  let migliore = null;
  for (const s of campioniFinestra) {
    for (let t = tPrec; t < s.ts && Number.isFinite(controFattuale); t += 900000) {
      const h = oraDi(t);
      if (h < 0) { controFattuale = NaN; break; }
      controFattuale -= K * (et0[h] || 0) * 0.25;
    }
    tPrec = s.ts;
    if (!Number.isFinite(controFattuale)) continue;
    const residuo = s.v - controFattuale;
    if (!migliore || residuo > migliore.residuo) {
      migliore = { ts: s.ts, residuo, controFattuale, osservato: s.v };
    }
  }
  return migliore;
}

// Raggruppa le ore di pioggia (dall'archivio orario) in eventi continui:
// ore consecutive con pioggia[h] > 0 diventano un unico evento. Un'ora
// secca interrompe il gruppo (nessuna tolleranza a buchi, semplificazione
// dichiarata nella spec §4).
function eventiPioggia() {
  const eventi = [];
  let corrente = null;
  for (let i = 0; i < tempo.length; i++) {
    const mm = pioggia[i] || 0;
    if (mm > 0) {
      if (!corrente) corrente = { inizio: tempo[i] * 1000, fine: (tempo[i] + 3600) * 1000, mm };
      else { corrente.fine = (tempo[i] + 3600) * 1000; corrente.mm += mm; }
    } else if (corrente) {
      eventi.push(corrente);
      corrente = null;
    }
  }
  if (corrente) eventi.push(corrente);
  return eventi;
}
const finestrePioggia = eventiPioggia()
  .filter((e) => e.inizio >= umidita[0].ts && e.fine <= umidita[umidita.length - 1].ts)
  .map((e) => ({ ...e, fineFinestra: e.fine + DOPO_MS }));

console.log(`\nore di pioggia raggruppate in ${finestrePioggia.length} eventi (periodo coperto)`);

// --- tabella di sensibilita' sul fattore di sicurezza (Fase C) ---
console.log('\n--- FASE B/C: sorprese per fattore di sicurezza (soglia = fattore * pavimento mediano) ---');
console.log('fattore | soglia (pp) | sorprese irrigazione | sorprese pioggia');
for (const fattore of [1.5, 2, 3]) {
  const soglia = fattore * pavimento.med;
  const nIrr = finestreIrrigazione.filter((f) => {
    const r = residuoDiPicco(f.inizio, f.fine);
    return r && Math.abs(r.residuo) > soglia;
  }).length;
  const nPioggia = finestrePioggia.filter((f) => {
    const r = residuoDiPicco(f.inizio, f.fineFinestra);
    return r && Math.abs(r.residuo) > soglia;
  }).length;
  console.log(`${fattore.toFixed(1).padStart(7)} | ${soglia.toFixed(2).padStart(11)} | ${String(nIrr).padStart(21)} | ${String(nPioggia).padStart(16)}`);
}
```

- [ ] **Passo 2: eseguire e verificare**

```bash
node analysis/stima_bagnatura.mjs
```

Atteso: in più rispetto al Task 2, il numero di eventi di pioggia raggruppati e
la tabella di sensibilità con 3 righe (fattori 1.5/2/3). Il conteggio delle
sorprese-irrigazione non può superare il numero di eventi valvola totali
stampato dal Task 2; il conteggio delle sorprese-pioggia non può superare il
numero di eventi di pioggia raggruppati appena stampato.

- [ ] **Passo 3: commit**

```bash
git add analysis/stima_bagnatura.mjs
git commit -m "feat(scripts): rilevazione delle sorprese nel modello di bagnatura

Fase B: proiezione contro-fattuale continua attraverso le finestre di
irrigazione (a differenza del fit di k, che le esclude). Fase C: tabella
di sensibilita sul fattore di sicurezza che decide quando un residuo
conta come sorpresa invece che rumore del modello di asciugatura."
```

---

## Task 4: Attribuzione (Fase D) — irrigazione, pioggia, ambiguo, scartato

**File:**
- Modifica: `analysis/stima_bagnatura.mjs`

**Interfacce:**
- Consuma: la tabella di sensibilità stampata dal Task 3 (lettura umana, per scegliere `FATTORE_SICUREZZA`).
- Produce: `candidatiIrrigazione`, `candidatiPioggia` (array con `{..., esito:'irrigazione'|'pioggia', tPicco, residuo}`). Consumati dal Task 5.
- Effetto collaterale: valorizza `tPicco` sulle entry di `finestreIrrigazione` corrispondenti ai candidati irrigazione — è quello che rende `erroreProiezione` capace di iniettare `wIrr` nel Task 6.

- [ ] **Passo 1: leggere la tabella del Task 3 e scegliere `FATTORE_SICUREZZA`**

Eseguire `node analysis/stima_bagnatura.mjs` e guardare l'output della Fase B/C.
Stesso criterio già usato per `PAVIMENTO_ET0_MM_H` in `stima_k.mjs`: scegliere il
fattore più basso fra {1.5, 2, 3} oltre il quale il conteggio delle sorprese
(sia irrigazione sia pioggia) smette di calare rapidamente — il punto in cui si
passa dallo scartare rumore residuo allo scartare segnale vero. Se i tre
conteggi calano in modo pressoché lineare senza un gomito evidente, usare 2
come default conservativo (a metà dell'intervallo testato) e annotarlo nel
report del Task 7 come scelta non netta.

- [ ] **Passo 2: aggiungere l'attribuzione**

Aggiungere in coda al file:

```js
// ============================================================
// FASE D — attribuzione. FATTORE_SICUREZZA e' stato scelto leggendo la
// tabella di sensibilita' stampata sopra (Passo 1 di questo task):
// aggiornare qui il valore e la riga di motivazione se il numero scelto
// e' diverso da 2.
// ============================================================
const FATTORE_SICUREZZA = 2; // vedi Passo 1: fattore piu basso prima che il conteggio si stabilizzi
const soglia = FATTORE_SICUREZZA * pavimento.med;

function classificaIrrigazione(f) {
  const r = residuoDiPicco(f.inizio, f.fine);
  if (!r || Math.abs(r.residuo) <= soglia) return { ...f, esito: 'scartato_rumore' };
  const pioggiaVicina = finestrePioggia.some((p) => p.inizio <= f.fine && p.fineFinestra >= f.inizio);
  if (pioggiaVicina) return { ...f, esito: 'scartato_ambiguo' };
  return { ...f, esito: 'irrigazione', tPicco: r.ts, residuo: r.residuo };
}

function classificaPioggia(f) {
  const r = residuoDiPicco(f.inizio, f.fineFinestra);
  if (!r || Math.abs(r.residuo) <= soglia) return { ...f, esito: 'scartato_rumore' };
  const valvolaVicina = finestreIrrigazione.some((e) => e.inizio <= f.fineFinestra && e.fine >= f.inizio);
  if (valvolaVicina) return { ...f, esito: 'scartato_ambiguo' };
  return { ...f, esito: 'pioggia', tPicco: r.ts, residuo: r.residuo };
}

const irrigazioneClassificata = finestreIrrigazione.map(classificaIrrigazione);
const pioggiaClassificata = finestrePioggia.map(classificaPioggia);

// Riporta tPicco sulle finestreIrrigazione originali (quelle che
// erroreProiezione legge nel Task 6): senza questo passaggio il backtest
// esteso non saprebbe dove iniettare il contributo di w_irr.
for (const f of irrigazioneClassificata) {
  if (f.esito === 'irrigazione') {
    const orig = finestreIrrigazione.find((x) => x.chiusura === f.chiusura);
    orig.tPicco = f.tPicco;
  }
}

console.log(`\n--- FASE D: attribuzione (fattore di sicurezza = ${FATTORE_SICUREZZA}, soglia = ${soglia.toFixed(2)} pp) ---`);
for (const [nome, arr] of [['irrigazione', irrigazioneClassificata], ['pioggia', pioggiaClassificata]]) {
  const conteggi = arr.reduce((acc, f) => { acc[f.esito] = (acc[f.esito] || 0) + 1; return acc; }, {});
  console.log(`${nome}: ${JSON.stringify(conteggi)}`);
}

const candidatiIrrigazione = irrigazioneClassificata.filter((f) => f.esito === 'irrigazione');
const candidatiPioggia = pioggiaClassificata.filter((f) => f.esito === 'pioggia');
console.log(`candidati puliti: ${candidatiIrrigazione.length} irrigazione, ${candidatiPioggia.length} pioggia`);
```

- [ ] **Passo 3: eseguire e verificare**

```bash
node analysis/stima_bagnatura.mjs
```

Atteso: le righe `irrigazione: {...}` e `pioggia: {...}` con conteggi per
`esito` che sommano rispettivamente al totale eventi valvola e al totale eventi
pioggia già stampati. L'ultima riga riporta i candidati puliti — questo numero,
confrontato con la guardia minima di 15 (vincoli globali), determina se il
Task 5 potrà fittare entrambi i coefficienti, uno solo, o nessuno.

- [ ] **Passo 4: commit**

```bash
git add analysis/stima_bagnatura.mjs
git commit -m "feat(scripts): attribuzione delle sorprese nel modello di bagnatura

Fase D: ogni sorpresa (Fase C) viene classificata come irrigazione,
pioggia, ambigua (entrambe vicine, scartata) o rumore (nessuna delle
due, scartata) confrontando le finestre di valvola con gli eventi di
pioggia raggruppati. E il passaggio che pulisce lo storico manuale: un
apertura valvola senza salita vera (acqua usata per altro) non supera
mai la soglia di sorpresa, quindi non entra mai fra i candidati."
```

---

## Task 5: Fitting di `w_irr` e `w_rain` (Fase E)

**File:**
- Modifica: `analysis/stima_bagnatura.mjs`

**Interfacce:**
- Consuma: `candidatiIrrigazione`, `candidatiPioggia` (Task 4).
- Produce: `wIrrStat`, `wRainStat` (`{n, p10, mediana, p90}` o `null` se sotto la guardia minima). Consumati dal Task 6.

- [ ] **Passo 1: aggiungere il fitting**

```js
// ============================================================
// FASE E — fitting. Stessi percentili 10/50/90 di k, sulla stessa
// aritmetica nearest-rank. Guardia a 15 campioni minimi (vincoli
// globali): sotto quella soglia il coefficiente resta null, non si
// forza un numero da un campione non significativo.
// ============================================================
function fitCoefficiente(candidati, campo) {
  if (candidati.length < 15) return null;
  const rapporti = candidati
    .map((c) => c.residuo / c[campo])
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  if (rapporti.length < 15) return null;
  return { n: rapporti.length, p10: perc(rapporti, 0.1), mediana: perc(rapporti, 0.5), p90: perc(rapporti, 0.9) };
}

const wIrrStat = fitCoefficiente(candidatiIrrigazione, 'litri');
const wRainStat = fitCoefficiente(candidatiPioggia, 'mm');

console.log('\n--- FASE E: fitting w_irr / w_rain ---');
if (!wIrrStat) {
  console.log(`w_irr: DATI INSUFFICIENTI (${candidatiIrrigazione.length} candidati, servono >= 15)`);
} else {
  console.log(`w_irr = ${wIrrStat.mediana.toFixed(4)} %/L  (n=${wIrrStat.n}, p10=${wIrrStat.p10.toFixed(4)}, p90=${wIrrStat.p90.toFixed(4)})`);
  if (!(wIrrStat.p10 <= wIrrStat.mediana && wIrrStat.mediana <= wIrrStat.p90)) {
    console.error(`ordinamento p10 <= w_irr <= p90 VIOLATO — non usare questo valore`);
    process.exit(1);
  }
}
if (!wRainStat) {
  console.log(`w_rain: DATI INSUFFICIENTI (${candidatiPioggia.length} candidati, servono >= 15)`);
} else {
  console.log(`w_rain = ${wRainStat.mediana.toFixed(4)} %/mm  (n=${wRainStat.n}, p10=${wRainStat.p10.toFixed(4)}, p90=${wRainStat.p90.toFixed(4)})`);
  if (!(wRainStat.p10 <= wRainStat.mediana && wRainStat.mediana <= wRainStat.p90)) {
    console.error(`ordinamento p10 <= w_rain <= p90 VIOLATO — non usare questo valore`);
    process.exit(1);
  }
}
if (!wIrrStat && !wRainStat) {
  console.error('\nNessuno dei due coefficienti e stimabile con i dati attuali.');
  console.error('Esito valido per la fase 1 (spec §5): fermarsi qui, servono piu settimane');
  console.error('di mode=auto (eventi trigger=auto sono puliti per costruzione) prima di riprovare.');
  process.exit(1);
}
```

- [ ] **Passo 2: eseguire e verificare**

```bash
node analysis/stima_bagnatura.mjs
```

Atteso: due righe con `w_irr`/`w_rain` (numero + p10/p90) oppure `DATI
INSUFFICIENTI` per ciascuno. Se **entrambi** sono insufficienti, lo script esce
con codice 1 — è l'esito "servono più dati" della spec §5, non un errore da
correggere: passare comunque al Task 7 per scrivere il report con questa
conclusione esplicita, poi al Task 8 (non ci sarà backtest esteso da fare nel
Task 6 in questo caso, vedi nota lì).

- [ ] **Passo 3: commit**

```bash
git add analysis/stima_bagnatura.mjs
git commit -m "feat(scripts): fitting di w_irr e w_rain

Fase E: percentili 10/50/90 (stessa aritmetica di k) sul rapporto
residuo/litri per l irrigazione e residuo/mm per la pioggia, con
guardia a 15 campioni minimi. Sotto la guardia il coefficiente resta
non stimato invece di forzare un numero non significativo."
```

---

## Task 6: Backtest esteso e lettura del cancello (Fase F)

Salta questo task (vai al Task 7) se il Task 5 si è fermato con **entrambi** i
coefficienti a `DATI INSUFFICIENTI`: non c'è nulla da iniettare nel backtest.

**File:**
- Modifica: `analysis/stima_bagnatura.mjs`

**Interfacce:**
- Consuma: `erroreProiezione` (Task 2), `wIrrStat`, `wRainStat` (Task 5).
- Produce: la tabella stampata che alimenta la raccomandazione del Task 7. Nessuna soglia di accettazione è fissata nel codice (spec §5, D3): la decisione si legge dai numeri.

- [ ] **Passo 1: aggiungere il backtest esteso**

```js
// ============================================================
// FASE F — backtest esteso. Confronto onesto a tre colonne sugli stessi
// orizzonti gia' usati per k (6/12/24h):
//   1. puliti, solo asciugatura      — gia' calcolato per k, riferimento
//   2. contaminati, modello esteso   — w_irr/w_rain iniettati dove serve
//   3. contaminati, solo asciugatura — stessi intervalli della colonna 2,
//      ma SENZA alcun termine di bagnatura: mostra quanto sarebbe
//      sbagliato ignorare l'evento, a parita' di campioni
// Nessuna soglia di accettazione qui: la spec (D3, §5) chiede di leggere
// il numero prima di fissarla, non di calarla dall'alto.
// ============================================================
const wIrrFinale = wIrrStat ? wIrrStat.mediana : 0;
const wRainFinale = wRainStat ? wRainStat.mediana : 0;

console.log('\n--- FASE F: backtest esteso (asciugatura + bagnatura) ---');
console.log(`w_irr usato: ${wIrrStat ? wIrrFinale.toFixed(4) : '0 (dati insufficienti)'}  w_rain usato: ${wRainStat ? wRainFinale.toFixed(4) : '0 (dati insufficienti)'}`);
console.log('orizzonte | 1) puliti/solo-asciugatura med,p90 (n) | 2) contaminati/esteso med,p90 (n) | 3) contaminati/solo-asciugatura med,p90 (n)');
for (const ore of [6, 12, 24]) {
  const base = erroreProiezione(ore, {});
  const esteso = erroreProiezione(ore, { wIrr: wIrrFinale, wRain: wRainFinale });
  const c1 = `${base.puliti.med.toFixed(2)},${base.puliti.p90.toFixed(2)} (${base.puliti.n})`;
  const c2 = `${esteso.contaminati.med.toFixed(2)},${esteso.contaminati.p90.toFixed(2)} (${esteso.contaminati.n})`;
  const c3 = `${base.contaminati.med.toFixed(2)},${base.contaminati.p90.toFixed(2)} (${base.contaminati.n})`;
  console.log(`${String(ore).padStart(8)}h | ${c1.padStart(38)} | ${c2.padStart(34)} | ${c3.padStart(38)}`);
}
```

- [ ] **Passo 2: eseguire e leggere il risultato**

```bash
node analysis/stima_bagnatura.mjs
```

Questa fase itera l'intero storico per 6 combinazioni (3 orizzonti × 2
varianti): può richiedere qualche decina di secondi, non è bloccato.

**Non è un cancello pass/fail automatico.** Leggere la tabella confrontando la
colonna 2 (modello esteso) con la colonna 3 (nessuna bagnatura, stessi
intervalli): se a 12h la colonna 2 ha un errore mediano chiaramente più basso
della colonna 3, il modello sta aggiungendo segnale reale. Se le due colonne
sono vicine o la 2 è peggiore, il modello di bagnatura non sta migliorando le
cose rispetto a ignorare l'evento — annotare questo esito onestamente, non è
un errore di implementazione da correggere finché il codice rispecchia
l'algoritmo della spec.

- [ ] **Passo 3: commit**

```bash
git add analysis/stima_bagnatura.mjs
git commit -m "feat(scripts): backtest esteso del modello di bagnatura

Fase F: confronto a tre colonne fra il modello di sola asciugatura (dati
puliti, riferimento gia noto da k), il modello esteso sugli intervalli
che attraversano un evento, e lo stesso intervallo SENZA bagnatura —
per vedere se aggiungere w_irr/w_rain migliora davvero la proiezione o
no. Nessuna soglia di accettazione fissata nel codice: si legge dal
risultato, si argomenta nel report (prossimo task)."
```

---

## Task 7: Report `analysis/04_modello_bagnatura.md`

**File:**
- Crea: `analysis/04_modello_bagnatura.md`

**Interfacce:**
- Consuma: tutto l'output stampato dai Task 2-6.
- Produce: la raccomandazione esplicita su una fase 2, che il Task 8 riporta nel diario dello step.

- [ ] **Passo 1: scrivere il report**

Stesso formato di `analysis/03_stima_asciugatura.md`. Includere, in quest'ordine:

1. **Intestazione**: data di esecuzione, periodo coperto, scope (una riga:
   "stima di w_irr/w_rain per lo step 16 fase 1, vedi
   `docs/step16_modello_bagnatura.md`").
2. **Dati di partenza**: numero di eventi valvola totali e per trigger, numero
   di eventi di pioggia raggruppati (output Task 2/3).
3. **Pavimento di rumore**: il numero della Fase A.
4. **Tabella di sensibilità** sul fattore di sicurezza (Fase B/C, Task 3), con
   il fattore scelto e la motivazione (Task 4, Passo 1).
5. **Attribuzione**: i conteggi per esito (Fase D), con un commento esplicito
   su quanti eventi manuali storici sono stati esclusi come "acqua per altro
   uso" (esito `scartato_rumore` con residuo vicino a zero) — è il numero che
   risponde direttamente al problema dei dati sporchi posto a inizio step 16.
6. **Coefficienti**: `w_irr`/`w_rain` con p10/mediana/p90, o la dichiarazione
   esplicita di dati insufficienti per uno o entrambi.
7. **Backtest esteso**: la tabella a tre colonne (Fase F), con l'osservazione
   onesta se il modello migliora la colonna 3 o no.
8. **Raccomandazione**, una delle tre, argomentata in 2-3 frasi:
   - **Procedere a una fase 2** (wiring live nel simulatore step 15) — solo se
     il backtest mostra un miglioramento chiaro a 12h.
   - **Non procedere ora, servono più dati** — se uno o entrambi i coefficienti
     sono `DATI INSUFFICIENTI`, o il miglioramento nel backtest non è netto.
     Notare che ogni settimana di `mode=auto` aggiunge eventi puliti per
     costruzione (§2 della spec), quindi questo non è un vicolo cieco.
   - **Non procedere, il modello non aiuta** — se il backtest mostra che la
     colonna 2 non batte la colonna 3 in modo convincente nemmeno con più
     eventi puliti attesi in futuro (giudizio via, da usare con cautela: un
     solo giro di dati raramente giustifica questa conclusione così netta).

- [ ] **Passo 2: commit**

```bash
git add analysis/04_modello_bagnatura.md
git commit -m "docs(scripts): report del modello di bagnatura (step 16 fase 1)

Numeri del fitting w_irr/w_rain, tabella di sensibilita sul fattore di
sicurezza, attribuzione delle sorprese (quanti eventi manuali storici
erano acqua per altro uso), backtest esteso a tre colonne, e
raccomandazione esplicita su una fase 2."
```

---

## Task 8: Diario di implementazione, `CLAUDE.md`, merge

**File:**
- Modifica: `docs/step16_modello_bagnatura.md` (sezione `## Implementazione`)
- Modifica: `CLAUDE.md` (stato avanzamento)

- [ ] **Passo 1: aggiungere `## Implementazione` in coda a `docs/step16_modello_bagnatura.md`**

```markdown
---
## Implementazione
**Stato:** ✅ COMPLETATO (fase 1) — <data>
**Commit di riferimento:** `<ultimo commit rilevante>` (<hash breve>)
**Note:** [numero di eventi storici classificati per esito, w_irr/w_rain
ottenuti o dati insufficienti, risultato del backtest a tre colonne,
raccomandazione sulla fase 2 — riassunto di analysis/04_modello_bagnatura.md]
**Deviazioni dalla spec:** [nessuna | descrizione e motivazione — in
particolare se il fattore di sicurezza scelto al Task 4 non ha un gomito
netto nella tabella di sensibilita]
```

- [ ] **Passo 2: aggiornare `CLAUDE.md`**

Nella tabella **Stato avanzamento**, riga 16: sostituire

```
| 16 | Modello di bagnatura (quanto sale l'umidità irrigando) | ⏳ Prossimo |
```

con, a seconda della raccomandazione scritta nel report:

```
| 16 | Modello di bagnatura (fase 1 — analisi offline: w_irr/w_rain) | ✅ (fase 1; fase 2 <procedere / da rivalutare / non prevista> — vedi analysis/04_modello_bagnatura.md) |
```

Nessun'altra modifica a `CLAUDE.md`: fase 1 non tocca lo schema InfluxDB, non
aggiunge container, non aggiunge file chiave di produzione (`stima_bagnatura.mjs`
non gira in produzione, stesso trattamento di `stima_k.mjs`, che infatti non è
in tabella).

- [ ] **Passo 3: verificare `git status` prima di committare**

```bash
git status --short
```

Atteso: solo `docs/step16_modello_bagnatura.md` e `CLAUDE.md` modificati.
`analysis/eventi.csv` e `analysis/umidita.csv` **non devono comparire** (sono
gitignored) — se compaiono, è un segno che `.gitignore` è stato toccato per
errore altrove: fermarsi e controllare prima di procedere.

- [ ] **Passo 4: commit e merge**

```bash
git add docs/step16_modello_bagnatura.md CLAUDE.md
git commit -m "docs(step16): marca fase 1 come COMPLETATA

Riassunto in CLAUDE.md e nel diario dello step: risultato del fitting
w_irr/w_rain, esito del backtest esteso, raccomandazione sulla fase 2.
Nessuna modifica a produzione (flows.json/config/frontend invariati)."

git checkout main
git merge step/16-bagnatura-fase1
git push origin main
git branch -d step/16-bagnatura-fase1
```

---

## Verifica di copertura della spec

| Sezione spec | Task |
|---|---|
| §1 obiettivo (w_irr, w_rain) | 5 |
| §2 stato di partenza, riuso di stima_k.mjs | 2, 3 |
| §3 D1 regressione semplice | 5 (nessun ML introdotto) |
| §3 D2 contro-fattuale | 3 |
| §3 D3 pavimento misurato | 2, 4 |
| §3 D4 finestre ambigue scartate | 4 |
| §3 D5 litri da portata nota | 2 (campo `litri`), 5 |
| §3 D6 fase 1 analisi pura | tutto il piano (nessun task tocca produzione) |
| §4 fasi A-E | 2 (A), 3 (B/C), 4 (D), 5 (E) |
| §5 backtest esteso, cancello, guardia campioni | 5 (guardia), 6 (backtest) |
| §6 file toccati | 1, 2, 7 |
| §7 fuori scope | rispettato (nessun task tocca flows.json/config/frontend, nessuna modellazione per-sonda) |
| §8 verifica di completamento | 7, 8 |
| §9 aggiornamenti a CLAUDE.md | 8 |
