# SONOFF Hydro DUO — Scheda tecnica e integrazione

**Data raccolta info:** 2026-05-23
**Contesto:** valutazione hardware per deviare il flusso del rubinetto verso 2 tubi/aree distinte, in alternativa a `02 × SONOFF SWV` o a una valvola 3-vie + ESP32. Vedi `01_irrigazione_decisione.md` per il confronto completo.

---

## Cos'è
Evoluzione **dual-channel** del SONOFF SWV. È un'unica valvola IP65 a batteria con due uscite indipendenti controllabili via Zigbee 3.0, ciascuna con il proprio attuatore e un flussometro integrato. Pensata esplicitamente per gestire **due zone di irrigazione separate** dallo stesso rubinetto.

Annunciata il 13 maggio 2026 (in preorder dall'8 maggio al 25 giugno, spedizioni da fine giugno 2026).

## Modelli

| SKU | Mercato | Attacchi |
|---|---|---|
| `SWV-ZF2E` | UK/Europa (quello da prendere) | BSP 3/4" |
| `SWV-ZF2U` | Nord America | NH (National Hose) |

## Specifiche

| Parametro | Valore |
|---|---|
| Canali | 2 indipendenti |
| Connettività | Zigbee 3.0 + Bluetooth 5 LE |
| Alimentazione | 4× AA (1.5V) in 2s2p → 3V, autonomia ~1 anno **oppure** USB-C 5V/1A |
| Pressione acqua | 0.06 – 0.8 MPa (0.6 – 8 bar) |
| Temperatura aria | 0 – 50 °C |
| Temperatura acqua | 5 – 40 °C |
| Grado protezione | IP65 |
| Dimensioni | 132 × 121 × 67 mm |
| Materiale | Corpo ABS, attacchi ottone |
| Altitudine max | 2000 m |
| Flussometro | Integrato |
| Prezzo | ~$42.21 preordine (~€40); coupon `CNXSOFT` sconto 10% (non valido su preorder) |

## Funzionalità firmware
- Fino a 12 schedulazioni di irrigazione personalizzate
- Modalità: durata, capacità, durata con intervallo (anche ciclica)
- Allerte: rischio gelo, perdite, batteria scarica, mancanza acqua
- Ritardo pioggia
- Regolazione stagionale (moltiplicatore mensile 0.1–2.0)
- Lettura storico irrigazione 24h / 30g / 180g
- Child lock
- Aggiornamento OTA via Zigbee

> Le funzioni avanzate (es. `weather-based adjustment`, link a scene) funzionano **solo** in Zigbee, non in modalità BLE prossimità → per noi è ininfluente, useremo sempre Zigbee.

## Integrazione Zigbee2MQTT

Dispositivo censito come **`SWV-ZF2`** ed è **completamente supportato** (compreso OTA).
Pagina ufficiale: <https://www.zigbee2mqtt.io/devices/SWV-ZF2.html>

### Topic di controllo (esempio device: `irrigazione_principale`)

Comando ON/OFF canale 1:
```
TOPIC: zigbee2mqtt/irrigazione_principale/set
PAYLOAD: {"state_1": "ON"}     {"state_1": "OFF"}     {"state_1": "TOGGLE"}
```

Comando ON/OFF canale 2:
```
TOPIC: zigbee2mqtt/irrigazione_principale/set
PAYLOAD: {"state_2": "ON"}     {"state_2": "OFF"}     {"state_2": "TOGGLE"}
```

Anche `on with timed off`:
```json
{"state_1": "ON", "on_time": 600, "off_wait_time": 0}
```
(`on_time` e `off_wait_time` in secondi — utile per safety timeout lato dispositivo)

### Attributi letti
- `battery` (%)
- `child_lock`
- piani irrigazione (fino a 5 per canale)
- record irrigazione (sola lettura)
- stato anomalo valvola (sola lettura)

## Impatti sul nostro stack (se adottato)

### Zigbee2MQTT
- Re-pairing: cancellare il vecchio `SWV` singolo, aggiungere il nuovo `SWV-ZF2`.
- Rinominare il device nel pannello Z2M (es. `valvola_principale_duo`) e aggiornare `configuration.yaml` se ci sono `friendly_name` espliciti.

### Node-RED (`flows.json`)
- Il nodo MQTT che oggi pubblica `{"state":"ON"}` su un device singolo deve diventare 2 nodi (o un nodo parametrico) che pubblicano `state_1`/`state_2` sullo stesso device.
- La logica step 4 (cooldown, finestre orarie, soglie 40/65%) resta identica: l'unica novità è la **scelta del canale** prima di aprire.
- Bonus: il flussometro integrato espone via Z2M dati di portata/totale per canale → arricchire `irrigation_events` con `liters` reale, oltre a `duration_seconds`.

### CLAUDE.md
- Aggiornare la tabella "Logica irrigazione" se introduciamo cap separati per canale (per ora non serve).

### Salvataggio in InfluxDB
- `valve_state` con tag `valve_id=SWV_DUO_CH1` / `SWV_DUO_CH2` (o mantenere `SWV_01` + `SWV_02` per coerenza con il naming attuale).
- Nuovo field opzionale `liters` in `irrigation_events` se sfruttiamo il flussometro.

## Pro e contro nello scenario Orto Digitale

**Pro**
- Drop-in nello stack Zigbee2MQTT già attivo (step 3).
- Un solo dispositivo fisico, una sola batteria → manutenzione dimezzata rispetto a "2× SWV".
- Flussometro integrato = leak detection + litri reali (utile come dato fattuale per la decisione umana di affinare le soglie, coerente con [[feedback_complessita_proporzionata]]).
- IP65 outdoor.
- Prezzo allineato al singolo (≈ €40 vs ≈ €25-30 del SWV singolo).

**Contro**
- Disponibilità solo da **fine giugno 2026** (preorder).
- Sostituendo il SWV già installato, il dispositivo attuale resta inutilizzato (riusabile altrove).
- Le due uscite escono accoppiate al rubinetto → entrambi i tubi devono partire da lì (non risolve casi in cui la biforcazione serve a 10 m di distanza).
- Selettività "mai due aperte insieme" è solo via software, non hardware.

## Decisione (pending)
Vedi `01_irrigazione_decisione.md`. Le due alternative realistiche per il nostro caso restano:
1. **Hydro DUO** (questo) se accettiamo l'attesa fino a fine giugno.
2. **Secondo SONOFF SWV in parallelo** se vogliamo partire subito riusando l'hardware esistente.

---

## Fonti

- Annuncio tecnico CNX Software: <https://www.cnx-software.com/2026/05/13/sonoff-hydro-duo-a-dual-channel-zigbee-3-0-smart-water-valve-with-flow-meter/>
- Pagina prodotto ufficiale SONOFF: <https://sonoff.tech/en-us/products/sonoff-hydro-duo-dual-channel-zigbee-smart-water-valve-swv-zf2e-swv-zf2u>
- Supporto Zigbee2MQTT (`SWV-ZF2`): <https://www.zigbee2mqtt.io/devices/SWV-ZF2.html>
- Rivenditore EU (smarterhome.sk): <https://smarterhome.sk/en/irrigation/sonoff-swv-zf2e-hydro-duo-dual-channel-zigbee-smart-water-valve-with-flow-meter-2283.html>
