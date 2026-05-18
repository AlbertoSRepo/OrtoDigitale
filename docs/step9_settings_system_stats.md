# Step 9 — Settings: statistiche di sistema RPi5

## Indice
1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza](#2-stato-di-partenza)
3. [Architettura](#3-architettura)
4. [Raccolta dati sull'host](#4-raccolta-dati-sullhost)
5. [Endpoint API — contratto](#5-endpoint-api--contratto)
6. [Frontend — sezione System nella pagina Settings](#6-frontend--sezione-system-nella-pagina-settings)
7. [Soglie di colore](#7-soglie-di-colore)
8. [Aggiornamento `verify_rpi5.sh`](#8-aggiornamento-verify_rpi5sh)
9. [Verifica end-to-end](#9-verifica-end-to-end)
10. [Out of scope](#10-out-of-scope)

> Documenti propedeutici: [`step5_backend_api_https.md`](./step5_backend_api_https.md), [`step6_frontend_spa.md`](./step6_frontend_spa.md)

---

## 1. Obiettivo

Aggiungere alla pagina **Settings** della PWA una sezione "Sistema" che mostra in tempo reale:

- **Spazio libero su disco** (root `/`) — con barra colorata: verde / giallo / rosso in funzione del riempimento.
- **Utilizzo CPU** — percentuale corrente, barra colorata.
- **Utilizzo RAM** — percentuale corrente, barra colorata, dettaglio totale / used / free.

I valori sono freschi (≤ 15s) e riflettono lo stato reale dell'host RPi5, non del container Node-RED.

### Perché serve

- L'utente deve poter capire da remoto se il RPi sta per riempire il disco (logs InfluxDB / Grafana / Node-RED tendono a crescere) **prima** che i container crashino.
- CPU / RAM costanti sopra soglia indicano sovraccarico — utile diagnostica prima di chiamare `verify_rpi5.sh`.
- Si integra con la sezione "Diagnostica" già presente (uptime, valvola, sensori online).

---

## 2. Stato di partenza

| Componente | Stato |
|---|---|
| `Settings.tsx` | Esiste con sezioni: Tema, Diagnostica (uptime/mode/valve/sensors), Spegnimento RPi |
| `useSystemHealth()` (`api/system.ts`) | Esiste, polla `/api/system/health` ogni N secondi |
| `/api/system/health` | Esiste, ritorna `{ uptime_seconds, mode, valve_state, valve_reachable, sensors_online, sensors_total, ... }` |
| Endpoint disk/CPU/RAM | **non esiste** |
| Raccolta stat host | **non implementata** |

---

## 3. Architettura

Il problema: Node-RED gira in container, quindi `/proc/meminfo` e `/proc/stat` letti dal container riflettono il container, non l'host. Anche `df` vede solo i mount del container.

### Pattern adottato: file-flag watcher (coerente con shutdown)

Già usato in step 5 per lo shutdown: uno script sull'host raccoglie i dati periodicamente e scrive un JSON in un percorso bind-mounted accessibile al container Node-RED.

```
┌──────────────────────────────────────────────────────────┐
│  Host RPi5                                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │  /usr/local/bin/orto-system-stats.sh            │    │
│  │  - df -B1 /                                     │    │
│  │  - cat /proc/meminfo                            │    │
│  │  - cat /proc/stat (delta su due sample)         │    │
│  │  - cat /proc/loadavg                            │    │
│  │  → scrive /opt/orto-digitale/system_stats.json  │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ ogni 10s                         │
│  ┌────────────────────▼────────────────────────────┐    │
│  │  systemd timer: orto-system-stats.timer         │    │
│  │  unit:           orto-system-stats.service      │    │
│  └─────────────────────────────────────────────────┘    │
└──────────────────┬───────────────────────────────────────┘
                   │ bind mount RO
                   ▼
┌──────────────────────────────────────────────────────────┐
│  Container nodered                                       │
│  /data/system_stats.json (RO)                            │
│   ↓                                                       │
│  flow f-system: legge il file, espone /api/system/stats  │
└──────────────────────────────────────────────────────────┘
```

### Alternative scartate

| Approccio | Verdetto |
|---|---|
| Mount `/proc` e `/sys` del host nel container | Rischio sicurezza (anche RO espone informazioni inutilmente), bind mount fragile su `proc` non sempre coerente |
| Container con privileged: true | Eccessivo per leggere df + meminfo |
| Esporre Prometheus node_exporter | Aggiunge un servizio per niente, sproporzionato per orto residenziale |
| SSH dal container con chiave dedicata | Già rifiutato in step 5 (shutdown) per stesso motivo: complica setup |
| Polling diretto da Node-RED con `exec` | `exec` vede il filesystem del container, non dell'host — soluzione errata |

Il file-flag watcher riusa il pattern già operativo (`orto-shutdown-watcher`) e non aggiunge superficie di sicurezza.

---

## 4. Raccolta dati sull'host

### 4.1 Script `orto-system-stats.sh`

Path host: `/opt/orto-digitale/scripts/system_stats.sh`
Permessi: `755`, owner `as:as`

Contenuto (bash):

```bash
#!/bin/bash
set -euo pipefail

OUT="/opt/orto-digitale/system_stats.json"
TMP="${OUT}.tmp"

# --- DISCO (root filesystem) ---
df_line=$(df -B1 --output=size,used,avail / | tail -n1)
disk_total=$(echo "$df_line" | awk '{print $1}')
disk_used=$(echo  "$df_line" | awk '{print $2}')
disk_avail=$(echo "$df_line" | awk '{print $3}')
disk_used_pct=$(awk -v u="$disk_used" -v t="$disk_total" 'BEGIN{printf "%.1f", (u/t)*100}')

# --- RAM (da /proc/meminfo) ---
mem_total_kb=$(awk '/^MemTotal:/     {print $2}' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
mem_used_kb=$((mem_total_kb - mem_avail_kb))
mem_used_pct=$(awk -v u="$mem_used_kb" -v t="$mem_total_kb" 'BEGIN{printf "%.1f", (u/t)*100}')

# --- CPU (delta tra due snapshot di /proc/stat a 1s di distanza) ---
read_cpu() {
  awk '/^cpu / {idle=$5+$6; total=$2+$3+$4+$5+$6+$7+$8; print idle, total}' /proc/stat
}
read s1_idle s1_total <<< "$(read_cpu)"
sleep 1
read s2_idle s2_total <<< "$(read_cpu)"
delta_idle=$((s2_idle  - s1_idle))
delta_total=$((s2_total - s1_total))
cpu_used_pct=$(awk -v di="$delta_idle" -v dt="$delta_total" \
  'BEGIN{if(dt==0) print 0; else printf "%.1f", (1 - di/dt)*100}')

# --- Load average + temperatura ---
loadavg=$(awk '{printf "%.2f, %.2f, %.2f", $1, $2, $3}' /proc/loadavg)
temp_c="null"
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  temp_raw=$(cat /sys/class/thermal/thermal_zone0/temp)
  temp_c=$(awk -v t="$temp_raw" 'BEGIN{printf "%.1f", t/1000}')
fi

# --- Output JSON atomico ---
cat > "$TMP" <<EOF
{
  "generated_at": "$(date -Iseconds)",
  "disk": {
    "total_bytes": $disk_total,
    "used_bytes": $disk_used,
    "free_bytes": $disk_avail,
    "used_pct": $disk_used_pct
  },
  "ram": {
    "total_bytes": $((mem_total_kb * 1024)),
    "used_bytes":  $((mem_used_kb  * 1024)),
    "free_bytes":  $((mem_avail_kb * 1024)),
    "used_pct": $mem_used_pct
  },
  "cpu": {
    "used_pct": $cpu_used_pct,
    "load_avg_1_5_15": [$loadavg]
  },
  "thermal": {
    "soc_temp_c": $temp_c
  }
}
EOF

mv -f "$TMP" "$OUT"
chmod 644 "$OUT"
```

### 4.2 systemd unit

`/etc/systemd/system/orto-system-stats.service`:

```ini
[Unit]
Description=Orto Digitale — raccolta stat host
After=multi-user.target

[Service]
Type=oneshot
User=as
ExecStart=/opt/orto-digitale/scripts/system_stats.sh
```

`/etc/systemd/system/orto-system-stats.timer`:

```ini
[Unit]
Description=Trigger raccolta stat sistema ogni 10s

[Timer]
OnBootSec=15s
OnUnitActiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
```

Setup:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orto-system-stats.timer
systemctl list-timers | grep orto-system-stats
```

### 4.3 Bind mount nel container Node-RED

Modifica `rpi5/docker-compose.yml`:

```yaml
  nodered:
    # ... resto invariato ...
    volumes:
      - ./nodered/data:/data
      - /opt/orto-digitale/system_stats.json:/data/system/system_stats.json:ro
```

> **Caveat:** bind mount di **file** (non directory) richiede che il file esista già al primo `docker compose up`. Eseguire `system_stats.sh` manualmente una volta prima del restart del container.

> **Alternativa più sicura:** bind mount di una **directory** `/opt/orto-digitale/system-out/` → `/data/system/` (RO). Più robusto, l'inode non viene perso se lo script ricrea il file. Preferire questa via.

Forma raccomandata:
```yaml
      - ./system-out:/data/system:ro
```
e in `system_stats.sh` cambiare `OUT="/opt/orto-digitale/system-out/stats.json"`.

---

## 5. Endpoint API — contratto

### 5.1 `GET /api/system/stats`

Risposta:
```json
{
  "generated_at": "2026-05-18T14:30:00+02:00",
  "age_seconds": 4,
  "disk": {
    "total_bytes": 31265517568,
    "used_bytes":  12086374400,
    "free_bytes":  17612345600,
    "used_pct": 38.7
  },
  "ram": {
    "total_bytes": 8589934592,
    "used_bytes":  3221225472,
    "free_bytes":  5368709120,
    "used_pct": 37.5
  },
  "cpu": {
    "used_pct": 12.4,
    "load_avg_1_5_15": [0.42, 0.31, 0.28]
  },
  "thermal": {
    "soc_temp_c": 48.3
  }
}
```

- `age_seconds`: calcolato come `now - generated_at`. Se > 30s → il watcher non sta scrivendo (timer fermo o crash dello script).
- `cpu.used_pct`: media 1s al momento dell'ultimo sample.
- `thermal.soc_temp_c`: opzionale, `null` se non disponibile.

### 5.2 Errori

| Caso | Status | Body |
|---|---|---|
| File JSON esiste e parse ok | 200 | dato vero |
| File esiste ma `age_seconds > 60` | 200 | dato con flag esterno `"stale": true` (il FE decide come trattare) |
| File non esiste o JSON malformato | 503 | `{ "error": "system stats unavailable", "code": 503 }` |

### 5.3 Implementazione Node-RED

Nuovo nodo nel tab `f-system`:

| Nodo | Tipo | Funzione |
|---|---|---|
| `http-in` | `http in` | `GET /api/system/stats` |
| `read-file` | `file in` (modalità single utf8) | `/data/system/stats.json` |
| `parse-and-augment` | `function` | `JSON.parse`, calcola `age_seconds`, aggiunge `stale: age>60` |
| `http-response` | `http response` | 200 + JSON; 503 se errore |
| `error-catch` | `catch` (collegato a read-file) | risponde 503 |

---

## 6. Frontend — sezione System nella pagina Settings

### 6.1 Layout target

Riga aggiuntiva in `Settings.tsx`, **prima** della riga "Spegnimento Raspberry Pi":

```
┌────────────────────────────────────────────────────────────────────┐
│  Sistema                                                            │
│  disco · cpu · ram · temperatura                                    │
│                                                                     │
│    Disco        ▰▰▰▰▰▰▱▱▱▱  38.7%   12.0 GB / 29.1 GB              │
│    CPU          ▰▱▱▱▱▱▱▱▱▱  12.4%   load 0.42, 0.31, 0.28          │
│    RAM          ▰▰▰▰▱▱▱▱▱▱  37.5%   3.0 GB / 8.0 GB                │
│    Temp SoC     48.3 °C                                             │
└────────────────────────────────────────────────────────────────────┘
```

Le barre sono `<div class="bar"><div class="bar-fill" style="width: 38.7%; background: var(--bar-green)"></div></div>`. Larghezza fissa (es. 160 px), altezza 8 px, bordi arrotondati 4 px, sfondo `var(--rule-2)`.

### 6.2 Nuovi file frontend

| File | Contenuto |
|---|---|
| `src/api/system.ts` | Aggiungi `useSystemStats()` con `refetchInterval: 10_000` |
| `src/api/types.ts` | Aggiungi `SystemStats` (matcha il JSON §5.1) |
| `src/components/SystemStats.tsx` | Nuovo componente: 3 righe (disco, cpu, ram) + temp |
| `src/helpers/formatBytes.ts` | `fmtBytes(n)` → `"12.0 GB"`, `"3.5 MB"` |
| `src/helpers/thresholds.ts` | `colorForPct(value, kind)` ritorna `'green' | 'yellow' | 'red'` |
| `src/pages/Settings.tsx` | Inserisci `<SystemStats />` come riga `.settings-row` |
| `src/styles/global.css` | Stili `.bar`, `.bar-fill`, `.bar-green`, `.bar-yellow`, `.bar-red`, `.sys-row` |

### 6.3 Componente `<SystemStats />` (scheletro)

```tsx
import { useSystemStats } from '../api/system';
import { fmtBytes } from '../helpers/formatBytes';
import { colorForPct } from '../helpers/thresholds';

export function SystemStats() {
  const { data, isLoading, error } = useSystemStats();
  if (isLoading) return <span className="muted">…</span>;
  if (error || !data) return <span className="error">stat non disponibili</span>;

  const isStale = data.age_seconds > 30;

  return (
    <div className="sys-rows">
      <SysBar
        label="Disco"
        pct={data.disk.used_pct}
        detail={`${fmtBytes(data.disk.used_bytes)} / ${fmtBytes(data.disk.total_bytes)}`}
        kind="disk"
      />
      <SysBar
        label="CPU"
        pct={data.cpu.used_pct}
        detail={`load ${data.cpu.load_avg_1_5_15.map(n => n.toFixed(2)).join(', ')}`}
        kind="cpu"
      />
      <SysBar
        label="RAM"
        pct={data.ram.used_pct}
        detail={`${fmtBytes(data.ram.used_bytes)} / ${fmtBytes(data.ram.total_bytes)}`}
        kind="ram"
      />
      {data.thermal.soc_temp_c !== null && (
        <div className="sys-temp">SoC: <strong>{data.thermal.soc_temp_c.toFixed(1)} °C</strong></div>
      )}
      {isStale && <span className="badge-warn">dati di {data.age_seconds}s fa</span>}
    </div>
  );
}

function SysBar({ label, pct, detail, kind }: SysBarProps) {
  const color = colorForPct(pct, kind);
  return (
    <div className="sys-row">
      <span className="sys-label">{label}</span>
      <div className="bar"><div className={`bar-fill bar-${color}`} style={{ width: `${pct}%` }} /></div>
      <span className="sys-pct tabular">{pct.toFixed(1)}%</span>
      <span className="sys-detail">{detail}</span>
    </div>
  );
}
```

### 6.4 React Query hook

```typescript
// src/api/system.ts (aggiunta)
export function useSystemStats() {
  return useQuery({
    queryKey: ['system', 'stats'],
    queryFn: () => apiGet<SystemStats>('/system/stats'),
    refetchInterval: 10_000,    // allineato al timer host
    staleTime: 5_000,
    retry: 1,
  });
}
```

### 6.5 Service Worker (step 7)

Aggiungere `/api/system/stats` al pattern `live-data` (NetworkFirst, 3s timeout, TTL 1h). Stessa logica di `/api/system/health`.

---

## 7. Soglie di colore

`src/helpers/thresholds.ts`:

```typescript
type Kind = 'disk' | 'cpu' | 'ram';
type Color = 'green' | 'yellow' | 'red';

export function colorForPct(value: number, kind: Kind): Color {
  const t = THRESHOLDS[kind];
  if (value >= t.red)    return 'red';
  if (value >= t.yellow) return 'yellow';
  return 'green';
}

const THRESHOLDS: Record<Kind, { yellow: number; red: number }> = {
  disk: { yellow: 70, red: 85 },   // disco si riempie lentamente: avvisa presto
  cpu:  { yellow: 70, red: 90 },   // picchi normali, allarme solo costante alto
  ram:  { yellow: 75, red: 90 },   // RPi5 ha 8 GB, raro arrivare in zona red
};
```

Palette CSS in `styles/tokens.css`:

```css
:root[data-theme="light"] {
  --bar-green:  #6f8b51;   /* --leaf */
  --bar-yellow: #c9a227;
  --bar-red:    #c54a3e;   /* --hm-dry */
}
:root[data-theme="dark"] {
  --bar-green:  #88a866;
  --bar-yellow: #e0b840;
  --bar-red:    #de6957;
}
```

### Motivazione delle soglie

| Risorsa | Yellow | Red | Why |
|---|---|---|---|
| Disco | 70% | 85% | InfluxDB + logs Caddy + Grafana possono crescere di ~1-2 GB/mese. A 85% restano ~4 GB su 30 → tempo per archiviare CSV su USB (step 8) o aumentare retention. A 95% i container iniziano a fallire scritture. |
| CPU | 70% | 90% | Su RPi5 (4 core ARM) sopra il 70% sostenuto la latenza UI degrada. Picchi a 100% durante il polling Node-RED sono normali — il colore reagisce solo se il valore al sample è alto. |
| RAM | 75% | 90% | InfluxDB cache + Grafana possono crescere. Sopra il 90% inizia swap (se abilitato) e degrado generale. |

Le soglie sono **letterali, non configurabili da UI in step 9**. Se in futuro servisse, spostarle in config store Node-RED come gli altri parametri.

---

## 8. Aggiornamento `verify_rpi5.sh`

Aggiungere check:

```bash
# Check 14: system stats watcher attivo
echo -n "[14] system-stats watcher... "
if systemctl is-active --quiet orto-system-stats.timer \
   && [ -f /opt/orto-digitale/system-out/stats.json ] \
   && [ $(($(date +%s) - $(stat -c %Y /opt/orto-digitale/system-out/stats.json))) -lt 30 ]; then
  echo "OK"
else
  echo "FAIL"
  exit 1
fi

# Check 15: endpoint /api/system/stats
echo -n "[15] /api/system/stats reachable... "
if curl -sk --max-time 5 https://localhost/api/system/stats \
   --resolve orto.local:443:127.0.0.1 \
   | jq -e '.disk.used_pct != null' >/dev/null; then
  echo "OK"
else
  echo "FAIL"
  exit 1
fi
```

---

## 9. Verifica end-to-end

### 9.1 Sull'host RPi

```bash
# Lo script funziona standalone
sudo -u as /opt/orto-digitale/scripts/system_stats.sh
cat /opt/orto-digitale/system-out/stats.json | jq

# Timer attivo
systemctl list-timers | grep orto-system-stats
# atteso: prossima esecuzione entro 10s

# JSON aggiornato di recente
stat -c %y /opt/orto-digitale/system-out/stats.json
# atteso: timestamp degli ultimi 10s
```

### 9.2 Backend

```bash
curl -sk https://orto.local/api/system/stats | jq
# atteso:
# - disk.used_pct float 0-100
# - ram.used_pct float 0-100
# - cpu.used_pct float 0-100
# - age_seconds < 15

# Stress test: ferma il timer, riprova dopo 60s
sudo systemctl stop orto-system-stats.timer
sleep 60
curl -sk https://orto.local/api/system/stats | jq '.age_seconds, .stale'
# atteso: age_seconds > 60, stale: true (200, non 503)
sudo systemctl start orto-system-stats.timer
```

### 9.3 Frontend

- [ ] Aprire PWA → tab Settings → sezione "Sistema" presente prima dello shutdown
- [ ] Tre barre visibili: Disco, CPU, RAM, con percentuali e dettagli
- [ ] Colore corretto rispetto alle soglie (forzare valori alti riempiendo disco con `fallocate -l 25G /tmp/test.bin` solo se sai cosa fai)
- [ ] Polling ogni 10s — DevTools Network mostra `system/stats` ricorrente
- [ ] Temperatura SoC visibile se disponibile
- [ ] Tema dark: colori barre coerenti con palette dark

### 9.4 Stress / boundary

| Scenario | Comportamento atteso |
|---|---|
| Disco al 88% | Barra rossa, percentuale rossa, valore corretto |
| Watcher fermo > 60s | Badge "dati di Ns fa", barre congelate |
| File JSON corrotto | API 503, FE mostra "stat non disponibili" |
| RPi appena avviato (< 15s) | API 503 finché il primo run del timer scrive il file |

---

## 10. Out of scope

- **Storicizzazione su InfluxDB delle stat di sistema**: rimandata. Se servirà trend ("la RAM è cresciuta del X% al mese?") si crea measurement `system_stats` con retention 90 giorni e si scrive ogni 60s dal watcher (non ogni 10s).
- **Alert proattivi** (es. notifica "disco al 90%"): fuori scope step 9. La PWA non ha push notification — eventualmente in futuro via log → log esterno.
- **Stat per-container (CPU/RAM di Mosquitto, InfluxDB, etc.)**: richiede Docker stats API, complica setup. Per debug si usa `docker stats` da SSH.
- **Throttling / CPU governor info**: il RPi5 può termo-throttlare; per ora basta esporre `soc_temp_c`, la decisione di reagire resta all'utente.
- **Storage USB esterno (step 10 in roadmap)**: lo step 10 introdurrà un secondo filesystem (`/mnt/usb`) — quando attivato, estendere `system_stats.sh` con un campo `disk_usb` parallelo. Non parte di step 9.
- **Rete / banda**: traffico LAN non monitorato; il GW3000 e i sensori sono pochi pacchetti/min.
- **Soglie configurabili da UI**: hardcoded in `thresholds.ts`. Cambiarle = modifica codice + redeploy FE.

---

## Spec
Vedi sezioni 1-10 sopra.

---
## Implementazione
**Stato:** ✅ COMPLETATO — 2026-05-18
**Commit di riferimento:** `feat(step9): statistiche di sistema RPi5 in Settings` (hash da assegnare al commit)
**Note:**
- Host RPi5: nuovo script `rpi5/scripts/system_stats.sh` (sample `df -B1 /` + `/proc/meminfo` + delta `/proc/stat` a 1s + `/proc/loadavg` + `/sys/class/thermal/thermal_zone0/temp`). Output JSON atomico (`mv -f` da `.tmp`) in `/opt/orto-digitale/system-out/stats.json`. Owner `as:as`, chmod 644.
- systemd: `orto-system-stats.service` (`Type=oneshot`, `User=as`) + `orto-system-stats.timer` (`OnBootSec=15s`, `OnUnitActiveSec=10s`, `AccuracySec=1s`). Esplicito `Unit=orto-system-stats.service` nella sezione `[Timer]` per chiarezza.
- Docker: aggiunta riga `./system-out:/data/host-system:ro` al service `nodered` di `rpi5/docker-compose.yml`. Mount RO bind di **directory** (non file singolo) per evitare il footgun "il container fallisce al primo `up` se il file non esiste".
- Node-RED: nuovo endpoint `GET /api/system/stats` nel tab `f-system` con 3 nodi (`sy-http-in-stats`, `sy-fn-stats`, `sy-http-resp-stats`). Function async (`libs: [{var:'fs', module:'fs'}]`) legge `/data/host-system/stats.json`, parse, calcola `age_seconds`, marca `stale: true` se > 60s. On read/parse failure → 503 con body `{ error, code }`.
- Frontend: nuovi tipi `SystemStats{Disk,Ram,Cpu,Thermal}` in `src/api/types.ts`; nuovo hook `useSystemStats()` in `src/api/system.ts` (`refetchInterval: 10s`, `staleTime: 5s`, `retry: 1`); nuovi helper `src/helpers/formatBytes.ts` (`fmtBytes`, base 1024) e `src/helpers/thresholds.ts` (`colorForPct`, soglie disk 70/85, cpu 70/90, ram 75/90). Componente `src/components/SystemStats.tsx` con 3 righe (Disco/CPU/RAM) via `<SysBar>`, riga Temp SoC opzionale, badge "dati di Ns fa" se `stale` o `age > 30s`.
- Settings: nuova `.settings-row` "Sistema" inserita immediatamente prima di "Spegnimento Raspberry Pi". Layout invariato (`.settings-row` flex space-between).
- Stili: tokens `--bar-green/yellow/red` in entrambi i temi (light/dark). Nuovi blocchi CSS `.sys-rows`, `.sys-row` (grid 60/140/56/auto), `.sys-label`, `.sys-pct`, `.sys-detail`, `.sys-temp`, `.bar`, `.bar-fill.bar-{green,yellow,red}`, `.badge-warn`.
- Service Worker: pattern `/api/system/stats` aggiunto al blocco `NetworkFirst` `live-data` già esistente in `vite.config.ts` (accanto a `/api/system/health`).
- Healthcheck: header aggiornato da "13 controlli" a "15 controlli"; nuovo check **[14]** verifica `orto-system-stats.timer` attivo e `system-out/stats.json` aggiornato < 30s; nuovo check **[15]** curl `/api/system/stats` via Caddy e jq parse `disk/ram/cpu used_pct != null`.
- Verifiche pre-deploy: `npx tsc --noEmit` clean; `npx vite build` OK con `dist/sw.js` contenente i pattern `system/stats`; `node -e 'JSON.parse(...)'` su `flows.json` OK (117 nodi totali, 3 nuovi stats); `bash -n` su `system_stats.sh` e `verify_rpi5.sh` OK.

**Deviazioni dalla spec:**
- Spec §4.3 indicava il bind-mount `./system-out:/data/system:ro`. Implementato come `./system-out:/data/host-system:ro` perché `/data/system/` dentro il container è già usato dal flow `f-system` per scrivere `shutdown_requested.flag` (step 5, footgun già operativo): un mount RO sovrapposto avrebbe spezzato lo shutdown. Lo stesso mount RO su un path dedicato evita la collisione e mantiene la stessa garanzia di isolamento.
- Spec §5.3 distingueva i casi "file esiste ma `age > 60s`" (200 + `stale: true`) e "file mancante o JSON malformato" (503). Implementato come: 503 solo su `fs.readFile`/`JSON.parse` falliti; se il file è leggibile ma stale (`age > 60`), risposta 200 con `stale: true` (il FE mostra la badge "dati di Ns fa"). Stesso intento della spec, semplificato in un unico path try/catch.
- Spec §5.3 suggeriva 5 nodi (`http-in`, `read-file`, `parse-and-augment`, `http-response`, `error-catch`). Implementato con 3 nodi totali: `http in` + function async (lettura+parse+augment+errori in un solo blocco try/catch) + `http response`. Stessa decisione architetturale di step 8 (`wf-fn-handle`): meno superficie di errore, più facile da mantenere.
