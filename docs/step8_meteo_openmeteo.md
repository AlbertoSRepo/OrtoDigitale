# Step 8 — Meteo Open-Meteo nel frontend (no storicizzazione)

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Architettura](#3-architettura)
4. [Modifiche Node-RED](#4-modifiche-node-red)
5. [Endpoint API — contratto](#5-endpoint-api--contratto)
6. [Frontend — `WeatherCard` esteso](#6-frontend--weathercard-esteso)
7. [Caching e fallback](#7-caching-e-fallback)
8. [Compatibilità con la logica di irrigazione (step 4)](#8-compatibilità-con-la-logica-di-irrigazione-step-4)
9. [Verifica end-to-end](#9-verifica-end-to-end)
10. [Out of scope](#10-out-of-scope)

> Documenti propedeutici: [`step4_irrigazione_automatica.md`](./step4_irrigazione_automatica.md), [`step5_backend_api_https.md`](./step5_backend_api_https.md), [`step6_frontend_spa.md`](./step6_frontend_spa.md), [`analisi_integrazione_meteo.md`](./analisi_integrazione_meteo.md)

---

## 1. Obiettivo

Mostrare nella PWA **dati meteo veritieri** provenienti direttamente da Open-Meteo, eliminando in questo step la dipendenza dalla cache InfluxDB scritta da step 4 per la *visualizzazione* (la storicizzazione resta in step 4 solo a supporto della logica di irrigazione). Per il frontend non serve storicizzazione locale: la lettura è always-on dall'API, con cache breve in memoria su Node-RED per assorbire i picchi di richieste della PWA.

Vincolo guida (`CLAUDE.md`): il sistema è "completamente locale" *per la logica decisionale* — la chiamata a Open-Meteo è già concessa da step 4 e qui viene estesa al solo layer di presentazione. Il RPi è on-line in modo affidabile (Ethernet primaria + WiFi fallback), quindi una dipendenza network sul path di lettura è accettabile.

### Risultato atteso

- La sezione meteo della Pagina Orto mostra **temperatura corrente, umidità relativa, vento, condizione meteo (icona WMO), min/max di oggi, pioggia prevista 24h** e una **strip 7 giorni** con min/max + icona.
- I valori sono freschi (≤ 5 min dall'API).
- Se Open-Meteo è momentaneamente irraggiungibile, l'app mostra l'ultimo dato cached con badge "ultimo aggiornamento N minuti fa" — coerente con il behavior offline di step 7.

---

## 2. Stato di partenza

| Componente | Stato | Note |
|---|---|---|
| `/api/weather/now` | ✅ esistente | Oggi legge dalla cache InfluxDB `weather_forecast` scritta da step 4 (polling 30 min) |
| `/api/weather/forecast` | ✅ esistente | Oggi tira live da Open-Meteo (verificato in `step5_backend_api_https.md §11`) |
| Polling Open-Meteo (step 4) | ✅ esistente | Ogni 30 min, scrive `weather_forecast` su InfluxDB, alimenta logica `rain_delay` |
| `WeatherCard.tsx` | ✅ esistente | Mostra temperatura, min/max, pioggia 24h, strip 7g con emoji WMO |
| `api/weather.ts` | ✅ esistente | `useWeatherNow` (refetch 60s), `useWeatherForecast` (refetch 30 min) |

**Gap da colmare in step 8:**
- `/api/weather/now` deve esporre **umidità, vento, codice WMO, ora di aggiornamento dal provider** — campi oggi non presenti nel JSON.
- I dati esposti al FE devono provenire da una **cache in-memory Node-RED dedicata al frontend**, non dalla measurement InfluxDB (che resta confinata alla logica di irrigazione, con la sua finestra di 30 min).
- Frontend: arricchire `WeatherCard` con i nuovi campi e mostrare un'indicazione di freschezza dato.

---

## 3. Architettura

```
                  ┌──────────────────────────────────────────────┐
                  │   api.open-meteo.com/v1/forecast             │
                  └───────────────┬──────────────────────────────┘
                                  │ HTTPS (no key)
        ┌─────────────────────────┼──────────────────────────────┐
        │                         │ pull on-demand (TTL 5 min)   │
        │                         ▼                              │
        │             ┌────────────────────────┐                 │
        │             │   Node-RED tab         │                 │
        │             │   f-weather-frontend   │                 │
        │             │   (cache in memory)    │                 │
        │             └───────┬────────────────┘                 │
        │  GET /api/weather/now            GET /api/weather/forecast
        │                                                        │
        │             ┌────────────────────────┐                 │
        │             │   Node-RED tab         │  (immutato)    │
        │             │   f-weather-irrigation │                 │
        │             │   polling 30 min       │                 │
        │             │   → InfluxDB           │                 │
        │             │   → cache logica step 4│                 │
        │             └────────────────────────┘                 │
        └────────────────────────────────────────────────────────┘
```

Due flussi indipendenti che condividono solo l'URL del provider:

- **`f-weather-frontend`** (nuovo) — Pull on-demand quando arriva una richiesta dal FE, con cache 5 min in `global.context`. Nessuna scrittura su InfluxDB.
- **`f-weather-irrigation`** (esistente, da step 4) — Polling fisso ogni 30 min, scrive su InfluxDB, alimenta la logica `rain_delay`. **Resta invariato.**

Separare i due flussi evita di accoppiare il refresh rate FE alla scrittura InfluxDB (oggi 30 min sono troppi per il FE che si aspetta dati "live").

---

## 4. Modifiche Node-RED

### 4.1 Nuovo tab `f-weather-frontend`

Nodi richiesti:

| Nodo | Tipo | Funzione |
|---|---|---|
| `http-in-now` | `http in` | `GET /api/weather/now-v2` (vedi §5 per la motivazione del suffisso) |
| `http-in-forecast` | `http in` | `GET /api/weather/forecast-v2` |
| `cache-read-now` | `function` | Legge `global.weather_frontend_cache`; se fresh (age < TTL) → risponde subito; altrimenti passa al fetch |
| `cache-read-forecast` | `function` | Idem per forecast |
| `http-request-openmeteo` | `http request` | URL costruito dinamicamente con i campi richiesti (vedi §4.2) |
| `parse-openmeteo` | `function` | Estrae i campi e popola la cache |
| `http-response-now` | `http response` | 200 + JSON |
| `http-response-forecast` | `http response` | 200 + JSON |
| `error-fallback` | `function` | Se la cache è scaduta e la chiamata fallisce, ritorna l'ultima cache nota con flag `stale: true` |

### 4.2 Chiamata a Open-Meteo

URL unico, una sola chiamata serve sia `/now` che `/forecast`:

```
https://api.open-meteo.com/v1/forecast
  ?latitude=45.71722434055733
  &longitude=9.733793667999565
  &timezone=Europe/Rome
  &current=temperature_2m,relative_humidity_2m,apparent_temperature,
           precipitation,weather_code,wind_speed_10m,wind_direction_10m
  &daily=weather_code,temperature_2m_max,temperature_2m_min,
         precipitation_sum,precipitation_probability_max,
         sunrise,sunset,wind_speed_10m_max
  &hourly=precipitation
  &forecast_days=7
```

**Una sola chiamata fonte di entrambi gli endpoint** — riduce il traffico verso Open-Meteo (rate limit gratuito: 10 000 chiamate/giorno, ampiamente sufficiente).

Latitude/longitude sono già in `analisi_integrazione_meteo.md §1.5` e devono restare configurabili via Node-RED config store (NON hardcoded nel flow).

### 4.3 Cache in `global.context`

Struttura:

```javascript
global.set("weather_frontend_cache", {
  fetched_at: 1747567890000,         // epoch ms
  source: "openmeteo",
  ok: true,                          // false se ultima chiamata fallita
  now: { /* payload §5.1 */ },
  forecast: [ /* payload §5.2 */ ]
});
```

TTL: **5 minuti** (configurabile via `weather_frontend_cache_ttl_seconds`, default `300`).

Politica:
- Richiesta FE → se `age < TTL` → risponde dalla cache (latenza < 5 ms).
- Richiesta FE → se `age ≥ TTL` → fetch sincrono (non background), aggiorna cache, risponde.
- Fetch fallito → ritorna ultima cache con `stale: true` e header `X-Weather-Age-Seconds: <N>`.

### 4.4 Coalescing richieste concorrenti

Se due richieste FE arrivano contemporaneamente con cache scaduta, evitare doppia chiamata a Open-Meteo. Implementare un mini lock in memoria:

```javascript
if (global.get("weather_fetch_in_flight")) {
  // attendi promise pendente o ritorna stale
  return ... // restituisci ultima cache con flag stale
}
global.set("weather_fetch_in_flight", true);
// ... fetch ...
global.set("weather_fetch_in_flight", false);
```

In pratica non è quasi mai un problema (il FE polla a 60s, 1 utente, 1 device), ma è una rete di sicurezza.

---

## 5. Endpoint API — contratto

Per non rompere il contratto esistente (consumato da PWA in cache, e potenzialmente da Grafana), si introducono nuovi endpoint **`-v2`** che sostituiscono i vecchi nel FE. I vecchi `/api/weather/now` e `/api/weather/forecast` restano disponibili per backward-compat e per la logica di step 4 (che li usa via cache InfluxDB internamente, non via HTTP).

> **Alternativa scartata**: arricchire in place gli endpoint esistenti. Rischio: rompere assunzioni della logica di irrigazione (step 4) o degli script di verifica (`verify_rpi5.sh`). Meglio una nuova versione semantica.

### 5.1 `GET /api/weather/now-v2`

Risposta:
```json
{
  "fetched_at": "2026-05-18T14:30:00+02:00",
  "age_seconds": 42,
  "stale": false,
  "source": "openmeteo",
  "temperature_c": 21.3,
  "apparent_temperature_c": 20.1,
  "humidity_pct": 62,
  "precipitation_mm_last_hour": 0.0,
  "wind_speed_kmh": 8.4,
  "wind_direction_deg": 220,
  "weather_code": 2,
  "today": {
    "t_min": 14.2,
    "t_max": 24.6,
    "precip_sum_mm": 1.4,
    "precip_probability_pct": 35,
    "sunrise": "2026-05-18T05:47:00+02:00",
    "sunset": "2026-05-18T20:38:00+02:00"
  }
}
```

Campi:
- `fetched_at`: timestamp dell'ultima chiamata effettivamente riuscita a Open-Meteo (ISO 8601).
- `age_seconds`: età del dato in secondi.
- `stale`: `true` se la cache è oltre TTL e l'ultima chiamata è fallita.
- `source`: `"openmeteo"` (predisposto a futuri provider).
- Tutti i campi numerici sono `null` se non disponibili dal provider per quella response.

### 5.2 `GET /api/weather/forecast-v2`

Risposta:
```json
{
  "fetched_at": "2026-05-18T14:30:00+02:00",
  "age_seconds": 42,
  "stale": false,
  "source": "openmeteo",
  "days": [
    {
      "date": "2026-05-18",
      "weather_code": 2,
      "t_min": 14.2,
      "t_max": 24.6,
      "precip_sum_mm": 1.4,
      "precip_probability_pct": 35,
      "wind_speed_max_kmh": 14.0,
      "sunrise": "2026-05-18T05:47:00+02:00",
      "sunset": "2026-05-18T20:38:00+02:00"
    },
    /* ... 6 giorni successivi ... */
  ]
}
```

Sempre 7 elementi in `days[]` (oggi + 6 giorni futuri).

### 5.3 Errori

| Caso | Status | Body |
|---|---|---|
| Cache fresh OK | 200 | dato vero, `stale: false` |
| Cache scaduta, fetch OK | 200 | dato vero, `stale: false` |
| Cache scaduta, fetch fail, cache pre-esistente | 200 | ultima cache, `stale: true`, `age_seconds: <N>` |
| Cache scaduta, fetch fail, **nessuna** cache pre-esistente (cold start + offline) | 503 | `{ "error": "weather provider unreachable", "code": 503 }` |
| Parametri invalidi (lat/lon non float) | 500 | `{ "error": "config error", "code": 500 }` |

La PWA tratta 503 come "non disponibile" (mostra placeholder), e usa il SW di step 7 per fallback a cache.

---

## 6. Frontend — `WeatherCard` esteso

### 6.1 Nuovi campi visualizzati

| Campo | Provenienza | Dove |
|---|---|---|
| Temperatura corrente (°C) | `now.temperature_c` | invariato, già presente |
| Temperatura percepita | `now.apparent_temperature_c` | nuovo, riga sotto temperatura grande |
| Umidità relativa (%) | `now.humidity_pct` | nuovo, kv block |
| Vento (km/h + direzione) | `now.wind_speed_kmh`, `now.wind_direction_deg` | nuovo, kv block |
| Pioggia ultima ora | `now.precipitation_mm_last_hour` | nuovo, kv block |
| Min / max oggi | `now.today.t_min/t_max` | invariato |
| Pioggia 24h prevista | `now.today.precip_sum_mm` | invariato (rinominato campo) |
| Probabilità pioggia | `now.today.precip_probability_pct` | nuovo, kv block |
| Alba / tramonto | `now.today.sunrise/sunset` | nuovo, kv block |
| Strip 7 giorni | `forecast.days[]` | invariato + icona WMO + precip_probability |
| Freschezza dato | `now.fetched_at` + `age_seconds` + `stale` | nuovo, eyebrow "aggiornato 2m fa" o "ultimi dati offline" |

### 6.2 Modifiche file frontend

| File | Modifica |
|---|---|
| `src/api/types.ts` | Aggiungi `WeatherNowV2`, `WeatherForecastV2`, `WeatherDay` |
| `src/api/weather.ts` | `useWeatherNow()` chiama `/weather/now-v2`; `useWeatherForecast()` chiama `/weather/forecast-v2`. Refetch interval 60s per now, 5 min per forecast (allineati al TTL backend) |
| `src/components/WeatherCard.tsx` | Espandi i campi visualizzati (vedi §6.1). Aggiungi mini-direzione vento (es. icona freccia ruotata o sigla `SSW`) |
| `src/helpers/wind.ts` | Nuova utility: `degToCompass(deg)` → `"N"|"NNE"|...|"NNW"` |
| `src/helpers/formatDate.ts` | Aggiungi `fmtTime(iso)` → `"05:47"` per sunrise/sunset |
| `src/styles/global.css` | Estendi `.weather`, `.weather .now-temp`, `.weather .kv` per i nuovi campi senza rompere layout 12-col |

### 6.3 Indicatore freschezza

In alto a destra della card, badge piccolo:
- `age < 2 min` → eyebrow muto "aggiornata · ora"
- `2 ≤ age < 5 min` → `aggiornata · Nm fa`
- `stale === true` → badge `--terra`: `dati cached · Nm fa`

### 6.4 Service Worker (step 7)

Il SW già intercetta `/api/weather/now` e `/api/weather/forecast` (vedi step 7 §3). Aggiungere il pattern v2:

```typescript
urlPattern: ({ url }) => url.pathname.startsWith('/api/weather/now-v2')
   || url.pathname.startsWith('/api/weather/forecast-v2'),
handler: 'NetworkFirst',
options: { cacheName: 'live-data', networkTimeoutSeconds: 3,
           expiration: { maxAgeSeconds: 60 * 60, maxEntries: 50 } },
```

I vecchi pattern restano per backward-compat.

---

## 7. Caching e fallback

### 7.1 Tre livelli di cache

```
┌──────────────────────────────────────────────────────────┐
│  Browser (Workbox SW)                                    │
│   NetworkFirst, timeout 3s, TTL 1h                       │
│   Fallback offline → ultimo SW cache                     │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Node-RED in-memory cache (global.context)               │
│   TTL 5 min, popolata al primo hit                       │
│   Fallback fetch fail → ultima cache + stale: true       │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Open-Meteo (provider esterno)                           │
└──────────────────────────────────────────────────────────┘
```

### 7.2 Persistenza della cache Node-RED

`global.context` di Node-RED è **memoria volatile**: si perde a ogni restart del container `nodered`. Conseguenza: al primo hit dopo un riavvio, il FE attende ~500 ms (latenza Open-Meteo) anziché < 5 ms (cache hit).

**Decisione: accettabile.** Salvare la cache su filesystem (`/data/weather-cache.json`) aggiungerebbe complessità per un beneficio marginale. Il SW del FE copre il caso "RPi appena riavviato + cellulare offline" mostrando l'ultima cache browser.

### 7.3 Fallback se Open-Meteo è giù

Coerente con `analisi_integrazione_meteo.md §1.3`: un'API meteo down **non blocca mai** l'irrigazione (step 4 ha già la sua cache 90 min) e **non blocca mai** il frontend (mostra `stale: true` + ultima cache + badge offline).

---

## 8. Compatibilità con la logica di irrigazione (step 4)

**Step 4 NON viene toccato in step 8.** In dettaglio:

| Aspetto step 4 | Stato dopo step 8 |
|---|---|
| Polling Open-Meteo ogni 30 min | invariato |
| Scrittura `weather_forecast` su InfluxDB | invariata |
| Cache 90 min in `global.context.weather` per logica rain_delay | invariata |
| Aggiunta campi `rain_forecast_mm`, `weather_data_age_seconds`, `weather_available` in `irrigation_events` | invariata |

Le due aree (frontend vs irrigazione) condividono solo l'URL del provider e i tag di configurazione (`weather_lat`, `weather_lon`). Sono due cache distinte (`global.weather` per step 4, `global.weather_frontend_cache` per step 8) per evitare conflitti di TTL.

**Why two caches and not one shared?** Step 4 ha bisogno di una cache **a finestra lunga** (90 min) per non perdere il rain_delay anche se Open-Meteo è offline alla decisione. Step 8 ha bisogno di una cache **a finestra breve** (5 min) per dare al FE dati freschi. Unificarle costringerebbe a un compromesso che peggiora entrambi i casi.

---

## 9. Verifica end-to-end

### 9.1 Backend

```bash
# Cache miss + fetch live
curl -s https://orto.local/api/weather/now-v2 | jq
# atteso: temperature_c float, age_seconds < 5, stale false

# Cache hit (chiamata immediata dopo la prima)
curl -s https://orto.local/api/weather/now-v2 | jq '.age_seconds'
# atteso: < 5

# Aspetta 6 min, poi richiama → fetch nuovo
sleep 360
curl -s https://orto.local/api/weather/now-v2 | jq '.age_seconds'
# atteso: < 5 (nuova fetch)

# Forecast 7 giorni
curl -s https://orto.local/api/weather/forecast-v2 | jq '.days | length'
# atteso: 7

# Simula Open-Meteo down: blocca DNS o usa /etc/hosts → 0.0.0.0 api.open-meteo.com
# (da fare con cautela in finestra di test, ripristinare subito)
curl -s https://orto.local/api/weather/now-v2 | jq '.stale, .age_seconds'
# atteso: stale: true, age_seconds > 300
```

### 9.2 Frontend

- [ ] Aprire PWA su PC, sezione Orto → WeatherCard mostra tutti i campi nuovi (temperatura, percepita, umidità, vento + bussola, pioggia ultima ora, pioggia 24h, prob. pioggia, alba/tramonto)
- [ ] Strip 7 giorni: ogni giorno mostra icona WMO, t_min, t_max, opzionale prob. pioggia
- [ ] Badge "aggiornata · ora" visibile in alto destra della card
- [ ] Mettere PC in airplane mode + RPi su rete: card mostra dati cached del SW; badge "dati offline"
- [ ] Riconnettere: dati si aggiornano entro 60s

### 9.3 Healthcheck

Aggiornare `rpi5/scripts/verify_rpi5.sh`:

```bash
# Check 13: weather endpoints v2 reachable
curl -sk --max-time 5 https://localhost/api/weather/now-v2 \
  --resolve orto.local:443:127.0.0.1 \
  | jq -e '.temperature_c != null' >/dev/null
```

---

## 10. Out of scope

- **Storicizzazione FE-side dei campi meteo arricchiti** (umidità aria, vento): se servirà in futuro per correlazioni evaporazione, si estende la measurement `weather_forecast` (step 4) — non in step 8.
- **Dashboard meteo Grafana dedicata**: rimandata se richiesta esplicita.
- **Notifiche push "pioggia in arrivo"**: richiede SW push handler + VAPID, fuori scope (anche step 7 l'ha esplicitato).
- **Provider meteo alternativi (MeteoSwiss, Aeronautica)**: l'architettura è predisposta (campo `source`) ma non implementata.
- **Selezione coordinate da UI**: lat/lon restano in config store Node-RED, modificabili via MQTT/REST come il resto dei parametri irrigazione.
- **Map / radar pioggia**: fuori filosofia "orto residenziale 40 m²".

---

## Spec
Vedi sezioni 1-10 sopra.

---
## Implementazione
**Stato:** ✅ COMPLETATO — 2026-05-18
**Commit di riferimento:** `feat(step8): meteo Open-Meteo v2 nel frontend` (hash da assegnare al commit)
**Note:**
- Frontend: aggiunti tipi `WeatherNowV2`, `WeatherForecastV2`, `WeatherDay`, `WeatherTodayV2` in `src/api/types.ts`. Hook `useWeatherNow`/`useWeatherForecast` ora puntano a `/weather/now-v2` e `/weather/forecast-v2` (refetch 60s / 5 min).
- Nuovo helper `src/helpers/wind.ts` con `degToCompass()` (16 direzioni N..NNW). Aggiunto `fmtTime()` in `formatDate.ts` per orari di alba/tramonto.
- `WeatherCard.tsx` riscritto: temperatura grande, percepita sotto, kv con umidità · vento (km/h + bussola) · pioggia ultima ora · pioggia 24h · prob. pioggia · alba/tramonto; strip 7 giorni con icona WMO + min/max + (se presente) prob. pioggia; eyebrow di freschezza in alto a destra (badge `--terra` se `stale: true`).
- Stili in `styles/global.css`: aggiunti `.weather-head`, `.weather-fresh.is-stale`, `.weather-apparent`, `.weather-kv`, `.wind-compass`, `.forecast .day .precip-prob`.
- Service Worker: aggiunti i pattern `/api/weather/now-v2` e `/api/weather/forecast-v2` al runtime caching `NetworkFirst` (timeout 3s). I vecchi pattern restano per backward-compat.
- Node-RED: nuovo tab `f-weather-frontend` con 2 `http in` (`/api/weather/now-v2`, `/api/weather/forecast-v2`) che convergono su un unico nodo function async `wf-fn-handle`. La function gestisce cache `global.weather_frontend_cache` (TTL 5 min, default override via `irrigation_config.weather_frontend_cache_ttl_seconds`), single-flight tramite `weather_fetch_in_flight`, fetch unificata Open-Meteo con `current+daily+hourly`, fallback `stale: true` su ultima cache, 503 a cold start senza cache. Distingue gli endpoint via `msg.req.url.indexOf('forecast') >= 0`.
- `f-weather` (step 4) NON modificato: continua a fare polling 30 min e a scrivere `weather_forecast` su InfluxDB per la logica `rain_delay`. Due cache distinte (`weather_cache` step 4 vs `weather_frontend_cache` step 8) per evitare conflitti di TTL.
- Healthcheck: header aggiornato da "12 controlli" a "13 controlli" + nuovo check `[13] Weather endpoints v2` in `rpi5/scripts/verify_rpi5.sh` (verifica `temperature_c != null` su `/now-v2` e `days|length >= 7` su `/forecast-v2`).
- Verifiche pre-deploy: `npx tsc --noEmit` clean; `npx vite build` OK con PWA SW generato (`sw.js` contiene i pattern `now-v2`/`forecast-v2`); `JSON.parse(flows.json)` valido; `bash -n verify_rpi5.sh` OK.

**Deviazioni dalla spec:**
- Spec §4.1 elencava 9 nodi separati per tab `f-weather-frontend` (http-in × 2, cache-read × 2, http-request, parse, http-response × 2, error-fallback). Implementato con 4 nodi totali (2 http-in, 1 function async, 1 http response): in Node 18+ `fetch()` è disponibile nei function node, quindi cache check + fetch + fallback + format sono concentrati in `wf-fn-handle`. Stesso comportamento esterno, meno superficie di errore, più semplice da manutenere.
- Spec §6.4 mostrava un blocco SW `urlPattern` separato per i pattern v2. Implementato accorpando i pattern v2 nel blocco `NetworkFirst` già esistente per `now`/`valve/state`/`sensors/last`: stesse `options` (cacheName `live-data`, `networkTimeoutSeconds: 3`, TTL 1h), evita duplicazione.
