# Step 6 — Frontend SPA (browser-only)

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Stack tecnologico](#2-stack-tecnologico)
3. [Struttura repo `rpi5/frontend/`](#3-struttura-repo-rpi5frontend)
4. [Design tokens e theming](#4-design-tokens-e-theming)
5. [Routing e layout](#5-routing-e-layout)
6. [Stato globale (zustand)](#6-stato-globale-zustand)
7. [API client e React Query](#7-api-client-e-react-query)
8. [Pagina Orto](#8-pagina-orto)
9. [Pagina Waterflow](#9-pagina-waterflow)
10. [Pagina Settings](#10-pagina-settings)
11. [Build e deploy via Caddy](#11-build-e-deploy-via-caddy)
12. [Verifica end-to-end](#12-verifica-end-to-end)
13. [Out of scope (rimandato a step 7)](#13-out-of-scope-rimandato-a-step-7)

> Documenti propedeutici: [`step5_backend_api_https.md`](./step5_backend_api_https.md), [`frontend_dati_spec.md`](./frontend_dati_spec.md)
> Riferimenti design: `orto-digitale-design/project/` (prototipo HTML/JSX)

---

## 1. Obiettivo

Riscrivere il prototipo `orto-digitale-design/project/` come app web production-grade, consumando gli endpoint definiti in step 5. Niente features PWA in questo step (manifest, SW, install — rimandate a step 7). Risultato: app accessibile da qualsiasi browser (PC, Android, iOS) all'URL `https://orto.local` con i dati reali del RPi.

**Vincolo:** rispettare la spec dati `docs/frontend_dati_spec.md` e replicare visivamente il prototipo (design tokens, layout, palette earth-tone).

---

## 2. Stack tecnologico

| Categoria | Scelta | Versione target | Motivazione |
|---|---|---|---|
| Build / dev server | Vite | ^5.4 | Build veloce, HMR, output statico ottimale |
| Framework | React | ^18.3 | Standard, ecosistema Recharts |
| Linguaggio | TypeScript | ^5.5 | Type-safety su tipi InfluxDB/MQTT |
| Charting | Recharts | ^2.13 | Step chart nativo, tooltip hover, React-friendly |
| Date picker | react-day-picker | ^9.1 | Range nativo, accessibile, ~30 KB |
| Fetching/cache | @tanstack/react-query | ^5.59 | Polling, cache, revalidate built-in |
| State globale | zustand | ^4.5 | Theme, range temporali, tab attiva |
| Date utilities | date-fns | ^4.1 | Format/parse leggero |
| Routing | Nessuno (tab interne) | — | App a 3 sezioni, no URL routing |

Dipendenze totali: ~270 KB gzipped build esteso. Niente Tailwind, niente MUI.

---

## 3. Struttura repo `rpi5/frontend/`

```
rpi5/frontend/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/
│   │   ├── client.ts            (axios o fetch wrapper, baseURL = '/api')
│   │   ├── sensors.ts           (getSensorsLast, getSensorTrend)
│   │   ├── valve.ts             (getValveState, openValve, closeValve, getIntervals, getCumulative)
│   │   ├── weather.ts           (getWeatherNow, getWeatherForecast)
│   │   └── system.ts            (shutdown, health)
│   ├── components/
│   │   ├── TabNav/
│   │   ├── ThemeToggle/
│   │   ├── DateRangePicker/     (wrapper react-day-picker + preset 24h/7d/30d/custom)
│   │   ├── Heatmap/             (SVG sopra <img ortophoto>)
│   │   ├── HumidityChart/       (Recharts LineChart multi-serie)
│   │   ├── SensorList/          (card per sensore con battery/rssi/online)
│   │   ├── WeatherCard/         (now + 7d forecast)
│   │   ├── ValveCard/           (stato + countdown + 4 bottoni durata + close)
│   │   ├── ValveStepChart/      (Recharts step line, colori auto/manual)
│   │   ├── ValveCumulative/     (badge con somma 7g/range)
│   │   └── ConfirmModal/        (per shutdown)
│   ├── pages/
│   │   ├── Orto.tsx
│   │   ├── Waterflow.tsx
│   │   └── Settings.tsx
│   ├── state/
│   │   └── store.ts             (zustand: theme, activeTab, periodOrto, periodValve)
│   ├── config/
│   │   └── sensors.ts           (coordinate x,y normalizzate 0-1 dei 6 sensori)
│   ├── helpers/
│   │   ├── humidityColor.ts     (porting da prototype helpers.jsx)
│   │   ├── formatDate.ts
│   │   └── formatDuration.ts    ("5m 23s", "1h 12m")
│   └── styles/
│       ├── tokens.css           (CSS variables copiate dal prototipo)
│       └── global.css           (reset, layout grid, tipografia)
├── public/
│   ├── ortophoto.jpg            (copiato da orto-digitale-design/project/assets/)
│   ├── valvola.svg
│   └── water_drop.svg
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

## 4. Design tokens e theming

Copiare i token CSS dal prototipo (`orto-digitale-design/project/styles.css`) in `src/styles/tokens.css`. Mantenere identici:

```css
:root[data-theme="light"] {
  --paper: #f4efe6;
  --paper-2: #ede7da;
  --ink: #000;
  --ink-2: #2a261f;
  --ink-3: #4d473b;
  --ink-4: #877f6c;
  --rule: #2a261f;
  --rule-2: #c8c0ad;
  --moss: #5b6f47;
  --leaf: #6f8b51;
  --terra: #b8642b;
  --water: #2d6b8a;
  --sky: #5e8aa8;
  --hm-dry: #c54a3e;
  --hm-mid: #6f8b51;
  --hm-wet: #2d6b8a;
}
:root[data-theme="dark"] {
  /* ... copiare dal prototipo ... */
}
```

Toggle theme via `zustand` → applica `document.documentElement.dataset.theme = "light" | "dark"`.

Font dal prototipo via Google Fonts (DM Serif Display, Be Vietnam Pro, JetBrains Mono).

---

## 5. Routing e layout

Niente router (es. react-router): la `activeTab` in zustand controlla quale pagina renderizzare in `App.tsx`:

```tsx
function App() {
  const { activeTab } = useStore();
  return (
    <>
      <Topbar />
      <TabNav />
      <main className="grid-12">
        {activeTab === 'orto' && <Orto />}
        {activeTab === 'waterflow' && <Waterflow />}
        {activeTab === 'settings' && <Settings />}
      </main>
    </>
  );
}
```

Layout grid 12 colonne max-width 1200px (come prototipo).

---

## 6. Stato globale (zustand)

`src/state/store.ts`:

```typescript
type Period = '24h' | '7d' | '30d' | { start: Date; end: Date };

interface AppState {
  theme: 'light' | 'dark';
  activeTab: 'orto' | 'waterflow' | 'settings';
  periodOrto: Period;     // selettore date umidità (§1.4 spec)
  periodValve: Period;    // selettore date valvola (§2.3 spec) — indipendente
  setTheme: (t: 'light' | 'dark') => void;
  setActiveTab: (t: AppState['activeTab']) => void;
  setPeriodOrto: (p: Period) => void;
  setPeriodValve: (p: Period) => void;
}
```

Persist solo `theme` su `localStorage`. Le tab e i range temporali tornano ai default ad ogni reload.

---

## 7. API client e React Query

### 7.1 Client

`src/api/client.ts`:
```typescript
const BASE_URL = '/api';

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(BASE_URL + path, window.location.origin);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> { /* ... */ }
```

### 7.2 React Query setup

`src/main.tsx`:
```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});
```

### 7.3 Hook per ogni risorsa

Esempi:
```typescript
export function useSensorsLast() {
  return useQuery({
    queryKey: ['sensors', 'last'],
    queryFn: () => apiGet<SensorLast[]>('/sensors/last'),
    refetchInterval: 5000,
  });
}

export function useValveState() {
  return useQuery({
    queryKey: ['valve', 'state'],
    queryFn: () => apiGet<ValveState>('/valve/state'),
    refetchInterval: 2000,  // più rapido per countdown live
  });
}

export function useSensorTrend(sensorId: string, period: Period) {
  return useQuery({
    queryKey: ['sensors', 'trend', sensorId, period],
    queryFn: () => apiGet<TrendData>('/sensors/trend', periodToParams(period, { sensor_id: sensorId })),
  });
}
```

Mutations per comandi:
```typescript
export function useOpenValve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (duration_seconds?: number) => apiPost('/valve/on', { duration_seconds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['valve'] }),
  });
}
```

---

## 8. Pagina Orto

### 8.1 Layout
```
┌─────────────────────────────────────────────────────────────┐
│  [Hero ortofoto + heatmap sensori]            span-12       │
├──────────────────────────────────┬──────────────────────────┤
│  [HumidityChart + DatePicker]    │  [SensorList]            │
│            span-7                │         span-5            │
├──────────────────────────────────┴──────────────────────────┤
│  [WeatherCard now + 7d forecast]              span-12       │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Componenti

**`<Heatmap />`** (`src/components/Heatmap/`)
- `<img src="/ortophoto.jpg" />` come background
- `<svg>` overlay con 6 `<circle>` (uno per sensore) a coordinate `config/sensors.ts`
- Colore cerchio = `humidityColor(value, thresholds, theme)` (porting da prototipo)
- Hover → tooltip flottante con valori da §1.1 della spec: `sensor_id`, `aiuola`, `position`, `value`, `battery_ok`, `rssi`, `online`, `timestamp`
- Optional: blob heatmap interpolata (riusa algoritmo del prototipo se rapido)

**`<HumidityChart />`** (`src/components/HumidityChart/`)
- `Recharts LineChart` con 6 serie (una per sensore), colori distinti
- Asse X: time, asse Y: 0-100 (%)
- Tooltip Recharts custom: mostra valore puntuale per ogni sensore al hover
- Comfort band 40-65% in grigio chiaro (`<ReferenceArea>`)
- `<DateRangePicker>` sopra il chart con preset 24h/7d/30d + custom

**`<SensorList />`** (`src/components/SensorList/`)
- Cards per sensore con: valore % grande, battery icon, RSSI bar, badge online/offline
- Stile come prototipo `panels.jsx → SensorList`

**`<WeatherCard />`** (`src/components/WeatherCard/`)
- Riga top: temperatura corrente grande, icona meteo
- Sotto: forecast 7 giorni come strip orizzontale o mini Recharts area chart con t_min/t_max
- Date fisse (non selezionabili) — spec §3.1

### 8.3 Coordinate sensori (`src/config/sensors.ts`)

Riusare le coordinate dal prototipo `data.js` (normalizzate 0-1):
```typescript
export const SENSOR_COORDS = {
  WH51_01: { x: 0.21, y: 0.35 },
  WH51_02: { x: 0.28, y: 0.78 },
  // ...
};
```

Visualizzare solo i sensori realmente attivi (WH51_01-04). Per WH51_05-06 mostrare cerchio grigio con tooltip "non installato".

---

## 9. Pagina Waterflow

### 9.1 Layout
```
┌─────────────────────────────────────────────────────────────┐
│  [ValveCard - stato corrente]                 span-12       │
├─────────────────────────────────────────────────────────────┤
│  [ValveStepChart + DatePicker]                span-12       │
├──────────────────────────────────┬──────────────────────────┤
│  [ValveCumulative]               │  [EventsList ultimi 5]   │
│            span-5                │           span-7         │
└──────────────────────────────────┴──────────────────────────┘
```

### 9.2 `<ValveCard />`

Sezioni:
- **Stato corrente:** badge grande "APERTA" verde o "CHIUSA" rosso. Indicatori `reachable` (icona wifi) e `linkquality` (barre).
- **Se aperta:**
  - "Aperta da: 5m 32s" (formattato da `open_since_seconds`)
  - "Spegnimento tra: 9m 28s" (formattato da `auto_close_in_seconds`)
  - Progress bar che riempie da 0 a `requested_duration`
- **Controlli manuali:**
  - 4 bottoni SVG identici al prototipo (water_drop.svg) per durata: `5m`, `15m`, `30m`, `1h` → chiamano `openValve(seconds)`
  - 1 bottone "Chiudi" (rosso) → `closeValve()`
  - Bottoni disabilitati con spinner durante la mutation
- **Toast/feedback** su risposta API

### 9.3 `<ValveStepChart />`

- Recharts `LineChart` con `type="step"` (step-after)
- Serie 1: `state=1/0` da `irrigation_events` (line a gradini)
- Colore differenziato per `trigger`:
  - Auto → moss/verde
  - Manual → terra/marrone
- Quando un'apertura manuale interrompe un'automatica, il chart mostra il cambio colore alla transizione (come da specifica utente)
- DateRangePicker sopra (preset 24h/7d/30d + custom)
- Tooltip mostra `start`, `duration_seconds`, `trigger` dell'intervallo

### 9.4 `<ValveCumulative />`

Card semplice: "Totale apertura nel periodo: **2h 45m 12s**" + breakdown auto/manual se utile. Range vincolato a quello di `ValveStepChart` (spec §2.4).

### 9.5 `<EventsList />`

Tabella con ultimi 5 intervalli ordinati per data desc: timestamp, durata, trigger (badge colorato).

---

## 10. Pagina Settings

### 10.1 Sezioni

- **Tema:** toggle light/dark
- **Diagnostica:** versione app (da `package.json`), versione Node-RED (da `/api/system/health`), uptime, badge stato componenti (Influx, MQTT, Z2M)
- **Spegnimento sistema:** bottone rosso "Spegni Raspberry Pi" con duplice conferma:
  1. Click → apre `<ConfirmModal>` con avviso "Il sistema si spegnerà tra 1 minuto. Sarà necessario alimentazione fisica per riavviare."
  2. Nel modal: input testuale richiesto, l'utente deve digitare `SHUTDOWN` (case-sensitive) per abilitare il bottone "Conferma"
  3. Click "Conferma" → `POST /api/system/shutdown { confirm: "shutdown" }`
  4. Toast: "Spegnimento programmato. Disconnetto in 60s."

### 10.2 No editing config irrigazione

Out of scope: l'editing di soglie/finestre/cooldown resta via MQTT (vedi step 4). Si mostra solo readonly la config attuale (da `/api/config`).

---

## 11. Build e deploy via Caddy

### 11.1 Sul PC (Windows)

```powershell
cd C:\Users\user\Desktop\OrtoDigitale\dev\rpi5\frontend
npm install
npm run build      # output in dist/
```

Verifica locale:
```powershell
npm run preview    # serve dist/ su http://localhost:4173
```

### 11.2 Deploy sul RPi

```powershell
scp -r dist as@192.168.1.12:/opt/orto-digitale/frontend/dist
ssh as@192.168.1.12 'docker compose -f /opt/orto-digitale/docker-compose.yml restart caddy'
```

Caddy serve `dist/` come `file_server` (vedi Caddyfile in step 5). Niente container Node aggiuntivo per il FE: è un sito statico.

### 11.3 Script `deploy_frontend.sh` (opzionale)

In `rpi5/scripts/deploy_frontend.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../frontend"
npm run build
rsync -avz --delete dist/ as@192.168.1.12:/opt/orto-digitale/frontend/dist/
ssh as@192.168.1.12 'docker compose -f /opt/orto-digitale/docker-compose.yml restart caddy'
```

---

## 12. Verifica end-to-end

Da browser desktop su `https://orto.local`:
- [ ] Pagina Orto carica: heatmap con 6 sensori (4 attivi colorati, 2 grigi), hover mostra tooltip
- [ ] HumidityChart mostra 6 linee colorate, tooltip su hover puntuale
- [ ] DateRangePicker: cambia range → chart si ricarica con loading state
- [ ] SensorList mostra 6 card con valori attuali
- [ ] WeatherCard mostra temperatura corrente + 7 giorni forecast
- [ ] Pagina Waterflow: ValveCard mostra stato (CHIUSA inizialmente)
- [ ] Click "5m" → valvola apre, countdown "Aperta da: 0:05" parte, "Spegnimento tra: 4:55" decresce
- [ ] Dopo 5 min valvola si chiude automaticamente (oppure click "Chiudi")
- [ ] ValveStepChart mostra l'apertura manuale appena fatta, colore terra/marrone
- [ ] Cambio range → cumulativo si aggiorna
- [ ] Pagina Settings: toggle theme funziona
- [ ] Click "Spegni" → modal, digita SHUTDOWN, conferma → API risponde 200, toast appare
- [ ] Annullare shutdown via SSH: `ssh as@192.168.1.12 'sudo shutdown -c'`

Da browser mobile (Android Chrome) su `https://orto.local`:
- [ ] Layout responsive (verifica su 360px width)
- [ ] Touch hover sui sensori funziona (tap apre tooltip, tap fuori chiude)
- [ ] Bottoni durata valvola hanno hit-area ≥ 44px

---

## 13. Out of scope (rimandato a step 7)

- `manifest.webmanifest` e icone PWA
- Service Worker e caching offline
- Banner offline
- Install prompt "Aggiungi a schermata Home"
- Lighthouse PWA audit

---
## Implementazione
**Stato:** ✅ COMPLETATO — 2026-05-15
**Branch:** `step/6-frontend-spa`
**Healthcheck:** 11/11 verde (`bash /opt/orto-digitale/scripts/verify_rpi5.sh`)

### Cosa è stato fatto

- Scaffold `rpi5/frontend/` con Vite 5 + React 18 + TypeScript strict.
- API client tipizzato (`src/api/`) con fetch wrapper + 4 moduli (sensors / valve / weather / system) e hooks React Query con polling differenziato (sensori 5s, valve state 2s per countdown live, health 10s, weather now 60s, weather forecast 30 min).
- Tipi TS allineati 1:1 al payload reale di Node-RED (estratto da `rpi5/nodered/data/flows.json` per evitare deviazioni).
- Store globale `zustand` con `theme` (persistito su localStorage), `activeTab`, `periodOrto`, `periodValve` indipendenti.
- Design tokens earth-tone copiati dal prototipo `orto-digitale-design/project/styles.css`; CSS globale ~1500 righe portato as-is (light + dark + responsive 700/900/1100/1280px).
- Componenti core: `TabNav`, `ThemeToggle`, `Topbar`, `DateRangePicker` (preset 24h/7d/30d + range custom con click-outside / ESC).
- Pagina **Orto**: `Hero` (ortofoto + 6 pin SVG con halo/blob heatmap, tooltip su hover con metadati sensore + indicazione "non installato" per WH51_05/06), `HumidityChart` (Recharts LineChart con 6 serie colorate, comfort band 40–65 % via `ReferenceArea`, tooltip dark), `SensorList`, `WeatherCard` (temperatura corrente + 7 giorni con WMO weather-code → emoji).
- Pagina **Waterflow**: `ValveCard` (stato grande, countdown `aperta da` / `spegnimento tra`, 4 bottoni durata 5/15/30/60 m + bottone chiudi con feedback toast inline, chip `reachable` + `linkquality`), `ValveStepChart` (SVG custom con segmenti `auto` / `manuale` / `chiuso`, tooltip al hover con start/fine/durata), `EventsList` (ultimi 5 intervalli), card cumulativo separata.
- Pagina **Settings**: toggle tema, badge diagnostica (uptime, mode, valve, sensori online), bottone shutdown con `ShutdownModal` che richiede digitazione `SHUTDOWN` (case-sensitive) per abilitare la conferma; bottone "annulla shutdown" appare dopo richiesta riuscita e chiama `POST /api/system/shutdown/cancel`.
- Build production: 176 KB gzip totali (CSS 6 KB + JS 176 KB) — sotto la stima di spec (270 KB).
- Script `rpi5/scripts/deploy_frontend.sh`: build + rsync (fallback scp) + reload Caddy. Variabile `RPI_HOST` overridable per WiFi fallback (`as@192.168.1.46`).

### Verifiche eseguite

- `npm run build` → typecheck strict pulito.
- Deploy su `/opt/orto-digitale/frontend/dist` (Caddy `:/srv:ro`).
- Smoke test HTTPS via `curl --resolve orto.local:443:127.0.0.1`:
  - `/` → 200, 873 B (`index.html`)
  - `/assets/index-*.js` → 200, 609 KB
  - `/assets/index-*.css` → 200, 28 KB
  - `/ortophoto.jpg` → 200, 4 MB
  - `/api/sensors/last` → 200, 6 sensori
  - `/api/sensors/trend?start=-24h` → 200, 33 KB serie
  - `/api/valve/state` → 200
  - `/api/valve/intervals?start=-7d` → 200
  - `/api/weather/now` → 200
  - `/api/weather/forecast` → 200, 7 giorni
  - `/api/system/health` → 200
- Healthcheck 11/11 verde.
- **Test browser visivo da PC** (umidità live, hover sensori, switch tab, theme toggle, date picker custom, controllo valvola): **da eseguire dall'utente** sull'URL `https://orto.local` (richiede CA Caddy installata sul PC, già fatto in step 5).

### Deviazioni dalla spec

1. **Niente cartelle separate per ogni componente** (`Heatmap/`, `HumidityChart/`, ecc.). I componenti vivono come singoli file `.tsx` in `src/components/`. Riduce boilerplate e import friction; ogni componente è ~150 righe e auto-contenuto.
2. **`<Heatmap />` rinominato `<Hero />`** per coerenza col prototipo che usa lo stesso nome (l'ortofoto + heatmap è già il "hero" della pagina).
3. **`Period` in zustand è discriminated union (`'24h' | '7d' | '30d' | { start, end }`) invece di stringa serializzata `custom:<a>:<b>`.** TypeScript-friendly, niente parse manuale.
4. **`weather_code` → emoji mappato lato client** (non lato Node-RED come suggerito in §3.3), perché Node-RED già ritorna il codice WMO grezzo e la mappatura è UI-concern. Tabella standard WMO compatta (~15 ranges).
5. **`ValveStepChart` è SVG custom (non Recharts step line).** Le serie a gradino di Recharts non rendono bene il pattern "intervallo discreto con colore variabile per `trigger`": la SVG custom (portata dal prototipo) gestisce direttamente segmenti `auto` / `manuale` / `chiuso` con tooltip integrato.
6. **`<ConfirmModal>` è un overlay full-screen** (non un popover ancorato al bottone come nel prototipo): pattern più rigoroso per un'azione distruttiva (shutdown), focus trap implicito sul campo testo.
7. **Bottone "annulla shutdown" mostrato dopo successo del POST** (non in spec): sfrutta l'endpoint `POST /api/system/shutdown/cancel` aggiunto in step 5 per cancellare il countdown senza SSH (impossibile a `pam_nologin` lockato).
8. **Toast inline nel ValveCard invece che globale** per il feedback delle mutation (apri/chiudi). Meno layout overhead, vicino all'azione.
9. **`HealthBadges` invece di lista verbosa**: aggrega uptime/mode/valve/sensori in 4 righe mono compatte allineate a destra. Nessun call separato a `nodered_version` (deviazione step 5 §4: `process.env` non disponibile in function node).

### Nuovi artefatti

- `rpi5/frontend/` — sorgenti SPA (~30 file, zero `node_modules` committate)
- `rpi5/scripts/deploy_frontend.sh` — build + rsync + reload Caddy
- `/opt/orto-digitale/frontend/dist/` sul RPi — bundle servito da Caddy come `/srv`
