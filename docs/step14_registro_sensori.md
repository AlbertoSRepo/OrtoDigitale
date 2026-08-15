# Step 14 — Registro dei sensori

## Indice

1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Decisioni di design](#3-decisioni-di-design)
4. [Modello dati](#4-modello-dati)
5. [Contratto API](#5-contratto-api)
6. [Scoperta dal gateway](#6-scoperta-dal-gateway)
7. [Ingest filtrato dal registro](#7-ingest-filtrato-dal-registro)
8. [Le operazioni](#8-le-operazioni)
9. [Interfaccia](#9-interfaccia)
10. [File toccati](#10-file-toccati)
11. [Fuori scope](#11-fuori-scope)
12. [Verifica end-to-end](#12-verifica-end-to-end)
13. [Aggiornamenti a CLAUDE.md](#13-aggiornamenti-a-claudemd)

---

## 1. Obiettivo

Sostituire l'elenco di sensori scritto a mano con un **registro** dei sensori
effettivamente in servizio, alimentato da ciò che il gateway rileva davvero.

### Perché serve

Oggi si possono piazzare esattamente quattro sonde, e non perché siano quattro: è
scritto in due costanti, `ACTIVE_SENSORS` nel frontend e `const CHANNELS = [1,2,3,4]`
nel parser Node-RED. Accoppiare una quinta sonda al GW3000 non produce alcun effetto:
nessuno la vede, nessuno la scrive.

---

## 2. Stato di partenza

### Cosa pubblica il gateway

Un solo messaggio su `ecowitt/gw3000`, form-urlencoded, ogni 60 s:

```
runtime=894773&soilmoisture1=50&soilad1=244&soilmoisture2=44&soilad2=225
&soilmoisture3=41&soilad3=212&soilmoisture4=46&soilad4=229
&soilbatt1=1.5&soilbatt2=1.6&soilbatt3=1.6&soilbatt4=1.5
&freq=868M&model=GW3000A&interval=60
```

**La scoperta non richiede infrastruttura nuova**: i sensori rilevati *sono* le chiavi
`soilmoistureN` presenti nel payload. Accoppiandone una quinta compare `soilmoisture5`.

### Il rischio nascosto nell'irrigazione

`decision logic` calcola la media così:

```js
const cache = global.get('soil_moisture_cache') || {};
const valid = Object.values(cache).filter(e => (now - e.ts) < max_age_ms).map(e => e.value);
```

**Tutti** i sensori in cache, filtrati solo per età: nessun riferimento al layout o
all'aiuola. Oggi il sistema è protetto per caso, perché `CHANNELS` è una costante.
Aprendo alla registrazione senza precauzioni, una sonda accoppiata e lasciata sul
tavolo — che legge percentuali basse — trascinerebbe giù la media e farebbe partire
l'irrigazione. È il caso d'uso normale: «ne registro una nuova prima di andare a
piantarla».

Da qui D3.

---

## 3. Decisioni di design

| # | Decisione | Motivazione |
|---|---|---|
| D1 | Il registro vive in `/data/orto_sensors.json` | Stesso schema di `orto_layout.json` e `irrigation_config.json`: stato mutabile su file, che InfluxDB non sa aggiornare né cancellare |
| D2 | Il registro **non** memorizza la posizione | La sa già il layout. Due copie della stessa cosa divergono, e quando divergono vince quella sbagliata. «Libera» è **derivata**: registrata e assente da tutte le file |
| D3 | Il registro **filtra l'ingest** | Registrare diventa l'atto con cui dichiari che una sonda è in campo. Un canale non registrato non produce punti e non entra nella cache dell'irrigazione (§2) |
| D4 | Fail-open se il registro è illeggibile | Si scrivono tutti i canali presenti, con `node.warn`. Perdere telemetria è peggio che scriverne troppa |
| D5 | `sensor_id` è congelato alla registrazione, `channel` resta modificabile | Ri-accoppiando la stessa sonda su un altro canale si aggiorna `channel` e **lo storico non si spezza**, perché i tag InfluxDB sono su `sensor_id` |
| D6 | Un `GET` e un `PUT` sull'intero documento | Stesso schema del layout. Quattro endpoint CRUD sarebbero quattro contratti da tenere allineati invece di uno |
| D7 | Deregistrare una sonda piazzata è **bloccato** | Il contrario lascerebbe il layout a puntare a un sensore inesistente: errore facile da fare, noioso da scoprire |
| D8 | `ACTIVE_SENSORS` sparisce | Il layout può contenere solo sensori registrati, garantito dalla validazione: la distinzione "installato / non installato" non ha più casi |

---

## 4. Modello dati

Tre archivi, un mestiere ciascuno, nessuna sovrapposizione:

| | Cosa sa | Chi lo scrive |
|---|---|---|
| **registro** (`orto_sensors.json`) | quali sonde esistono: id, canale, etichetta, da quando | registrazione / deregistrazione |
| **layout** (`orto_layout.json`) | dove sta ciascuna, adesso | editor mappa (step 13) |
| **`sensor_moves`** (bucket `events`) | dove stava prima | diff del `PUT /api/layout` (step 13) |

```jsonc
// /data/orto_sensors.json
{
  "version": 1,
  "updated_at": 1755264000,
  "sensori": [
    { "sensor_id": "WH51_01", "channel": 1, "label": "testa fila 1", "registered_at": 1749721260 },
    { "sensor_id": "WH51_02", "channel": 2, "label": "",             "registered_at": 1749721260 }
  ]
}
```

### 4.1 Invarianti

| Invariante | Codice |
|---|---|
| `sensor_id` conforme a `WH51_\d\d` | `bad_sensor_id` |
| `sensor_id` univoco | `duplicate_sensor_id` |
| `channel` intero fra 1 e 8 | `bad_channel` |
| `channel` univoco | `duplicate_channel` |
| `label` stringa, ≤ 60 caratteri | `bad_label` |
| un sensore rimosso dal registro **non** è nel layout | `sensor_in_use` |

Il limite 8 è la capienza di canali soil del GW3000.

### 4.2 Seed

`rpi5/nodered/data/orto_sensors.seed.json`: `WH51_01`–`04` sui canali 1–4, cioè
esattamente lo stato attuale. Al primo deploy non cambia nulla.

---

## 5. Contratto API

### 5.1 `GET /api/sensors/registry`

Restituisce il registro **più i campi derivati**, che il `PUT` ignora: sono una
vista, non una seconda copia (D2).

```jsonc
{
  "version": 1,
  "updated_at": 1755264000,
  "sensori": [
    {
      "sensor_id": "WH51_01", "channel": 1, "label": "testa fila 1", "registered_at": 1749721260,
      "placement": { "fila": 1, "x": 0.124 },
      "gateway":   { "seen_seconds_ago": 42, "moisture": 50, "battery_v": 1.5 }
    }
  ],
  "rilevati": [
    { "channel": 5, "seen_seconds_ago": 30, "moisture": 12, "battery_v": 1.5 }
  ]
}
```

`placement: null` ⇒ la sonda è **libera**. `gateway: null` ⇒ non rilevata di recente.
`rilevati` elenca i canali visti al gateway e **non** registrati: è ciò che alimenta
la finestra «nuovo sensore».

Un solo giro di rete serve sia la tabella in Impostazioni sia la finestra.

### 5.2 `PUT /api/sensors/registry`

Corpo: `{ version, sensori: [ { sensor_id, channel, label, registered_at } ] }`.
Campi derivati ignorati. `updated_at` imposto dal server.

Validazione: §4.1, con `400` e lo stesso formato dello step 13 (`path`, `code`,
`message`). Scrittura atomica su temporaneo + rename, `.bak` col precedente,
aggiornamento di `global.orto_sensors`.

---

## 6. Scoperta dal gateway

`parse WH51` annota **ogni** canale presente nel payload, registrato o no:

```js
// global.gw_seen: { [channel]: { ts, moisture, battery_v } }
```

Da qui esce `rilevati` (canali visti negli ultimi 30 min e non registrati) e il campo
`gateway` di ogni sensore registrato. Nessun nodo nuovo, nessun topic nuovo: il dato
passava già di lì e veniva buttato.

---

## 7. Ingest filtrato dal registro

`const CHANNELS = [1,2,3,4]` sparisce. Al suo posto i canali del registro, con la
mappa `channel → sensor_id` (D5: non è più l'identità, è un aggancio).

**`parse WH51` carica il registro da sé**, non aspetta che qualcuno chiami la `GET`.
È la differenza con `orto_layout`, che poteva permetterselo: lì un layout mancante
degradava i tag, qui un registro mancante **fermerebbe la raccolta dati**. Al riavvio,
prima del primo caricamento di pagina, non si scriverebbe nulla.

Sequenza: `global.orto_sensors` se presente; altrimenti lettura del file e memoria in
`global`; se il file manca o è invalido, **fail-open** — si scrivono tutti i canali
presenti con un `node.warn` (D4). Il `PUT` aggiorna `global`, quindi una registrazione
ha effetto sulla lettura successiva senza riavvii.

---

## 8. Le operazioni

| # | Operazione | Registro | Layout | InfluxDB |
|---|---|---|---|---|
| 1 | Rilevata dal gateway | — | — | — (compare in `rilevati`) |
| 2 | **Registrazione** | +1 riga | — | da qui in poi i suoi punti vengono scritti |
| 3 | Piazzamento sulla mappa | — | +1 sonda | `place` |
| 4 | Spostamento nella stessa fila | — | `x` cambia | `move` |
| 5 | Cambio fila | — | fila cambia | `reassign`, tag nuovi da qui in poi |
| 6 | Rimozione dalla mappa | — | −1 sonda → libera | `remove` |
| 7 | **Deregistrazione** | −1 riga | deve essere già libera | i suoi punti smettono; lo storico resta |
| 8 | **Rinomina** | riga aggiornata | — | — |
| 9 | **Ri-aggancio su altro canale** | `channel` cambia | — | nulla si spezza (D5) |

Le operazioni 3–6 esistono già dallo step 13. Questo step aggiunge 2, 7, 8, 9.

### 8.1 Casi che il requisito non nomina

**Sonda registrata che smette di trasmettere.** `gateway: null`. Non viene cancellata
d'ufficio: si mostra come «non rilevata», perché la decisione è dell'utente — batteria
scarica, guasto o sganciamento sono diagnosi diverse.

**Sostituzione fisica sullo stesso canale.** Stesso `sensor_id`, storico continuo.
Di solito è ciò che si vuole, ma va detto perché non è ovvio: il sistema non distingue
l'hardware.

**Canale già registrato che ricompare dopo un'assenza.** Nessuna azione: torna ad
avere `gateway` valorizzato.

---

## 9. Interfaccia

### 9.1 Finestra «nuovo sensore»

Aperta dalla voce `＋ nuovo sensore…` in fondo alla tendina `+ sonda` di ogni fila
(step 13). Mostra **solo i rilevati non registrati**: canale, umidità attuale,
batteria, ultimo contatto, e *Registra*.

Registrando dalla finestra aperta su una fila, la sonda viene registrata **e** piazzata
in quella fila: è il gesto che l'utente stava già facendo.

### 9.2 Tabella in Impostazioni

I sensori registrati stanno in una sezione della pagina Impostazioni, non nella
finestra: è anagrafica, si consulta più spesso di quanto si modifichi, e la finestra
deve restare focalizzata sul gesto che l'ha aperta.

Colonne: `sensor_id`, canale, etichetta (modificabile), **dove sta** (`fila 2 · 10%`)
oppure **libera**, stato gateway, e *Deregistra* — disabilitato se piazzata (D7), con
il motivo nel `title`.

---

## 10. File toccati

### Nuovi

| File | Contenuto |
|---|---|
| `rpi5/nodered/data/orto_sensors.seed.json` | seed: WH51_01–04 sui canali 1–4 |
| `src/api/registry.ts` | tipi, `useRegistry()`, `putRegistry()` |
| `src/helpers/registryOps.ts` | operazioni pure + validazione |
| `src/helpers/registryOps.test.ts` | test |
| `src/components/NewSensorModal.tsx` | finestra dei rilevati |
| `src/components/SensorRegistryTable.tsx` | tabella per Impostazioni |

### Modificati

| File | Modifica |
|---|---|
| `rpi5/nodered/data/flows.json` | `GET`/`PUT` registro, scoperta in `parse WH51`, ingest dal registro |
| `src/components/OrtoOverlay.tsx` | voce `＋ nuovo sensore…` nella tendina `+ sonda` |
| `src/components/OrtoEditor.tsx` | apertura finestra, sonde libere dal registro |
| `src/components/OrtoMap.tsx` | via `ACTIVE_SENSORS` (D8) |
| `src/config/sensors.ts` | resta `SENSOR_LOCATIONS` come fallback dei tag |
| `src/pages/Settings.tsx` | sezione registro |
| `rpi5/scripts/verify_rpi5.sh` | check registro |

---

## 11. Fuori scope

- registrazione automatica di un canale appena rilevato: la scelta resta dell'utente;
- cancellazione dei dati storici di un sensore deregistrato: i tag InfluxDB sono
  immutabili e lo storico è comunque un dato valido;
- gestione dell'hardware (numero di serie, sostituzioni tracciate);
- soglie o configurazioni per singolo sensore;
- registro dei sensori non-soil del gateway (temperatura, pioggia): oggi il sistema
  non li usa.

---

## 12. Verifica end-to-end

```bash
# registro servito, con derivati
curl -sk https://orto.local/api/sensors/registry | jq '.sensori[] | {sensor_id, channel, placement}'
# atteso: 4 sensori, tutti con placement non nullo

# nessun canale non registrato al momento
curl -sk https://orto.local/api/sensors/registry | jq '.rilevati | length'
# atteso: 0

# deregistrare una sonda piazzata deve fallire
curl -sk -X PUT https://orto.local/api/sensors/registry \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"sensori":[]}' | jq '.errors[].code'
# atteso: "sensor_in_use" (quattro volte)
```

- [ ] Impostazioni mostra i quattro sensori con la fila e la posizione corrette
- [ ] `Deregistra` è disabilitato su tutti finché sono piazzati
- [ ] togliendo una sonda dalla mappa e salvando, in Impostazioni risulta **libera** e `Deregistra` si abilita
- [ ] deregistrandola, i suoi punti smettono di comparire in `soil_moisture`
- [ ] ri-registrandola, i punti riprendono senza riavviare Node-RED
- [ ] con `orto_sensors.json` rinominato, l'ingest continua a scrivere tutti i canali e logga il warning (D4)

---

## 13. Aggiornamenti a CLAUDE.md

1. **File chiave** — aggiungere `rpi5/nodered/data/orto_sensors.seed.json`.
2. **Mapping sensori → aiuole** — la tabella era già segnata come fallback allo step 12;
   precisare che l'elenco dei sensori **esistenti** è ora il registro, non una costante.
3. **Footgun** — annotare che `parse WH51` legge il registro da file e non dipende da
   una `GET`, e che senza registro va in fail-open.
4. **Stato avanzamento** — riga `| 14 | Registro dei sensori | ✅ |`.

---

## Implementazione

**Stato:** ⏳ DA IMPLEMENTARE
