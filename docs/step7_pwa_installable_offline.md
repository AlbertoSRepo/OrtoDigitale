# Step 7 — PWA installable + offline support

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Architettura PWA](#2-architettura-pwa)
3. [Configurazione `vite-plugin-pwa`](#3-configurazione-vite-plugin-pwa)
4. [Manifest e icone](#4-manifest-e-icone)
5. [Service Worker — strategie di caching](#5-service-worker--strategie-di-caching)
6. [Componente `<OfflineBanner />`](#6-componente-offlinebanner-)
7. [Update flow (nuova versione disponibile)](#7-update-flow-nuova-versione-disponibile)
8. [Procedura installazione su Android](#8-procedura-installazione-su-android)
9. [Lighthouse audit](#9-lighthouse-audit)
10. [Verifica end-to-end](#10-verifica-end-to-end)
11. [Out of scope](#11-out-of-scope)

> Documenti propedeutici: [`step5_backend_api_https.md`](./step5_backend_api_https.md), [`step6_frontend_spa.md`](./step6_frontend_spa.md)

---

## 1. Obiettivo

Trasformare la SPA dello step 6 in **Progressive Web App installabile su Android**, con caching intelligente che permette:
- Apertura istantanea dell'app (asset precaching).
- Funzionamento offline degradato: l'utente vede gli ultimi dati ricevuti anche se il RPi è irraggiungibile, con un banner che lo segnala.
- Esperienza "app-like": icona sull'home, splash screen, full-screen (no chrome browser), theme color coerente.

L'app continua a essere fruibile anche da browser desktop senza installazione — la PWA è un'aggiunta, non un sostituto.

---

## 2. Architettura PWA

```
┌────────────────────────────────────────────────┐
│  Browser Chrome Android                         │
│  ┌──────────────────────────────────────────┐  │
│  │      App Shell (precached)               │  │
│  │  index.html, JS bundles, CSS, fonts,     │  │
│  │  ortophoto.jpg, icons                    │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │      Service Worker                       │  │
│  │  - precache app shell at install          │  │
│  │  - runtime cache /api/* (NetworkFirst)    │  │
│  │  - skipWaiting + clientsClaim             │  │
│  └────────────┬─────────────────────────────┘  │
└───────────────┼────────────────────────────────┘
                │ network o cache
                ▼
        https://orto.local
                │
                ▼
          Caddy → Node-RED
```

---

## 3. Configurazione `vite-plugin-pwa`

`vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',          // user-controlled update
      includeAssets: [
        'ortophoto.jpg',
        'valvola.svg',
        'water_drop.svg',
        'fonts/*.woff2',
      ],
      manifest: { /* vedi §4 */ },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/sensors/last')
              || url.pathname.startsWith('/api/valve/state')
              || url.pathname.startsWith('/api/weather/now')
              || url.pathname.startsWith('/api/system/health'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'live-data',
              networkTimeoutSeconds: 3,
              expiration: { maxAgeSeconds: 60 * 60, maxEntries: 50 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/sensors/trend')
              || url.pathname.startsWith('/api/valve/intervals')
              || url.pathname.startsWith('/api/valve/cumulative')
              || url.pathname.startsWith('/api/weather/forecast'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'historical-data',
              expiration: { maxAgeSeconds: 60 * 60 * 24, maxEntries: 100 },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'images',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
```

**POST endpoint** (`/api/valve/on`, `/api/valve/off`, `/api/system/shutdown`): non gestiti dal SW, vanno sempre in rete. Workbox di default non intercetta POST.

---

## 4. Manifest e icone

Inline nel plugin config:

```typescript
manifest: {
  name: 'Orto Digitale',
  short_name: 'Orto',
  description: 'Controllo irrigazione orto residenziale',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait-primary',
  background_color: '#f4efe6',
  theme_color: '#5b6f47',
  lang: 'it',
  categories: ['utilities', 'productivity'],
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}
```

### Generazione icone

Partire dal logo del prototipo (`orto-digitale-design/project/assets/orto-digitale-title.png`) oppure da una nuova icona dedicata in stile foglia/water drop.

Tool consigliato: `pwa-asset-generator`
```bash
npx pwa-asset-generator logo.png ./public/icons --type png \
    --background "#f4efe6" --opaque false \
    --padding "10%" --maskable true
```

Output richiesto in `public/icons/`:
- `icon-192.png` (192×192, sfondo trasparente o paper color)
- `icon-512.png` (512×512)
- `icon-512-maskable.png` (512×512, contenuto entro safe zone 80%)

---

## 5. Service Worker — strategie di caching

| Risorsa | Strategy | TTL | Motivazione |
|---|---|---|---|
| App shell (HTML/JS/CSS/font) | Precache (build time) | versione bundle | Apertura istantanea |
| `/api/sensors/last`, `/api/valve/state`, `/api/weather/now`, `/api/system/health` | NetworkFirst (3s timeout) → cache | 1h | Dati live: prima rete, fallback cache solo se offline |
| `/api/sensors/trend`, `/api/valve/intervals`, `/api/valve/cumulative`, `/api/weather/forecast` | StaleWhileRevalidate | 24h | Storici cambiano poco, cache buona |
| `ortophoto.jpg`, icone, SVG | CacheFirst | 30g | Statici |
| POST (valve, shutdown) | Network only (default) | — | Mai cachare comandi |

### 5.1 Comportamento offline

- L'utente apre l'app senza rete (es. RPi giù, telefono fuori LAN): l'app shell si carica dalla cache, React Query trova dati cached per `/api/sensors/last` ecc. e li mostra.
- React Query, vedendo lo stale time scaduto, prova a riconvalidare; il SW intercetta, prova rete, timeout 3s, ritorna cache. React Query non lancia errore, la UI continua a mostrare gli ultimi dati noti.
- `<OfflineBanner>` (vedi §6) appare in alto con un avviso "ultimi dati: 5 min fa".

### 5.2 Boot ordering

Service Worker registration in `src/main.tsx`:
```typescript
import { registerSW } from 'virtual:pwa-register';

const updateSW = registerSW({
  onNeedRefresh() { /* show toast "nuova versione disponibile" */ },
  onOfflineReady() { /* show toast "pronto per uso offline" */ },
});
```

---

## 6. Componente `<OfflineBanner />`

`src/components/OfflineBanner/OfflineBanner.tsx`:

```typescript
export function OfflineBanner() {
  const isOnline = useOnlineStatus();    // window.navigator.onLine + listener
  const lastSensorFetch = useLastSensorFetchTime();  // da react-query

  if (isOnline && Date.now() - lastSensorFetch < 30_000) return null;

  return (
    <div className="offline-banner">
      <Icon name="cloud-off" />
      {isOnline
        ? `Connessione lenta — ultimi dati: ${formatRelative(lastSensorFetch)}`
        : `Offline — visualizzazione dati dalla cache (${formatRelative(lastSensorFetch)})`
      }
    </div>
  );
}
```

Hook helpers:
```typescript
function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
```

Banner sticky in alto sopra il `<TabNav>`, colore `--terra` (arancio terra) come warning.

### 6.1 Bottoni valvola in offline

Quando offline, i bottoni `<ValveCard>` mostrano stato disabilitato + tooltip "Comandi non disponibili offline". React Query mutations falliscono comunque, ma meglio prevenire il click.

---

## 7. Update flow (nuova versione disponibile)

Strategia `registerType: 'prompt'`: quando deploy un nuovo build, il SW viene aggiornato in background e l'utente vede un toast non invasivo:

> Nuova versione disponibile  [Aggiorna] [Più tardi]

Click "Aggiorna" → `updateSW(true)` → `skipWaiting` + reload.

Implementazione in `src/components/UpdatePrompt/`:
```typescript
const updateSW = registerSW({
  onNeedRefresh: () => setShowPrompt(true),
});
```

---

## 8. Procedura installazione su Android

Documentare per l'utente finale nel README del progetto e in `docs/step7_pwa_installable_offline.md` stesso.

### Prerequisiti
- Root CA `caddy_root.crt` installata (vedi step 5 §9).
- Telefono nella stessa rete LAN del RPi.

### Procedura
1. Aprire Chrome Android (versione ≥ 90).
2. Andare a `https://192.168.1.12` (o `https://orto.local` se mappato).
3. Verificare lucchetto verde nella barra address. Se non verde → re-installare la CA.
4. Menu `⋮` → "Aggiungi a schermata Home" (oppure pop-up automatico "Installa app").
5. Confermare nome "Orto Digitale" → icona compare nel launcher.
6. Aprire l'app dal launcher: si apre full-screen, senza chrome browser, splash screen con icona + background color del manifest.

### Comportamento atteso
- Prima apertura: app shell precaching in background (qualche secondo).
- Aperture successive: <1s anche offline.
- Aggiornamenti: toast "Nuova versione disponibile" automatico al successivo deploy.

### Disinstallazione
Long-press icona → "Disinstalla" (rimuove app + cache + service worker).

---

## 9. Lighthouse audit

Lanciare Lighthouse audit (Chrome DevTools → Lighthouse → PWA only) sull'URL `https://orto.local` dopo deploy.

**Target:** PWA score ≥ 90.

Criteri principali da soddisfare:
- ✅ Manifest valido con icone 192 e 512
- ✅ Service Worker registrato
- ✅ HTTPS (Caddy)
- ✅ `start_url` raggiungibile offline
- ✅ Theme color + `<meta name="theme-color">` in `index.html`
- ✅ Viewport meta tag
- ✅ Apple touch icon (`<link rel="apple-touch-icon">` in `index.html`)
- ✅ Maskable icon

Eventuali warning su "Does not provide a valid apple-touch-icon" → aggiungere manualmente in `index.html`:
```html
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="theme-color" content="#5b6f47">
```

---

## 10. Verifica end-to-end

### 10.1 Sul PC (Chrome)
- [ ] DevTools → Application → Manifest: tutti i campi popolati, icone caricate
- [ ] DevTools → Application → Service Workers: 1 SW "activated and running"
- [ ] DevTools → Application → Cache Storage: `live-data`, `historical-data`, `images`, `workbox-precache-*` popolate
- [ ] DevTools → Network → Offline checkbox: ricarica pagina, app si apre, banner offline appare
- [ ] DevTools → Lighthouse → PWA score ≥ 90
- [ ] Click icona "installa" nella address bar → app si installa come app desktop (Chrome)

### 10.2 Su Android
- [ ] Chrome mostra pop-up "Aggiungi a schermata Home" entro 30s dalla prima visita
- [ ] Dopo install, icona "Orto" presente nel launcher
- [ ] Aprire app dal launcher: splash screen con icona + background `#f4efe6`, poi app full-screen senza barra Chrome
- [ ] Mettere telefono in airplane mode → riaprire app: si apre, dati cached visibili, banner "Offline"
- [ ] Riconnettere wifi: banner sparisce entro 5s, dati si aggiornano
- [ ] Bottoni valvola in offline: disabilitati con tooltip
- [ ] Deploy nuovo build dal PC: dopo ~30s sul telefono compare toast "Nuova versione disponibile"

### 10.3 Edge case: RPi spento
- [ ] Spegnere RPi (`sudo shutdown -h now`)
- [ ] Aprire app sul telefono: app si apre, dati cached visibili, banner offline persistente
- [ ] Riaccendere RPi, attendere boot containers (~30s): banner sparisce, dati aggiornati

---

## 11. Out of scope

- **Push notification web (VAPID + push-API):** rimandate a futuro step opzionale. Utili per notifiche tipo "valvola aperta" o "batteria sensore bassa", ma richiedono server VAPID e service worker push handler. Decisione: step 7 si ferma a PWA installable + offline.
- **Background sync:** anche questo possibile via SW ma poco utile dato che il polling 5s copre già il caso "app aperta". Background sync (azioni differite quando si torna online) potrebbe servire solo se introducessimo comandi offline-queued — non in roadmap.
- **iOS / Safari install:** Safari supporta "Add to Home Screen" ma con limitazioni (no install prompt, SW più restrittivo). Per ora si testa solo su Android Chrome; iOS funziona "best effort".
- **App store distribution (TWA, PWA Builder):** la PWA su LAN privata non ha senso pubblicarla su Play Store.
- **Auto-updates senza prompt:** scelta esplicita di mostrare prompt per non sorprendere l'utente con reload inattesi.

---
## Implementazione
**Stato:** ✅ COMPLETATO — 2026-05-18
**Commit di riferimento:** `feat(frontend): PWA installable + offline support`
**Note:**
- `vite-plugin-pwa@^1.3` + `workbox-window@^7.4` integrati in `rpi5/frontend/`.
- Service Worker generato in `dist/sw.js` (modalità `generateSW`), 20 entries precachate (~5.5 MiB inclusa ortophoto). `maximumFileSizeToCacheInBytes` portato a 5 MiB per coprire `ortophoto.jpg` (4 MB).
- Manifest inline emette `dist/manifest.webmanifest` con `name`, `short_name`, `start_url=/`, `scope=/`, `display=standalone`, `theme_color=#5b6f47`, `background_color=#f4efe6`, `orientation=portrait-primary`, `lang=it`.
- Runtime caching:
  - `NetworkFirst` (3 s timeout, TTL 1 h) per `/api/sensors/last`, `/api/valve/state`, `/api/weather/now`, `/api/system/health`.
  - `StaleWhileRevalidate` (TTL 24 h) per `/api/sensors/trend`, `/api/valve/intervals`, `/api/valve/cumulative`, `/api/weather/forecast`.
  - `CacheFirst` (TTL 30 g) per immagini.
  - `StaleWhileRevalidate` aggiunto anche per Google Fonts (`fonts.googleapis.com` + `fonts.gstatic.com`), così l'app shell carica con font corretti anche offline.
- Icone PWA generate via `scripts/generate-icons.mjs` (sharp + rsvg) a partire da un SVG inline (foglia moss `#5b6f47` + goccia terra `#a05e44` su sfondo paper `#f4efe6`). Output in `public/icons/`: `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` (safe zone ~78%). Comando: `npm run icons`.
- `index.html` esteso con `<meta name="theme-color">`, `<link rel="apple-touch-icon">`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`.
- Componenti React aggiunti:
  - `src/components/UpdatePrompt.tsx` — usa `useRegisterSW` (registerType `prompt`): mostra toast "Nuova versione disponibile" + bottoni `Aggiorna` / `Più tardi`; gestisce anche `onOfflineReady`.
  - `src/components/OfflineBanner.tsx` — combina `useOnlineStatus` (navigator.onLine + listener) e `dataUpdatedAt` della query `['sensors','last']` per mostrare banner sticky con etichetta relativa (es. "ultimi dati 2m fa"). Soglia stale: 30 s.
  - `src/helpers/useOnlineStatus.ts` — hook con event listeners `online`/`offline`.
  - `src/components/ValveCard.tsx` — bottoni "apri/chiudi" e durate disabilitati quando `!isOnline`, tooltip "Comandi non disponibili offline".
- Stili: blocchi `.offline-banner` e `.pwa-toast` aggiunti in fondo a `src/styles/global.css`, palette `--terra` per il banner, paper/ink per il toast, responsive su < 700 px.
- Type references PWA in nuovo `src/vite-env.d.ts` (`virtual:pwa-register/react`).
- Caddy non richiede modifiche: serve già il contenuto di `/srv` (mount `/opt/orto-digitale/frontend/dist/`) con MIME corretto per `manifest.webmanifest` e `sw.js` (verificato con curl: 200, `application/manifest+json` / `text/javascript`).
- Deploy verificato: `scp -r dist/* as@192.168.1.12:/opt/orto-digitale/frontend/dist/`; healthcheck `verify_rpi5.sh` verde post-deploy (12/12 check ok).

**Deviazioni dalla spec:**
- Service Worker registrato da `UpdatePrompt` (via `useRegisterSW`) anziché direttamente in `src/main.tsx`. Risultato equivalente — il componente è sempre montato in `App.tsx` — ma mantiene la logica vicina al toast che la consuma.
- Aggiunta una runtime caching extra per Google Fonts (non in spec): senza, l'app shell offline perde i font. Cache `StaleWhileRevalidate` con TTL 1 anno.
- `maximumFileSizeToCacheInBytes` portato a 5 MiB (default Workbox è 2 MiB) per consentire la precache di `ortophoto.jpg` (4 MB). In alternativa avremmo dovuto comprimerla o spostarla su runtime cache.
- Icone disegnate inline via SVG + sharp anziché `pwa-asset-generator` (che richiede Chromium e download di ~150 MB). Risultato equivalente sulla forma richiesta (192/512/512-maskable), riproducibile con `npm run icons`.
