# Step 13 — Editor del layout orto

## Indice

1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Attivazione dell'editor](#3-attivazione-delleditor)
4. [Grammatica delle interazioni](#4-grammatica-delle-interazioni)
5. [Stato bozza e salvataggio](#5-stato-bozza-e-salvataggio)
6. [`PUT /api/layout` — contratto](#6-put-apilayout--contratto)
7. [Bucket `events` e measurement `sensor_moves`](#7-bucket-events-e-measurement-sensor_moves)
8. [Motore di diff](#8-motore-di-diff)
9. [Segnalazione del cambio aiuola](#9-segnalazione-del-cambio-aiuola)
10. [File toccati](#10-file-toccati)
11. [Fuori scope](#11-fuori-scope)
12. [Verifica end-to-end](#12-verifica-end-to-end)
13. [Aggiornamenti a CLAUDE.md](#13-aggiornamenti-a-claudemd)

---

## 1. Obiettivo

Rendere il layout dell'orto — aree coltura e posizione dei misuratori — modificabile
dal frontend, senza deploy, e **tracciare permanentemente** ogni spostamento di
sensore.

Presuppone lo step 12 completato: geometria, contratto `/api/layout` in lettura,
`<OrtoMap />` e catalogo colture esistono già. Questo step aggiunge la scrittura.

---

## 2. Stato di partenza

| Elemento | Da step 12 |
|---|---|
| Contratto layout | `docs/step12_vista_orto_schematica.md` §5 — invariato |
| `GET /api/layout` | funzionante, con fallback sul seed |
| Invarianti §5.3 | verificate **in lettura**; qui diventano validazione in scrittura |
| `<OrtoMap />` | rendering a 5 livelli, sola lettura |
| `useOrtoMetrics().editable` | flag già calcolato, nessun consumatore |
| Bucket InfluxDB | solo `garden`, retention `120d` |

---

## 3. Attivazione dell'editor

L'editor è **desktop-only**, come da requisito. Il pulsante «Modifica» compare solo se:

```ts
editable = containerWidth >= 900 && matchMedia('(pointer: fine)').matches
```

Su telefono il pulsante non esiste — non è disabilitato, non c'è proprio. Nessuna
interazione di trascinamento va implementata per il touch, il che elimina in blocco
gesture handling, long-press, e conflitti con lo scroll della pagina.

---

## 4. Grammatica delle interazioni

Una regola sola, invece di un elenco di casi speciali:

> **trascinare = continuo · tasto destro = discreto**

| Gesto | Bersaglio | Effetto |
|---|---|---|
| trascina | divisorio | ridimensiona le **due** aree adiacenti |
| trascina | pin | sposta il sensore lungo la fila |
| destro | area | *Dividi qui* · *Coltura ▸* · *Unisci a sinistra* · *Unisci a destra* · *Piante − / +* |
| destro | fila (fuori da un pin) | *Aggiungi misuratore ▸* |
| destro | pin | *Cambia sensore ▸* · *Rimuovi misuratore* |

### 4.1 Divisori

Il modello a partizione (step 12, D2) fa sì che trascinare un divisorio muova un
confine condiviso: entrambe le aree adiacenti cambiano, la somma resta `1.0`.
È il comportamento dei divisori di finestra, che è l'analogia da cui il requisito
è nato.

Clamp durante il trascinamento:

```
minTo = to(i-1) + 0.05
maxTo = to(i+1) - 0.05
```

Il divisorio non può quindi mai superare i vicini né schiacciare un'area sotto il 5%.
Nessuno stato intermedio del trascinamento è invalido: non serve validare al rilascio.

### 4.2 Voci di menu — abilitazione

| Voce | Disabilitata quando |
|---|---|
| *Dividi qui* | la fila ha già 5 aree, **o** il punto di click cadrebbe a meno di 5% da un confine |
| *Unisci a sinistra* | l'area è la prima |
| *Unisci a destra* | l'area è l'ultima |
| *Piante −* | `n === 0` |
| *Piante +* | `n === 20` |
| *Aggiungi misuratore* | tutti i sensori attivi sono già piazzati |

*Unisci* elimina il confine e assegna all'area risultante la coltura di quella su cui
si è aperto il menu.

*Dividi qui* crea un confine nel punto di click; la nuova area a destra eredita la
coltura, con `n` ripartito proporzionalmente alla larghezza (arrotondato).

### 4.3 Menu contestuale

Componente custom, con `onContextMenu` + `preventDefault()` sul menu nativo del
browser, attivo **solo** in modalità editor. Chiusura su `Escape`, click fuori, o
scroll.

### 4.4 Pin

Clamp `x ∈ [0, 1]`, con distanza minima `0.03` da un altro pin della stessa fila.
Il dropdown *Aggiungi misuratore* elenca i sensori in `ACTIVE_SENSORS` non ancora
piazzati altrove. Sceglierne uno la cui aiuola di targa differisce dalla fila
produce l'avviso di §9, ma **non** viene impedito.

---

## 5. Stato bozza e salvataggio

Le modifiche vivono in una **bozza locale**. Nulla raggiunge il Raspberry finché non
si preme *Salva*: una trascinata sbagliata non deve diventare uno stato persistito.

```ts
// useLayoutDraft.ts
interface LayoutDraft {
  draft: Layout;
  dirty: boolean;
  errors: ValidationError[];      // validazione client, live
  ops: {
    splitArea(fila: number, at: number): void;
    mergeArea(fila: number, idx: number, dir: 'left' | 'right'): void;
    setCrop(fila: number, idx: number, crop: string): void;
    setPlantCount(fila: number, idx: number, n: number): void;
    moveDivider(fila: number, idx: number, to: number): void;
    addSensor(fila: number, sensorId: string, x: number): void;
    moveSensor(sensorId: string, fila: number, x: number): void;
    changeSensor(from: string, to: string): void;
    removeSensor(sensorId: string): void;
  };
  save(): Promise<void>;
  reset(): void;
}
```

- *Salva* → `PUT`, poi invalidazione della query React Query.
- *Annulla* → `reset()`, ripristina l'ultimo stato **salvato sul server**.
- Undo multilivello: **no**, YAGNI. *Annulla* è l'undo.
- Guardia `beforeunload` finché `dirty`.
- *Salva* disabilitato se `errors.length > 0`.

La validazione client rispecchia §5.3 dello step 12; quella server è comunque
autoritativa e ripetuta (§6.2).

---

## 6. `PUT /api/layout` — contratto

### 6.1 Richiesta

```
PUT /api/layout
Content-Type: application/json
```

Corpo: il documento di step 12 §5.1. `updated_at` è ignorato in ingresso — lo
imposta il server.

### 6.2 Validazione

Tutte le invarianti di step 12 §5.3, ripetute server-side. In caso di violazione:

```
400 Bad Request
```
```json
{
  "ok": false,
  "errors": [
    { "path": "file[1].aree[2].to", "code": "not_increasing",
      "message": "to deve essere strettamente crescente" },
    { "path": "file[0].sensori[1].sensor_id", "code": "duplicate_sensor",
      "message": "WH51_02 è già piazzato in fila 2" }
  ]
}
```

Codici: `bad_file_set`, `too_many_areas`, `not_increasing`, `not_closed`,
`area_too_narrow`, `unknown_crop`, `bad_plant_count`, `unknown_sensor`,
`duplicate_sensor`, `sensor_too_close`, `x_out_of_range`.

### 6.3 Sequenza di scrittura

1. valida il corpo → `400` se fallisce;
2. legge il layout corrente da `/data/orto_layout.json`;
3. calcola il diff degli spostamenti sensore (§8);
4. scrive `/data/orto_layout.json.bak` con il contenuto **precedente**;
5. scrive il nuovo documento in modo atomico (file temporaneo + rename);
6. aggiorna `global.orto_layout` — da cui `parse WH51` deriva i tag (step 12 §11);
7. scrive i punti `sensor_moves` sul bucket `events`;
8. risponde `200` con il documento salvato.

**Il passo 7 è best-effort.** Se la scrittura su InfluxDB fallisce, il layout resta
salvato e si logga `node.warn`: la collocazione corrente è il dato autoritativo, la
history è un registro. Il contrario — rifiutare un salvataggio valido perché il
registro non è raggiungibile — sarebbe peggio.

### 6.4 Concorrenza

Nessun locking. L'utenza è una persona sola su rete locale; il `.bak` copre l'errore
umano, che è l'unico realistico.

---

## 7. Bucket `events` e measurement `sensor_moves`

### 7.1 Perché un bucket nuovo

`garden` ha retention `120d` (`docs/step1_setup_rpi5.md`). Un registro degli
spostamenti che si autocancella dopo quattro mesi non è un registro. `events` nasce
con retention **illimitata**.

```bash
influx bucket create \
  --name events \
  --org orto-digitale \
  --retention 0
```

### 7.2 Token

> ⚠️ In InfluxDB 2.x i permessi di un token **non sono modificabili dopo la
> creazione** (`PATCH /api/v2/authorizations` accetta solo `status` e `description`).
> Non è quindi possibile estendere `token-nodered-rw` al nuovo bucket: serve un
> secondo token.

| Token | Permessi |
|---|---|
| `token-nodered-events-rw` | Write su `events` |

Variabile d'ambiente: **`INFLUX_TOKEN_NODERED_EVENTS_RW`**, con lo **stesso identico
nome** in `rpi5/docker-compose.yml` e in `rpi5/.env.example`.

> Il footgun #1 di `CLAUDE.md` documenta che `INFLUX_TOKEN_NODERED_RW` e
> `INFLUXDB_TOKEN_NODERED_RW` sono lo stesso token con due nomi, e prescrive di non
> aggiungere nuovi alias. Questo step non ne aggiunge: un nome, due file.

### 7.3 Schema

| Measurement | Tag | Field |
|---|---|---|
| `sensor_moves` | `sensor_id` (WH51_01–06), `action` (`place`/`move`/`reassign`/`remove`) | `from_aiuola` (int), `to_aiuola` (int), `from_x` (float), `to_x` (float), `changed_aiuola` (bool) |

Valore sentinella `-1` per i campi privi di significato nell'azione (`from_*` su
`place`, `to_*` su `remove`).

`action` è un tag perché ha cardinalità 4 e ci si filtra sopra; `x` e `aiuola` sono
field perché sono valori, non chiavi di raggruppamento.

### 7.4 Semantica delle azioni

| `action` | Condizione |
|---|---|
| `place` | il sensore non era nel layout precedente, ora c'è |
| `remove` | c'era, ora non c'è |
| `move` | stessa fila, `x` diversa |
| `reassign` | fila diversa — implica `changed_aiuola = true` |

### 7.5 Il guadagno concreto

Essendo in InfluxDB e non in un file, gli spostamenti si sovrappongono come marker
allo storico di `soil_moisture`: un salto di umidità del 12 giugno si spiega guardando
se quel giorno la sonda è stata mossa. È l'unica ragione per cui questo dato merita di
stare in un time-series DB invece che in un log.

---

## 8. Motore di diff

Server-side, dentro il flow `PUT`. È l'unico punto che conosce con certezza lo stato
precedente, e non è aggirabile da un client sbagliato.

```js
// pseudo
const prev = index(currentLayout);   // sensor_id -> { aiuola, x }
const next = index(incomingLayout);
const events = [];

for (const id of union(keys(prev), keys(next))) {
  const a = prev[id], b = next[id];
  if (!a && b)  events.push(ev(id, 'place',  null, b));
  else if (a && !b) events.push(ev(id, 'remove', a, null));
  else if (a.aiuola !== b.aiuola)        events.push(ev(id, 'reassign', a, b));
  else if (Math.abs(a.x - b.x) >= 0.005) events.push(ev(id, 'move',     a, b));
  // delta < 0.005 => rumore di arrotondamento, nessun evento
}
```

La soglia `0.005` evita di riempire il registro di eventi generati da riarrotondamenti
in serializzazione. Un salvataggio che non tocca i sensori non produce alcun punto.

**Le modifiche alle aree coltura non generano eventi.** Il requisito riguarda gli
spostamenti dei sensori; storicizzare le colture è esplicitamente YAGNI (step 12 §13).

---

## 9. Segnalazione del cambio aiuola

Doppia, come richiesto: visibile subito, e registrata per sempre.

**In editor**, appena un pin finisce in una fila diversa dall'aiuola di targa
(`SENSOR_LOCATIONS`), compare un avviso inline non bloccante:

> ⚠ WH51_03 risulta installato in aiuola 2. Spostandolo in fila 3, le nuove letture
> verranno registrate come aiuola 3. Lo storico precedente resta invariato.

Il testo dice esattamente cosa succede, incluso il limite: i tag InfluxDB già scritti
sono immutabili (step 12 §11.3).

**Nel registro**, l'evento `reassign` con `changed_aiuola = true`.

Non è un errore e non blocca il salvataggio: se la sonda è stata davvero spostata nel
terreno, il layout deve poterlo dire.

> Nota: `decision logic` calcola la media su tutti i sensori indistintamente e non
> raggruppa per aiuola (step 12 §2c). Un cambio di aiuola **non altera** il
> comportamento dell'irrigazione. Se in futuro si introducesse una soglia per aiuola,
> questo avviso andrebbe promosso a conferma esplicita.

---

## 10. File toccati

### Nuovi

| File | Contenuto |
|---|---|
| `src/components/OrtoMap/useLayoutDraft.ts` | bozza, operazioni, validazione client |
| `src/components/OrtoMap/ContextMenu.tsx` | menu custom |
| `src/components/OrtoMap/EditorToolbar.tsx` | Modifica / Salva / Annulla + stato dirty |
| `src/components/OrtoMap/useDragHandle.ts` | trascinamento con clamp, pointer events |
| `src/helpers/layoutValidation.ts` | invarianti condivise client/server |

### Modificati

| File | Modifica |
|---|---|
| `src/components/OrtoMap/index.tsx` | modalità editor, maniglie, bersagli del menu |
| `src/api/layout.ts` | `putLayout()` + mutation |
| `src/pages/Orto.tsx` | toolbar editor |
| `rpi5/nodered/data/flows.json` | `PUT /api/layout`, validazione, diff, scrittura `events` |
| `rpi5/docker-compose.yml` | `INFLUX_TOKEN_NODERED_EVENTS_RW` |
| `rpi5/.env.example` | stessa variabile, **stesso nome** |
| `rpi5/scripts/verify_rpi5.sh` | check bucket `events` + endpoint `PUT` |

### Operazioni una tantum sul RPi

1. creare il bucket `events` con retention `0`;
2. creare il token `token-nodered-events-rw` (Write su `events`);
3. inserirlo in `/opt/orto-digitale/.env` (chmod 600, mai nel repo);
4. ri-iniettare le credenziali Node-RED dopo il redeploy di `flows.json`
   (`docs/comandi_verifica.md §5.5`).

---

## 11. Fuori scope

- editing su touch — decisione di prodotto, non limite tecnico;
- trascinamento delle singole piante;
- undo multilivello;
- storicizzazione delle aree coltura;
- date di semina e raccolto;
- pannello di consultazione della history nel frontend: si interroga da Grafana. Un
  overlay dei marker sul grafico umidità è un candidato naturale per uno step futuro,
  ma **non** viene predisposto qui;
- modifica della geometria delle file (`FILE_GEOM` resta config).

---

## 12. Verifica end-to-end

### 12.1 Bucket e token

```bash
ssh as@192.168.1.12 'cd /opt/orto-digitale && set -a && . ./.env && set +a && \
  docker exec influxdb influx bucket list --org orto-digitale \
    --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" | grep events'
# atteso: retention infinita (0s)

ssh as@192.168.1.12 'cd /opt/orto-digitale && set -a && . ./.env && set +a && \
  docker exec influxdb influx auth list --org orto-digitale \
    --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" | grep nodered-events'
# atteso: un token con Write sul solo bucket events
```

### 12.2 Validazione

I payload abbreviati qui sotto violano anche `bad_file_set` (non hanno tre file), per
cui si asserisce la **presenza** del codice atteso, non l'unicità.

```bash
# area sotto la larghezza minima -> 400
curl -sk -X PUT https://orto.local/api/layout \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"file":[{"id":1,"aree":[{"crop":"pomodoro","to":0.01,"n":1},
       {"crop":"libero","to":1.0,"n":0}],"sensori":[]}]}' \
  | jq '.errors | map(.code) | index("area_too_narrow") != null'
# atteso: true

# ultimo to != 1.0 -> 400, codice not_closed
# sensore ripetuto in due file -> 400, codice duplicate_sensor
# stesse asserzioni, sostituendo il codice cercato
```

```bash
# il documento completo e valido deve invece passare
curl -sk -X PUT https://orto.local/api/layout \
  -H 'Content-Type: application/json' \
  --data @rpi5/nodered/data/orto_layout.seed.json -o /dev/null -w '%{http_code}\n'
# atteso: 200
```

### 12.3 History

```bash
# dopo aver spostato WH51_03 da fila 2 a fila 3 e salvato
ssh as@192.168.1.12 'cd /opt/orto-digitale && set -a && . ./.env && set +a && \
  docker exec influxdb influx query --org orto-digitale \
    --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" "
      from(bucket:\"events\") |> range(start:-1h)
        |> filter(fn:(r) => r._measurement == \"sensor_moves\")
        |> filter(fn:(r) => r.sensor_id == \"WH51_03\")"'
# atteso: action=reassign, from_aiuola=2, to_aiuola=3, changed_aiuola=true
```

```bash
# un salvataggio che tocca solo le colture non deve generare punti
# atteso: nessun nuovo punto in sensor_moves
```

### 12.4 Tagging a valle

```bash
# dopo la prima lettura GW3000 successiva allo spostamento
ssh as@192.168.1.12 'cd /opt/orto-digitale && set -a && . ./.env && set +a && \
  docker exec influxdb influx query --org orto-digitale \
    --token "$DOCKER_INFLUXDB_INIT_ADMIN_TOKEN" "
      from(bucket:\"garden\") |> range(start:-15m)
        |> filter(fn:(r) => r._measurement == \"soil_moisture\"
                         and r.sensor_id == \"WH51_03\")
        |> distinct(column:\"aiuola\")"'
# atteso: 3
```

### 12.5 Frontend

- [ ] il pulsante «Modifica» **non compare** a 390 px né su dispositivo touch
- [ ] trascinare un divisorio muove entrambe le aree adiacenti e non scende sotto il 5%
- [ ] la sesta *Dividi qui* è disabilitata (limite 5 aree)
- [ ] il menu nativo del browser non compare mai in modalità editor
- [ ] *Annulla* ripristina esattamente lo stato servito dal server
- [ ] chiudere la scheda con modifiche pendenti chiede conferma
- [ ] spostare un pin in un'altra fila mostra l'avviso di §9 e **consente** il salvataggio
- [ ] `.bak` presente sul volume dopo il primo salvataggio, con il contenuto precedente
- [ ] con Node-RED irraggiungibile, *Salva* mostra un errore e la bozza **non** viene persa

---

## 13. Aggiornamenti a CLAUDE.md

Da applicare **nello stesso commit** dell'implementazione:

1. **Stack / InfluxDB** — documentare il bucket `events` (retention illimitata) accanto
   a `garden` (120d).
2. **Schema dati** — nuova riga: `sensor_moves` | tag `sensor_id`, `action` | field
   `from_aiuola`, `to_aiuola`, `from_x`, `to_x`, `changed_aiuola`, con l'indicazione
   che vive nel bucket `events`, non in `garden`.
3. **Token InfluxDB** — aggiungere `token-nodered-events-rw` → Write su `events`.
4. **Footgun #1** — annotare che `INFLUX_TOKEN_NODERED_EVENTS_RW` ha volutamente lo
   stesso nome in compose e in `.env.example`, e che non va creato alcun alias.
5. **Mapping sensori → aiuole** — la tabella è un fallback; la collocazione autoritativa
   è `/api/layout`, modificabile dall'editor, e i cambiamenti sono tracciati in
   `sensor_moves`.
6. **Stato avanzamento** — riga `| 13 | Editor layout orto | ✅ |`.

---

## Implementazione

**Stato:** 🟡 IMPLEMENTATO E DEPLOYATO — verifica a mano dell'editor da fare
**Commit:** `feat(nodered): PUT /api/layout...` (50e8077), `feat(frontend): editor del layout orto` (2376035)

### Verificato

Backend, con `rpi5/nodered/test/put_layout.test.mjs` — 24 controlli che eseguono il
corpo del nodo **letto da `flows.json`**, con filesystem finto: validazione (tutti gli
11 codici), scrittura atomica, `.bak`, `updated_at` imposto dal server, e le quattro
azioni del diff. Poi sul RPi vero: `place` ×4 al primo salvataggio, `move` con
`from_x`/`to_x` corretti, `400` con `area_too_narrow` su documento invalido.

Frontend, con `layoutOps.test.ts` — 19 controlli sulle operazioni pure, fra cui uno
che spazza 200 posizioni di divisorio verificando che **nessuna** produca un layout
invalido. In totale il progetto ha 41 test.

`verify_rpi5.sh` sezione [16]: GET, PUT che rifiuta, seed presente, token nel
container, bucket con retention infinita. Healthcheck completo **TUTTO OK**.

### NON verificato

L'editor **non è mai stato usato a mano**: l'estensione Chrome non è collegata in
questa sessione. Trascinamento divisori e sonde, menu contestuale, Salva/Annulla e
l'avviso di riassegnazione hanno il typecheck e la logica sotto test, ma nessuno li
ha ancora toccati col mouse.

### Deviazioni dalla spec

| Deviazione | Motivo |
|---|---|
| Scrittura su `events` via `http request` + `env.get()`, non con un secondo `influxdb out` | `cfg-influxdb` tiene il token in `flows_cred.json`, che ogni redeploy di `flows.json` svuota. Preso da `.env` il token non è una credenziale Node-RED e nessun redeploy può cancellarlo |
| Menu contestuale a un livello, senza sottomenu `▸` | Le voci di scelta stanno in linea sotto un'intestazione: un gesto in meno e molto meno codice |
| `sensor_id` validato server-side contro tutti e sei i WH51, non contro `ACTIVE_SENSORS` | Il confine di fiducia è "è un sensore vero"; quali siano installati è politica di prodotto, e cablarla nel backend richiederebbe di toccarlo quando 05/06 verranno installati. Il dropdown resta ristretto ad `ACTIVE_SENSORS` |
| `OrtoMap/` cartella → `OrtoMap.tsx` + `OrtoEditor.tsx` + `ContextMenu.tsx` + `helpers/layoutOps.ts` | La mappa era già un file solo dallo step 12; la logica pura sta nei helper perché lì i test la raggiungono |
| `config/orto.ts` diviso, glifi in `config/cropGlyphs.ts` | `import.meta.glob` è solo-Vite e impediva a `node --test` di caricare la config |

### Da fare

1. Usare l'editor davvero: dividere, unire, cambiare coltura, trascinare, salvare.
2. Controllare che uno spostamento reale finisca in `sensor_moves`.
3. Marcare COMPLETATO e aggiornare `CLAUDE.md` §Stato avanzamento.
