# Frontend — Specifica Dati

Spec **estremamente basilare** che descrive i soli **dati** che il layer di visualizzazione deve gestire. Nessuna scelta grafica, nessun mockup: serve come input neutro per il design frontend.

Tutti i dati provengono da InfluxDB (bucket `garden`) o da Node-RED, eccetto la temperatura ambiente che arriva da API esterna. Per i dettagli su measurement/tag/field vedi `CLAUDE.md` §"InfluxDB Data Model".

---

## 1. Umidità terreno

### 1.1 Valori correnti per misuratore

Per ognuno dei 6 misuratori (`WH51_01` … `WH51_06`):

| Dato | Tipo | Note |
|------|------|------|
| `sensor_id` | string | `WH51_01` … `WH51_06` |
| `aiuola` | int | 1, 2 o 3 |
| `position` | string | `near` / `far` |
| `value` | float (%) | umidità corrente |
| `timestamp` | datetime | ultima lettura |
| `battery_ok` | bool | indicatore batteria |
| `rssi` | int | qualità segnale RF |
| `online` | bool | derivato (vero se `last_seen` recente) |

### 1.2 Heatmap su ortofoto 2D dell'orto

Il frontend deve poter posizionare i 6 misuratori su un'immagine ortofoto statica dell'orto.

| Dato | Tipo | Note |
|------|------|------|
| `sensor_id` | string | chiave |
| `x`, `y` | float (0–1) o px | coordinate sull'immagine, **statiche, definite in config** |
| `value` | float (%) | usato per colore della heatmap |

Il colore è funzione di `value`. La mappatura colore→valore è una scelta di design, non un dato (es. rosso < 40%, verde 40–65%, blu > 65%).

### 1.3 Hover su misuratore

Al passaggio del mouse su un misuratore della heatmap mostra **i dati di §1.1** per quel `sensor_id`.

### 1.4 Trend per periodo temporale selezionato

Selettore periodo indipendente (es. ultime 24h, 7 giorni, 30 giorni, custom).

| Dato | Tipo | Note |
|------|------|------|
| `sensor_id` | string | una serie per misuratore |
| `timestamp` | datetime | asse X |
| `value` | float (%) | asse Y |

Granularità: campionamento nativo (~60s) per finestre brevi, aggregazione media per finestre lunghe.

---

## 2. Irrigazione

### 2.1 Stato corrente valvola

| Dato | Tipo | Note |
|------|------|------|
| `valve_id` | string | `SWV_01` |
| `state` | enum | `open` / `closed` |
| `reachable` | bool | valvola raggiungibile |
| `linkquality` | int | qualità Zigbee |
| `last_change` | datetime | timestamp ultima transizione di `state` |

### 2.2 Comando manuale

Bottone toggle apertura/chiusura. Il frontend invia un comando; nessun dato persistito lato UI oltre allo stato di §2.1.

| Dato inviato | Tipo | Note |
|--------------|------|------|
| `command` | enum | `open` / `close` |
| `trigger` | string | sempre `manual` quando da UI |

### 2.3 Trend apertura per periodo temporale selezionato

Selettore periodo **indipendente** da quello di §1.4.

| Dato | Tipo | Note |
|------|------|------|
| `timestamp` | datetime | asse X |
| `state` | enum | `open` / `closed` — serie a gradino |

In alternativa, lista di intervalli di apertura:

| Dato | Tipo | Note |
|------|------|------|
| `start` | datetime | inizio apertura |
| `end` | datetime | fine apertura (null se ancora aperta) |
| `duration_seconds` | int | durata |
| `trigger` | enum | `auto` / `manual` |

### 2.4 Tempo cumulato di apertura nel periodo

Stesso selettore di §2.3.

| Dato | Tipo | Note |
|------|------|------|
| `total_open_seconds` | int | somma `duration_seconds` nel periodo |

### 2.5 Tempo da quando l'acqua è aperta

Calcolato lato frontend o backend. Significativo solo se `state == open`.

| Dato | Tipo | Note |
|------|------|------|
| `open_since_seconds` | int | `now - last_change` se aperta, altrimenti null |

### 2.6 Tempo residuo prima dello spegnimento automatico

Significativo solo se `state == open`. La durata massima è il safety timeout (15 min, vedi `CLAUDE.md` §"Irrigation Logic Parameters").

| Dato | Tipo | Note |
|------|------|------|
| `auto_close_in_seconds` | int | `max_duration - open_since_seconds`, null se chiusa |

---

## 3. Altro

### 3.1 Temperatura ambiente (API esterna)

Origine: API meteo esterna (es. Open-Meteo) interrogata da Node-RED o direttamente dal frontend.

#### Corrente

| Dato | Tipo | Note |
|------|------|------|
| `temperature_c` | float (°C) | temperatura attuale |
| `timestamp` | datetime | ora del valore |

#### Trend prossimi 7 giorni (forecast)

| Dato | Tipo | Note |
|------|------|------|
| `timestamp` | datetime | asse X |
| `temperature_c` | float (°C) | asse Y |
| `t_min`, `t_max` | float (°C) | opzionali, se aggregato giornaliero |

Periodo fisso (7 giorni avanti), non selezionabile dall'utente.

---

## Riepilogo selettori temporali

| Pannello | Selettore | Indipendente da |
|----------|-----------|-----------------|
| §1.4 Trend umidità | sì | tutti gli altri |
| §2.3 Trend apertura | sì | §1.4 |
| §2.4 Tempo cumulato | **vincolato** a §2.3 | — |
| §3.1 Forecast temperatura | no (fisso 7gg) | — |
