# Step 18 — Id fisico delle sonde

## Indice

1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Decisioni di design](#3-decisioni-di-design)
4. [Scoperta dal gateway](#4-scoperta-dal-gateway)
5. [Contratto API](#5-contratto-api)
6. [Interfaccia](#6-interfaccia)
7. [Correzione delle posizioni reali](#7-correzione-delle-posizioni-reali)
8. [File toccati](#8-file-toccati)
9. [Fuori scope](#9-fuori-scope)
10. [Verifica end-to-end](#10-verifica-end-to-end)
11. [Aggiornamenti a CLAUDE.md](#11-aggiornamenti-a-claudemd)

---

## 1. Obiettivo

Rendere riconoscibile una sonda **stando davanti all'orto**.

Il sistema sapeva su quale canale sta ciascuna sonda e dove è piazzata sulla
mappa, ma non quale oggetto fisico sia: `WH51_03` è un nome nostro, non c'è
scritto da nessuna parte sul guscio. Chi va a controllare una sonda in campo
non ha modo di sapere quale pin della mappa ha in mano — e viceversa, chi
sposta una sonda non sa quale pin muovere.

Il GW3000 invece l'id ce l'ha: è quello che compare nella sua pagina *Sensors
ID*, ed è lo stesso stampato sulla sonda.

---

## 2. Stato di partenza

| Elemento | Da step 14 |
|---|---|
| Registro | `orto_sensors.json`: `sensor_id`, `channel`, `label`, `registered_at` |
| Derivati in lettura | `placement` (dal layout), `gateway` (da `global.gw_seen`) |
| Scoperta | solo dal payload MQTT: i canali presenti, non la loro identità |
| Tooltip mappa | aiuola, posizione, `sensor_id`, batteria, rssi, ultima lettura |

Il payload MQTT del GW3000 (`soilmoisture1=50&soilbatt1=1.5&…`) **non contiene
gli id**: porta i canali e i valori. L'identità sta solo nell'API HTTP locale
del gateway.

---

## 3. Decisioni di design

| # | Decisione | Motivazione |
|---|---|---|
| D1 | `hw_id` è **derivato**, non memorizzato nel registro | Stessa ragione di `placement` e `gateway` (step 14, D2): due copie divergono, e quando divergono vince quella sbagliata. La verità sta nel gateway, che sa cosa è realmente accoppiato |
| D2 | Vive in `global.gw_hw_ids`, non su file | Se il GW3000 tace, l'id **sparisce dalla vista** invece di restare lì a mentire. È il comportamento che ha già `gateway: null` |
| D3 | Si scandiscono le prime 4 pagine di `/get_sensors_info` | Il contenuto delle pagine non è un contratto: oggi i `wh51` stanno nella 3, ma è ordine di firmware. Vedi §4 |
| D4 | L'id si normalizza a minuscolo con gli zeri iniziali | Il gateway restituisce `FC98F`, sulla sonda e nell'app Ecowitt si legge `0fc98f`. Deve combaciare con quello che l'utente ha davanti |
| D5 | Polling ogni 15 minuti | Un id cambia solo ri-accoppiando una sonda. Il payload MQTT resta la fonte dei **valori**, ogni 60 s: qui si scopre solo l'anagrafica |
| D6 | Host del gateway da `GW3000_HOST`, con default nel compose | Un indirizzo in più in `flows.json` sarebbe invisibile. Il default `:-192.168.1.5` evita di dover toccare `.env` sul RPi |

---

## 4. Scoperta dal gateway

`GET http://<GW3000>/get_sensors_info?page=N` restituisce un array di slot:

```jsonc
[{ "img": "wh51", "type": "14", "name": "Soil moisture CH1",
   "id": "FC98F", "batt": "5", "rssi": "-97", "signal": "4", "idst": "1" }, …]
```

Il canale sta **nel nome**, non in un campo suo. `FFFFFFFF` (mai accoppiato) e
`FFFFFFFE` (disattivato) non sono id.

### 4.1 Perché scandire tutte le pagine

Sedici slot per pagina, e la pagina in cui cadono i `wh51` dipende da quanti
tipi di sensore il firmware elenca prima. Cablare `page=3` significa rompersi al
primo aggiornamento del gateway.

Lo scan è **idempotente per pagina**: una pagina che non contiene `wh51` non
tocca la mappa, una che li contiene la riscrive tutta. Non serve né sapere in
anticipo dove guardare né accumulare risultati fra pagine.

```js
// global.gw_hw_ids: { [channel]: { hw_id, ts } }
```

Uno slot che si svuota **rimuove** il canale: una sonda sganciata non deve
restare a video.

---

## 5. Contratto API

`GET /api/sensors/registry` guadagna un campo derivato per riga, e uno per ogni
rilevato:

```jsonc
{
  "sensori": [
    { "sensor_id": "WH51_01", "channel": 1, "label": "", "registered_at": 0,
      "hw_id": "0fc98f",
      "placement": { "fila": 1, "x": 0.124 },
      "gateway":   { "seen_seconds_ago": 45, "moisture": 47, "battery_v": 1.5 } }
  ],
  "rilevati": [ { "channel": 5, "hw_id": "0fd1a3", "seen_seconds_ago": 30, … } ]
}
```

`hw_id: null` ⇒ il gateway non ha (ancora) detto nulla su quel canale. Il `PUT`
lo ignora come ignora `placement` e `gateway`.

**L'id segue il canale, non il `sensor_id`.** Ri-agganciando `WH51_01` sul
canale 3, il suo `hw_id` diventa quello della sonda che sta sul 3 — che è
esattamente il comportamento voluto: `sensor_id` è l'identità dello *storico*,
`hw_id` è l'identità dell'*oggetto*.

---

## 6. Interfaccia

| Dove | Cosa |
|---|---|
| Tooltip della mappa | riga `id sonda` in cima all'elenco |
| Tabella in Impostazioni | colonna `id sonda`, fra canale ed etichetta |
| Finestra «nuovo sensore» | colonna `id sonda` accanto al canale |

L'ultima è quella che serve di più: accoppiando due sonde insieme, il canale da
solo non dice quale si ha in mano.

Il tooltip **conserva** anche `WH51_03` in alto a destra: sono due identità
diverse e servono entrambe — una per parlare con lo storico, l'altra per
parlare con l'orto.

---

## 7. Correzione delle posizioni reali

Contestualmente allo step, il layout è stato allineato alla realtà del campo.
La mappa `canale → id` letta dal gateway è ciò che ha reso possibile
verificarlo:

| Canale | `hw_id` | `sensor_id` | Prima | Dopo |
|---|---|---|---|---|
| 1 | `0fc98f` | `WH51_01` | fila 1, x 0.124 | invariato |
| 2 | `0fd067` | `WH51_02` | fila 1, x 0.866 | invariato |
| 3 | `0fd04e` | `WH51_03` | **fila 2**, x 0.103 | **fila 3**, x 0.103 |
| 4 | `0fcdf2` | `WH51_04` | fila 2, **x 0.835** | fila 2, **x 0.5** |

Applicato via `PUT /api/layout`, quindi registrato in `sensor_moves`
(`reassign` per `WH51_03` con `changed_aiuola=true`, `move` per `WH51_04`).

> ⚠️ Le sonde erano in queste posizioni **da circa un mese**, mentre il layout
> diceva altro. I punti `soil_moisture` di `WH51_03` scritti in quel periodo
> portano `aiuola=2` invece di `aiuola=3`: i tag dei punti già scritti in
> InfluxDB sono immutabili e **quello storico non è correggibile**. Solo le
> letture successive al 2026-08-17 hanno il tag giusto.
>
> L'irrigazione non ne è stata influenzata: `decision logic` calcola la media
> su tutti i sensori senza raggruppare per aiuola (step 12, §2c).
>
> Il marker in `sensor_moves` porta la data del salvataggio, non quella dello
> spostamento fisico: sovrapposto allo storico dell'umidità cade il 17 agosto.

### 7.1 `position` al centro

Il tag `position` è binario (`x < 0.5 ? 'near' : 'far'`). `WH51_04` a `x = 0.5`
finisce quindi in `far`, che è una convenzione al limite, non una descrizione:
«al centro» non ha un valore proprio nello schema. Introdurne uno vorrebbe dire
cambiare uno schema InfluxDB per un caso solo — rimandato finché non serve
davvero.

---

## 8. File toccati

### Nuovi

| File | Contenuto |
|---|---|
| `rpi5/nodered/test/id_fisici.test.mjs` | 16 controlli sui due nodi nuovi |

### Modificati

| File | Modifica |
|---|---|
| `rpi5/nodered/data/flows.json` | catena `tick 15m → richiesta id gateway → GET GW3000 sensors info → id fisici dal gateway`; `hw_id` derivato nel `GET /api/sensors/registry` |
| `rpi5/docker-compose.yml` | `GW3000_HOST` con default `192.168.1.5` |
| `rpi5/.env.example` | stessa variabile, documentata come facoltativa |
| `rpi5/scripts/verify_rpi5.sh` | sezione [18] |
| `rpi5/nodered/test/registro_sensori.test.mjs` | 6 controlli su `hw_id` |
| `src/api/registry.ts` | `hw_id` su `RegistrySensor` e `DetectedChannel` |
| `src/components/OrtoMap.tsx` | prop `hwIds`, riga `id sonda` nel tooltip |
| `src/components/OrtoEditor.tsx` | mappa `sensor_id → hw_id` dal registro |
| `src/components/SensorRegistryTable.tsx` | colonna `id sonda` |
| `src/components/NewSensorModal.tsx` | colonna `id sonda` |
| `src/helpers/registryOps.ts` | `hw_id: null` sui sensori appena registrati |

---

## 9. Fuori scope

- storicizzare l'associazione `hw_id → canale`: il registro dice cosa c'è
  adesso, e una sostituzione hardware non cambia lo storico (step 14, §8.1);
- id dei sensori non-soil del gateway (pioggia, vento): il sistema non li usa;
- ricerca di una sonda per `hw_id` nel frontend: con quattro sonde è cercare
  con gli occhi;
- allarme quando un canale cambia id (sostituzione fisica non dichiarata):
  candidato naturale per le notifiche dello step 17, non qui.

---

## 10. Verifica end-to-end

```bash
# il gateway espone davvero gli id
ssh as@192.168.1.12 'curl -s "http://192.168.1.5/get_sensors_info?page=3"' | grep -i wh51
# atteso: "Soil moisture CH1" ... "id": "FC98F"

# l'API li serve normalizzati
curl -sk https://orto.local/api/sensors/registry | jq '.sensori[] | {sensor_id, channel, hw_id}'
# atteso: 0fc98f / 0fd067 / 0fd04e / 0fcdf2 sui canali 1-4

# il PUT non li scrive nel registro
curl -sk https://orto.local/api/sensors/registry | jq '.sensori[0].hw_id'   # "0fc98f"
ssh as@192.168.1.12 'grep -c hw_id /opt/orto-digitale/nodered/data/orto_sensors.json'
# atteso: 0 (oppure file assente: il registro gira dal seed)
```

- [ ] in hover su una sonda compare `id sonda 0fc98f`
- [ ] la tabella in Impostazioni mostra l'id di tutte e quattro
- [ ] con il GW3000 spento l'id diventa `—` e nient'altro si rompe
- [ ] `verify_rpi5.sh` sezione [18] verde

---

## 11. Aggiornamenti a CLAUDE.md

1. **Mapping sensori → aiuole** — tabella riscritta con `hw_id` e con la
   collocazione reale al 2026-08-17.
2. **Schema dati** — nessuna modifica: `hw_id` non è un tag né un field, non
   entra in InfluxDB.
3. **Stack Docker / env** — `GW3000_HOST` fra le variabili del container
   `nodered`.
4. **Stato avanzamento** — riga `| 18 | Id fisico delle sonde dal GW3000 | ✅ |`.

---

## Implementazione

**Stato:** ✅ COMPLETATO — 2026-08-17
**Commit di riferimento:** `feat(nodered): scopri dal GW3000 l'id fisico di ogni sonda` (8229f96)

### Verificato

Backend, con `id_fisici.test.mjs` (16 controlli) e `registro_sensori.test.mjs`
(6 nuovi, 29 in totale), che eseguono i corpi dei nodi **letti da
`flows.json`**: normalizzazione, slot vuoti, ri-aggancio, pagine senza sonde,
risposte non JSON, `hw_id` derivato e ignorato dal `PUT`.

Frontend: `tsc -b` pulito, 67 controlli verdi.

Sul RPi dopo il deploy: `GET /api/sensors/registry` serve i quattro id reali;
i punti `soil_moisture` continuano ad arrivare con i tag corretti — la verifica
che conta di più, avendo toccato il tab dell'ingest; `verify_rpi5.sh` **TUTTO
OK** con la sezione [18] nuova.

Correzione delle posizioni (§7) applicata via API e confermata in
`sensor_moves`; il tag `aiuola=3` di `WH51_03` è comparso alla prima lettura
successiva.

### Deviazioni dalla spec

| Deviazione | Motivo |
|---|---|
| Scan di 4 pagine invece di `page=3` fissa | Durante l'analisi il gateway ha risposto con i `wh51` prima sulla 3 e poi, a interrogazione ripetuta, sempre sulla 3 — ma l'ordine dipende da quanti tipi il firmware elenca prima. Lo scan costa 4 richieste LAN ogni 15 minuti |
| `ret: 'txt'` sul nodo http, non `'obj'` | Il GW3000 non dichiara `application/json`. Il parse sta nella funzione, che sa anche cosa fare quando fallisce |

### NON verificato

L'interfaccia non è ancora stata usata a mano: tooltip, colonna in Impostazioni
e finestra «nuovo sensore» hanno il typecheck e i dati dell'API sotto test, ma
nessuno li ha ancora guardati col mouse.
