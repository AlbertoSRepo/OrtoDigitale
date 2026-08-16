# Analisi — Stima del coefficiente di asciugatura k

**Data esecuzione:** 2026-08-16
**Scope:** stimare `k_pct_per_mm` (e le code `p10`/`p90`) dallo storico reale di quest'orto, per il modello di asciugatura `velocità (%/h) = k · ET0` usato dal simulatore di previsione. Cancello di accettazione dello step 15 (spec §11): errore mediano della proiezione dell'umidità a 12h sotto 3 punti percentuali.
**Documenti propedeutici:** [`docs/step15_previsione_prossima_irrigazione.md`](../docs/step15_previsione_prossima_irrigazione.md) (spec del modello e della fascia di incertezza `p10`/`p90`), [`analysis/stima_k.mjs`](stima_k.mjs) (script che produce questi numeri, eseguibile con `node analysis/stima_k.mjs`).

---

## 0. Esito in breve

| | |
|---|---|
| Periodo coperto | 2026-04-26 → 2026-08-16 (≈112 giorni) |
| Campioni puliti (pavimento scelto) | 1647 |
| `k_pct_per_mm` | **1.296** |
| `k_pct_per_mm_p10` | **0.256** |
| `k_pct_per_mm_p90` | **4.593** |
| Ordinamento `p10 ≤ k ≤ p90` | OK |
| Errore mediano a 12h | **1.95 pp** — sotto la soglia di 3 pp |
| **Cancello** | **RISPETTATO** |

I tre valori sopra sono stati scritti in `rpi5/nodered/data/irrigation_config.json` (sezione `forecast`).

---

## 1. Dati grezzi

Esportati da InfluxDB con due query di sola lettura (dettaglio nel Task 7 del piano di implementazione dello step 15):

| File | Righe dato | Contenuto |
|---|---|---|
| `analysis/umidita.csv` (non versionato) | 10531 | media dei 4 sensori attivi, bucket 15 min |
| `analysis/eventi.csv` (non versionato) | 296 | eventi di irrigazione (`duration_seconds > 0`) |

L'ET0 storica e la pioggia oraria vengono dall'archivio Open-Meteo (`archive-api.open-meteo.com`), stessa coppia di coordinate già in uso per le previsioni (`lat 45.71722434055733`, `lon 9.733793667999565`).

**Esclusioni applicate al fitting** (tutte necessarie prima di poter leggere `calo/ET0` come segnale):

- passo fra due letture consecutive `dt_h` fuori da `(0, 0.5]` ore (buchi nella serie)
- finestra contaminata da irrigazione: da 30 min prima dell'apertura a 3 h dopo la chiusura
- ore con pioggia oraria > 0 mm
- calo di umidità ≤ 0 (sale: pioggia non tracciata o rumore)
- **pavimento sull'ET0 orario**: campioni con `et0[h] < 0.15 mm/h` esclusi — vedi §2

## 2. Il problema del pavimento ET0

La prima versione dello script filtrava solo sul passo di ET0 cumulato (`et0[h]·dt_h ≤ 0.001 mm`), una soglia praticamente nulla. Il fitting è un **rapporto** (`calo/ET0`), non una regressione: quando l'ET0 oraria è vicina a zero — tipicamente di notte — qualunque rumore della sonda diviso per un denominatore minuscolo produce valori assurdi. Sui dati di questo orto, il rapporto più alto osservato era **1900 %/mm**, e il 90° percentile della prima stima risultava **30 %/mm** (13 volte la mediana): un coefficiente fisicamente implausibile, sintomo di uno stimatore rotto in quella coda, non di una vera dispersione del fenomeno.

Verifica indipendente (nessun `k` coinvolto): il "calo" osservato per fascia di ET0 orario resta piatto (0.067–0.100 punti percentuali) su un intervallo di ET0 15× più ampio (0.01–0.15 mm/h) — il segno di un livello dominato da rumore/risoluzione, non da vera asciugatura — e comincia a crescere con più chiarezza solo da 0.15 mm/h in su (0.125, poi 0.156).

**Correzione:** un pavimento esplicito su `et0[h]` (mm/h), scelto con un'analisi di sensibilità su cinque candidati, argomentata sulla tabella "calo vs fascia ET0" sopra e **non** sulla tabella degli errori:

```
pavimento(mm/h) |    n |    k    |   p10  |   p90  || err6h med/p90 | err12h med/p90 | err24h med/p90
       originale | 2637 |   2.222 |  0.364 | 30.000 ||     1.95/6.68 |      3.46/9.70 |     7.34/16.31
            0.01 | 2637 |   2.222 |  0.364 | 30.000 ||     1.95/6.68 |      3.46/9.70 |     7.34/16.31
            0.02 | 2446 |   2.037 |  0.333 | 21.871 ||     1.78/6.32 |      3.08/9.21 |     6.50/16.36
            0.05 | 1970 |   1.481 |  0.284 |  8.851 ||     1.34/5.75 |      2.13/8.75 |     4.02/17.09
            0.10 | 1753 |   1.333 |  0.265 |  5.507 ||     1.29/5.71 |      1.99/8.69 |     3.45/17.46
            0.15 | 1647 |   1.296 |  0.256 |  4.593 ||     1.27/5.70 |      1.95/8.71 |     3.32/17.56
```

Le variazioni fra pavimenti **consecutivi** mostrano convergenza monotona, non oscillazione:

```
0.01 -> 0.02   k  -8.3%   err12h -11.0%
0.02 -> 0.05   k -27.3%   err12h -30.8%   (gradino grosso: qui si toglie la contaminazione notturna)
0.05 -> 0.10   k -10.0%   err12h  -6.6%
0.10 -> 0.15   k  -2.8%   err12h  -2.0%   (assestamento)
```

Scelto **0.15 mm/h**: il più alto fra i candidati testati, coerente con il punto in cui il segnale osservato comincia a separarsi dalla banda piatta di rumore. Il cancello risulta rispettato a **ogni** pavimento della fascia fisicamente difendibile (0.05, 0.10, 0.15) — la conclusione non dipende dal punto esatto scelto in quella fascia.

## 3. Risultato finale (pavimento 0.15 mm/h)

```
campioni puliti: 1647
k    = 1.296 %/mm
k p10= 0.256   k p90= 4.593
ordinamento p10 <= k <= p90: OK
```

## 4. Backtest — tabella degli errori

```
orizzonte | campioni | errore mediano | errore p90
       6h |     4637 |           1.27 |       5.70
      12h |     3265 |           1.95 |       8.71
      24h |     2086 |           3.32 |      17.56
```

**Rispetto al criterio:** il cancello richiede errore mediano a 12h sotto 3 pp. Il risultato (1.95 pp) è sotto soglia con un margine di oltre 1 pp — il criterio è rispettato in modo netto, non al limite.

## 5. Riserve — cosa questo numero non dice

Tre limiti misurati o strutturali, non ipotetici, che chi userà la previsione deve conoscere:

**a) La coda a 24 ore è spessa, e peggiora invece di migliorare col pavimento.** L'errore p90 a 24h è ~17.6 pp, ed è l'unica metrica della tabella di sensibilità (§2) che va nella direzione opposta a tutte le altre: peggiora monotonamente man mano che il pavimento sale (16.31 → 17.56). Significa che una volta su dieci la proiezione a 24 ore sbaglia di oltre 17 punti percentuali. Le previsioni a lungo raggio hanno un'incertezza reale, non solo teorica, e chi costruirà l'interfaccia deve mostrarla — non solo l'orario centrale.

**b) Lo scarto fra `p10` e `p90` è un fattore ~18** (0.256 contro 4.593). La fascia di incertezza che ne deriva sarà molto larga. In particolare, con `p10 = 0.256` lo scenario ottimistico (asciugatura più lenta) attraverserà la soglia di apertura raramente entro l'orizzonte di previsione: `band_end_open` risulterà `true` quasi sempre per quello scenario. Non è un difetto del codice — è la larghezza reale dell'incertezza misurata sui dati di questo orto — ma va scritto qui, altrimenti chi lo vede per la prima volta lo scambierà per un bug.

**c) Il backtest è in-sample: non c'è separazione fra dati di stima e dati di verifica.** Gli stessi campioni (e la stessa serie di umidità) usati per calcolare `k` in §3 sono quelli su cui si misura l'errore di proiezione in §4 — non esiste un holdout temporale che tenga i due usi separati. È un limite ereditato dall'impostazione stessa dell'analisi, non una scelta fatta per far tornare il numero. L'effetto atteso è modesto: `k` è una mediana su 1647 punti sparsi su ~4 mesi, non un fit calibrato finestra per finestra, quindi il rischio che il backtest stia solo "ricordando" i dati di stima è basso — ma resta un'aspettativa, non una misura. Per escluderlo del tutto servirebbe una separazione temporale esplicita (es. stimare `k` sui primi mesi del periodo e validare il backtest solo sugli ultimi), non fatta in questo giro.

## 6. Conclusione

`k_pct_per_mm = 1.296`, `k_pct_per_mm_p10 = 0.256`, `k_pct_per_mm_p90 = 4.593` sostituiscono i `null` in `rpi5/nodered/data/irrigation_config.json`. Il cancello è rispettato con margine, ma le riserve del §5 (coda a 24h, fascia di incertezza molto larga, backtest in-sample) restano parte del risultato tanto quanto il numero centrale.
