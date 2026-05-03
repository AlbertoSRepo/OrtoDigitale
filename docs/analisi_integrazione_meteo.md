# Analisi Integrazione Dati Meteo + Storicizzazione

**Data:** 2026-05-03
**Documento padre:** [analisi_logica_irrigazione.md](./analisi_logica_irrigazione.md) — sezione "Parametro 3 — Previsione pioggia"
**Scope:** definire architettura di integrazione Open-Meteo e decidere se/come storicizzare i dati su InfluxDB.

---

## 1. Architettura di integrazione

### 1.1 Dove vive l'integrazione: Node-RED

Node-RED è il punto naturale per l'integrazione meteo perché:
- Già orchestra la logica di irrigazione (consumer dei dati meteo)
- Ha nodi `http request` + `json` nativi
- Ha lo storage di context (`flow.set`/`global.set`) per la cache in memoria
- Le credenziali e i parametri (lat, lon) vivono già in `flows.json` o env

**Alternative scartate:**
- Script Python a parte: aggiunge un servizio in più, più dipendenze, separazione artificiale
- Chiamata diretta da Grafana: Grafana è solo viewer, non deve fare logica decisionale

### 1.2 Frequenza di polling

| Frequenza | Verdetto |
|---|---|
| 5 minuti (= ciclo irrigazione) | **No.** Open-Meteo aggiorna i forecast circa ogni ora; polling più frequente è spreco di richieste e non migliora la qualità del dato |
| 30 minuti | Buon compromesso: cache sempre fresca quando serve, carico API minimo |
| 60 minuti | Accettabile, ma rischio di avere cache "vecchia" di 50 minuti al momento della decisione |
| On-demand al momento della decisione | **No.** Se l'API è giù proprio in quel momento, salta tutto. Meglio disaccoppiare |

**Raccomandazione: polling ogni 30 minuti, cache in `global.context`, lettura on-demand dalla cache.**

### 1.3 Resilienza

```
ogni 30 min:
  fetch openmeteo
  └─ successo  → aggiorna cache, last_update = now()
  └─ fallimento → log warn, NON svuotare la cache

al momento della decisione:
  leggi cache
  └─ cache age < 90 min → usa il valore
  └─ cache age >= 90 min → considera "meteo non disponibile" → procedi senza rain delay
```

Il principio guida: **un'API meteo down non deve mai bloccare l'irrigazione**. Il sistema deve degradarsi a "comportamento da step 4 base" (umidità + orario + cooldown).

### 1.4 Campi minimi da estrarre dall'API

```
endpoint: https://api.open-meteo.com/v1/forecast
params:
  latitude:  <lat orto>
  longitude: <lon orto>
  hourly:    precipitation,temperature_2m,relative_humidity_2m
  forecast_days: 2
  timezone: Europe/Rome
```

Da cui derivare 4 valori scalari per la decisione:

| Variabile | Calcolo | Uso |
|---|---|---|
| `precip_next_24h_mm` | sum(hourly.precipitation[0:24]) | Rain delay (soglia 5mm) |
| `precip_next_6h_mm` | sum(hourly.precipitation[0:6]) | Decisione fine — pioggia imminente |
| `temp_max_next_12h_c` | max(hourly.temperature_2m[0:12]) | Soglia adattiva estate |
| `humidity_now_pct` | hourly.relative_humidity_2m[0] | Stima evaporazione |

### 1.5 Parametri configurabili per l'integrazione meteo

Coerente con il principio "tutti i parametri modificabili da frontend, no hardcoded":

| Parametro | Default | Note |
|---|---|---|
| `weather_polling_interval_seconds` | 1800 (30min) | Sotto i 600s spreco; sopra 3600s rischio di cache stantia |
| `weather_cache_max_age_seconds` | 5400 (90min) | Soglia oltre la quale la cache è considerata "non disponibile" |
| `rain_threshold_mm` | 5 | Sotto questa soglia la pioggia è considerata "trascurabile" |
| `rain_window_hours` | 24 | Finestra di lookahead per il rain delay |
| `weather_api_url` | `https://api.open-meteo.com/v1/forecast` | Cambiabile per provider alternativi |
| `weather_lat` | **45.71722434055733** | Coordinata orto |
| `weather_lon` | **9.733793667999565** | Coordinata orto |

Tutte le modifiche prendono effetto al successivo polling, **senza redeploy**. Vedi `analisi_completezza_step4.md §2.7` per l'architettura del config store.

---

## 2. Storicizzare i dati meteo: ha senso?

**Risposta breve: sì, ma in modo selettivo, distinguendo tra _previsione al momento della decisione_ e _osservazione meteo corrente_.**

### 2.1 Ragionamento

Si potrebbe pensare: "Open-Meteo offre già un endpoint `/archive` con i dati storici, perché duplicare?"

Questo argomento però **confonde due cose diverse**:

| Cosa | Disponibile retroattivamente? | Serve storicizzarla? |
|---|---|---|
| **Meteo reale** del 2025-12-15 alle 14:00 (es. pioggia caduta, temperatura) | Sì, via API archivio | **No** — recuperabile on-demand |
| **Previsione che il sistema aveva** il 2025-12-15 alle 14:00 per le 24h successive | **No** — Open-Meteo non ti dice cosa prevedeva ieri | **Sì, obbligatoriamente** |

La previsione è un input decisionale del sistema. Senza storicizzarla, non si può rispondere a domande come:
- "Perché ieri sera non ha irrigato?" → senza la previsione di ieri non c'è risposta
- "Quanto sono affidabili le previsioni Open-Meteo per la nostra zona?" → richiede confronto previsione vs reale
- "Il rain delay scatta troppo spesso? Sotto-stima la pioggia?" → idem

### 2.2 Casi d'uso che giustificano la storicizzazione

**A. Auditabilità delle decisioni di non-irrigazione (priorità alta)**
Quando step 4 decide "skip per pioggia prevista", deve essere ricostruibile *cosa* aveva visto in quel momento. Senza storico, le decisioni del sistema sono opache.

**B. Calibrazione delle soglie (priorità media)**
La soglia "5mm in 24h" è euristica. Con 6 mesi di storico:
- correlare `precip_next_24h_mm` previsto vs `precip_next_24h_mm` osservato → bias dell'API per la zona
- correlare giornate piovose previste con effettiva variazione di umidità del suolo → soglia ottimale

**C. Modellazione dell'evapotraspirazione locale (priorità bassa)**
Combinando temperatura aria + umidità aria + variazione umidità suolo, si può stimare quanto velocemente l'orto perde acqua in funzione del meteo. Utile in step 5/6, non in step 4.

**D. Dashboard contestuale**
Sovrapporre in un grafico Grafana umidità del suolo + temperatura aria + pioggia rende immediatamente leggibili gli episodi di stress idrico.

### 2.3 Quanto costa storicizzare

Calcolo grossolano:
- 1 punto / 30 min × 4 field × 17.520 punti/anno ≈ 70 KB/anno (compresso InfluxDB)

È **trascurabile** rispetto a `soil_moisture` (4 sensori × 1 punto/20s ≈ 25 MB/anno). Non c'è motivo economico per non storicizzare.

### 2.4 Cosa NON storicizzare

Per evitare di accumulare dati senza valore decisionale:
- Tutta la curva `hourly` (48 punti × N field) → **no**: bastano gli aggregati (sum 24h, max 12h, etc.)
- La risposta JSON grezza dell'API → **no**: parsare e scartare
- Tag ad alta cardinalità tipo `forecast_hour=2026-05-04T14:00` → **no**: esplosione cardinalità in InfluxDB

---

## 3. Schema InfluxDB proposto

Due measurement separati, perché sono concettualmente due cose diverse e hanno frequenze diverse:

### Measurement `weather_forecast`
Snapshot della previsione, scritto **al momento del polling** (ogni 30 min).

| Tipo | Nome | Note |
|---|---|---|
| Tag | `source` | `openmeteo` (predisposto a futuri provider) |
| Tag | `location` | `orto` (costante per ora, predisposto a multi-sito) |
| Field | `precip_next_24h_mm` | Somma precipitazioni 24h |
| Field | `precip_next_6h_mm` | Somma precipitazioni 6h |
| Field | `temp_max_next_12h_c` | Massima temperatura prossime 12h |
| Field | `humidity_now_pct` | Umidità relativa corrente |
| Field | `api_latency_ms` | Latenza chiamata (utile per debug) |

### Measurement `weather_observation` (opzionale, fase 2)
Solo se in step 5 si vuole correlare suolo ↔ aria. Può essere popolato anche con dati storici batch da Open-Meteo `/archive`.

| Tipo | Nome |
|---|---|
| Tag | `source`, `location` |
| Field | `temp_c`, `humidity_pct`, `precip_last_hour_mm` |

### Cosa logga `irrigation_events` (modifica al schema esistente)

Quando step 4 prende una decisione, il record dell'evento deve **incorporare** lo snapshot meteo usato:
- `rain_forecast_mm` (già previsto nell'analisi padre)
- `weather_data_age_seconds` ← nuovo: età del dato meteo al momento della decisione (0 se appena letto, alto se cache stantia)
- `weather_available` ← nuovo: bool, false se sistema ha deciso senza meteo

Questo evita di dover fare join temporali tra `weather_forecast` e `irrigation_events` per ricostruire una decisione: il record dell'evento è autocontenuto.

---

## 4. Flusso dati

```
                    ┌─────────────────┐
   ogni 30 min ───► │   Node-RED      │ ───► global.context.weather (cache)
                    │  http request   │ ───► InfluxDB.weather_forecast
                    │  → openmeteo    │
                    └─────────────────┘
                            │
                            ▼  (lettura cache)
                    ┌─────────────────┐
   ogni 5 min  ───► │  Logica step 4  │
                    │  (decisione)    │ ───► InfluxDB.irrigation_events
                    │                 │       (con snapshot meteo incluso)
                    └─────────────────┘
```

Note:
- La cache in `global.context` permette decisioni anche durante un'API failure transitoria
- La scrittura su InfluxDB è asincrona rispetto alla decisione — un fail di scrittura non blocca l'irrigazione
- Non si passa per MQTT: i dati meteo non sono sensori, sono input esterno; il roundtrip MQTT aggiungerebbe complessità inutile

---

## 5. Retention

Proposta:
- `weather_forecast`: **2 anni** (analisi stagionale + calibrazione)
- `irrigation_events`: **forever** (eventi rari, valore storico alto, peso storage trascurabile)
- `weather_observation` (se attivato): **2 anni**

Da configurare nel bucket `garden` o in un bucket dedicato `weather` se si vogliono retention diverse rapidamente. Per semplicità, restare nel bucket `garden`.

---

## 6. Raccomandazione finale

**Implementare in step 4 (versione minima sufficiente):**
1. Polling Open-Meteo con intervallo letto dal config store (default 30 min)
2. Cache in Node-RED context con TTL configurabile (default 90 min)
3. Scrittura `weather_forecast` su InfluxDB ad ogni polling riuscito
4. Aggiunta dei campi `rain_forecast_mm`, `weather_data_age_seconds`, `weather_available` su `irrigation_events`
5. Fallback graceful: cache scaduta → si irriga senza rain delay
6. Soglia pioggia (`rain_threshold_mm`) e finestra (`rain_window_hours`) modificabili a runtime

**Rimandare a step 5/6:**
- Measurement `weather_observation` per correlazioni evaporazione
- Backfill storico via `/archive` di Open-Meteo
- Dashboard meteo dedicata in Grafana

**Da NON fare:**
- Storicizzare la risposta API grezza
- Storicizzare la curva oraria completa (basta il sum 24h)
- Far dipendere la decisione di irrigare dalla disponibilità dell'API meteo
