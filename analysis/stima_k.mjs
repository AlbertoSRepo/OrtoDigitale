// Stima del coefficiente di asciugatura k (%/mm) per lo step 15.
//
//   node analysis/stima_k.mjs
//
// Ingressi: analysis/umidita.csv e analysis/eventi.csv esportati da InfluxDB
// (vedi Task 7 nel piano di implementazione dello step 15 per le due query
// di sola lettura usate per generarli). L'ET0 storica arriva dall'archivio
// Open-Meteo. Nessuna scrittura: questo script stampa e basta.
//
// Script una-tantum: si esegue a mano, produce i numeri per la configurazione,
// e resta come traccia di come ci si e' arrivati. Non e' richiamato da nulla.
//
// CORREZIONE rispetto alla prima versione: l'esclusione originale sul passo
// di ET0 cumulato (et0[h]*dt_h <= 0.001 mm) lascia passare campioni con ET0
// orario vicino a zero (tipicamente notturno). Il fitting e' un rapporto
// (calo/et0Passo), non una regressione: quando il denominatore e' minuscolo,
// qualunque rumore della sonda diviso per esso produce rapporti fisicamente
// assurdi (osservato fino a 1900 %/mm su questi dati). Sostituito con un
// pavimento esplicito sull'ET0 orario (mm/h): sotto quella soglia il campione
// non entra nel fitting. Il pavimento e' scelto con un'analisi di
// sensibilita' (vedi in fondo a questo file) e argomentato su basi fisiche,
// non sul risultato del backtest — vedi il report del Task 7 per il dettaglio
// della scelta.
import { readFileSync } from 'node:fs';

const LAT = 45.71722434055733;
const LON = 9.733793667999565;
const PRIMA_MS = 30 * 60000;
const DOPO_MS = 3 * 3600000;

// Pavimento scelto in coda all'analisi di sensibilita' qui sotto. Vedi il
// report del Task 7 per l'argomentazione completa; in breve: e' il piu alto
// fra i pavimenti testati, punto in cui il "calo" osservato smette di essere
// piatto (rumore) e comincia chiaramente a scalare con l'ET0 (segnale).
const PAVIMENTO_ET0_MM_H = 0.15;

function leggiCsv(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((r) => r.startsWith(',,'))
    .map((r) => r.split(','))
    .map((c) => ({ ts: Date.parse(c[c.length - 2]), v: Number(c[c.length - 1]) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
    .sort((a, b) => a.ts - b.ts);
}

// Percentile "nearest-rank" (senza interpolazione): rango = ceil(p*n),
// indice 0-based = rango-1, con i limiti agli estremi. E' la stessa
// definizione adottata dal Task 4 nel nodo nf-fn-stats di flows.json: due
// stime del percentile della stessa grandezza (quella empirica di Node-RED e
// questa offline) devono usare la stessa aritmetica, altrimenti due numeri
// "p90" nello stesso progetto significano cose diverse. Usata ovunque in
// questo script serva un percentile: sui campioni di k e sugli errori del
// backtest.
const perc = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1))];

const umidita = leggiCsv('analysis/umidita.csv');
const eventi = leggiCsv('analysis/eventi.csv');
if (umidita.length < 100) { console.error('serie di umidita troppo corta'); process.exit(1); }

const finestre = eventi.map((e) => [e.ts - e.v * 1000 - PRIMA_MS, e.ts + DOPO_MS]);
const contaminato = (ts) => finestre.some(([a, b]) => ts >= a && ts <= b);

// Ora locale approssimata (CEST = UTC+2): il periodo coperto (aprile-agosto)
// non attraversa alcun cambio di ora legale, quindi l'offset fisso e' valido
// per tutta la serie. Usata solo per il riepilogo giorno/notte qui sotto,
// nessun impatto sul fitting.
const oraLocale = (ts) => (new Date(ts).getUTCHours() + 2) % 24;
const eGiorno = (ts) => { const h = oraLocale(ts); return h >= 6 && h < 21; };

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

// --- campioni "base": stessa pipeline della prima versione dello script,
// unico gate sul passo di ET0 cumulato (et0Passo <= 0.001 mm). Servono qui
// solo da riferimento per la distribuzione dell'ET0 e per il confronto nella
// tabella di sensibilita' piu sotto ("originale").
function campioniConPavimento(pavimentoMmH) {
  const out = [];
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
    const et0h = et0[h] || 0;
    if (pavimentoMmH == null) {
      const et0Passo = et0h * dt_h;
      if (et0Passo <= 0.001) continue;
    } else if (et0h < pavimentoMmH) {
      continue;
    }
    out.push({ ts: p.ts, dt_h, calo, et0h, r: calo / (et0h * dt_h) });
  }
  return out;
}

const campioniBase = campioniConPavimento(null);
if (campioniBase.length < 50) { console.error(`solo ${campioniBase.length} campioni puliti`); process.exit(1); }

// --- distribuzione dell'ET0 oraria: quanto e' diffuso il problema ---
console.log(`\ncampioni puliti (pipeline originale, senza pavimento esplicito): ${campioniBase.length}`);
console.log('distribuzione ET0 oraria tra questi campioni:');
console.log('  soglia (mm/h) | n sotto soglia | quota | di cui notte');
for (const soglia of [0.01, 0.02, 0.05, 0.1]) {
  const sotto = campioniBase.filter((c) => c.et0h < soglia);
  const notte = sotto.filter((c) => !eGiorno(c.ts)).length;
  console.log(`  ${soglia.toFixed(2).padStart(13)} | ${String(sotto.length).padStart(14)} | ${(100 * sotto.length / campioniBase.length).toFixed(1).padStart(4)}% | ${notte}/${sotto.length}`);
}

let oreTot = 0;
const oreSotto = { 0.01: 0, 0.02: 0, 0.05: 0, 0.1: 0 };
let oreNotteSotto005 = 0, oreSotto005 = 0;
for (let i = 0; i < tempo.length; i++) {
  const tsMs = tempo[i] * 1000;
  if (tsMs < umidita[0].ts || tsMs > umidita[umidita.length - 1].ts) continue;
  oreTot++;
  const v = et0[i] || 0;
  for (const s of [0.01, 0.02, 0.05, 0.1]) if (v < s) oreSotto[s]++;
  if (v < 0.05) { oreSotto005++; if (!eGiorno(tsMs)) oreNotteSotto005++; }
}
console.log(`\nore totali nel periodo (serie meteo oraria intera): ${oreTot}`);
console.log(`ore < 0.01: ${oreSotto[0.01]}  < 0.02: ${oreSotto[0.02]}  < 0.05: ${oreSotto[0.05]}  < 0.1: ${oreSotto[0.1]}`);
console.log(`ore < 0.05 mm/h: ${oreSotto005}, di cui notte: ${oreNotteSotto005} (${(100 * oreNotteSotto005 / oreSotto005).toFixed(0)}%)`);

// --- verifica indipendente dal modello: il "calo" osservato scala con l'ET0
// (segnale) o resta piatto (rumore)? Bin per bin, nessun k coinvolto. ---
console.log('\ncalo osservato per fascia di ET0 orario (verifica segnale vs rumore):');
console.log('  fascia et0h (mm/h) |     n | calo mediano | calo p90');
const fasce = [[0.01, 0.02], [0.02, 0.05], [0.05, 0.10], [0.10, 0.15], [0.15, 0.30], [0.30, Infinity]];
for (const [lo, hi] of fasce) {
  const g = campioniBase.filter((c) => c.et0h >= lo && c.et0h < hi).map((c) => c.calo).sort((x, y) => x - y);
  if (!g.length) { console.log(`  [${lo}, ${hi}) vuoto`); continue; }
  console.log(`  [${lo}, ${hi === Infinity ? '∞' : hi})`.padStart(21) + ` | ${String(g.length).padStart(5)} | ${perc(g, 0.5).toFixed(4).padStart(12)} | ${perc(g, 0.9).toFixed(4).padStart(8)}`);
}

// --- fit + backtest per un dato pavimento ---
function fitConPavimento(pavimentoMmH) {
  const campioni = campioniConPavimento(pavimentoMmH).map((c) => c.r).sort((x, y) => x - y);
  const n = campioni.length;
  if (n < 50) return { pavimentoMmH, n, k: NaN, k10: NaN, k90: NaN, errori: {} };
  const k = perc(campioni, 0.5), k10 = perc(campioni, 0.1), k90 = perc(campioni, 0.9);
  const errori = {};
  for (const ore of [6, 12, 24]) {
    const errArr = [];
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
      if (Number.isFinite(m)) errArr.push(Math.abs(m - reale.v));
    }
    errArr.sort((x, y) => x - y);
    errori[ore] = { n: errArr.length, med: errArr.length ? perc(errArr, 0.5) : NaN, p90: errArr.length ? perc(errArr, 0.9) : NaN };
  }
  return { pavimentoMmH, n, k, k10, k90, errori };
}

// --- tabella di sensibilita' ---
console.log('\n--- analisi di sensibilita\' sul pavimento ET0 ---');
console.log('pavimento(mm/h) |    n |    k    |   p10  |   p90  || err6h med/p90 | err12h med/p90 | err24h med/p90');
const candidati = [null, 0.01, 0.02, 0.05, 0.10, 0.15];
for (const pav of candidati) {
  const r = fitConPavimento(pav);
  const e6 = r.errori[6], e12 = r.errori[12], e24 = r.errori[24];
  const etichetta = pav == null ? 'originale' : pav.toFixed(2);
  console.log(
    `${etichetta.padStart(16)} | ${String(r.n).padStart(4)} | ${r.k.toFixed(3).padStart(7)} | ${r.k10.toFixed(3).padStart(6)} | ${r.k90.toFixed(3).padStart(6)} || ` +
    `${(e6.med.toFixed(2) + '/' + e6.p90.toFixed(2)).padStart(13)} | ${(e12.med.toFixed(2) + '/' + e12.p90.toFixed(2)).padStart(14)} | ${(e24.med.toFixed(2) + '/' + e24.p90.toFixed(2)).padStart(14)}`
  );
}

// --- risultato al pavimento scelto ---
console.log(`\n--- risultato al pavimento scelto (${PAVIMENTO_ET0_MM_H} mm/h) ---`);
const finale = fitConPavimento(PAVIMENTO_ET0_MM_H);
console.log(`campioni puliti: ${finale.n}`);
console.log(`k    = ${finale.k.toFixed(3)} %/mm`);
console.log(`k p10= ${finale.k10.toFixed(3)}   k p90= ${finale.k90.toFixed(3)}`);
console.log(`ordinamento p10 <= k <= p90: ${finale.k10 <= finale.k && finale.k <= finale.k90 ? 'OK' : 'VIOLATO'}`);
console.log('\norizzonte | campioni | errore mediano | errore p90');
for (const ore of [6, 12, 24]) {
  const e = finale.errori[ore];
  console.log(`${String(ore).padStart(8)}h | ${String(e.n).padStart(8)} | ${e.med.toFixed(2).padStart(14)} | ${e.p90.toFixed(2).padStart(10)}`);
}
