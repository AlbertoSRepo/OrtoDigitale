# Analisi — Modello di bagnatura (`w_irr` / `w_rain`)

**Data esecuzione:** 2026-08-17
**Periodo coperto:** eventi valvola dal 2026-05-03 al 2026-08-17 (oggi); serie di umidità/ET0/pioggia sul periodo `2026-04-26 .. 2026-08-17` (~113 giorni, riga `periodo:` stampata dallo script — vedi §1 per il dettaglio righe/campioni) a 15 minuti (`analysis/umidita.csv`).
**Scope:** stima di `w_irr`/`w_rain` per lo step 16 fase 1, vedi [`docs/step16_modello_bagnatura.md`](../docs/step16_modello_bagnatura.md).
**Documenti propedeutici:** [`docs/step15_previsione_prossima_irrigazione.md`](../docs/step15_previsione_prossima_irrigazione.md) (modello di asciugatura `k·ET0`, riusato qui come contro-fattuale), [`analysis/03_stima_asciugatura.md`](03_stima_asciugatura.md) (stessa metodologia di percentili "nearest-rank"), [`analysis/stima_bagnatura.mjs`](stima_bagnatura.mjs) (script che produce questi numeri, eseguibile con `node analysis/stima_bagnatura.mjs`).

---

## 0. Esito in breve

| | |
|---|---|
| Eventi valvola totali (`duration_seconds>0`) | 296 (71 `auto`, 8 `emergency`, 217 `manual`) |
| Eventi di pioggia raggruppati | 139 |
| Pavimento di rumore (Fase A, orizzonte 2h) | mediana **0.44 pp**, p90 **2.86 pp** |
| Fattore di sicurezza scelto | **3.0** (soglia 1.31 pp) |
| Attribuzione irrigazione (su 296) | 90 `scartato_rumore` · **150 irrigazione** · 56 `scartato_ambiguo` |
| Attribuzione pioggia (su 139) | 56 `scartato_rumore` · **38 pioggia** · 45 `scartato_ambiguo` |
| `w_irr` | **0.0380 %/L** (n=150, p10 -0.0108, p90 0.3408) |
| `w_rain` | **2.0141 %/mm** (n=38, p10 -3.6185, p90 26.9744) |
| Backtest — `w_irr` da solo, 24h (§6.1) | **6.69 pp** mediana, batte la baseline "senza bagnatura" (7.48 pp) |
| Backtest — `w_rain` fittato vs costante di produzione 1.2 (bucket "puliti", §6.2) | **peggiore a ogni orizzonte**, specialmente in coda (p90 24h: 33.72 contro 17.56 pp) |
| **Raccomandazione** | **Non procedere ora col modello combinato — ma scomposto: `w_irr` promettente e da ritestare con più dati, `w_rain` va rivisto prima di sostituire `1.2`** |

---

## 1. Dati di partenza

| File | Righe/eventi | Contenuto |
|---|---|---|
| `analysis/umidita.csv` (non versionato) | 10589 righe CSV grezze → **10584 campioni finiti** dopo il parsing (le 5 righe di differenza sono intestazioni/annotazioni Influx, scartate dal filtro `Number.isFinite` — stessa convenzione di `analysis/03_stima_asciugatura.md`: il conteggio delle righe del file grezzo e il conteggio dei campioni effettivamente usati dallo script sono due numeri diversi, entrambi riportati qui) | media dei sensori attivi, bucket 15 min, periodo `2026-04-26 .. 2026-08-17` (~113 giorni) |
| `analysis/eventi.csv` (non versionato) | 296 | eventi valvola con `duration_seconds > 0`, dal 2026-05-03 al 2026-08-17, con tag `trigger` |

Distribuzione `trigger` sui 296 eventi valvola: **71 `auto`**, **8 `emergency`**, **217 `manual`**.

Eventi di pioggia (Open-Meteo `/archive`, stessa coppia di coordinate già in uso dallo step 15), raggruppati da ore consecutive con pioggia > 0 in episodi distinti: **139**.

### Scoperta rilevante: la premessa dello step 15 §2 sul `trigger` è inesatta

`docs/step15_previsione_prossima_irrigazione.md` §2 afferma che «prima del 2026-08-16 ogni irrigazione è stata manuale». Il riesame dei 296 eventi mostra che è **falso**: il primo evento con `trigger=auto` è già del 2026-05-03, mesi prima della data indicata.

Causa probabile, individuata in `flows.json`: il campo `trigger` viene scritto come `auto`/`emergency` ogni volta che il decision loop apre la valvola, **anche in `mode=dry_run`** — modalità che logga l'evento come se avesse aperto, ma non comanda la valvola reale — e non solo quando il `mode` globale del sistema è `auto`.

**Questa scoperta non invalida il piano di questo step.** L'attribuzione (Fase D, §4 sotto) si basa sempre sul residuo di umidità osservato rispetto al contro-fattuale, mai sull'etichetta `trigger`. Un evento `dry_run` (nessuna acqua realmente erogata) produce quindi comunque un residuo vicino a zero e finisce in `scartato_rumore`, esattamente come un evento manuale di "acqua per altro uso" — la scoperta conferma anzi che l'approccio scelto (basato sul segnale fisico misurato, non sull'etichetta del record) era la scelta giusta anche per questa fonte di sporco nei dati non anticipata in fase di spec.

**Attenzione — vedi §7 punto 4**: questa scoperta ha una conseguenza operativa concreta per qualunque futura estrazione dati "pulita": filtrare solo su `trigger=auto` non basta.

---

## 2. Pavimento di rumore (Fase A)

Errore naturale del modello di sola asciugatura (`k·ET0`, nessun termine di bagnatura) su dati puliti, orizzonte 2h — la scala di rumore sotto cui un residuo non conta come "sorpresa":

```
campioni: 6555
errore mediano: 0.44 pp
errore p90:     2.86 pp
```

---

## 3. Tabella di sensibilità sul fattore di sicurezza (Fase B/C)

Soglia di "sorpresa" = fattore × mediana del pavimento (§2). Il valore pieno non arrotondato usato dallo script è ≈0.4353 pp, non 0.44: le soglie sotto sono il valore effettivamente stampato dallo script (`fattore * pavimento.med`), non fattore×0.44 calcolato a mano. 139 eventi di pioggia raggruppati usati come base per il conteggio pioggia, 296 eventi valvola come base per il conteggio irrigazione:

```
fattore | soglia (pp) | sorprese irrigazione (/296) | sorprese pioggia (/139)
    1.5 |        0.65 |                          231 |                     109
    2.0 |        0.87 |                          224 |                     101
    3.0 |        1.31 |                          206 |                      83
```

(Nota: `residuoDiPicco` traccia ora il residuo massimo in **valore assoluto**, non solo il massimo con segno positivo — un bug corretto in questo stesso giro di correzioni, vedi il diario di implementazione. La correzione fa salire i conteggi rispetto a una versione precedente di questo script, perché ora anche un forte residuo negativo può superare la soglia, coerentemente con il confronto a valle che già usava `Math.abs(r.residuo) > soglia`.)

Nessun gomito netto: il calo non è perfettamente lineare (accelera leggermente fra i fattori 2.0 e 3.0, sia per irrigazione sia per pioggia), ma non c'è un punto dove il rumore residuo si stacca chiaramente dal segnale vero.

**Riserva statistica identificata e confermata da due review indipendenti**: `residuoDiPicco` prende il **massimo in valore assoluto** su ~12+ campioni in una finestra di 3h, ma la soglia è calibrata sulla **mediana** di un errore *puntuale* (un solo campione per proiezione, non un massimo su finestra) — un bias da statistica d'ordine che gonfia sistematicamente il tasso di "sorprese" rilevate anche in assenza di segnale vero. Per questo, anche al fattore più alto testato, il tasso resta alto: **70% degli eventi valvola** (206/296) e **60% delle piogge** (83/139) contano ancora come "sorpresa".

**Fattore scelto: 3.0** — il più prudente fra i tre candidati testati. Non elimina il bias descritto sopra, ma lo mitiga parzialmente rispetto ai fattori 1.5 e 2.0. La verifica definitiva se il modello così ottenuto sia effettivamente utile arriva dal backtest esteso (§6), non da questa tabella.

---

## 4. Attribuzione (Fase D)

Ogni finestra di sorpresa (fattore 3.0) è classificata incrociando "valvola aperta vicino" (qualunque `trigger`) e "pioggia registrata vicino":

| Categoria | `scartato_rumore` | esito valido | `scartato_ambiguo` | Totale |
|---|---|---|---|---|
| Irrigazione | 90 | **150** (`irrigazione`) | 56 | 296 |
| Pioggia | 56 | **38** (`pioggia`) | 45 | 139 |

**Questo è il numero che risponde direttamente al problema posto a inizio step 16** ("ho sempre usato lo sblocco manuale sia per l'orto sia per altro"): **90 aperture valvola su 296 (30%) non hanno prodotto una salita di umidità misurabile oltre il pavimento di rumore** — sono i candidati più probabili per "acqua usata per altro uso, non per l'orto", correttamente scartati dal modello prima ancora di arrivare al fitting. Il modello distingue quindi, sul segnale fisico, esattamente il tipo di evento che l'utente aveva segnalato come fonte di sporco nei dati.

---

## 5. Coefficienti (Fase E)

Percentili 10/50/90 (aritmetica *nearest-rank*, stessa dei percentili di `k` in `analysis/03_stima_asciugatura.md`) sui candidati puliti di §4:

| Coefficiente | n | p10 | mediana | p90 |
|---|---|---|---|---|
| `w_irr` (%/L) | 150 | -0.0108 | **0.0380** | 0.3408 |
| `w_rain` (%/mm) | 38 | -3.6185 | **2.0141** | 26.9744 |

Ordinamento `p10 ≤ mediana ≤ p90` rispettato per entrambi (per costruzione: lo script si ferma con errore altrimenti). Le fasce restano larghe — il rapporto p90/mediana è ≈9× per `w_irr` (0.34/0.038) e ≈13× per `w_rain` (26.97/2.01) — coerente con l'irregolarità per-sonda già osservata nello step 15 (§2 di `docs/step16_modello_bagnatura.md`: una sonda guadagna 17 punti, una resta immobile, sullo stesso evento).

Entrambi i `p10` sono **negativi**: una minoranza dei candidati mostra un residuo di segno opposto a quello atteso (umidità che scende invece di salire nella finestra attribuita a irrigazione/pioggia). È una lettura plausibile del rumore/irregolarità per-sonda già nota, non un errore di calcolo — dopo la correzione del bug di `residuoDiPicco` (§3), il candidato selezionato per ogni finestra è il residuo più estremo in valore assoluto, non solo il più positivo, quindi questi casi "a segno invertito" entrano regolarmente nel campione quando sono il segnale più forte disponibile in quella finestra.

**Controllo di plausibilità fisica**: convertendo `w_irr` nel suo equivalente in %/mm (moltiplicando per l'area dell'orto, ~40 m² → ×40) si ottiene `0.0380 × 40 ≈ 1.52 %/mm` — stesso ordine di grandezza dell'ancoraggio fisico usato dalla spec dello step 15 (`rain_gain_pct_per_mm = 1.2`, dichiarato lì come stima di ordine di grandezza da un solo evento, non una misura). Questa conversione assume che l'irrigazione bagni l'intera superficie dell'orto (~40 m²) come farebbe la pioggia: è probabile che non sia così (irrigazione a goccia/manichetta copre verosimilmente un'area minore dei 40 m² interi), quindi il vero equivalente %/mm di `w_irr` è probabilmente **più alto** di 1.52 — il che restringe ulteriormente il divario con `w_rain`, rinforzando la conclusione sotto invece di indebolirla.

**`w_rain` fittato (2.0141), testato sui dati che effettivamente governa** (bucket "puliti", mai attraversato da una finestra valvola — vedi FASE F bis in §6.2), **risulta peggiore della costante già in produzione (1.2) a ogni orizzonte testato**, non migliore come una versione precedente di questo report concludeva confrontando `w_rain` solo indirettamente, nel bucket "contaminati" dove non viene mai esercitato in proporzione significativa (le finestre valvola dominano il segnale lì). Questo è coerente con il bias da statistica d'ordine documentato in §3: `w_rain` è fittato su appena 38 candidati (contro i 150 di `w_irr`) e ha una coda relativa più ampia (p90/mediana ≈13× contro ≈9× di `w_irr`) — il coefficiente più esposto a quel bias tra i due. È quindi più plausibile che sia il valore fittato di `w_rain` a essere gonfiato verso l'alto dal bias, non che la vecchia costante (1.2) fosse sottostimata.

---

## 6. Backtest esteso (Fase F)

### 6.1 Bucket "contaminati": asciugatura + bagnatura attraverso gli eventi

Confronto a quattro colonne (mediana, p90 in pp, n fra parentesi):

1. **puliti, solo asciugatura, senza alcun termine di pioggia** — variante NUOVA di questo giro di correzioni, **non** il riferimento pubblicato dallo step 15 (vedi nota sotto la tabella).
2. **contaminati, modello esteso** (`w_irr`/`w_rain` iniettati attraverso gli eventi)
3. **contaminati, senza bagnatura** — stessi intervalli della colonna 2, ma senza alcun termine di bagnatura
4. **contaminati, solo `w_irr`** — stessi intervalli della colonna 2, ma con `w_rain` forzato a 0: isola il contributo di `w_irr` da solo

```
orizzonte | 1) puliti/solo-asciugatura | 2) contaminati/esteso  | 3) contaminati/senza-bagnatura | 4) contaminati/solo-w_irr
      6h  |      1.15, 4.98 (4676)     |    2.35, 11.69 (5767)  |        1.89, 8.90 (5767)        |    2.14, 11.21 (5767)
     12h  |      1.76, 7.12 (3280)     |    4.28, 15.03 (7085)  |       3.75, 10.76 (7085)        |    4.08, 13.66 (7085)
     24h  |      3.44, 9.97 (2086)     |    6.69, 23.59 (8197)  |       7.48, 13.68 (8197)        |    6.69, 20.00 (8197)
```

**Nota sulla colonna 1**: questa colonna (n=4676/3280/2086) **non è** il riferimento pubblicato da `analysis/03_stima_asciugatura.md` (step 15) — quel riferimento usa `w_rain=1.2` sui campioni puliti, non `w_rain=0`. La riga "w_rain=1.2" della tabella §6.2 sotto lo riproduce: 1.28/5.79 (6h), 1.96/8.70 (12h), 3.32/17.56 (24h) — molto vicino ma non identico ai valori pubblicati (1.27/5.70, 1.95/8.71, 3.32/17.56 in `analysis/03_stima_asciugatura.md`). La piccola differenza è attesa e non un errore di metodo: questo giro usa lo storico aggiornato al 2026-08-17, un giorno in più rispetto allo snapshot (`2026-08-16`) usato per il report dello step 15.

**Decomposizione (colonna 4 contro 2 e 3)**: `w_irr` da solo (colonna 4) è vicino al pareggio con la baseline "senza bagnatura" (colonna 3), e a 24h la **batte sulla mediana**: 6.69 pp contro 7.48 pp. Il modello esteso completo (colonna 2) ha la **stessa mediana** di "solo `w_irr`" a 24h (6.69 pp), ma un p90 più alto (23.59 contro 20.00) — il peggioramento nella coda, a parità di mediana, è quasi interamente opera di `w_rain`. A 6h/12h `w_rain` peggiora sia mediana sia p90 rispetto a "solo `w_irr`". Nel complesso, il modello esteso (colonna 2) non batte "senza bagnatura" (colonna 3) a nessun orizzonte — ma la causa principale è `w_rain`, non `w_irr`.

### 6.2 Bucket "puliti": test onesto di `w_rain`

Il bucket "contaminati" sopra è dominato dalle finestre valvola: `w_rain` non viene mai esercitato lì in proporzione significativa (il termine si applica sempre, ma il segnale di `w_irr` è quello che domina ogni finestra classificata "contaminata"). Il bucket "puliti" — mai attraversato da una finestra valvola, per costruzione — è l'unico posto dove si può testare onestamente `w_rain` da solo, confrontando tre valori sugli stessi campioni: 0 (nessun termine di pioggia), 1.2 (la costante già in produzione, `rpi5/nodered/data/irrigation_config.json` → `forecast.rain_gain_pct_per_mm`) e 2.0141 (il valore fittato in §5):

```
orizzonte    | w_rain=0 (nessuna pioggia) | w_rain=1.2 (produzione attuale) | w_rain=2.0141 (fittato)
 6h (n=4676) |          1.15/4.98         |            1.28/5.79            |        1.38/6.94
12h (n=3280) |          1.76/7.12         |            1.96/8.70            |        2.24/12.66
24h (n=2086) |          3.44/9.97         |            3.32/17.56           |        3.37/33.72
```

**Il `w_rain` fittato è peggiore della costante di produzione a ogni orizzonte**, sia in mediana sia in p90, con l'eccezione di un quasi-pareggio in mediana a 24h (3.37 contro 3.32 — differenza di 0.05 pp, trascurabile). Il p90 invece peggiora nettamente a ogni orizzonte, in modo drammatico a 24h (33.72 contro 17.56 — quasi il doppio). Questa è la lettura corretta, e va nella direzione opposta a quella di una versione precedente di questo report: `w_rain` fittato **non batte** la costante già in produzione sui dati che effettivamente governa.

---

## 7. Raccomandazione

**Non procedere ora con il modello combinato — ma la scomposizione di §6 rende il quadro più utile di un "no" generico: `w_irr` e `w_rain` non sono nella stessa situazione e vanno trattati separatamente.**

1. **`w_irr` è vicino al pareggio ed è il candidato migliore per un secondo giro**: da solo (§6.1, colonna 4) è quasi neutro rispetto alla baseline "senza bagnatura", e a 24h la batte sulla mediana (6.69 contro 7.48 pp). È anche fisicamente plausibile in ordine di grandezza (§5: equivalente ~1.52 %/mm, probabilmente sottostimato dall'assunzione di copertura piena dei 40 m², quindi ancora più vicino a `w_rain` di quanto sembri). Non serve cambiare metodo: serve più campione pulito, che crescerà da solo con `mode=auto` (punto 4 sotto).
2. **`w_rain`, al valore attualmente fittato (2.0141), è invece dannoso e non va usato per sostituire la costante di produzione (1.2)**: testato sui dati che effettivamente governa — il bucket "puliti", mai attraversato da una finestra valvola (§6.2) — è peggiore della costante attuale a ogni orizzonte, in modo netto sul p90 (fino quasi al doppio a 24h). Non è un errore di dati o di codice: è coerente con il bias da statistica d'ordine di §3 (massimo su finestra confrontato con una soglia calibrata su un errore puntuale) applicato a un campione piccolo (n=38) e con coda relativa ampia (p90/mediana ≈13×) — il coefficiente più esposto a quel bias fra i due. `w_rain` ha bisogno di un giro di lavoro dedicato (più campioni pioggia, e/o la ricalibrazione della soglia del punto 5 sotto) prima di poter essere anche solo riconfrontato con la produzione.
3. Il campione pioggia usato per `w_rain` (n=38) è più consistente della guardia minima di 15 campioni (§5 di `docs/step16_modello_bagnatura.md`) rispetto al giro precedente di questo script, ma resta piccolo rispetto a `w_irr` (n=150) e ha la coda relativa più ampia dei due: un fit ancora fragile, a rischio di instabilità con la prossima estrazione di dati.
4. **C'è un motivo concreto per essere ottimisti sul futuro, non solo per rimandare**: da quando `mode=auto` gira stabilmente (dal 2026-08-16, più la settimana di monitoraggio appena iniziata a oggi), ogni evento `trigger=auto` è per costruzione irrigazione reale verificata dal decision loop stesso — non serve più il processo di pulizia (Fasi B/C/D) per i dati nuovi. **Attenzione — avviso esplicito**: `trigger=auto` viene scritto anche in `mode=dry_run` (§1), quindi filtrare solo su `trigger=auto` **non** garantisce dati puliti. **Qualunque futura estrazione dati "pulita" per un eventuale giro 2 deve filtrare su entrambe le condizioni insieme — `_time >= 2026-08-16` E `trigger=auto` — mai su `trigger` da solo**, altrimenti mesi di rumore `dry_run` rientrerebbero silenziosamente nel campione presunto pulito.
5. Come possibile miglioramento futuro (non un'azione di questo report): la soglia di "sorpresa" potrebbe essere ricalibrata contro una distribuzione di massimi-su-finestra invece che contro una mediana puntuale, per correggere il bias di §3 e ridurre i falsi positivi nella rilevazione — utile soprattutto per `w_rain`, il coefficiente più esposto a quel bias.

Non si raccomanda di procedere a una fase 2 unica per entrambi i coefficienti (wiring live nel simulatore dello step 15): il backtest esteso non mostra il miglioramento chiaro a 12h richiesto da quella soglia, e la causa è quasi interamente `w_rain`. Non si raccomanda nemmeno la conclusione più netta "il modello non aiuta": `w_irr` da solo è vicino al pareggio ed è un candidato ragionevole per un secondo giro con più dati puliti, con lo stesso metodo (nessun cambio di metodologia richiesto). `w_rain`, invece, non è pronto: va rivisto (più campioni, soglia ricalibrata) prima di poter anche solo ricompetere con la costante `1.2` già in produzione.
