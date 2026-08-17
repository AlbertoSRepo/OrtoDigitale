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
  const colonne = righe[idxHeader].trim().split(',');
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
