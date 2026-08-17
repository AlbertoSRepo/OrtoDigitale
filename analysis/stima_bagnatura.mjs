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

// Residuo di picco in (inizio, fine]: il campione dove |osservato meno
// contro-fattuale| e' massimo in valore assoluto (non solo il massimo con
// segno positivo — vedi il confronto Math.abs(...) sotto). Ritorna null se
// manca un punto di partenza pulito o se la finestra non contiene campioni.
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
    if (!migliore || Math.abs(residuo) > Math.abs(migliore.residuo)) {
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

// ============================================================
// FASE D — attribuzione. FATTORE_SICUREZZA e' stato scelto leggendo la
// tabella di sensibilita' stampata sopra (Passo 1 di questo task):
// (a) nessun gomito netto nella tabella (231→224→206, calo non perfettamente
//     lineare — accelera leggermente fra i fattori 2.0 e 3.0);
// (b) bias statistico noto: residuoDiPicco prende il MASSIMO su ~12+ campioni
//     in finestra 3h, ma soglia e' tarata sulla MEDIANA di errore puntuale
//     (un solo campione) — il massimo supera sistematicamente una soglia sulla
//     mediana del singolo punto, anche senza segnale vero (bias da statistica
//     d'ordine), confermato da due review indipendenti;
// (c) scelto il fattore piu' alto disponibile fra i tre testati come
//     mitigazione parziale, non come soluzione del bias;
// (d) il backtest del Task 6 resta la verifica onesta finale.
const FATTORE_SICUREZZA = 3;
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

// ============================================================
// FASE F — backtest esteso. Confronto onesto a quattro colonne sugli
// stessi orizzonti gia' usati per k (6/12/24h):
//   1. puliti, solo asciugatura, senza alcun termine di pioggia (variante
//      NUOVA, NON il riferimento pubblicato dallo step 15 — quel
//      riferimento usa w_rain=1.2 sui campioni puliti, riprodotto dalla
//      riga "w_rain=1.2" della tabella FASE F bis piu' sotto, che va
//      confrontata con analysis/03_stima_asciugatura.md)
//   2. contaminati, modello esteso   — w_irr/w_rain iniettati dove serve
//   3. contaminati, solo asciugatura — stessi intervalli della colonna 2,
//      ma SENZA alcun termine di bagnatura: mostra quanto sarebbe
//      sbagliato ignorare l'evento, a parita' di campioni
//   4. contaminati, solo w_irr       — stessi intervalli della colonna 2,
//      ma con w_rain forzato a 0: isola il contributo di w_irr da solo.
//      w_rain NON si testa onestamente su questo bucket (le finestre
//      valvola dominano il segnale): il suo test onesto e' sul bucket
//      "puliti", mai attraversato da una finestra valvola — vedi FASE F
//      bis subito sotto.
// Nessuna soglia di accettazione qui: la spec (D3, §5) chiede di leggere
// il numero prima di fissarla, non di calarla dall'alto.
// ============================================================
const wIrrFinale = wIrrStat ? wIrrStat.mediana : 0;
const wRainFinale = wRainStat ? wRainStat.mediana : 0;

console.log('\n--- FASE F: backtest esteso (asciugatura + bagnatura) ---');
console.log(`w_irr usato: ${wIrrStat ? wIrrFinale.toFixed(4) : '0 (dati insufficienti)'}  w_rain usato: ${wRainStat ? wRainFinale.toFixed(4) : '0 (dati insufficienti)'}`);
console.log('orizzonte | 1) puliti/solo-asciugatura med,p90 (n) | 2) contaminati/esteso med,p90 (n) | 3) contaminati/senza-bagnatura med,p90 (n) | 4) contaminati/solo-w_irr med,p90 (n)');
for (const ore of [6, 12, 24]) {
  const base = erroreProiezione(ore, {});
  const esteso = erroreProiezione(ore, { wIrr: wIrrFinale, wRain: wRainFinale });
  const soloWIrr = erroreProiezione(ore, { wIrr: wIrrFinale, wRain: 0 });
  const c1 = `${base.puliti.med.toFixed(2)},${base.puliti.p90.toFixed(2)} (${base.puliti.n})`;
  const c2 = `${esteso.contaminati.med.toFixed(2)},${esteso.contaminati.p90.toFixed(2)} (${esteso.contaminati.n})`;
  const c3 = `${base.contaminati.med.toFixed(2)},${base.contaminati.p90.toFixed(2)} (${base.contaminati.n})`;
  const c4 = `${soloWIrr.contaminati.med.toFixed(2)},${soloWIrr.contaminati.p90.toFixed(2)} (${soloWIrr.contaminati.n})`;
  console.log(`${String(ore).padStart(8)}h | ${c1.padStart(38)} | ${c2.padStart(34)} | ${c3.padStart(38)} | ${c4.padStart(34)}`);
}

// ============================================================
// FASE F (bis) — test onesto di w_rain. Il bucket "contaminati" (colonna
// 2/3/4 sopra) e' dominato dalle finestre valvola: w_rain non viene mai
// esercitato li' in proporzione significativa. Il bucket "puliti" e'
// l'UNICO che w_rain governa senza mai attraversare una finestra valvola
// (per costruzione: se una finestra di proiezione attraversa una valvola,
// finisce in "contaminati", vedi erroreProiezione sopra) — e' quindi il
// solo posto dove il valore fittato si puo' confrontare onestamente.
// Confronto a tre valori di w_rain sugli stessi orizzonti: 0 (nessun
// termine di pioggia), 1.2 (la costante gia' in produzione,
// rpi5/nodered/data/irrigation_config.json -> forecast.rain_gain_pct_per_mm)
// e il valore fittato in FASE E. wIrr resta a 0 (default): non ha alcun
// effetto sul bucket "puliti" per lo stesso motivo, quindi e' irrilevante
// qui.
// ============================================================
console.log('\n--- FASE F (bis): w_rain sul bucket "puliti" (solo pioggia, mai valvola) ---');
console.log(`orizzonte | w_rain=0 (nessuna pioggia) | w_rain=1.2 (produzione attuale) | w_rain=${wRainFinale.toFixed(4)} (fittato)`);
for (const ore of [6, 12, 24]) {
  const w0 = erroreProiezione(ore, { wRain: 0 }).puliti;
  const w12 = erroreProiezione(ore, { wRain: 1.2 }).puliti;
  const wFit = erroreProiezione(ore, { wRain: wRainFinale }).puliti;
  const f = (r) => `${r.med.toFixed(2)}/${r.p90.toFixed(2)}`;
  console.log(`${String(ore).padStart(8)}h (n=${w0.n}) | w=0 -> ${f(w0)} | w=1.2 -> ${f(w12)} | w=${wRainFinale.toFixed(4)} -> ${f(wFit)}`);
}
