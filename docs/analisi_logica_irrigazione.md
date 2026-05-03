# Analisi Logica Irrigazione Automatica — Orto Digitale

**Data:** 2026-05-03
**Contesto:** Orto ~40 m², 3 aiuole, singola valvola SWV_01, 4 sensori umidità attivi (WH51_01–04).

---

## Il vincolo architetturale di partenza

Il sistema ha **una sola valvola** che bagna l'intero orto. Questo cambia radicalmente la logica rispetto a un sistema multi-zona: non possiamo scegliere quale aiuola irrigare, ma solo decidere *se* e *per quanto* aprire. Tutte le decisioni devono quindi basarsi su grandezze aggregate (media, minimo) e non su singoli sensori.

---

## Parametro 1 — Umidità del suolo

### Perché è il parametro principale
L'umidità del suolo è l'unica misura diretta del bisogno d'acqua delle piante. Tutti gli altri parametri sono correzioni o guardrail su questa grandezza fondamentale.

### Come calcolare la media
Con una singola valvola che bagna tutto l'orto, la logica più robusta è:

**Media pesata per sensori attivi:**
```
umidità_media = media(WH51_01, WH51_02, WH51_03, WH51_04)
```

Considerazioni aggiuntive:
- Usare solo i sensori con `battery_ok = true` e visti negli ultimi 30 minuti
- Se un sensore è offline, escluderlo dalla media anziché usare l'ultimo valore noto
- Loggare anche la **deviazione standard** tra i sensori: una varianza alta (es. un'aiuola a 20%, un'altra a 60%) è un segnale che la distribuzione dell'acqua non è uniforme

### Soglie operative

| Evento | Soglia (default) | Configurabile |
|---|---|---|
| Apertura in finestra | media < **40%** | ✅ |
| Apertura in emergenza (fuori finestra) | media < **25%** | ✅ |
| Chiusura valvola | media > **65%** | ✅ |
| Safety timeout (irrigazione standard) | 15 minuti | ✅ |
| Safety timeout (irrigazione emergenza) | 5 minuti | ✅ |

> **Tutte le soglie sono modificabili a runtime** dal frontend (step 5) — nessun parametro hardcoded. I valori in tabella sono solo i default iniziali. Vedi §"Parametri configurabili a runtime".

### Raffinamento con il minimo
Una variante più conservativa usa `min(sensori)` invece della media per l'apertura: si apre solo se *il sensore più asciutto* è sotto soglia. Questo è più aggressivo (irriga più spesso) ma protegge meglio le piante. Con una valvola singola è accettabile.

**Raccomandazione:** usare la media per ora; valutare il minimo nella stagione più calda.

---

## Parametro 2 — Orario e temperatura

### Perché conta
Irrigare a mezzogiorno con 30°C significa che il 30–40% dell'acqua evapora prima di penetrare nel suolo. Irrigare di sera o di mattina presto riduce le perdite per evaporazione e permette all'acqua di raggiungere le radici.

### Finestre orarie raccomandate

| Finestra | Motivazione |
|---|---|
| **19:00–21:00 (sera)** | Temperatura in calo, niente sole diretto, acqua penetra durante la notte. **Preferita.** |
| **06:00–08:00 (mattina)** | Terreno fresco, ma le foglie bagnate restano umide tutto il giorno (rischio funghi in stagioni umide). Buona alternativa. |
| **11:00–17:00 (da evitare)** | Massima evaporazione, possibile stress termico sulle piante se l'acqua fredda tocca foglie calde. |

**Implementazione:** la logica di step 4 già prevede queste due finestre. Nessun cambiamento necessario alla spec attuale.

### Temperatura come moltiplicatore di urgenza
La temperatura dell'aria (disponibile dal GW3000 se presente, oppure da API meteo) può modulare le soglie:

```
se temperatura > 30°C:
    soglia_apertura = 45%  (si irriga prima del solito)
    soglia_chiusura = 70%  (si irriga di più)
```

Questo adattamento stagionale diventa rilevante da giugno ad agosto. Non è prioritario per step 4 ma è utile tenerlo in mente.

### Soglia di emergenza: bypass della finestra orario

Caso reale: in piena estate l'umidità precipita al 20% alle 14:00. Aspettare le 19:00 può causare stress termico irreversibile alle piante. La logica prevede un **bypass dell'orario** quando l'umidità è critica:

| Condizione | Comportamento |
|---|---|
| `umidità_media < soglia_emergenza` (default **25%**, configurabile) | Apertura immediata anche fuori finestra |
| Durata | Ridotta a **5 min** (configurabile) — obiettivo: salvataggio piante, non saturazione |
| Cooldown | **rispettato** (evita aperture multiple ravvicinate) |
| Rain delay | **rispettato** (se pioverà tra 2h, meglio aspettare) |
| Trigger | logged come `emergency` per distinguerlo da `auto` |

Solo l'orario viene bypassato. Tutti gli altri guardrail restano attivi. Questa scelta evita un comportamento "panico" dove a 24% si irriga 3 volte di fila e mantiene il sistema prevedibile.

---

## Parametro 3 — Previsione pioggia

### Perché è importante
Irrigare la sera prima di una notte con 15mm di pioggia è uno spreco. La previsione pioggia è il guardrail più impattante sulla frequenza di irrigazione in primavera e autunno.

### Fonte dati consigliata: Open-Meteo
Open-Meteo è un'API meteo **gratuita, senza chiave API, no-cloud-account**, con endpoint REST che funziona anche da rete locale purché il RPi abbia accesso a internet. Restituisce previsioni orarie di precipitazione per coordinate GPS.

Endpoint esempio:
```
https://api.open-meteo.com/v1/forecast?latitude=<LAT>&longitude=<LON>&hourly=precipitation&forecast_days=2
```

### Logica rain delay

```
rain_forecast_next_24h = somma precipitazioni previste nelle prossime 24 ore

se rain_forecast_next_24h >= 5 mm:
    skip irrigazione (rain delay)
    log motivo: "pioggia prevista {X}mm nelle prossime 24h"
```

Parametri configurabili:
- **Soglia mm:** 5 mm è un valore standard per orti. Sotto i 5mm la pioggia bagna la superficie ma non le radici.
- **Finestra temporale:** 24h è un buon compromesso. Con 48h si rischia di non irrigare mai in settimane con piogge sparse.

### Fallback se API non raggiungibile
Se la chiamata HTTP fallisce o il RPi non ha internet:
- **Non bloccare** l'irrigazione → si irriga comunque se l'umidità lo richiede
- Loggare l'assenza di dati meteo nel record `irrigation_events`
- Non ritentare la chiamata ogni 5 minuti: usare una cache con TTL di 30–60 minuti

---

## Parametro 4 — Durata apertura valvola

### Il problema
Non sappiamo a priori quanti mm d'acqua servono per passare dal 40% al 65% di umidità in quest'orto specifico. Dipende da:
- Composizione del terreno (argilloso vs sabbioso)
- Densità e distribuzione dei gocciolatori
- Portata SWV_01 (conosciuta dal campo `flow` in `valve_state`)
- Temperatura e condizioni atmosferiche
- Profondità dei sensori WH51

### Approccio adattivo (raccomandato)

**Fase 1 — Apprendimento (prime 2-4 settimane):**
Aprire per un tempo fisso (es. 10 minuti), registrare il delta di umidità ottenuto:
```
delta_umidità = umidità_after - umidità_before
mm_per_minuto = delta_umidità / durata_minuti
```

**Fase 2 — Controllo in loop:**
Una volta stimato il tasso di assorbimento, stimare la durata necessaria:
```
durata_stimata = (soglia_chiusura - umidità_attuale) / tasso_assorbimento
durata_effettiva = min(durata_stimata, 15 min)  # safety cap
```

**Guardrail sempre attivi:**
- Safety timeout: **15 minuti** dal momento dell'apertura, indipendentemente dall'umidità
- Monitoraggio ogni 5 minuti: se umidità > 65% → chiudi anticipatamente
- Se umidità non sale dopo 10 minuti → anomalia (sensore rotto? problema idrico?) → chiudi e lancia alert

### Cosa loggare su InfluxDB per abilitare il calcolo adattivo
Nel measurement `irrigation_events`:
- `duration_seconds`: durata effettiva
- `avg_moisture_at_trigger`: umidità media all'apertura
- `avg_moisture_at_close`: umidità media alla chiusura ← da aggiungere
- `delta_moisture`: differenza (calcolabile in query Flux, o registrata direttamente)
- `rain_forecast_mm`: mm previsti al momento dell'irrigazione

---

## Algoritmo decisionale completo

```
ogni 5 minuti (polling_interval_seconds), se non è in corso un'irrigazione:

1. UMIDITÀ
   └─ calcola media sensori validi
   └─ media >= soglia_apertura (40%)? → exit (non serve irrigare)
   └─ media < soglia_emergenza (25%)? → is_emergency = true
   └─ altrimenti is_emergency = false

2. ORARIO
   └─ is_emergency = true → salta questa check
   └─ siamo in finestra mattina o sera? → continua
   └─ NO → exit con skip_reason="out_of_window"

3. COOLDOWN (sempre attivo, anche in emergenza)
   └─ tempo dall'ultima irrigazione > cooldown (4h default)?
   └─ NO → exit con skip_reason="cooldown"

4. PIOGGIA (sempre attivo, se cache meteo disponibile)
   └─ precipitazioni previste nelle prossime 24h >= soglia_pioggia (5mm)?
   └─ SI → exit con skip_reason="rain_delay"

5. APRI VALVOLA SWV_01
   └─ durata target = is_emergency ? emergency_duration (5min) : safety_timeout (15min)
   └─ log evento: trigger=auto|emergency, avg_moisture_at_trigger, rain_forecast_mm

6. MONITORA (ogni monitoring_interval_seconds, default 60s, mentre aperta)
   └─ umidità media > soglia_chiusura (65%)? → vai a 7
   └─ tempo aperto > durata target? → vai a 7 (safety timeout)
   └─ NB: la finestra orario governa SOLO l'apertura. Se l'irrigazione
      è partita alle 20:55, prosegue oltre le 21:00 fino a soglia/timeout.

7. CHIUDI VALVOLA SWV_01
   └─ log evento: duration_seconds, avg_moisture_at_close, motivo chiusura
```

---

## Parametri configurabili a runtime

**Requisito non negoziabile:** ogni numero nella logica è un parametro modificabile da frontend, non un valore hardcoded. Lo step 5 esporrà una UI di configurazione; nel frattempo i parametri sono settabili via MQTT (`orto/config/set/<key>`) o REST su Node-RED. Vedi `analisi_completezza_step4.md §2.7` per l'architettura completa del config store.

| Parametro | Default | Range ragionevole |
|---|---|---|
| `soglia_apertura_pct` | 40 | 30–50 |
| `soglia_chiusura_pct` | 65 | 55–75 |
| `soglia_emergenza_pct` | 25 | 15–35 |
| `cooldown_seconds` | 7200 (2h) | 1800–43200 |
| `safety_timeout_seconds` | 900 (15min) | 300–1800 |
| `emergency_duration_seconds` | 300 (5min) | 120–600 |
| `finestra_mattina` | `["06:00", "08:00"]` | — |
| `finestra_sera` | `["19:00", "21:00"]` | — |
| `polling_interval_seconds` | 300 (5min) | 60–600 |
| `monitoring_interval_seconds` | 60 (1min) | 30–300 |

I parametri meteo e quorum sensori sono trattati nei rispettivi documenti (`analisi_integrazione_meteo.md`, `analisi_completezza_step4.md`).

**Vincoli di consistenza** (validati al momento del set):
- `soglia_emergenza < soglia_apertura < soglia_chiusura`
- `emergency_duration < safety_timeout`
- `finestra_*[0] < finestra_*[1]`

I valori non validi vengono rifiutati senza modificare lo stato corrente.

---

## Cosa non implementare ora (step 4)

| Feature | Motivo per rimandare |
|---|---|
| Soglie adattive per temperatura | Richiede stagione di dati storici per calibrare |
| Durata adattiva calcolata | Idem — prima raccogliere dati con durata fissa |
| Alert SMS/email | Scope oltre il sistema locale |
| Multi-zona (per aiuola) | Richiederebbe valvole aggiuntive non ancora previste |
| Evapotraspirazione (ET) | Modello complesso, overkill per un orto 40m² |

---

## Priorità di implementazione per step 4

1. **Base:** config store + parametri runtime configurabili (no hardcoded)
2. **Base:** umidità + orario + cooldown + safety timeout
3. **Base:** soglia di emergenza (25% default) con bypass orario
4. **Alta priorità:** integrazione Open-Meteo rain delay
5. **Media priorità:** logging `avg_moisture_at_close` e `delta_moisture`
6. **Bassa priorità:** soglie adattive per temperatura estiva (post step 5)

---

## Note sulla validazione post-deploy

Dopo il deploy di step 4, verificare:
- Che `irrigation_events` riceva record con tutti i campi attesi
- Che il rain delay scatti correttamente (simulabile forzando il valore nella logica)
- Che il safety timeout funzioni (simulare un sensore bloccato sotto soglia)
- Che dopo un'irrigazione il cooldown impedisca una seconda apertura immediata
