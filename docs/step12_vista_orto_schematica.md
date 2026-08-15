# Step 12 — Vista orto schematica

## Indice

1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Decisioni di design](#3-decisioni-di-design)
4. [Geometria dell'orto](#4-geometria-dellorto)
5. [Modello dati — contratto `/api/layout`](#5-modello-dati--contratto-apilayout)
6. [Catalogo colture e glifi](#6-catalogo-colture-e-glifi)
7. [Livelli di rendering](#7-livelli-di-rendering)
8. [Cosa è sempre visibile](#8-cosa-è-sempre-visibile)
9. [Responsive](#9-responsive)
10. [Backend Node-RED](#10-backend-node-red)
11. [Tagging reale di `aiuola` / `position`](#11-tagging-reale-di-aiuola--position)
12. [File toccati](#12-file-toccati)
13. [Fuori scope](#13-fuori-scope)
14. [Verifica end-to-end](#14-verifica-end-to-end)
15. [Aggiornamenti a CLAUDE.md](#15-aggiornamenti-a-claudemd)

---

## 1. Obiettivo

Sostituire l'ortofoto della vista Orto con uno **schema vettoriale** della disposizione
reale del terreno, in cui le informazioni principali — prima fra tutte l'umidità —
sono leggibili **senza passare in hover**.

### Perché serve

La `<Hero />` attuale è un'ortofoto con sei pin numerati. Ogni valore è dietro un
`onMouseEnter`, e quindi:

- su touch non è raggiungibile in modo affidabile;
- richiede un gesto per ogni sensore: sei gesti per farsi un'idea dello stato dell'orto;
- la foto non ha spazio tipografico dove scrivere — circa il 40% dei pixel non è orto
  (palma, muro, motozappa), e i rettangoli `aiuola 01/02/03` sono tratteggi che non
  coincidono con le file reali.

L'hover non è stato scelto: è stato imposto dalla foto. Rimuovendo la foto si rimuove
il vincolo.

---

## 2. Stato di partenza

### Frontend

| Elemento | Dove | Stato |
|---|---|---|
| `<Hero />` | `src/components/Hero.tsx` | ortofoto + pin + `<SensorTooltip>` su hover |
| Coordinate pin | `src/config/sensors.ts` → `SENSOR_COORDS` | hardcoded, normalizzate 0-1 sulla foto |
| Guide aiuole | `src/config/sensors.ts` → `AIUOLE` | tre rettangoli tratteggiati, non allineati alle file vere |
| Mapping aiuola | `src/config/sensors.ts` → `SENSOR_LOCATIONS` | fallback client-side |
| Sensori attivi | `src/config/sensors.ts` → `ACTIVE_SENSORS` | `WH51_01`–`04` |
| Colore umidità | `src/helpers/humidityColor.ts` | riusato invariato |

### Tre criticità rilevate nell'analisi

**(a) I tag `aiuola` / `position` valgono la stringa `'test'`.**
Nel nodo Node-RED `parse WH51 -> points + cache`:

```js
{ sensor_id, aiuola: 'test', position: 'test' }
```

La migrazione ai valori reali che `CLAUDE.md` dà per «prevista prima di step 5» non è
mai stata eseguita, benché gli step 5–10 risultino completati. L'intera serie storica
`soil_moisture` porta tag privi di significato.

**(b) Bug attivo in produzione: la UI mostra «aiuola test · test».**
`format response` fa `aiuola: r.aiuola || null` e passa `'test'` al frontend; il
frontend fa `s.aiuola ?? loc?.aiuola`, e `??` interviene solo su `null`/`undefined`.
La stringa `'test'` attraversa entrambi i fallback e arriva a schermo in
`SensorTooltip` e `SensorList`.

**(c) La logica di irrigazione non legge quei tag.**
`decision logic` calcola la media su `Object.values(global.soil_moisture_cache)`,
cioè su **tutti** i sensori indistintamente, con chiave `sensor_id`. Non raggruppa
mai per aiuola.

Conseguenza di (c): riposizionare i sensori è **privo di rischio** per l'irrigazione.
Conseguenza di (a) + (b): il tagging va implementato per la prima volta, e la sorgente
naturale del dato diventa il layout.

---

## 3. Decisioni di design

| # | Decisione | Motivazione |
|---|---|---|
| D1 | Lo schema **sostituisce** l'ortofoto | Serve spazio tipografico per i valori; la foto non ne ha |
| D2 | Le aree coltura **partizionano** la riga (contigue, somma 1.0) | Rende gli stati invalidi non rappresentabili: niente buchi né sovrapposizioni da validare |
| D3 | I vuoti si esprimono con la coltura `libero` | Visivamente identico alle "isole" di `crops.png`, senza indebolire D2 |
| D4 | Le zone di umidità sono **derivate** dai pin, non disegnate | Zero lavoro nell'editor; sposti un pin, la zona segue |
| D5 | Zone umidità e aree coltura sono **livelli indipendenti** | Lo sono anche nella realtà: un tratto di pomodori può stare a cavallo di due sonde |
| D6 | L'altezza di riga è un **parametro di rendering**, non geometria | Consente il responsive senza deformare le proporzioni reali |
| D7 | L'impianto di irrigazione **non** viene disegnato | Lo stato valvola resta in `<ValveCard />` e nella scheda Waterflow |
| D8 | I glifi coltura sono **illustrazioni a colori**, il glifo sonda è **vettoriale monocromo** | Sono due cose diverse: le colture sono arte fornita dall'utente, la sonda è un'icona di UI che deve tingersi col colore dell'umidità |
| D9 | Il perimetro del lotto **non** viene disegnato | Richiesta esplicita dopo la revisione del primo render; le lunghezze diverse delle file raccontano già la forma senza tracciarla |
| D10 | L'etichetta di fila sta **sopra** la riga, non in una colonna a destra | Una colonna riservata sarebbe spazio vuoto per due file su tre, e impedirebbe a fila 3 di occupare tutta la larghezza |

### Nota su D2

La partizione non è un'ipotesi di comodo: è ciò che `example.png` già mostra. I
divisori misurati in fila 2 sono 3 aree, e in `crops.png` la stessa fila 2 contiene
terra nuda con la sonda 03, poi 2 zucchine, poi 4 melanzane — tre aree contigue di cui
**la prima vuota**. Il tipo `libero` formalizza qualcosa che era già disegnato.

---

## 4. Geometria dell'orto

Ricavata per misurazione in pixel di `example.png` (2428×1154), rilevando le
campiture grigie (aiuole), le linee blu (divisori) e il tracciato rosso (perimetro).

### 4.1 Perimetro

Pentagono, con diagonale perfettamente rettilinea che parte da `x=0.722` a `y=0` e
raggiunge `x=1.0` a `y=0.667` — cioè **esattamente dove inizia fila 3**.

> **Non viene disegnato** (D9). La misurazione resta qui perché è da lì che escono le
> lunghezze relative delle file, che sono la cosa che conta.

### 4.2 File

| Fila | y iniziale | altezza | lunghezza (frazione della più lunga) |
|---|---|---|---|
| 1 | 0.008 | 0.316 | **0.722** |
| 2 | 0.330 | 0.321 | **0.790** |
| 3 | 0.668 | 0.321 | **1.000** |

Le aiuole sono **rettangoli**: aree e sonde vivono tutte dentro i rettangoli.

Fila 3 occupa l'intera larghezza disponibile; fila 1 e fila 2 sono in proporzione a
essa. Il rapporto d'aspetto che ne risulta è 2.11:1, contro il 2.1:1 misurato su
`example.png`.

Nota sulla forma reale, non più disegnata ma utile a chi tornerà su questo file: fila 1
e fila 3 toccavano la diagonale del lotto all'altezza del proprio bordo superiore
(0.717 contro 0.725, e 0.993 contro 1.0), mentre **fila 2 no** — il suo bordo destro è
a 0.784 dove la diagonale passa a 0.860. Fila 2 è più corta di quanto il lotto le
consentirebbe.

### 4.3 File di configurazione

```ts
// src/config/orto.ts

/** length = frazione della lunghezza della fila più lunga (fila 3). */
export const FILE_GEOM = [
  { id: 1, length: 0.722 },
  { id: 2, length: 0.790 },
  { id: 3, length: 1.0 },
] as const;
```

Altezza di riga, distanza fra righe e spazio per l'etichetta **non stanno qui**: sono
metriche responsive, e vivono in `src/helpers/ortoMetrics.ts` (§9).

> ⚠️ Le proporzioni sono ricavate dal disegno, non da un rilievo sul campo. Se le
> misure reali in metri divergono, si aggiorna `FILE_GEOM` e nient'altro.

---

## 5. Modello dati — contratto `/api/layout`

Un solo documento persistito. Non «le colture» ma il **layout**: dopo lo step 13 anche
i pin sono posizionati dall'utente, e oggi vivono hardcoded in `SENSOR_COORDS`.

### 5.1 Struttura

```jsonc
{
  "version": 1,
  "updated_at": 1755264000,
  "file": [
    {
      "id": 1,
      "aree":    [ { "crop": "pomodoro", "to": 1.00, "n": 5 } ],
      "sensori": [ { "sensor_id": "WH51_01", "x": 0.124 },
                   { "sensor_id": "WH51_02", "x": 0.866 } ]
    },
    {
      "id": 2,
      "aree":    [ { "crop": "libero",    "to": 0.369, "n": 0 },
                   { "crop": "zucchina",  "to": 0.587, "n": 2 },
                   { "crop": "melanzana", "to": 1.000, "n": 4 } ],
      "sensori": [ { "sensor_id": "WH51_03", "x": 0.103 },
                   { "sensor_id": "WH51_04", "x": 0.835 } ]
    },
    {
      "id": 3,
      "aree":    [ { "crop": "zucchina",  "to": 0.290, "n": 3 },
                   { "crop": "lattuga",   "to": 0.463, "n": 2 },
                   { "crop": "melanzana", "to": 0.635, "n": 1 },
                   { "crop": "lattuga",   "to": 1.000, "n": 4 } ],
      "sensori": []
    }
  ]
}
```

### 5.2 Perché l'area ha solo `to`

Un'area espone il **bordo destro** e basta: il bordo sinistro è il `to` della
precedente (o `0.0` per la prima), e l'ultima area ha sempre `to: 1.0`.

Non è una scorciatoia di serializzazione, è la ragione per cui D2 conviene: **non
esiste un JSON con buchi o sovrapposizioni**, quindi non esiste il codice che li
gestisce, né i test che li coprono, né i bug che ci si annidano.

### 5.3 Invarianti

| Invariante | Vincolo |
|---|---|
| struttura | esattamente 3 file, con `id` 1, 2, 3 |
| numero aree per fila | `1 ≤ aree.length ≤ 5` |
| monotonia | `to` strettamente crescenti |
| chiusura | ultimo `to === 1.0` |
| larghezza minima | ogni area ≥ `0.05` |
| coltura | `crop` presente nel catalogo (§6) |
| piante | `0 ≤ n ≤ 20`; `n = 0` obbligatorio per `libero` |
| sensore | `sensor_id ∈ ACTIVE_SENSORS`, **unico su tutto il documento** |
| posizione | `0 ≤ x ≤ 1`; distanza minima fra due pin della stessa fila `0.03` |

In step 12 le invarianti sono verificate **in lettura** (documento malformato ⇒ si
ricade sul seed e si logga un warning). La validazione in scrittura arriva con
`PUT` allo step 13.

### 5.4 Seed

`rpi5/nodered/data/orto_layout.seed.json`, committato nel repo: le 8 aree misurate da
`example.png` più i 4 pin derivati dalle `SENSOR_COORDS` attuali. Serve al primo avvio
e come fallback se `/data/orto_layout.json` è assente o illeggibile.

I pin non si trasferiscono come sono: le `SENSOR_COORDS` sono normalizzate sull'**intera
ortofoto**, mentre `x` è normalizzata sulla **fila**. Conversione, usando l'estensione
orizzontale delle guide `AIUOLE` (`x = 0.295`, `w = 0.485`):

```
x_fila = (x_foto − 0.295) / 0.485
```

| Sensore | `x_foto` | `x_fila` | `position` derivata |
|---|---|---|---|
| WH51_01 | 0.355 | **0.124** | near |
| WH51_02 | 0.715 | **0.866** | far |
| WH51_03 | 0.345 | **0.103** | near |
| WH51_04 | 0.700 | **0.835** | far |

Le `position` derivate coincidono con `SENSOR_LOCATIONS`, il che conferma la
conversione.

---

## 6. Catalogo colture e glifi

### 6.1 Catalogo

```ts
// src/config/crops.ts
export interface Crop {
  key: string;
  label: string;
  color: string | null;   // null = nessuna tinta (libero)
}

export const CROPS: Record<string, Crop> = {
  libero:    { key: 'libero',    label: 'libero',    color: null },
  pomodoro:  { key: 'pomodoro',  label: 'pomodoro',  color: 'var(--terra)' },
  zucchina:  { key: 'zucchina',  label: 'zucchina',  color: 'var(--moss)' },
  melanzana: { key: 'melanzana', label: 'melanzana', color: 'var(--water)' },
  lattuga:   { key: 'lattuga',   label: 'lattuga',   color: 'var(--leaf)' },
};
```

Catalogo chiuso e in config, come richiesto: l'editor dello step 13 offre esattamente
queste voci in dropdown.

### 6.2 Glifi coltura — illustrazioni raster

I file consegnati in `svg/` avevano estensione `.svg` ma **non erano vettoriali**:
ognuno conteneva un PNG 612×408 in base64 dentro un `<pattern>`, ritagliato da una
`matrix()`. Tutti e quattro portavano **lo stesso foglio** (`md5 0953eb96`), uno sprite
con le quattro verdure affiancate: 165 KB a file per mostrare un'icona, con il
medesimo PNG ripetuto quattro volte.

I ritagli sono stati ricostruiti dalle `matrix()` — gli aspect ratio combaciano al
terzo decimale — ed estratti con `sharp`, già presente fra le devDependencies:

| Chiave | Ritaglio nel foglio | Peso |
|---|---|---|
| `pomodoro` | (34, 114) 125×175 | 30,6 kB |
| `lattuga` | (180, 151) 121×131 | 26,4 kB |
| `zucchina` | (320, 124) 124×165 | 27,9 kB |
| `melanzana` | (459, 116) 130×170 | 24,7 kB |

Vivono in `src/assets/crops/<chiave>.png`, dove **il nome del file è la chiave** in
`CROPS`. Vite li serve come asset statici: restano fuori dal bundle JS e il service
worker li precachea.

Essendo raster a colori **non si tingono**. Una chiave senza file non è un errore:
l'area mostra etichetta e conteggio senza glifo.

> Se un giorno servisse tingerli, o scalarli senza sfocatura, vanno riesportati da
> Figma come vettori veri — l'export attuale ha appiattito tutto in raster.

### 6.3 Glifo sonda — vettoriale monocromo

`src/assets/sensor.svg`, disegnato a mano. È l'unico glifo che deve **cambiare colore**:
prende la tinta dell'umidità della propria zona, quindi resta vettoriale con
`fill="currentColor"` e viene inlineato via `?raw`. Nessun `id` e nessun `<style>`, per
poterlo inlineare più volte nello stesso documento senza collisioni.

Ha un alone chiaro (`paint-order: stroke`) così resta leggibile anche sopra una banda
scura. **È un segnaposto**, da sostituire quando ci sarà il disegno definitivo.

---

## 7. Livelli di rendering

Un unico `<svg>`, cinque livelli dal fondo alla cima.

```
4  sonde + etichette    ⌸ 01 · 38%
3  aree coltura         divisori, timbro coltura (un glifo per area)
2  zone umidità         tinte derivate dai pin
1  terreno              fondo per riga
```

Il perimetro, che nella prima stesura era il livello 4, non esiste più (D9).

### 7.1 Livello 2 — zone umidità (il cuore dello step)

Dati i pin di una fila ordinati per `x` (`x₁ … xₙ`):

- confini: `b₀ = 0`, `bᵢ = (xᵢ + xᵢ₊₁) / 2`, `bₙ = 1`
- la zona `i` copre `[bᵢ₋₁, bᵢ]` e prende il colore del sensore `i` via
  `humidityColor(value, thresholds)`
- opacità `0.55`, così il livello 3 resta leggibile sopra

Casi limite:

| Caso | Resa |
|---|---|
| `n = 0` (fila 3 oggi) | nessuna tinta, campitura tratteggiata "nessun dato" |
| `n = 1` | zona unica su `[0, 1]` |
| sensore `offline` o `value === null` | zona tratteggiata; il pin mostra l'ultimo valore in stile attenuato |

### 7.2 Livello 3 — aree coltura

- divisori verticali sottili in `--rule`
- **un solo glifo per area**, non uno per pianta
- timbro compatto centrato nell'area: `[glifo] pomodoro ×5`

```
├──────── area ────────┤
│                      │
│    🍅 pomodoro ×5    │      un glifo, non cinque
│                      │
```

Il glifo unico non è solo più semplice da disegnare: è **più leggibile**. Con cinque
glifi ripetuti bisogna contarli per sapere quante piante ci sono; con `×5` il numero
si legge. E un glifo solo può essere reso più grande, quindi riconoscibile a colpo
d'occhio anche in un'area stretta.

`n` **resta nel modello dati** (§5.1): non viene più reso per ripetizione, ma è ancora
il dato che l'editor modifica con *Piante − / +* (step 13 §4.2).

Degradazione per larghezza dell'area in pixel resi:

| Larghezza | Resa |
|---|---|
| ≥ 150 | glifo + etichetta + conteggio |
| 80–150 | glifo + conteggio |
| 34–80 | solo glifo |
| < 34 | nulla: resta il solo divisore |

(soglie in unità viewBox; il glifo è alto 44 unità su desktop, 76 su mobile)

Le aree `libero` non hanno glifo né etichetta a nessuna larghezza: si disegnano come
terreno nudo (§6.1).

### 7.3 Livello 4 — sonde

Il glifo sonda, **tinto col colore dell'umidità della propria zona**, più l'etichetta
`01 · 38%` accanto. Marchi di stato inline: `⚠` batteria scarica, opacità ridotta per
sensore non installato.

Niente pastiglia arrotondata: l'alone di `paint-order: stroke` rende il testo leggibile
su qualunque tinta senza rettangolo di fondo e — cosa che conta di più — **senza dover
misurare il testo** per dimensionarlo.

**Bande verticali.** La riga è divisa in due fasce orizzontali: le pastiglie sensore
occupano la fascia **superiore**, i timbri coltura quella **inferiore**. Così i due
livelli non possono collidere fra loro, e ciascuno deve risolvere solo le collisioni
al proprio interno.

**Anticollisione fra pastiglie:** se due pastiglie della stessa fila si sovrappongono
orizzontalmente, la seconda viene sfalsata verticalmente **dentro la propria fascia**.
Sulle metriche desktop la fascia superiore è alta abbastanza da contenere due livelli
sfalsati.

I timbri coltura non hanno bisogno di anticollisione: essendo uno per area e le aree
disgiunte per costruzione (D2), non possono sovrapporsi — la degradazione per larghezza
è sufficiente.

---

## 8. Cosa è sempre visibile

Requisito centrale dello step: quanto segue si legge **senza alcuna interazione**.

| Informazione | Dove |
|---|---|
| valore % di ogni sensore | pastiglia sul pin |
| identificativo sensore (`01`…`06`) | pastiglia sul pin |
| stato idrico dell'area | tinta della zona |
| batteria scarica / offline | marchio sulla pastiglia |
| coltura di ogni area | timbro: glifo + etichetta |
| numero piante dell'area | conteggio `×5` nel timbro |
| media per fila | etichetta sopra la riga |
| nome fila | etichetta sopra la riga |

Restano dietro hover/click, come **dettaglio** e non come informazione primaria:
tensione e stato batteria, `rssi`, ultima lettura relativa, `sensor_id` esteso.
Il tooltip dell'area serve solo quando la degradazione per larghezza (§7.2) ha
soppresso etichetta o conteggio.

---

## 9. Responsive

Un solo componente. Le proporzioni orizzontali **non cambiano mai**: cambiano soltanto
le metriche verticali e le dimensioni tipografiche. Le costanti e le formule stanno in
`src/helpers/ortoMetrics.ts`.

| | desktop (≥ 900 px) | mobile |
|---|---|---|
| larghezza utile `vw` | 1150 | 1000 |
| altezza riga | 132 | 260 |
| spazio etichetta | 30 | 46 |
| glifo coltura / sonda | 44 / 26 | 76 / 40 |
| corpo valore / timbro | 22 / 13 | 34 / 20 |

Fila 3 occupa `vw` per intero; fila 1 e 2 ne prendono 0.722 e 0.790. Il `viewBox` si
allarga di `pad` per lato, così nessuna riga tocca il bordo della card.

Su mobile la riga è molto più alta **in rapporto alla larghezza**: scalando a schermo
stretto, metriche identiche a quelle desktop schiaccerebbero le etichette.

`editable` (usato solo dallo step 13) richiede `≥ 900 px` **e**
`matchMedia('(pointer: fine)')`.

### 9.1 Etichetta di fila

Sopra ogni riga, a filo del bordo sinistro: `fila 2 · media 61%`. Uguale a ogni
breakpoint.

> Le due stesure precedenti sono state entrambe scartate. Il triangolo libero creato
> dalla diagonale non funzionava perché fila 3 è a piena larghezza e quel triangolo lì
> non esiste. Una colonna riservata a destra, provata nel primo render, funzionava ma
> costava 150 unità di larghezza **sempre**, per un'informazione che riguarda due file
> su tre: fila 3 non poteva più occupare tutta la riga. Sopra la riga costa solo
> altezza, ce n'è in abbondanza, ed elimina il ramo `gutter: 'right' | 'above'` che
> nella prima versione raddoppiava il codice di posizionamento.

---

## 10. Backend Node-RED

### 10.1 `GET /api/layout`

```
200 OK
Content-Type: application/json
Access-Control-Allow-Origin: *
```

Corpo: il documento di §5.1.

Comportamento:

1. legge `/data/orto_layout.json` dal volume Node-RED;
2. se assente o non parsabile ⇒ restituisce il seed e logga `node.warn`;
3. se presente ma viola le invarianti di §5.3 ⇒ restituisce il seed e logga `node.warn`.

Stesso pattern già collaudato di `irrigation_config.json`, che vive nello stesso volume.

`PUT /api/layout` è **fuori scope**: step 13.

### 10.2 Footgun

> ⚠️ Toccare `flows.json` svuota le credenziali Node-RED. Vanno ri-iniettate via API
> REST dopo ogni redeploy — `docs/comandi_verifica.md §5.5`.

---

## 11. Tagging reale di `aiuola` / `position`

Risolve le criticità (a) e (b) di §2.

### 11.1 Sorgente del dato

Il layout diventa la sorgente di verità della collocazione. Node-RED tiene in
`global.orto_layout` il documento caricato all'avvio e a ogni scrittura, e ne deriva
una mappa `sensor_id → { aiuola, position }`:

```js
// aiuola  = id della fila che contiene il pin
// position = 'near' se x < 0.5, 'far' altrimenti
```

`position` resta un tag a due valori (cardinalità bassa, adatta a un tag). La `x`
puntuale **non** diventa un tag né un field su `soil_moisture`: vive nel layout, e
i suoi cambiamenti nella history dello step 13.

### 11.2 Modifica a `parse WH51 -> points + cache`

```diff
- { sensor_id, aiuola: 'test', position: 'test' }
+ { sensor_id, ...placementOf(sensor_id) }
```

`placementOf` ricade su `SENSOR_LOCATIONS` se il sensore non è piazzato nel layout,
così l'ingest non si ferma mai per un layout incompleto.

### 11.3 Vincolo InfluxDB — i tag sono immutabili

Non è possibile correggere `aiuola=test` sui punti già scritti. Assunzione adottata:

- da qui in avanti i nuovi punti nascono con l'aiuola reale;
- lo storico resta con `aiuola=test`;
- non si perde nulla di reale, perché quei tag non hanno mai contenuto informazione.

Effetto collaterale accettato: per ~120 giorni (retention del bucket `garden`) una
query che raggruppi per `aiuola` vedrà sia `test` sia `1|2|3`. Nessuna dashboard
Grafana attuale raggruppa per aiuola; da riverificare in fase di implementazione.

### 11.4 Correzione del bug `'test'` a schermo

Anche con l'ingest corretto, i 120 giorni di storico continuano a restituire `'test'`
sull'ultimo valore finché non arriva una lettura nuova. Serve quindi anche:

- `format response`: normalizzare `'test'` → `null`;
- frontend: sostituire `s.aiuola ?? loc?.aiuola` con un helper `placement(s)` che tratti
  `'test'` e la stringa vuota come assenti.

---

## 12. File toccati

### Nuovi

| File | Contenuto |
|---|---|
| `src/config/orto.ts` | `FILE_GEOM`, `CROPS`, caricamento glifi |
| `src/assets/crops/*.png` | quattro glifi coltura, ritagliati dallo sprite fornito (§6.2) |
| `src/assets/sensor.svg` | glifo sonda vettoriale, segnaposto (§6.3) |
| `src/api/layout.ts` | hook React Query `useLayout()` |
| `src/helpers/moistureBands.ts` | calcolo delle zone dai pin (+ test) |
| `src/helpers/ortoMetrics.ts` | metriche responsive e formule di banda (+ test) |
| `src/helpers/useMediaQuery.ts` | breakpoint, stesso schema di `useOnlineStatus` |
| `src/components/OrtoMap.tsx` | i 5 livelli, in un file solo |
| `rpi5/nodered/data/orto_layout.seed.json` | seed |

### Modificati

| File | Modifica |
|---|---|
| `src/pages/Orto.tsx` | `<Hero>` → `<OrtoMap>`, aggiunta `useLayout()` |
| `src/api/types.ts` | tipi `Layout`, `LayoutRow`, `LayoutArea`, `LayoutSensor` |
| `src/styles/global.css` | stili `.orto-*`; rimossi `.hero`, `.photo`, `.pin`, `.blob`, `.aiuola-guide` |
| `src/styles/tokens.css` | token `--aubergine` (chiaro e scuro) |
| `tsconfig.json` | esclude `*.test.ts`: girano con `node --test`, non nel bundle |
| `package.json` | script `test` |
| `rpi5/nodered/data/flows.json` | `GET /api/layout`; tagging in `parse WH51`; `'test'` → `null` in `format response` |

### Rimossi

| File | Nota |
|---|---|
| `src/components/Hero.tsx` | sostituito da `OrtoMap.tsx` |

`src/config/sensors.ts` resta invariato: `ACTIVE_SENSORS` e `SENSOR_LOCATIONS` servono
ancora, `SENSOR_COORDS` e `AIUOLE` sono ora solo la provenienza storica del seed.

`public/ortophoto.jpg` **resta nel repo** ma non è più referenziata dalla vista Orto.
Se ricollocarla (es. in Settings) o rimuoverla è una decisione separata, fuori da
questo step.

---

## 13. Fuori scope

### Rimandato allo step 13

Editor: `PUT /api/layout`, validazione in scrittura, menu contestuale, trascinamento
di divisori e pin, Salva/Annulla, bucket `events` e measurement `sensor_moves`.

### YAGNI — non si fa, e non si predispone

- rendering e trascinamento delle singole piante: `n` è un **conteggio**, non un
  insieme di entità posizionate, e non lo diventa;
- undo multilivello;
- storicizzazione del layout come serie temporale («cosa c'era piantato a maggio»);
- date di semina e raccolto;
- zone di umidità disegnate a mano (sono derivate — D4);
- interpolazione continua del colore fra due pin: le zone sono a gradino, perché una
  sfumatura suggerirebbe una misura che non esiste fra una sonda e l'altra;
- rendering dell'impianto di irrigazione (D7).

---

## 14. Verifica end-to-end

### 14.1 Backend

```bash
# layout servito, con le tre file
curl -sk https://orto.local/api/layout | jq '.file | length'
# atteso: 3

# invarianti rispettate sul seed
curl -sk https://orto.local/api/layout | jq '[.file[].aree[-1].to] | unique'
# atteso: [1]

# nessun sensore duplicato
curl -sk https://orto.local/api/layout \
  | jq '[.file[].sensori[].sensor_id] | (length) == (unique | length)'
# atteso: true
```

### 14.2 Tagging

```bash
# dopo almeno una lettura GW3000 successiva al deploy
ssh as@192.168.1.12 'cd /opt/orto-digitale && set -a && . ./.env && set +a && \
  docker exec influxdb influx query --org orto-digitale \
    --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" "
      from(bucket:\"garden\") |> range(start:-15m)
        |> filter(fn:(r) => r._measurement == \"soil_moisture\")
        |> distinct(column:\"aiuola\")"'
# atteso: valori 1|2|3, non 'test'
```

### 14.3 Frontend

- [ ] i sei valori di umidità sono leggibili **senza alcun gesto**, a mouse fermo fuori dalla mappa
- [ ] fila 3 (nessun sensore) è resa tratteggiata, non colorata
- [ ] le zone cambiano confine coerentemente con la posizione dei pin nel seed
- [ ] ogni area mostra **un solo** glifo, indipendentemente da `n`, col conteggio `×n` accanto
- [ ] le aree `libero` non mostrano né glifo né etichetta
- [ ] restringendo un'area il timbro degrada nell'ordine di §7.2 senza mai debordare
- [ ] etichette sonda e timbri coltura non si sovrappongono mai (bande separate)
- [ ] nessuna occorrenza della stringa `test` a schermo (tooltip, `SensorList`)
- [ ] a 390 px le etichette non si accavallano e i glifi restano riconoscibili
- [ ] a 1440 px le proporzioni 0.722 / 0.790 / 1.000 sono rispettate
- [ ] tema chiaro e scuro: tinte umidità e glifi leggibili in entrambi
- [ ] fila 3 arriva al bordo: nessuna colonna vuota a destra
- [ ] nessun tracciato di perimetro né diagonale
- [ ] il glifo sonda cambia colore con l'umidità della sua zona
- [ ] offline (service worker step 7): l'ultimo layout in cache è servito senza errori

---

## 15. Aggiornamenti a CLAUDE.md

Da applicare **nello stesso commit** dell'implementazione:

1. **Schema dati** — nessun nuovo measurement in questo step, ma va corretta la nota
   «al termine di step 2 i tag sono ancora `aiuola=test, position=test`, migrazione
   prevista prima di step 5»: la migrazione avviene qui, allo step 12, e la nota va
   riscritta indicando che la sorgente dei tag è il layout.
2. **Mapping sensori → aiuole** — precisare che la tabella è ora un **fallback**, e che
   la collocazione autoritativa è `/api/layout`.
3. **Stato avanzamento** — riga `| 12 | Vista orto schematica | ✅ |`.
4. **File chiave** — aggiungere `rpi5/nodered/data/orto_layout.seed.json`.

---

## Implementazione

**Stato:** 🟡 CODICE COMPLETO E RIVISTO A SCHERMO — deploy sul RPi da fare
**Commit di riferimento:** _(non ancora committato)_

### Verificato

- `npm run build` verde (931 moduli, nessun errore TypeScript)
- `npm test` verde: 14 check con `node --test` (type-stripping nativo di Node 24, zero dipendenze aggiunte)
- `flows.json` riletto dopo la patch: JSON valido, 123 nodi, nessun id duplicato, nessun wire rotto
- la funzione `valid()` dell'endpoint, estratta ed eseguita davvero, accetta il seed e rifiuta i quattro casi malformati (documento vuoto, area < 5%, ultimo `to` ≠ 1.0, sensore duplicato)

### Revisione visiva

Fatta dall'utente su un mock locale (`dist/` servito con backend finto), non da me:
l'estensione Chrome non è mai stata collegata in questa sessione. Il primo render è
stato approvato quanto a leggibilità dei valori, con quattro richieste di modifica —
fila 3 a piena larghezza, inserimento dei glifi, glifo sonda, rimozione del perimetro —
tutte applicate e riviste una seconda volta.

### NON verificato

- Tema scuro: mai guardato, né da me né dall'utente.
- Tutto ciò che richiede il RPi: endpoint servito da Node-RED, tagging effettivo su
  InfluxDB, scomparsa della stringa `test` a schermo.

### Deviazioni dalla spec

Applicate seguendo il plugin `ponytail` (livello full), richiesto dall'utente.

| Deviazione | Motivo |
|---|---|
| 13 file nuovi → 8 | `OrtoMap/` era sette file per un solo SVG; le parti non sono riusate altrove |
| `geometry.ts` + `crops.ts` → un `config/orto.ts` | stesso dominio, poche costanti |
| `PLOT_OUTLINE` eliminato | derivabile da `FILE_GEOM` (§4.2), e derivato resta corretto al cambio di breakpoint |
| `helpers/placement.ts` eliminato | la normalizzazione di `'test'` è a monte, in `format response`: cura la causa e sistema anche `SensorList` senza toccarlo |
| `helpers/ortoMetrics.ts` **aggiunto** (non previsto) | vedi sotto |
| pastiglie pin → testo con `paint-order: stroke` | alone nativo SVG: niente rettangoli, niente misurazione del testo |
| `vite-plugin-svgr` scartato | `import.meta.glob` + `?raw` fa lo stesso senza dipendenze (§6.3) |
| `useOrtoMetrics()` con `ResizeObserver` → `useMediaQuery` | il breakpoint è sul viewport, non sul contenitore: basta `matchMedia` |
| glifi coltura da SVG inline a `<image>` PNG | i file forniti erano raster travestiti da vettori (§6.2); via il componente `Glyph` e il parsing del `viewBox` |
| grondaia laterale → etichetta sopra la riga | richiesta dopo il primo render; elimina il ramo `gutter: 'right' \| 'above'` |
| perimetro e diagonale rimossi | richiesta dopo il primo render (D9) |

### Bug trovato durante l'implementazione

Le proporzioni verticali della spec (pin a `0.30·rowH`, timbro a `0.74·rowH`, sfalsamento
`1.35·fsValue`, `rowH = 112`) **producevano una sovrapposizione**: due pin vicini
sfalsano la seconda etichetta verso il basso, e quella finiva dentro il timbro coltura
di ~10.6 unità. Non lo vede né il typecheck né la build.

Corretto a `rowH = 132`, pin `0.24`, timbro `0.80`, sfalsamento `1.15` — margine 18.4
unità. Le metriche e le formule di banda sono state estratte in
`src/helpers/ortoMetrics.ts` proprio perché un test potesse raggiungerle: è l'unica
ragione per cui quel file esiste. Il test è stato verificato contro i valori vecchi e
fallisce, quindi non è decorativo.

### Da fare prima di marcare COMPLETATO

1. Guardare la mappa in **tema scuro** e a 390 px (finora solo tema chiaro su desktop).
2. Sostituire `src/assets/sensor.svg`, che è un segnaposto.
3. Deploy: `flows.json` + `orto_layout.seed.json` sul RPi, **ri-iniettare le credenziali Node-RED** (`docs/comandi_verifica.md §5.5`).
4. Eseguire la checklist di §14.
5. Applicare gli aggiornamenti a `CLAUDE.md` di §15.
