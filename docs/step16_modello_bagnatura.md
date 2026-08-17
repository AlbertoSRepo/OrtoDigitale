# Step 16 — Modello di bagnatura (fase 1: analisi offline)

## Indice

0. [Origine — ragionamento del 2026-08-16](#0-origine--ragionamento-del-2026-08-16)
1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Decisioni di design](#3-decisioni-di-design)
4. [L'algoritmo](#4-lalgoritmo)
5. [Fitting e cancello di accettazione](#5-fitting-e-cancello-di-accettazione)
6. [File toccati](#6-file-toccati)
7. [Fuori scope](#7-fuori-scope)
8. [Verifica di completamento (fase 1)](#8-verifica-di-completamento-fase-1)
9. [Aggiornamenti a CLAUDE.md](#9-aggiornamenti-a-claudemd)

---

## 0. Origine — ragionamento del 2026-08-16

Ragionamento originale dell'utente, precedente alla spec formale (nato il giorno prima
del brainstorming che ha prodotto questo documento, il 2026-08-17). Riportato qui perché
non era stato scritto da nessuna parte al momento in cui è stato formulato — solo
verbale — e vale la pena conservarlo come traccia di come si è arrivati alla scelta di
design del §3/D2.

> Utilizzando i dati oggi conservati nel DB, si può sviluppare un modello per capire la
> "bagnatura" del terreno? I dati nel DB sono **sporchi**: lo sblocco manuale è sempre
> stato usato sia per irrigare l'orto sia per prelevare acqua per altri usi — un evento
> di apertura valvola non implica quindi che l'acqua sia arrivata al terreno.
>
> L'unico modo per pulire i dati sembra essere: prendere tutti gli eventi di bagnatura
> del terreno e confrontarli con i valori di umidità nelle 2 ore successive, per capire
> se l'acqua sia stata effettivamente usata per l'orto; poi prendere tutti gli aumenti
> di umidità osservati e verificare che in quel momento non stesse piovendo. Obiettivo
> finale: capire quanto sale l'umidità sia con l'irrigazione sia con la pioggia.

**Cosa è rimasto invariato**: il problema (dati sporchi da sblocco manuale
indistinguibile), l'obiettivo finale (coefficienti misurati per irrigazione e pioggia),
e l'intuizione di base (usare la risposta di umidità osservata per attribuire un evento
a "irrigazione vera" o "pioggia", non fidarsi dell'etichetta del record).

**Cosa è stato raffinato in fase di brainstorming (§3)**: l'idea originale confrontava
l'umidità in una finestra fissa di 2 ore dopo l'evento — un salto assoluto. Discusso
come "Approccio B" durante il brainstorming e scartato a favore del **contro-fattuale**
(D2): invece di guardare la salita grezza, si proietta cosa avrebbe fatto l'umidità
*senza* alcun evento (solo asciugatura, modello `k·ET0` già validato dallo step 15) e si
confronta col dato osservato. Il motivo del cambio: in un pomeriggio caldo l'asciugatura
naturale può mascherare a occhio nudo una bagnatura reale ma modesta, mentre di notte una
soglia fissa rischia falsi positivi. Il contro-fattuale isola l'effetto netto
indipendentemente dall'ora del giorno — stessa idea di fondo, esecuzione più precisa. La
verifica "non stava piovendo" dell'idea originale diventa l'attribuzione a due vie
(irrigazione vs pioggia vs ambiguo vs rumore) di §4/Fase D.

Anche l'ipotesi implicita di modello ML nel primo inquadramento («possiamo sviluppare un
modello di machine learning...») è stata esplicitamente valutata e scartata in D1, a
favore di una regressione a percentili — coerente con `analysis/01_irrigazione_decisione.md`,
che aveva già scartato il ML per lo stesso problema a maggio.

---

## 1. Obiettivo

Capire, da storico reale, **quanto sale l'umidità del terreno** quando succede qualcosa
che la bagna — irrigazione o pioggia — e produrre due coefficienti misurati al posto
di uno indovinato:

- `w_rain` sostituisce `rain_gain_pct_per_mm = 1.2`, oggi in `irrigation_config.json`
  (sezione `forecast`, step 15). La spec dello step 15 lo dichiara esplicitamente
  «un ancoraggio di ordine di grandezza, non una misura», derivato da un solo evento.
- `w_irr` è nuovo: oggi non esiste alcuna stima di quanto sale l'umidità per litro
  d'acqua erogato. È il motivo per cui il simulatore dello step 15 si ferma al primo
  evento previsto (D2: «non serve indovinare cosa deciderà il sistema oltre il primo
  evento, serve un modello di risposta che oggi non esiste»).

**Questa è solo la fase 1: analisi offline.** Nessuna modifica a `flows.json`,
`irrigation_config.json` o frontend. Se il fit supera un cancello di qualità (§5),
la messa in produzione — estendere il simulatore oltre il primo evento, aggiungere i
campi in config — diventa una fase 2 separata, con la stessa disciplina di ogni altro
step (branch, TDD, deploy in `dry_run`, healthcheck). Non è impegnata da questo piano.

---

## 2. Stato di partenza

### Il problema dei dati sporchi

Lo storico di `irrigation_events` non distingue *perché* la valvola è stata aperta.
Fino al 2026-08-15 ogni apertura ha `trigger=manual` — e lo sblocco manuale è sempre
stato lo stesso, sia per irrigare l'orto sia per prelevare acqua per altri usi.

**Correzione (vedi `analysis/04_modello_bagnatura.md` §1)**: questa premessa è
risultata imprecisa — `trigger=auto` compare già da maggio, perché il decision loop
lo scrive anche in `mode=dry_run`.

Un record `trigger=manual` **non implica** che l'acqua sia arrivata al terreno.

**Dal 2026-08-16 (`mode=auto`) il problema non esiste più per i dati nuovi**: un
evento `trigger=auto` è per costruzione vera irrigazione da orto, perché il decision
loop apre la valvola solo per quel motivo. La pulizia descritta in questo documento
riguarda solo lo storico `manual` accumulato da maggio ad agosto.

### Cosa dice già lo storico (numeri noti dallo step 15, §2)

- 295 record `irrigation_events` con `duration_seconds > 0` dal 2026-05-03, di cui
  260 ≥ 120 s. Tutti `trigger=manual` all'epoca della rilevazione.
- `total_liters` è **inaffidabile**: presente in 101/295 record, con valori
  incompatibili con la portata misurata (un evento da 163 s risulterebbe a
  9.2 m³/h, dieci volte la portata reale). Non va usato come covariata.
- La portata della valvola durante l'apertura è invece stabile e misurata:
  **0.8–0.9 m³/h, ~14 L/min**. I litri si derivano da `durata_secondi × 14/60`.
- La distribuzione dell'acqua è **irregolare per singolo evento**, non una zona
  morta fissa: nell'evento del 14/08 (958 s) WH51_04 guadagna 17 punti, WH51_02
  ne guadagna 4, WH51_03 resta immobile pur non essendo una sonda guasta (è la più
  variabile delle quattro su 10 giorni). Rilevante perché il modello aggregato
  (media sulle sonde valide, stessa convenzione del decision loop e del simulatore)
  mescola questi effetti — è una fonte di rumore nota, non un bug da correggere qui.
- Il picco di risposta arriva **~90 minuti dopo la chiusura** della valvola.

### Cosa esiste già — non si riparte da zero

`analysis/stima_k.mjs` (step 15, Task 7) ha già gran parte dell'infrastruttura
necessaria:

| Cosa fa oggi | Come si riusa per la bagnatura |
|---|---|
| Scarica ET0 **e precipitazione oraria storica** da Open-Meteo `/archive`, stesso periodo della serie di umidità | La precipitazione è già scaricata: oggi serve solo per *escludere* ore dal fit di `k`, va riusata come *segnale* per etichettare le sorprese come pioggia |
| Isola le finestre di irrigazione con `contaminato()` (-30 min apertura → +3 h chiusura) | Oggi le *scarta* dal fit; qui diventano il materiale su cui lavorare, non uno scarto |
| Nel backtest simula già un termine di pioggia: `m += 1.2 * pioggia[h] * 0.25` ogni 15 min | `1.2` è hardcoded — esattamente il numero che questo step deve sostituire con `w_rain` fittato |
| Percentile "nearest-rank" (`perc`, righe 47-55) usato per `k`, `k10`, `k90` e per gli errori di backtest | Stessa aritmetica va riusata per `w_irr`/`w_rain`, per lo stesso motivo già scritto nel commento del codice: due percentili nello stesso progetto devono significare la stessa cosa |
| Guardia esplicita `if (campioniBase.length < 50)` prima di fittare | Stesso principio, soglia diversa (§5) — i campioni qui sono eventi, non punti a 15 min, molto più rari |

Non è una pipeline nuova: è un'estensione mirata di uno script che esiste già e i cui
numeri (`k`, `k10`, `k90`) sono già validati e in produzione.

---

## 3. Decisioni di design

### D1 — Regressione semplice, non ML

Coerente con due precedenti già scritti in questo stesso progetto:

- `analysis/01_irrigazione_decisione.md` (23 maggio) scarta esplicitamente «ML
  regressione (drying rate, duration estimator)» e «ML classificazione
  irriga/non-irriga» per lo stesso identico problema: dataset piccolo
  (60–200 episodi/anno), nessuna etichetta oggettiva di "verità", pipeline di
  training/versioning sproporzionata alla scala dell'orto.
- Lo step 15 ha risolto il lato asciugatura con una regressione lineare a
  percentili (`k · ET0`), non con un modello complesso.

Se durante il fitting emergesse un segnale chiaramente non lineare che una
regressione a percentili non cattura, si torna a discuterne — ma non è l'ipotesi
di partenza, ed è esattamente il tipo di scoperta che giustificherebbe di rialzare
il livello di ambizione in un secondo momento, non ora.

### D2 — Contro-fattuale al posto della soglia grezza

Confrontare l'umidità osservata con una traiettoria "solo asciugatura" proiettata
dal modello `k · ET0` già esistente, invece di guardare la salita grezza nelle 2h
successive. Un pomeriggio caldo (ET0 alto) può mascherare a occhio nudo una
bagnatura reale ma modesta; il contro-fattuale isola l'effetto netto sottraendo
l'evapotraspirazione che sarebbe comunque avvenuta nello stesso intervallo.

### D3 — Pavimento di rumore misurato, non costante a tavolino

Stesso principio del D3 dello step 15 («la fascia di incertezza si ricava dai
dati»). Il pavimento sotto cui un residuo non conta come "sorpresa" si stima
dall'errore naturale del modello di sola asciugatura sull'orizzonte rilevante
(~2–3h), non da un numero scelto a priori.

### D4 — Finestre ambigue scartate, non sommate

Se una finestra ha sia un'apertura valvola sia pioggia registrata nello stesso
intervallo, viene scartata invece di provare ad attribuire il salto a entrambe. Il
campione utile è già piccolo: sommare rischia di introdurre un bias sistematico
(attribuire a una causa un effetto dell'altra) peggiore della perdita di qualche
campione.

### D5 — Litri da durata × portata nota, non da `total_liters`

`total_liters` ha un bug noto e non è utilizzabile come verità (§2). La portata
misurata (0.8–0.9 m³/h) è invece stabile: `litri = durata_secondi × 14/60`.

### D6 — Fase 1 è analisi pura

Nessuna scrittura su `flows.json`, `irrigation_config.json` o frontend. Il cancello
di accettazione (§5) decide se ha senso una fase 2, ma quella fase — se esiste — è
un lavoro separato con la sua spec, il suo piano, il suo branch. Non è parte di
questo piano di implementazione.

---

## 4. L'algoritmo

### Estensione dell'export dati

`analysis/eventi.csv` oggi contiene solo `_time` (chiusura) e `duration_seconds`,
per qualunque trigger. Va rigenerato aggiungendo la tag `trigger`, con la stessa
query Flux di sola lettura già documentata nello step 15 (Task 7), estesa con
`|> keep(columns:["_time","_value","trigger"])`.

### Fase A — Pavimento di rumore

Estendere il calcolo degli errori di backtest già presente in `stima_k.mjs`
(righe 168-192) aggiungendo un orizzonte corto (~2-3h, quello rilevante per la
finestra di risposta osservata) accanto ai già presenti 6/12/24h. Questo errore,
calcolato SENZA alcun termine di bagnatura, è la scala naturale di rumore del
modello di sola asciugatura su quell'orizzonte.

### Fase B — Proiezione contro-fattuale continua

Stesso ciclo di proiezione già scritto nel backtest (`m -= k * et0[h] * 0.25` ogni
15 min), ma **senza fermarsi alle finestre contaminate**: prosegue attraverso di
esse. `residuo(t) = umidità_osservata(t) − umidità_contro-fattuale(t)`.

### Fase C — Rilevazione delle sorprese

Un residuo conta come "sorpresa" solo se supera il pavimento di rumore (Fase A) di
un fattore di sicurezza. Non fisso qui il fattore: la tabella di sensibilità di §5
lo sceglie sui dati, stesso pattern già usato per `PAVIMENTO_ET0_MM_H` in
`stima_k.mjs` (candidati {1.5×, 2×, 3×}, riportare n campioni ed errori per
ciascuno).

### Fase D — Attribuzione

Ogni finestra di sorpresa viene classificata:

| Valvola aperta vicino (qualunque trigger) | Pioggia registrata (Open-Meteo `/archive`) | Esito |
|---|---|---|
| Sì | No | **candidato irrigazione** |
| No | Sì | **candidato pioggia** |
| Sì | Sì | **scartato — ambiguo** (D4) |
| No | No | **scartato — rumore/buco di trasmissione** |

"Vicino" riusa la stessa finestra `contaminato()` già definita in `stima_k.mjs`
(-30 min apertura → +3h chiusura). Un buco di trasmissione tipo quelli già
osservati su WH51_01 (step15 §2) ricade nell'ultima riga e viene scartato, non
interpolato.

### Fase E — Fitting

Percentili 10/50/90 (stessa aritmetica *nearest-rank* di `k`) sul rapporto:

- `w_irr` = `residuo_irrigazione / litri` sui candidati irrigazione
- `w_rain` = `residuo_pioggia / mm_pioggia` sui candidati pioggia

---

## 5. Fitting e cancello di accettazione

### Backtest esteso

Il ciclo di backtest esistente (righe 168-192 di `stima_k.mjs`) va esteso per
attraversare le finestre di irrigazione usando `w_irr` invece di ignorarle, e
`w_rain` fittato invece del valore hardcoded `1.2`. Il confronto onesto è fra
l'errore del simulatore **end-to-end** (asciugatura + bagnatura, attraverso gli
eventi) e l'errore del modello di sola asciugatura sullo stesso orizzonte —
riportare entrambi, non solo il nuovo.

### Tabella di sensibilità

Stesso formato già usato per `PAVIMENTO_ET0_MM_H`: per ciascun fattore di sicurezza
candidato (§4 Fase C), riportare n campioni utili, `w_irr`/`w_rain` con
p10/mediana/p90, ed errore mediano/p90 del backtest esteso a 6/12/24h.

### Cancello di accettazione

**Non fisso qui una soglia numerica.** Nello step 15 la distribuzione dell'acqua
per singolo evento si è già mostrata irregolare (una sonda guadagna 17 punti, una
resta immobile): un cancello realistico per la bagnatura sarà quasi certamente più
permissivo del 3pp usato per la sola asciugatura. Il numero si sceglie guardando
la tabella di sensibilità, si argomenta nel report finale
(`analysis/04_modello_bagnatura.md`) e si applica lì — stesso principio del D3.

### Guardia sul volume di dati

`stima_k.mjs` si ferma se i campioni scendono sotto 50 (punti a 15 minuti, molto
frequenti). Qui i campioni sono eventi, molto più rari: propongo una guardia a
**15 campioni utili minimi** per `w_irr` (e separatamente per `w_rain`) prima di
accettare un fit. Sotto quella soglia lo script si ferma dichiarando dati
insufficienti — non forza un numero da un campione troppo piccolo per essere
significativo, nemmeno a livello di percentili.

**Rischio dichiarato:** su 295 eventi manual storici, dopo il filtro
ambiguo/scartato (D4) e la richiesta di una sorpresa che superi il pavimento di
rumore, il campione utile per `w_irr` potrebbe restare sotto quella soglia. Se
succede, l'esito legittimo di questa fase è "dati insufficienti, servono più
settimane di `mode=auto` prima di riprovare" — non un fallimento del lavoro, un
risultato onesto.

---

## 6. File toccati

| File | Modifica |
|---|---|
| `analysis/eventi.csv` | rigenerato con la tag `trigger` in più (query di sola lettura, stesso pattern dello step 15 Task 7) |
| `analysis/stima_bagnatura.mjs` | **nuovo** — estende la metodologia di `stima_k.mjs`: pavimento di rumore, contro-fattuale continuo, attribuzione, fit di `w_irr`/`w_rain`, backtest esteso, tabella di sensibilità |
| `analysis/04_modello_bagnatura.md` | **nuovo** — risultati, stesso formato di `analysis/03_stima_asciugatura.md`: numeri, riserve, raccomandazione esplicita su una fase 2 (procedere / non procedere / servono più dati) |
| `docs/step16_modello_bagnatura.md` | questo file — riceve la sezione `## Implementazione` a fase 1 conclusa |
| `CLAUDE.md` | nessuna modifica di schema dati (fase 1 non scrive nulla su InfluxDB); solo l'eventuale riga di stato avanzamento (§9) |

Nessun test `.mjs` con banco di prova stile Node-RED: `stima_bagnatura.mjs`, come
`stima_k.mjs`, è uno script una-tantum che stampa e basta, non codice che gira in
produzione.

---

## 7. Fuori scope

- **Modello per-aiuola/per-sonda**: deciso aggregato (media sulle sonde valide,
  stessa convenzione del decision loop). L'irregolarità per-sonda resta rumore
  noto, non un parametro da stimare qui.
- **Wiring live nel simulatore dello step 15**: fase 2 eventuale, condizionata al
  cancello di §5, con la sua spec e il suo piano separati.
- **ML "vero"** (random forest, gradient boosting, reti): scartato in D1.
- **Etichettatura manuale** degli eventi storici: scartata durante il
  brainstorming — stesso motivo per cui `analysis/01` scarta il feedback umano nel
  loop decisionale (segnale rumoroso, non scala, memoria inaffidabile su eventi di
  mesi fa).
- **Ricalibrazione di `k`**: resta quello già fittato e in produzione dallo step 15.
- **Nuovi endpoint o campi di configurazione**: nessuno in questa fase.

---

## 8. Verifica di completamento (fase 1)

1. `node analysis/stima_bagnatura.mjs` gira senza errori e produce `w_irr`/`w_rain`
   con ordinamento `p10 ≤ mediana ≤ p90` (stesso guard-rail già applicato a `k`) —
   oppure si ferma dichiarando dati insufficienti (§5), esito comunque valido.
2. Tabella di sensibilità sul fattore di sicurezza riportata nel report.
3. Backtest esteso (asciugatura + bagnatura) confrontato onestamente con il
   backtest di sola asciugatura — il risultato si dichiara così com'è, anche se
   peggiora rispetto ad oggi su qualche orizzonte.
4. `analysis/04_modello_bagnatura.md` scritto con i numeri, le riserve e una
   raccomandazione esplicita sulla fase 2.
5. Questo file aggiornato con `## Implementazione`, stato COMPLETATO — a
   prescindere dall'esito del cancello: un "no, servono più dati" argomentato è un
   risultato di questa fase, non un fallimento.

---

## 9. Aggiornamenti a CLAUDE.md

- Nessuna modifica allo schema dati InfluxDB (fase 1 non scrive nulla di nuovo).
- Tabella **Stato avanzamento**: riga 16 passa a `✅ (fase 1 — analisi)` se il
  cancello è superato con una raccomandazione di procedere, oppure resta `⏳` con
  una nota se il cancello non è superato o servono più dati.

---

## Implementazione

**Stato:** ✅ COMPLETATO (fase 1) — 2026-08-17

**Commit di riferimento:** `docs(scripts): report del modello di bagnatura (step 16 fase 1)` (86c369a)

**Note:** Attribuzione: sui 296 eventi valvola, 90 scartati come rumore (probabile acqua per altro uso), 150 candidati irrigazione, 56 scartati come ambigui (pioggia vicina). Sui 139 episodi di pioggia raggruppati, 56 scartati come rumore, 38 candidati pioggia, 45 scartati come ambigui (valvola vicina). Coefficienti ottenuti: w_irr = 0.0380 %/L (n=150, p10 -0.0108, p90 0.3408), w_rain = 2.0141 %/mm (n=38, p10 -3.6185, p90 26.9744). Backtest esteso a 12h: modello esteso 4.28 pp mediana (non batte baseline 3.75 pp). Scomposizione (review finale post-completamento, poi corretta da una seconda re-review indipendente): w_irr da solo è vicino al pareggio sulla mediana e la batte a 24h (6.69 contro 7.48 pp), ma peggiora il p90 a ogni orizzonte (+26%/+27%/+46% a 6h/12h/24h) — è w_irr, non w_rain, a pesare di più sul peggioramento in coda del backtest a 4 colonne (§6.1). w_rain, testato onestamente sul bucket che governa (mai attraversato da una finestra valvola, §6.2), è comunque peggiore della costante già in produzione (1.2) a ogni orizzonte: un risultato indipendente che vale di per sé, non perché sia la causa principale del backtest esteso. Raccomandazione aggiornata: non procedere ora col modello combinato, ma w_irr resta un candidato ragionevole per un secondo giro con più dati puliti (stesso metodo), mentre w_rain richiede un lavoro dedicato (più campioni, soglia ricalibrata) prima di poter competere di nuovo con la costante in produzione. Dettaglio completo in `analysis/04_modello_bagnatura.md`.

**Deviazioni dalla spec:** Una deviazione dichiarata: la Task 4 del piano prevede di default `FATTORE_SICUREZZA=2` quando la tabella di sensibilità non mostra un gomito netto (non c'era: calo quasi lineare fra i tre candidati testati). Si è scelto deliberatamente `3.0` invece del default `2` — il più prudente fra i tre candidati testati — per mitigare parzialmente il bias da statistica d'ordine noto e già documentato altrove nel piano, non per un'omissione: una scelta esplicita, motivata dalla direzione nota del bias, documentata nel codice (Fase D). Nessun'altra deviazione significativa. Scoperta del Report (§1): tag `trigger` riporta `auto` già dal 2026-05-03 anche in `mode=dry_run` (non solo in modalità auto), ma non invalida il metodo basato sul segnale fisico di umidità osservata — scoperta documentata nel report, fuori scope correggerla qui.
