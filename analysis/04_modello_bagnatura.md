# Analisi — Modello di bagnatura (`w_irr` / `w_rain`)

**Data esecuzione:** 2026-08-17
**Periodo coperto:** eventi valvola dal 2026-05-03 al 2026-08-17 (oggi); serie di umidità/ET0/pioggia sullo storico ultimo di 120 giorni a 15 minuti (`analysis/umidita.csv`).
**Scope:** stima di `w_irr`/`w_rain` per lo step 16 fase 1, vedi [`docs/step16_modello_bagnatura.md`](../docs/step16_modello_bagnatura.md).
**Documenti propedeutici:** [`docs/step15_previsione_prossima_irrigazione.md`](../docs/step15_previsione_prossima_irrigazione.md) (modello di asciugatura `k·ET0`, riusato qui come contro-fattuale), [`analysis/03_stima_asciugatura.md`](03_stima_asciugatura.md) (stessa metodologia di percentili "nearest-rank"), [`analysis/stima_bagnatura.mjs`](stima_bagnatura.mjs) (script che produce questi numeri, eseguibile con `node analysis/stima_bagnatura.mjs`).

---

## 0. Esito in breve

| | |
|---|---|
| Eventi valvola totali (`duration_seconds>0`) | 296 (71 `auto`, 8 `emergency`, 217 `manual`) |
| Eventi di pioggia raggruppati | 139 |
| Pavimento di rumore (Fase A, orizzonte 2h) | mediana **0.44 pp**, p90 **2.86 pp** |
| Fattore di sicurezza scelto | **3.0** (soglia 1.32 pp) |
| Attribuzione irrigazione (su 296) | 115 `scartato_rumore` · **134 irrigazione** · 47 `scartato_ambiguo` |
| Attribuzione pioggia (su 139) | 70 `scartato_rumore` · **31 pioggia** · 38 `scartato_ambiguo` |
| `w_irr` | **0.0419 %/L** (n=134, p10 0.0118, p90 0.3626) |
| `w_rain` | **3.1606 %/mm** (n=31, p10 0.9804, p90 26.9744) |
| Backtest esteso a 12h, modello esteso vs baseline senza bagnatura | 4.64 pp contro 3.75 pp — **il modello esteso non batte la baseline** |
| **Raccomandazione** | **Non procedere ora — servono più dati** |

---

## 1. Dati di partenza

| File | Righe/eventi | Contenuto |
|---|---|---|
| `analysis/umidita.csv` (non versionato) | 10589 | media dei sensori attivi, bucket 15 min, storico ultimi 120 giorni |
| `analysis/eventi.csv` (non versionato) | 296 | eventi valvola con `duration_seconds > 0`, dal 2026-05-03 al 2026-08-17, con tag `trigger` |

Distribuzione `trigger` sui 296 eventi valvola: **71 `auto`**, **8 `emergency`**, **217 `manual`**.

Eventi di pioggia (Open-Meteo `/archive`, stessa coppia di coordinate già in uso dallo step 15), raggruppati da ore consecutive con pioggia > 0 in episodi distinti: **139**.

### Scoperta rilevante: la premessa dello step 15 §2 sul `trigger` è inesatta

`docs/step15_previsione_prossima_irrigazione.md` §2 afferma che «prima del 2026-08-16 ogni irrigazione è stata manuale». Il riesame dei 296 eventi mostra che è **falso**: il primo evento con `trigger=auto` è già del 2026-05-03, mesi prima della data indicata.

Causa probabile, individuata in `flows.json`: il campo `trigger` viene scritto come `auto`/`emergency` ogni volta che il decision loop apre la valvola, **anche in `mode=dry_run`** — modalità che logga l'evento come se avesse aperto, ma non comanda la valvola reale — e non solo quando il `mode` globale del sistema è `auto`.

**Questa scoperta non invalida il piano di questo step.** L'attribuzione (Fase D, §4 sotto) si basa sempre sul residuo di umidità osservato rispetto al contro-fattuale, mai sull'etichetta `trigger`. Un evento `dry_run` (nessuna acqua realmente erogata) produce quindi comunque un residuo vicino a zero e finisce in `scartato_rumore`, esattamente come un evento manuale di "acqua per altro uso" — la scoperta conferma anzi che l'approccio scelto (basato sul segnale fisico misurato, non sull'etichetta del record) era la scelta giusta anche per questa fonte di sporco nei dati non anticipata in fase di spec.

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

Soglia di "sorpresa" = fattore × 0.44 pp (mediana del pavimento, §2). 139 eventi di pioggia raggruppati usati come base per il conteggio pioggia, 296 eventi valvola come base per il conteggio irrigazione:

```
fattore | soglia (pp) | sorprese irrigazione (/296) | sorprese pioggia (/139)
    1.5 |        0.66 |                          213 |                      90
    2.0 |        0.88 |                          204 |                      83
    3.0 |        1.32 |                          181 |                      69
```

Nessun gomito netto: il calo è quasi lineare fra i tre fattori testati, non c'è un punto dove il rumore residuo si stacca chiaramente dal segnale vero.

**Riserva statistica identificata e confermata da due review indipendenti**: `residuoDiPicco` prende il **massimo** residuo su ~12+ campioni in una finestra di 3h, ma la soglia è calibrata sulla **mediana** di un errore *puntuale* (un solo campione per proiezione, non un massimo su finestra) — un bias da statistica d'ordine che gonfia sistematicamente il tasso di "sorprese" rilevate anche in assenza di segnale vero. Per questo, anche al fattore più alto testato, il tasso resta alto: **61% degli eventi valvola** (181/296) e **50% delle piogge** (69/139) contano ancora come "sorpresa".

**Fattore scelto: 3.0** — il più prudente fra i tre candidati testati. Non elimina il bias descritto sopra, ma lo mitiga parzialmente rispetto ai fattori 1.5 e 2.0. La verifica definitiva se il modello così ottenuto sia effettivamente utile arriva dal backtest esteso (§6), non da questa tabella.

---

## 4. Attribuzione (Fase D)

Ogni finestra di sorpresa (fattore 3.0) è classificata incrociando "valvola aperta vicino" (qualunque `trigger`) e "pioggia registrata vicino":

| Categoria | `scartato_rumore` | esito valido | `scartato_ambiguo` | Totale |
|---|---|---|---|---|
| Irrigazione | 115 | **134** (`irrigazione`) | 47 | 296 |
| Pioggia | 70 | **31** (`pioggia`) | 38 | 139 |

**Questo è il numero che risponde direttamente al problema posto a inizio step 16** ("ho sempre usato lo sblocco manuale sia per l'orto sia per altro"): **115 aperture valvola su 296 (39%) non hanno prodotto una salita di umidità misurabile oltre il pavimento di rumore** — sono i candidati più probabili per "acqua usata per altro uso, non per l'orto", correttamente scartati dal modello prima ancora di arrivare al fitting. Il modello distingue quindi, sul segnale fisico, esattamente il tipo di evento che l'utente aveva segnalato come fonte di sporco nei dati.

---

## 5. Coefficienti (Fase E)

Percentili 10/50/90 (aritmetica *nearest-rank*, stessa dei percentili di `k` in `analysis/03_stima_asciugatura.md`) sui candidati puliti di §4:

| Coefficiente | n | p10 | mediana | p90 |
|---|---|---|---|---|
| `w_irr` (%/L) | 134 | 0.0118 | **0.0419** | 0.3626 |
| `w_rain` (%/mm) | 31 | 0.9804 | **3.1606** | 26.9744 |

Ordinamento `p10 ≤ mediana ≤ p90` rispettato per entrambi. Le fasce sono larghe: 31× per `w_irr`, 27× per `w_rain` — coerente con l'irregolarità per-sonda già osservata nello step 15 (§2 di `docs/step16_modello_bagnatura.md`: una sonda guadagna 17 punti, una resta immobile, sullo stesso evento).

**Controllo di plausibilità fisica**: convertendo `w_irr` nel suo equivalente in %/mm (moltiplicando per l'area dell'orto, ~40 m² → ×40) si ottiene `0.0419 × 40 ≈ 1.68 %/mm` — stesso ordine di grandezza dell'ancoraggio fisico usato dalla spec dello step 15 (`rain_gain_pct_per_mm = 1.2`, dichiarato lì come stima di ordine di grandezza da un solo evento, non una misura). `w_rain` fittato (3.1606) è più alto di quell'ancoraggio (1.2), ma quell'ancoraggio veniva da un singolo evento mentre questo fit è su 31 candidati puliti: è plausibile che il vecchio numero fosse sottostimato, non che il nuovo sia sbagliato.

---

## 6. Backtest esteso (Fase F)

Confronto a tre colonne (mediana, p90 in pp, n fra parentesi) fra: 1) dati puliti proiettati solo con asciugatura (riferimento), 2) dati contaminati proiettati col modello esteso (`w_irr`/`w_rain` iniettati attraverso gli eventi), 3) dati contaminati proiettati ignorando la bagnatura (stesso n della colonna 2, per costruzione, così il confronto 2 vs 3 è onesto):

```
orizzonte | 1) puliti/solo-asciugatura | 2) contaminati/modello-esteso | 3) contaminati/senza-bagnatura
      6h  |      1.15, 4.98 (4676)     |        2.45, 12.58 (5767)      |       1.89, 8.90 (5767)
     12h  |      1.76, 7.12 (3280)     |        4.64, 17.00 (7085)      |       3.75, 10.76 (7085)
     24h  |      3.44, 9.97 (2086)     |        7.50, 26.99 (8197)      |       7.48, 13.68 (8197)
```

**Osservazione onesta**: il modello esteso (colonna 2) **non batte** la baseline "nessuna bagnatura" (colonna 3) a nessuno dei tre orizzonti — è peggiore a 6h (2.45 contro 1.89 pp) e a 12h (4.64 contro 3.75 pp), e sostanzialmente pari a 24h (7.50 contro 7.48 pp). Il confronto è stato verificato come genuinamente comparabile: colonna 2 e colonna 3 hanno n identico a ogni orizzonte, perché la classificazione contaminato/pulito non dipende in alcun modo dai valori di `w_irr`/`w_rain`.

---

## 7. Raccomandazione

**Non procedere ora — servono più dati.**

1. Il segnale centrale, `w_irr`, è fisicamente plausibile (§5: l'equivalente in %/mm è dello stesso ordine di grandezza dell'ancoraggio della spec dello step 15). Il problema non è quindi "il fenomeno non esiste", ma "la stima attuale è troppo rumorosa per essere utile in produzione".
2. La causa più probabile del risultato negativo del backtest è il bias statistico nel rilevamento delle sorprese descritto in §3 (massimo su finestra confrontato con una soglia calibrata su un errore puntuale), identificato e confermato indipendentemente da due review — non un errore nei dati o nel codice.
3. Il campione pioggia usato per `w_rain` (n=31) è appena sopra la guardia minima di 15 campioni fissata dalla spec (§5 di `docs/step16_modello_bagnatura.md`): un fit fragile, a rischio di instabilità con la prossima estrazione di dati.
4. **C'è un motivo concreto per essere ottimisti sul futuro, non solo per rimandare**: da quando `mode=auto` gira stabilmente (dal 2026-08-16, più la settimana di monitoraggio appena iniziata a oggi), ogni evento `trigger=auto` è per costruzione irrigazione reale verificata dal decision loop stesso — non serve più il processo di pulizia (Fasi B/C/D) per i dati nuovi. Il campione pulito crescerà nelle prossime settimane senza bisogno di modificare la metodologia.
5. Come possibile miglioramento futuro (non un'azione di questo report): la soglia di "sorpresa" potrebbe essere ricalibrata contro una distribuzione di massimi-su-finestra invece che contro una mediana puntuale, per correggere il bias di §3 e ridurre i falsi positivi nella rilevazione.

Non si raccomanda di procedere a una fase 2 (wiring live nel simulatore dello step 15): il backtest esteso non mostra il miglioramento chiaro a 12h richiesto da quella soglia. Non si raccomanda nemmeno la conclusione più netta "il modello non aiuta": un solo giro di dati, con un campione pioggia al limite della guardia minima e un bias di rilevamento già identificato e correggibile, non giustifica ancora quella conclusione.
