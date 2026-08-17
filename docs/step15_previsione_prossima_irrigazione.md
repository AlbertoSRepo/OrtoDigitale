# Step 15 — Previsione della prossima irrigazione

## Indice

1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Decisioni di design](#3-decisioni-di-design)
4. [Il modello di proiezione](#4-il-modello-di-proiezione)
5. [Il modulo di regole condiviso](#5-il-modulo-di-regole-condiviso)
6. [Architettura del flow](#6-architettura-del-flow)
7. [Contratto API](#7-contratto-api)
8. [Degradazione e confidenza](#8-degradazione-e-confidenza)
9. [Configurazione](#9-configurazione)
10. [Interfaccia](#10-interfaccia)
11. [Test e validazione](#11-test-e-validazione)
12. [File toccati](#12-file-toccati)
13. [Fuori scope](#13-fuori-scope)
14. [Verifica end-to-end](#14-verifica-end-to-end)
15. [Aggiornamenti a CLAUDE.md](#15-aggiornamenti-a-claudemd)

---

## 1. Obiettivo

Rispondere nell'app alla domanda **«quando verrà bagnato prossimamente»**, con una
stima nell'ordine delle ore, una fascia di incertezza dichiarata e il motivo per cui
sarà quel momento e non prima.

### Perché serve

Due usi concreti, entrambi dichiarati dall'utente:

1. **Decidere se intervenire a mano.** «Il sistema bagna stasera o apro io adesso?»
2. **Non entrare in conflitto sull'acqua.** L'impianto serve anche altri usi oltre
   l'orto: sapere in anticipo quando la valvola aprirà, e per quanto, evita di
   trovarsi con due prelievi sovrapposti.

Il secondo uso implica che oltre all'istante serva la **durata prevista**. In
`mode=auto` è un dato certo, non una stima: l'auto-irrigazione è limitata a
`safety_timeout_seconds` (900 s).

---

## 2. Stato di partenza

### Cosa decide oggi il sistema

`decision logic` (tab *Decision Loop (step 4)*) gira ogni 5 minuti e applica una
catena di regole deterministica, nell'ordine:

| # | Regola | Fonte |
|---|---|---|
| 1 | `mode` = `paused` oppure `pause_until` non scaduto | config |
| 2 | Quorum sonde valide < `min_quorum` | `soil_moisture_cache` |
| 3 | Umidità media ≥ `soglia_apertura_pct` → non si apre | `soil_moisture_cache` |
| 4 | Fuori dalle finestre orarie (**saltata** se media < `soglia_emergenza_pct`) | orologio |
| 5 | Cooldown non scaduto | `last_irrigation_at` |
| 6 | Pioggia prevista ≥ `rain_threshold_mm` (solo se cache meteo fresca) | `weather_cache` |
| 7 | Valvola non raggiungibile | `valve_reachable` |
| 8 | → APRE | |

La previsione è quindi un problema **deterministico dato lo stato futuro**: non
serve indovinare cosa deciderà il sistema, serve proiettare in avanti gli
ingressi e rieseguire le stesse regole.

`mode=auto` è attivo dal 2026-08-16 (commit `689dc9f`). Prima di quella data ogni
irrigazione è stata manuale.

### Cosa dicono i dati (rilevati il 2026-08-16 su InfluxDB)

**Storico eventi:** 295 record `irrigation_events` con `duration_seconds > 0` dal
2026-05-03, di cui 260 ≥ 120 s. Tutti con `trigger=manual`.

**Portata della valvola:** il field `flow` di `valve_state` durante l'apertura vale
stabilmente **0.8–0.9 m³/h**, cioè ~14 L/min. Un'apertura da 900 s eroga quindi
circa **210 L**, che su 40 m² equivalgono a ~5.25 mm di pioggia.

**I campi derivati esistenti non sono utilizzabili come verità:**

- `delta_moisture` è misurato **alla chiusura della valvola** e vale 0 o valori
  negativi (−1.75, −1.33, −0.75 negli eventi del 14–15 agosto). Non misura
  l'effetto dell'irrigazione: misura il ritardo di infiltrazione.
- `total_liters` è presente in 101 record su 295, e i valori non sono compatibili
  con la portata misurata: 416 L attribuiti a un evento di 163 s richiederebbero
  9.2 m³/h, dieci volte la portata reale.

**Il ritardo di risposta del terreno**, evento del 2026-08-14T18:18Z (958 s):

| Ora (UTC) | WH51_01 | WH51_02 | WH51_03 | WH51_04 |
|---|---|---|---|---|
| 18:45 (chiusura) | 60.0 | 53.0 | 42.0 | **45.0** |
| 19:30 | — | 56.2 | 42.0 | 52.9 |
| 19:45 | — | 56.9 | 42.0 | 61.1 |
| 20:00 | — | 54.7 | 42.0 | **62.3** |

Il picco arriva **~90 minuti dopo la chiusura**. WH51_04 guadagna 17 punti,
WH51_02 ne guadagna 4, WH51_03 resta immobile: l'acqua non gli arriva. WH51_01 ha
buchi di trasmissione.

WH51_03 **non è una sonda guasta**: su 10 giorni è la più variabile delle quattro
(dev. std 7.15, contro 4.33 / 4.88 / 5.86 delle altre). La distribuzione dell'acqua
è irregolare **per singolo evento**, non c'è una zona morta fissa.

### Un bug in produzione nel parsing meteo (rilevato in fase di pianificazione)

Gli array orari di Open-Meteo **partono da mezzanotte del giorno corrente** nel
fuso richiesto, non dall'ora corrente. Verificato con chiamata reale il 2026-08-16:

```
hourly.time[0] = "2026-08-16T00:00"      utc_offset_seconds = 7200
```

Il nodo `parse + cache + influx point` indicizza invece per posizione
(`precip.slice(0, 24)`, `hum[0]`, `temp.slice(0, 12)`), assumendo che l'indice 0
sia «adesso». Ne consegue che, in produzione:

| Campo | Significato inteso | Significato reale |
|---|---|---|
| `precip_next_24h_mm` | pioggia nelle prossime 24 h | pioggia **di oggi da mezzanotte**, in gran parte già caduta |
| `humidity_now_pct` | umidità corrente | umidità **a mezzanotte** |
| `temp_max_next_12h_c` | massima nelle prossime 12 h | massima fra 00:00 e 12:00 — **perde sempre il picco pomeridiano** |

La regola 6 (`rain_delay`) del decision loop decide quindi sulla pioggia **già
caduta** invece che su quella prevista, e il difetto è attivo da quando `mode=auto`
è stato acceso.

**La correzione rientra in questo step** perché ne è comunque un prerequisito: il
simulatore deve poter mappare un istante futuro su una posizione dell'array, il che
richiede `hourly.time`. Vedi Task 1 del piano di implementazione.

### Conseguenze per questo step

Il modello di questo step riguarda l'**asciugatura**, che si misura
sulle serie grezze di `soil_moisture` (1 punto/minuto per sonda, integre). I campi
derivati rotti riguardano la **bagnatura**, che è materia dello step 16.

---

## 3. Decisioni di design

### D1 — La stima di asciugatura è guidata dall'evapotraspirazione, non dalla persistenza

`velocità di asciugatura (%/h) = k · ET0(ora)`, con `ET0` presa dalla previsione
oraria di Open-Meteo (`et0_fao_evapotranspiration`, stesso endpoint già in uso) e
`k` unico coefficiente stimato dallo storico.

**Alternativa scartata: media mobile pura** (pendenza delle ultime 24–48 h proiettata
in avanti). Ha un difetto strutturale: di notte l'orto non si asciuga quasi, di
giorno sì. Una pendenza media unica produce attraversamenti di soglia notturni che
non avverranno mai. Correggerlo richiede di separare giorno e notte a mano — e a
quel punto si è già a metà strada verso ET0, che lo fa meglio con lo stesso sforzo
perché di notte l'ET0 vale ~0. In più ET0 usa il meteo **previsto** invece di
assumere che domani sia come ieri: una giornata più fresca o nuvolosa viene
gestita correttamente.

**Alternativa scartata: ricalibrazione online di `k`** (aggiustamento continuo
confrontando previsto e osservato). Dà precisione superiore a quella richiesta in
cambio di opacità: quando sbaglia diventa difficile capire perché. Resta
un'evoluzione possibile quando `k` avrà mesi di storico alle spalle.

La media mobile resta implementata come **fallback** quando la cache meteo è
scaduta (vedi D6).

### D2 — La simulazione si ferma al primo evento

Il simulatore avanza fino alla prima apertura prevista e si ferma. Non prosegue per
prevedere la seconda e la terza.

Questa non è una limitazione dell'interfaccia: è ciò che rende lo step 15
**indipendente dallo step 16**. Proseguire oltre il primo evento richiederebbe di
modellare *quanto* sale l'umidità quando si bagna — cioè esattamente il modello di
risposta che lo step 16 dovrà costruire e che oggi non esiste. Fermandosi al primo
evento serve solo il modello di asciugatura.

Quando il modello di bagnatura esisterà, si aggancia qui senza riscrivere nulla.

### D3 — La fascia di incertezza si ricava dai dati, non da una costante

La stessa proiezione viene eseguita tre volte — scenario centrale, ottimistico e
pessimistico — e `band_start` / `band_end` sono gli istanti risultanti dagli
estremi. Due sorgenti di incertezza concorrono, entrambe misurate:

| Sorgente | Come entra negli scenari estremi | Da dove viene |
|---|---|---|
| Dispersione di `k` | `k_pct_per_mm_p10` e `k_pct_per_mm_p90` | fitting offline, in config |
| Dispersione dello stato iniziale | `m(0) ± stddev` fra le sonde valide | `soil_moisture_cache`, al momento del calcolo |

Lo scenario ottimistico (irrigazione più lontana) combina `k` al 10° percentile con
`m(0) + stddev`; quello pessimistico combina `k` al 90° percentile con
`m(0) − stddev`.

**Quando il modello degrada a `empirical`** (cache meteo assente) i percentili di
`k` non sono applicabili: la fascia si ricava allora dalla dispersione delle
pendenze osservate nella finestra `stats_window_days`, calcolata dal job orario.

Se lo storico dice che l'asciugatura è regolare e le sonde concordano, la fascia è
stretta; se una delle due cose varia molto, si allarga da sola. Nessuna tolleranza
inventata a tavolino.

### D4 — Le regole vivono in un modulo unico, condiviso fra chi decide e chi simula

Se il simulatore riscrivesse la catena di regole per conto suo, il giorno che una
soglia cambia in un posto solo la previsione comincerebbe a mentire in silenzio.

Le regole vengono estratte in un **function node dedicato di `flows.json`**
(`libreria regole`, id `nr-fn-lib`), che all'avvio registra
`global.set('orto_rules', { valutaRegole })`. Sia `decision logic` sia il
simulatore leggono la funzione da lì.

> **Correzione rispetto alla prima stesura di questa spec.** Era previsto un
> modulo in `rpi5/nodered/data/node_modules/orto-rules/` richiesto via `require`.
> Non è praticabile: `rpi5/nodered/data/node_modules/` è in `.gitignore`, quindi il
> modulo non sarebbe stato versionato. La soluzione qui sopra tiene tutto in
> `flows.json`, che `CLAUDE.md` indica già come source of truth, e si appoggia al
> banco di prova che il progetto usa dallo step 13 (vedi §11).

**Il refactor tocca codice in produzione da un giorno.** Sequenza obbligata:

1. Scrivere i test che **fotografano il comportamento attuale** di `decision logic`
   (stessi ingressi → stesse uscite di oggi).
2. Estrarre il modulo.
3. Verificare che le decisioni restino identiche.

Non è ammesso l'ordine inverso.

### D5 — La curva oraria del meteo resta in memoria, non su InfluxDB

La regola 6 non confronta un numero fisso: confronta la somma delle precipitazioni
**nelle 24 h successive all'istante considerato**. Al passo simulato «domani alle
06:00» serve la somma dalle 06:00 alle 06:00 del giorno dopo, che la cache attuale
non possiede — conserva solo `precip_next_24h_mm` calcolato adesso.

La cache meteo in `global.context` deve quindi conservare **la curva oraria** di
precipitazione ed ET0 per l'orizzonte di previsione.

Questo **non contraddice** `analisi_integrazione_meteo.md §2.4` («non storicizzare
la curva oraria completa»): quel vincolo riguarda cosa si **scrive su InfluxDB**. Su
InfluxDB continuano ad andare solo gli aggregati. La curva vive in memoria e viene
sovrascritta a ogni polling.

### D6 — Nessuna dipendenza esterna può rendere muta la previsione

Stesso principio già adottato per il rain delay: un'API meteo giù non deve bloccare
niente. La previsione degrada per gradi e **dichiara sempre in che grado si trova**
(vedi §8). Non esiste uno stato in cui la carta mostra un orario senza dire quanto
ci si può fidare.

### D7 — La previsione si scrive su InfluxDB

Measurement `irrigation_forecast`, un punto ogni 5 minuti. Non serve all'app, che
legge dal context: serve per poter rispondere fra un mese a «quanto sbagliava?».

È lo stesso ragionamento già messo per iscritto in
`analisi_integrazione_meteo.md §2.1`: la previsione che il sistema *aveva* in un dato
momento non è ricostruibile a posteriori se non la si salva. Costo ~5 field ogni
5 min, dell'ordine di 200 KB/anno.

### D8 — L'API risponde da context, non calcola

L'endpoint HTTP legge `global.irrigation_forecast` e risponde. Non interroga
InfluxDB, non chiama Open-Meteo. Risposta in millisecondi dal telefono, e nessun
fallimento se InfluxDB sta rispondendo lento.

---

## 4. Il modello di proiezione

### Equazione

Passo `Δt` = 15 minuti, orizzonte 72 h:

```
m(t+Δt) = m(t) − k · ET0(t) · Δt + r · pioggia(t)
```

| Simbolo | Significato | Unità | Provenienza |
|---|---|---|---|
| `m(t)` | umidità media proiettata | % | stato iniziale: stessa media che calcola `decision logic` |
| `k` | coefficiente di asciugatura | %/mm | fitting sullo storico, in config |
| `ET0(t)` | evapotraspirazione di riferimento | mm/h | curva oraria Open-Meteo |
| `r` | guadagno da pioggia | %/mm | config, valore debole (vedi sotto) |
| `pioggia(t)` | precipitazione nell'ora | mm | curva oraria Open-Meteo |

### Stima di `k`

Procedura, da eseguire una volta e documentare in `analysis/03_stima_asciugatura.md`:

1. Estrarre la serie di umidità media a passo 15 min su tutto lo storico disponibile.
2. Scartare le finestre contaminate: da 30 min prima di ogni apertura valvola a
   **3 h dopo** la chiusura (il picco arriva a ~90 min, il ritorno alla discesa
   regolare più tardi), e le ore con precipitazione osservata > 0.
3. Per ogni intervallo pulito residuo, calcolare il calo osservato e l'ET0
   cumulata Open-Meteo della stessa finestra (endpoint `/archive`).
4. Regredire calo contro ET0 cumulata → `k`, più i percentili 10 e 90 dei residui.

Il risultato va in `irrigation_config.json` sezione `forecast`, quindi correggibile
a runtime senza redeploy come tutti gli altri parametri.

La nota di analisi non è codice di produzione: si esegue una volta, produce `k`, e
resta come traccia di come ci si è arrivati. Stessa natura delle note già presenti
in `analysis/`.

### Il parametro `r` è il punto debole, ed è dichiarato tale

Tararlo correttamente richiede la pipeline di ricostruzione che è il cuore dello
step 16. Per questo step si adotta un default con derivazione documentata e nulla
di più:

> 900 s di apertura ≈ 210 L su 40 m² ≈ 5.25 mm. Nell'evento del 14/08 le sonde
> raggiungibili hanno guadagnato mediamente ~7 punti → ordine di grandezza
> **~1.3 %/mm**. Default adottato: **1.2 %/mm**.

Questa derivazione poggia su **un solo evento** e su un'applicazione notoriamente
irregolare, mentre la pioggia è uniforme: va considerata un ancoraggio di ordine di
grandezza, non una misura. Il suo peso pratico è comunque limitato, perché quando
piove in modo significativo scatta la regola 6 (`rain_delay`), che domina la
decisione a prescindere dal guadagno di umidità simulato.

Ricalibrazione prevista nello step 16.

### Stato iniziale

`m(0)` è la **stessa media** che calcola `decision logic`: media dei valori in
`soil_moisture_cache` più recenti di `sensors.max_age_seconds`. Non una media
"ripulita", non una mediana, non una media pesata per aiuola. Se la previsione
usasse un ingresso diverso da quello del decisore, prevederebbe il comportamento di
un sistema che non esiste.

---

## 5. Il modulo di regole condiviso

### Interfaccia

```js
// registrata da `libreria regole` in global.orto_rules
valutaRegole(stato) → { azione, motivo, regola }
```

Ordine di avvio: `libreria regole` è alimentato da un `inject` con
`once: true`, quindi la registrazione avviene all'avvio del flow, ben prima del
primo tick del decision loop. Entrambi i consumatori devono comunque
**verificare la presenza** di `global.orto_rules` e, se assente, non decidere
nulla e loggare un warn — mai ricadere su una copia locale delle regole, che
reintrodurrebbe la divergenza che questo design elimina.

`stato` è un oggetto puro, senza accesso a context o a I/O:

```js
{
  now: <epoch ms>,
  moisture_mean: <number|null>,
  sensor_count: <int>,
  last_irrigation_at: <epoch ms|0>,
  weather: { available: <bool>, rain_24h: <number> },
  valve_reachable: <bool>,
  mode: 'auto'|'dry_run'|'paused'|'manual',
  pause_until: <ISO|null>,
  cfg: <irrigation_config>
}
```

`azione` ∈ `{'apri', 'attendi'}`; `regola` è la regola che ha determinato l'esito
(`paused`, `no_quorum`, `moisture_sufficient`, `out_of_window`, `cooldown`,
`rain_delay`, `valve_unreachable`, `open`); `motivo` è la stringa leggibile.

La purezza è il requisito: nessuna lettura di `global`, nessuna scrittura, nessun
`Date.now()` interno. Tutto entra da `stato`. È ciò che rende la funzione
simulabile su istanti futuri e testabile senza Node-RED.

### Chi la usa

| Chiamante | `now` | `moisture_mean` | `weather` |
|---|---|---|---|
| `decision logic` | orologio reale | cache sonde | cache meteo, aggregato attuale |
| Simulatore | istante simulato | valore proiettato | somma 24 h dalla curva oraria, a partire dall'istante simulato |

### Assunzioni sul futuro simulato

Tre regole non hanno un valore futuro conoscibile e richiedono un'assunzione, che
va dichiarata qui e non nascosta nel codice:

| Regola | Assunzione | Effetto se sbagliata |
|---|---|---|
| Quorum sonde | le sonde restano online | se una cade, la previsione slitta |
| Valvola raggiungibile | resta raggiungibile | se è irraggiungibile **adesso** la carta lo segnala e la confidenza scende |
| `pause_until` | rispettato, simulazione ripresa alla scadenza | nessuno: è un dato certo |

La regola 4 (finestra oraria) va simulata **includendo lo scavalcamento in
emergenza**: se l'umidità proiettata scende sotto `soglia_emergenza_pct`, la finestra
non si applica. E va gestita la finestra serale che attraversa la mezzanotte —
comportamento già corretto una volta nel decision loop (commit `696ace5`), che i
test di fotografia devono catturare.

---

## 6. Architettura del flow

Nuovo tab Node-RED **`Previsione irrigazione (step 15)`**. Nessun container nuovo,
nessun servizio nuovo.

```
[tick 1h] → build flux → influxdb in → calcola statistiche asciugatura
                                        └→ global.drying_stats
                                           (pendenze osservate, dispersione,
                                            k empirico di fallback)

[tick 5m] → proietta + simula → global.irrigation_forecast
            legge: soil_moisture_cache, weather_cache (curva oraria),
                   drying_stats, irrigation_config, last_irrigation_at
                            └→ influxdb out: garden/irrigation_forecast

[GET /api/irrigation/forecast] → risponde da global.irrigation_forecast
```

Le statistiche di asciugatura si ricalcolano **ogni ora, non ogni 5 minuti**:
cambiano lentamente e richiedono una query su 7 giorni di serie: rifarla 288 volte
al giorno è spreco senza contropartita. La proiezione è invece aritmetica su dati
già in memoria e gira ogni 5 minuti, allineata al decision loop.

### Modifica al flow meteo esistente

Nel tab *Weather (Open-Meteo)*, il nodo `scheduler` costruisce l'URL con tre
modifiche:

| Parametro | Da | A | Perché |
|---|---|---|---|
| `hourly` | `precipitation,temperature_2m,relative_humidity_2m` | `…,et0_fao_evapotranspiration` | serve l'ET0 per il modello |
| `forecast_days` | `2` | `4` | al passo simulato a +72 h serve la somma pioggia fino a +96 h |
| `timeformat` | *(assente)* | `unixtime` | allinea gli indici a istanti assoluti senza ambiguità di fuso fra host e container |

Il nodo `parse + cache + influx point` viene corretto (indicizzazione a partire
dall'ora corrente, non dalla posizione 0) e conserva in `global.weather_cache` le
curve orarie `precipitation` ed `et0` con il vettore `time`, oltre agli aggregati
già presenti. **Il punto scritto su InfluxDB non cambia**: solo aggregati, come da
D5.

### Measurement `irrigation_forecast`

| Tipo | Nome | Note |
|---|---|---|
| Tag | `method` | `et0` / `empirical` |
| Field | `seconds_until_next` | secondi all'apertura prevista; assente se nessuna |
| Field | `band_low_seconds` | estremo ottimistico |
| Field | `band_high_seconds` | estremo pessimistico |
| Field | `moisture_mean` | umidità media al momento del calcolo |
| Field | `drying_rate_pct_h` | velocità di asciugatura corrente stimata |
| Field | `confidence_level` | 1–4 |

Nessun tag ad alta cardinalità, coerentemente con
`analisi_integrazione_meteo.md §2.4`.

---

## 7. Contratto API

`GET /api/irrigation/forecast`

```json
{
  "generated_at": "2026-08-16T18:00:00Z",
  "mode": "auto",
  "next_irrigation": {
    "predicted_at":  "2026-08-17T06:15:00Z",
    "band_start":    "2026-08-17T05:00:00Z",
    "band_end":      "2026-08-17T20:00:00Z",
    "band_end_open": false,
    "expected_duration_seconds": 900,
    "trigger": "auto",
    "limiting_rule": "out_of_window"
  },
  "current": {
    "moisture_mean": 47.3,
    "sensor_count": 4,
    "drying_rate_pct_h": 0.52
  },
  "model": {
    "method": "et0",
    "k_pct_per_mm": 1.8,
    "weather_available": true
  },
  "confidence": {
    "level": 3,
    "reasons": ["sonde in disaccordo (stddev 26%)"]
  },
  "no_irrigation_reason": null
}
```

`limiting_rule` è la regola che ha determinato **quel** momento e non uno
precedente. Se l'umidità scende sotto soglia alle 03:00 ma l'apertura avviene alle
06:00, il vincolo è `out_of_window`, non `moisture_sufficient`. È l'informazione che
rende la previsione ispezionabile invece che oracolare.

Quando non si prevede alcuna irrigazione entro l'orizzonte:

```json
{
  "next_irrigation": null,
  "no_irrigation_reason": "rain_forecast"
}
```

`band_end_open` vale `true` quando il bordo superiore della fascia **non è un
istante calcolato ma il bordo dell'orizzonte**: lo scenario ottimistico non
attraversa la soglia entro le 72 h. Non è un dato mancante, è l'incertezza più
larga possibile, e il frontend deve renderlo come «oltre 3 giorni» invece di
spacciare la data limite per una previsione.

> **Correzione rispetto alla prima stesura.** Il piano faceva scartare gli
> scenari che non attraversavano (`.filter(v => v !== null)`), col risultato che
> `band_end` collassava sulla stima centrale. Misurato sugli scenari del piano
> stesso: con umidità sopra il 50% l'ottimistico non può attraversare in 72 h,
> quindi il **caso normale** produceva una fascia monca che dichiarava un bordo
> mai calcolato.

Valori ammessi per `no_irrigation_reason`: `moisture_sufficient`, `rain_forecast`,
`paused`, `no_quorum`, `cooldown`, `out_of_window`.

> Gli ultimi due sono stati aggiunti in corso d'opera: la mappatura originale li
> faceva ricadere su `moisture_sufficient`, riportando un motivo falso. Sono
> raggiungibili quando il cooldown o le finestre orarie coprono l'intero
> orizzonte — configurazioni che §9 consente esplicitamente di impostare a
> runtime.

Entro 72 h possono bloccare regole diverse in momenti diversi. Si riporta **la più
informativa, non l'ultima incontrata**, secondo la priorità fissa
`paused` > `no_quorum` > `rain_delay` > `moisture_sufficient` > `cooldown` >
`out_of_window`. Se piove per tre giorni e nel frattempo il terreno resta bagnato,
entrambe le condizioni sono vere: dire «piove» spiega di più che dire «è bagnato».

`expected_duration_seconds` vale `safety_timeout_seconds` per `trigger: "auto"` e
`emergency_duration_seconds` per `trigger: "emergency"`.

---

## 8. Degradazione e confidenza

| Cosa si rompe | Comportamento | Confidenza |
|---|---|---|
| Cache meteo scaduta o assente | Si passa alla media mobile (`method: "empirical"`); **la pioggia non entra nella simulazione**, coerente con il decision loop che senza meteo procede senza rain delay | −1 |
| `k` non ancora stimato | Default da config, dichiarato in `model` | −1 |
| Sonde in forte disaccordo (stddev oltre `stddev_warning_pct`) | Fascia già allargata dal meccanismo di §4/D3, nessun trattamento aggiuntivo | −1 |
| Statistiche di asciugatura non aggiornabili (query Influx fallita) | Si tengono le ultime valide, con la loro età | −1 |
| Valvola non raggiungibile **adesso** | La previsione si calcola comunque (nel futuro simulato la valvola è assunta raggiungibile, vedi §5) ma la carta lo dichiara | −1 |
| Quorum sotto `min_quorum` **adesso** | `next_irrigation: null`, motivo `no_quorum` | — |
| `mode` = `paused` o `manual` | La carta mostra lo stato invece di una previsione che non si avvererebbe | — |
| `mode` = `dry_run` | Previsione calcolata normalmente ed etichettata come simulazione — è il modo per verificarla senza bagnare | — |

`confidence.level` parte da 4 e scende di un gradino per ogni condizione degradata,
con minimo 1. `confidence.reasons` elenca sempre cosa l'ha determinata: nessun
punteggio senza spiegazione.

---

## 9. Configurazione

Nuova sezione in `rpi5/nodered/data/irrigation_config.json`, modificabile a runtime
via `POST /api/config/forecast.<campo>` come tutte le altre:

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
}
```

I tre `k_*` sono `null` finché il fitting non li produce; con `null` il modello usa
`fallback_drying_rate_pct_h` e dichiara `method: "empirical"` con confidenza ridotta.

---

## 10. Interfaccia

Nuovo componente `NextIrrigationCard.tsx` più `api/forecast.ts`, collocato sul tab
**Waterflow** come prima card sopra `ValveCard`. Non su Orto: Waterflow è dove si va
quando si sta decidendo se aprire a mano, ed è lì che la previsione risponde a una
domanda che ci si sta già ponendo.

```
┌────────────────────────────────────┐
│  PROSSIMA IRRIGAZIONE              │
│                                    │
│  Domani mattina                    │
│  ~06:15   (fra 11 h - 19 h)        │
│                                    │
│  ●●●○  stima attendibile           │
│  Umidità 47%, cala ~0.5 %/h        │
│  Apertura prevista ~15 min         │
│  Attende la finestra delle 06:00   │
└────────────────────────────────────┘
```

Rispetto al mock approvato, due righe in più richieste dai casi d'uso: la **durata
prevista** (uso concorrente dell'acqua) e la **regola limitante** resa in linguaggio
naturale a partire da `limiting_rule`.

Stato senza irrigazione prevista:

```
┌────────────────────────────────────┐
│  PROSSIMA IRRIGAZIONE              │
│                                    │
│  Non prevista entro 3 giorni       │
│                                    │
│  Pioggia prevista 12 mm (gio)      │
└────────────────────────────────────┘
```

Fetch con React Query come il resto dell'app, `staleTime` 5 min allineato al
ricalcolo. Offline la PWA serve l'ultima risposta in cache **con l'età dichiarata**:
mai una previsione muta che potrebbe essere di ieri.

---

## 11. Test e validazione

### Test unitari — banco di prova su `flows.json`

Si adotta il pattern già in uso dallo step 13 (`rpi5/nodered/test/put_layout.test.mjs`,
`rpi5/nodered/test/registro_sensori.test.mjs`): il test **legge il corpo della
funzione da `flows.json`**, lo compila con `new AsyncFunction` e lo esegue contro un
banco con `global`, `node`, `env`, `fs` simulati. Si esegue con
`node rpi5/nodered/test/<nome>.test.mjs` ed esce con codice 1 se qualcosa fallisce.

Il vantaggio rispetto a un modulo separato è che non esiste una copia del codice da
tenere allineata: ciò che passa il test è letteralmente ciò che gira sul Raspberry.

**`libreria regole`** — test di fotografia del comportamento attuale, più i casi limite:

- emergenza sotto `soglia_emergenza_pct` che scavalca la finestra oraria
- finestra serale che attraversa la mezzanotte (regressione del commit `696ace5`)
- cooldown esattamente al confine
- quorum esattamente a `min_quorum`
- meteo non disponibile → nessun rain delay

**Modulo di proiezione:**

- asciugatura lineare con ET0 costante
- notte con ET0 a zero → curva piatta, nessun attraversamento
- soglia attraversata fuori finestra → apertura posticipata, `limiting_rule` corretta
- pioggia sopra soglia dentro l'orizzonte → `no_irrigation_reason: rain_forecast`
- nessun evento entro 72 h → `next_irrigation: null`
- `k` a `null` → fallback empirico, confidenza ridotta

### Non-regressione del decision loop

Stessi ingressi, stesse decisioni prima e dopo l'estrazione del modulo. È la
condizione di completamento del refactor, non un controllo accessorio.

### Validazione empirica — e il suo limite

**Non è possibile fare backtest sulla previsione dell'evento.** Tutto lo storico è
manuale: il sistema non ha mai deciso da solo, quindi non esiste una verità storica
con cui confrontarsi. Un backtest sugli eventi passati validerebbe le abitudini
dell'utente, non il modello.

È invece possibile, e su tutti i mesi disponibili, validare **la proiezione
dell'umidità**, che è il punto in cui il modello può davvero sbagliare: si prende un
istante passato, si proietta a 6/12/24 h con `k`, si confronta con l'umidità
realmente misurata.

**Criterio di accettazione: errore mediano sotto 3 punti percentuali a 12 h.** Con
una dinamica di ~0.5 %/h, 3 punti valgono circa 6 ore di scarto sull'orario
previsto — dentro l'ordine di grandezza richiesto. Tabella degli errori in
`analysis/03_stima_asciugatura.md`.

Se il fitting non raggiunge il criterio, va saputo **prima** di pubblicare la carta.

### Verifica in campo

Healthcheck verde, poi una settimana di confronto fra i punti `irrigation_forecast`
scritti ogni 5 min e gli `irrigation_events` reali. Con `auto` attivo la verità si
accumula da sola.

---

## 12. File toccati

| File | Modifica |
|---|---|
| `rpi5/nodered/test/regole_irrigazione.test.mjs` | **nuovo** — fotografia + casi limite della catena di regole |
| `rpi5/nodered/test/previsione.test.mjs` | **nuovo** — proiezione e simulazione |
| `rpi5/nodered/data/flows.json` | nuovo nodo `libreria regole`; nuovo tab previsione; `decision logic` passa a `global.orto_rules`; flow meteo corretto (indicizzazione oraria) ed esteso (curve orarie, `forecast_days=4`) |
| `rpi5/nodered/data/irrigation_config.json` | sezione `forecast` |
| `rpi5/frontend/src/api/forecast.ts` | **nuovo** |
| `rpi5/frontend/src/components/NextIrrigationCard.tsx` | **nuovo** |
| `rpi5/frontend/src/pages/Waterflow.tsx` | inserimento della card |
| `rpi5/frontend/src/api/types.ts` | tipi della risposta forecast |
| `rpi5/frontend/src/helpers/formatDuration.ts` | `fmtFraQuanto` — `fmtRelative` guarda al passato e non serve qui |
| `rpi5/frontend/src/helpers/formatDuration.test.ts` | **nuovo** |
| `analysis/stima_k.mjs` | **nuovo** — script una-tantum del fitting e del backtest |
| `analysis/03_stima_asciugatura.md` | **nuovo** — fitting di `k` e tabella degli errori |
| `docs/step15_previsione_prossima_irrigazione.md` | questo file |
| `CLAUDE.md` | vedi §15 |

**Promemoria operativo:** ogni modifica a `flows.json` richiede la **ri-iniezione
delle credenziali Node-RED** (`docs/comandi_verifica.md §5.5`).

---

## 13. Fuori scope

- **Modello di bagnatura** (quanto sale l'umidità irrigando): step 16.
- **Previsione del secondo e terzo evento** entro l'orizzonte: dipende dal modello
  di bagnatura.
- **Ricalibrazione online di `k`**: valutabile quando ci sarà storico sufficiente.
- **Correzione di `delta_moisture` e `total_liters`**: sono campi della bagnatura,
  step 16. I dati grezzi sono integri, non si sta perdendo nulla nel frattempo.
- **Previsione per singola aiuola**: la valvola è una sola e decide sulla media;
  una previsione per aiuola descriverebbe un impianto che non esiste.
- **Grafico della curva di proiezione a 72 h**: valutato e scartato in fase di
  design a favore della carta sintetica. Il dato per costruirlo esiste già nel
  simulatore, se in futuro lo si vorrà.

---

## 14. Verifica end-to-end

1. `k` stimato e scritto in config; tabella errori in
   `analysis/03_stima_asciugatura.md` entro il criterio di accettazione.
2. `node --test` verde su `orto-rules` e `orto-forecast`.
3. Decisioni del decision loop identiche a prima dell'estrazione (test di
   fotografia).
4. `ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh'` verde
   (fallback WiFi `192.168.1.46`).
5. `curl -k https://<host>/api/irrigation/forecast` risponde con contratto completo
   e `generated_at` più recente di 5 minuti.
6. Punti `irrigation_forecast` presenti su InfluxDB con cadenza 5 min.
7. Carta visibile su Waterflow, coerente con la risposta API, leggibile su mobile.
8. Test di degradazione: fermare temporaneamente la risoluzione DNS verso
   Open-Meteo → la carta continua a rispondere con `method: "empirical"` e
   confidenza ridotta, il decision loop non si blocca.
9. Con `mode=paused` la carta mostra lo stato, non un orario.

---

## 15. Aggiornamenti a CLAUDE.md

- Tabella **Schema dati InfluxDB**: aggiungere il measurement `irrigation_forecast`.
- Tabella **Stato avanzamento**: aggiungere `15 | Previsione prossima irrigazione`.
- Sezione **File chiave**: aggiungere `rpi5/nodered/data/node_modules/orto-rules/`
  come sede autoritativa della catena di regole di irrigazione, con la nota che
  `decision logic` non deve tornare a implementarla in proprio.

---
## Implementazione
**Stato:** ✅ COMPLETATO — 2026-08-17
**Commit di riferimento:** `feat(frontend): card della prossima irrigazione su Waterflow` (`6462331`)
**Note:**
- `k_pct_per_mm` stimato da `analysis/stima_k.mjs` sullo storico reale: **1.296**
  (`p10=0.256`, `p90=4.593`). Errore mediano della proiezione a 12h: **1.95 pp**,
  sotto la soglia di accettazione di 3 pp (margine oltre 1 pp) — dettagli in
  `analysis/03_stima_asciugatura.md`.
- Deploy eseguito in `mode=dry_run`, verificato (suite test 111/111, healthcheck
  17/17, endpoint `/api/irrigation/forecast` con `method:"et0"` e punti
  `irrigation_forecast` scritti su InfluxDB ogni ~5 min), poi tornato in `auto`.
  Deploy via fallback WiFi (`192.168.1.46`): l'Ethernet non rispondeva al momento
  del deploy.
- Da oggi parte la settimana di confronto fra `irrigation_forecast` e gli
  `irrigation_events` reali indicata al Passo 8 del piano.
**Deviazioni dalla spec:**
- **Prova di degradazione (Task 9, Passo 7) non eseguita end-to-end dal vivo.**
  Il piano richiede di interrompere la raggiungibilità di Open-Meteo e attendere
  che `weather_cache` superi `cache_max_age_seconds` (5400 s, ~90 min). Il
  validatore di config impedisce di abbassare la soglia sotto
  `polling_interval_seconds` proprio per evitare questa scorciatoia, e bloccare
  la connettività meteo reale per un'ora e mezza nel giorno in cui parte la
  settimana di monitoring non è sembrato un compromesso ragionevole. Il fallback
  a `method:"empirical"` con confidenza ridotta resta verificato a livello
  unitario (3 casi dedicati in `previsione.test.mjs`); la verifica dal vivo è
  rimandata a un'osservazione opportunistica durante la settimana, o a un test
  dedicato in un momento che non comprometta la raccolta dati.
- Il modulo delle regole (D4) vive nel nodo `libreria regole` di `flows.json`,
  non in `rpi5/nodered/data/node_modules/orto-rules/` come indicato in questa
  sezione: è la correzione già registrata in §3/D4, qui confermata
  nell'implementazione effettiva.
