# Analisi — Approccio decisionale per l'irrigazione automatica

**Data:** 2026-05-23
**Scope:** decidere come evolvere la logica di step 4 per quest'orto specifico: ~40 m², 3 aiuole, 1 valvola, gestione personale dell'utente.
**Documenti propedeutici:** [`docs/analisi_logica_irrigazione.md`](../docs/analisi_logica_irrigazione.md), [`docs/analisi_integrazione_meteo.md`](../docs/analisi_integrazione_meteo.md), [`docs/step4_irrigazione_automatica.md`](../docs/step4_irrigazione_automatica.md).

---

## 0. Il contesto che determina tutto

Questo non è un sistema agricolo professionale. È l'orto di casa, ~40 m², gestito finora **a occhio** dall'utente (controllo manuale del terreno, esperienza personale, irrigazione quando "serviva"). L'obiettivo del progetto è duplice:

1. **automatizzare** un'attività che oggi richiede presenza fisica
2. **sperimentare** come si costruisce una logica di autoirrigazione

Da questo derivano tre principi guida per l'analisi:

| Principio | Conseguenza |
|---|---|
| Il termine di paragone è la decisione umana, non l'agricoltura di precisione | Anche una soglia statica ben calibrata è *già* meglio del baseline; il marginal gain di sofisticazioni successive cala in fretta |
| Sistema mono-utente, scala domestica | Costo di manutenzione = tempo dell'utente. Ogni container in più, ogni pipeline di training, ogni parametro in più ha un costo reale |
| Sperimentazione → reversibilità | Le scelte devono restare semplici da disfare se non funzionano. Niente componenti che, una volta in produzione, sono *obbligatori* per il resto del sistema |

L'analisi sceglie esplicitamente di **non valutare** ML on-edge, bucket model FAO-56 completo, container ML aggiuntivi e altre opzioni che a questa scala portano più peso operativo che valore agronomico. Sono citate in §5 con una riga di motivo.

---

## 1. Stato attuale di step 4

Variabili effettivamente usate dall'algoritmo decisionale oggi:

| Variabile | Uso |
|---|---|
| `umidità_media` (4 sensori) | confronto vs `soglia_apertura/chiusura/emergenza` |
| ora del giorno | match finestre 06–08 e 19–21 |
| `last_irrigation_at` | cooldown 2h |
| `precip_next_24h_mm` | rain delay se ≥ 5 mm |
| `mode`, `valve.reachable` | gate |

**Funziona.** È già un grosso passo avanti rispetto alla decisione manuale: monitoraggio continuo, mai-overshoot oltre soglia, mai-doppia-irrigazione, rispetto delle finestre orarie. La fase di osservazione in `dry_run` serve proprio a confermarlo prima di passare ad `auto`.

I limiti reali emersi nei documenti propedeutici e nella spec:

| Limite | Effetto pratico |
|---|---|
| Soglie statiche tutto l'anno | A luglio (caldo + sole) l'orto si asciuga molto più veloce di marzo, ma le soglie sono le stesse → rischio sotto-irrigazione estiva |
| `precip_next_24h_mm` senza probabilità | "5 mm con prob 10 %" e "5 mm con prob 90 %" trattati allo stesso modo → falsi rain delay in stagioni mutevoli |
| Durata fissa (safety_timeout) | A volte sufficiente, a volte non porta a soglia_chiusura → chiusura prematura per cap, monitoring deve farla riaprire dopo cooldown |
| Cooldown e finestre rigide | Se nel pomeriggio si scende molto, si aspetta la sera anche se urgenza modesta — comportamento conservativo accettabile |

---

## 2. Cosa migliorare — e cosa no

### 2.1 Una sola aggiunta fa la maggior parte della differenza: ET₀

ET₀ (evapotraspirazione di riferimento) è il numero che dice *quanti mm di acqua il terreno+pianta perde oggi*. È il parametro che fa la differenza vera tra "soglia fissa" e "irrigazione informata dal meteo". Open-Meteo la espone già:

- campo: `et0_fao_evapotranspiration` (daily)
- nessuna chiave API, nessun servizio aggiuntivo, **stessa chiamata HTTP che già facciamo**

Cosa cambia in pratica: invece di chiedersi *"siamo sotto soglia? sì → apro"*, ci si chiede *"siamo sotto soglia E oggi il terreno sta perdendo molto? sì → apro prima, irrigo di più"*. Una formula a una riga:

```
soglia_apertura_oggi = soglia_apertura_base + α · (ET₀_oggi − 4)
```

Con `α` piccolo (es. 1.5) e `ET₀_oggi` in mm/giorno, in una giornata torrida (ET₀ ≈ 7 mm) la soglia sale a ~44 %, in una giornata nuvolosa (ET₀ ≈ 2 mm) scende a ~37 %. Stesso schema rule-based, ma stagionalmente cosciente.

### 2.2 Probabilità di pioggia, non solo quantità

Open-Meteo espone `precipitation_probability_max` (già visualizzato in PWA da step 8). Estendere il rain delay:

```
rain_delay attivo SE (precip_next_24h_mm ≥ 5 AND precip_probability ≥ 60%)
```

Una riga di codice. Elimina i falsi rain delay nelle giornate "forse pioverà".

### 2.3 Le altre variabili gratis: usarle solo se semplici

Open-Meteo offre altri campi (VPD, radiazione solare, vento, temperatura suolo modellata). **Non aggiungerli alla decisione finché ET₀ + probabilità non hanno dimostrato il loro valore.** Sono variabili tutte correlate tra loro: aggiungerle tutte insieme moltiplica i parametri di tuning senza moltiplicare la qualità della decisione.

Eccezione utile e a costo zero: **loggarli** in `weather_forecast` e in `irrigation_events`. Non entrano nella logica ma vengono registrati, così tra una stagione si vede se *ex post* avrebbero migliorato qualcosa. Pure osservazione, niente complessità.

### 2.4 Variabili già raccolte ma non sfruttate

Tutte derivabili da query InfluxDB, nessuna nuova fonte:

| Variabile | Uso semplice e diretto |
|---|---|
| `valve_state.flow` (m³/h) | Calcolare i **litri erogati** ad ogni irrigazione (`flow × durata`). Già loggato in `total_liters`, mostrarlo in PWA dà all'utente il feedback "ho usato N litri questa settimana" |
| `delta_moisture` storico | Dopo qualche settimana di dati, calcolare la *media* di quanto sale l'umidità per minuto. Numero unico, usabile per fissare una durata target sensata invece del safety_timeout grezzo |
| `umidità_stddev` | Già loggato come flag `sensors_high_variance`. Mostrarlo in PWA come warning "le aiuole stanno divergendo" è utile, **non** deve entrare nella decisione |

### 2.5 Input dell'utente: una sola dropdown

Un parametro manuale ha più valore di mille feature derivate, se cattura un'informazione che il sistema non può dedurre. Per quest'orto basta una dropdown nella sezione Settings della PWA:

```
Fase colturale:
  ○ Riposo / fuori stagione (nov-feb)     →  fattore × 0.5
  ○ Crescita (mar-mag)                    →  fattore × 0.9
  ○ Piena produzione (giu-ago)            →  fattore × 1.15
  ○ Fine ciclo (set-ott)                  →  fattore × 0.8
```

Il fattore moltiplica `ET₀` nella formula §2.1 (è il coefficiente colturale Kc, in versione brutalmente semplificata). 30 minuti di lavoro frontend, riconfigurabile in 2 click 4 volte l'anno, e l'utente sente di avere il controllo.

---

## 3. Cosa **non** aggiungere

Lista esplicita di cose che potrebbero sembrare buone idee ma a questa scala non lo sono:

| Non fare | Perché |
|---|---|
| Bucket model FAO-56 completo (water balance simulato + re-anchoring) | Richiede stima di AWC del suolo, tuning, re-anchoring quando diverge dai sensori. Su 40 m² omogenei con 4 sensori in-situ, il bucket aggiunge complessità senza superare un rule-based+ET₀ ben tarato |
| ML on-edge (qualunque tipo: classificazione, regressione, RL) | Dataset insufficiente (60–200 episodi/anno), retraining da mantenere, debugging black-box; lo stesso utente decideva a occhio fino a ieri — il guadagno marginale è sotto il rumore di misura dei WH51 |
| Container nuovi (orto-ml, modelli, sidecar di inference) | Ogni container aggiunto è una cosa in più da aggiornare, monitorare, debuggare al riavvio |
| Hardware aggiuntivo (pluviometro, sonde EC, piranometro, camera CV) | Tutti scartati nella prima analisi: nessuno produce un ΔROI difendibile su 40 m². L'unica cosa hardware sensata è **posare i WH51_05/06** già acquistati per aiuola 3 |
| Auto-tuning delle soglie con feedback umano (PWA: "irrigazione era giusta?") | Pochi click → segnale rumoroso → soglie che oscillano; meglio che l'utente cambi i parametri direttamente quando lo ritiene |
| Aggiungere VPD/radiazione/vento alla logica decisionale subito | Tutti correlati a ET₀; entrano insieme = troppi parametri da tarare con pochi dati. Loggarli e basta |
| Cooldown adattivo, finestre orarie dinamiche, decisioni "preventive" | Step rule-based+ET₀ deve dimostrare i suoi limiti prima di aggiungerli; per ora il comportamento conservativo (rispetta finestre, rispetta cooldown) è quello che ci si aspetta |

---

## 4. Approccio raccomandato

Una sola fase, una sola PR di evoluzione di step 4. Niente fase A/B/C.

### 4.1 Cosa cambia nella logica decisionale

```
Tick ogni 5 minuti:
  1. UMIDITÀ (invariato)
     media sensori validi; quorum check; se >= soglia_apertura_dynamic → skip

  2. SOGLIE ADATTIVE (nuovo)
     ETc_oggi = Kc · ET₀_oggi                   # Kc dalla dropdown stagione
     soglia_apertura_dynamic = soglia_apertura_base + α · (ETc_oggi − 4)
     (cap a [25, 55] per sicurezza)

  3. ORARIO (invariato)
  4. COOLDOWN (invariato)

  5. PIOGGIA (esteso)
     skip SE precip_next_24h_mm ≥ rain_threshold
            AND precip_probability ≥ prob_threshold

  6. APRI
     durata target = (se ho > 30 episodi storici):
                       (soglia_chiusura − media) / media_delta_per_minuto, cap a safety_timeout
                     altrimenti:
                       safety_timeout (come oggi)
```

Nient'altro. Stesso skeleton di step 4, due righe in più.

### 4.2 Cosa cambia nello schema dati

| Measurement | Modifica |
|---|---|
| `weather_forecast` | + `et0_today_mm`, `precip_probability_max`. Opzionali per ora osservativi: `vpd_max_today`, `radiation_sum_today_mj`, `wind_speed_max_kmh` |
| `irrigation_events` | + `et0_at_decision`, `kc_at_decision`, `soglia_apertura_dynamic` (snapshot effettivo usato) |
| `irrigation_config.json` | + `irrigation.alpha_et0` (default 1.5), `irrigation.kc` (default 1.0), `weather.precip_probability_threshold` (default 60) |

### 4.3 Cosa cambia nella PWA

- WeatherCard: aggiungere ET₀ giornaliera ("il terreno oggi perde ~X mm")
- Settings → nuova sezione "Stagione orto": dropdown a 4 stati che setta `irrigation.kc`
- Settings → soglie esistenti restano modificabili; aggiungere lo slider `alpha_et0` (avanzato, default OK)
- Pagina Storico (se esiste / quando esiste): mostrare litri totali settimana/mese da `total_liters`

### 4.4 Effort stimato

| Attività | Tempo |
|---|---|
| Estensione chiamata Open-Meteo (`f-weather` step 4 + `f-weather-frontend` step 8) | 1h |
| Schema InfluxDB + logica decisionale aggiornata in Node-RED | 3–4h |
| Dropdown stagione + visualizzazione ET₀ in PWA | 2–3h |
| Test in `dry_run` + verifica healthcheck | 1h |
| Aggiornamento `docs/step4_*.md` con la deviazione | 1h |

Totale: **~1 giornata di lavoro**, tutto reversibile (la formula adattiva diventa neutra se `α = 0`).

---

## 5. Opzioni esplicitamente scartate

Citate per memoria. Non sono "out of scope per ora": sono fuori dalla filosofia del progetto a questa scala.

| Opzione | Perché scartata |
|---|---|
| Bucket model FAO-56 con water-balance simulato | Stato-dell'arte agronomico, ma richiede tuning AWC + re-anchoring + dashboard di osservazione del bucket per il debug. Su 40 m² omogenei non batte sensori+ET₀ |
| ML regressione (drying rate, duration estimator) | Servirebbe pipeline di training, container Python, retraining settimanale, gate sul RMSE, versionamento modelli. La media empirica `delta_moisture / minuto` su 30+ episodi (§2.4) cattura il 90 % del valore con 3 righe SQL |
| ML classificazione "irriga/non irriga" | Manca un'etichetta oggettiva di "decisione giusta"; finirebbe per imitare le soglie statiche attuali |
| Time-series neurali (LSTM) sull'umidità | Dataset troppo piccolo, modello sproporzionato |
| Reinforcement learning | ~5 episodi/settimana, ricompensa a 24h, instabile |
| Multi-zona (decisione per aiuola) | Hardware non lo permette (single-valve) |
| Hardware aggiuntivo (pluviometro/EC/piranometro/camera) | Costo monetario + manutenzione, beneficio non rilevabile a questa scala |
| Modelli evapotraspirazione proprietari (Hargreaves locale) | ET₀ Open-Meteo è già calcolata via Penman-Monteith FAO-56 sul grid di zona; rifarla in casa con meno dati è peggio |

---

## 6. Conclusione e azione concreta

L'algoritmo giusto per quest'orto è **lo stesso rule-based di step 4, con una piccola informazione in più (ET₀) e un input umano stagionale (Kc da dropdown)**. Tutto qua. Niente ML, niente bucket model, niente container nuovi.

Il valore di ET₀ non sta nel renderlo "smart" — sta nel risolvere il bug stagionale concreto: a luglio l'orto si asciuga 3× più veloce di marzo, e nessuna soglia statica può andare bene per entrambi i regimi.

**Next action (una PR, ~1 giornata):**

1. Aggiungere `et0_fao_evapotranspiration` + `precipitation_probability_max` ai parametri Open-Meteo (entrambi i tab Node-RED).
2. Loggare `et0_today_mm` e `precip_probability` in `weather_forecast` e in `irrigation_events`.
3. Aggiungere `alpha_et0`, `kc`, `precip_probability_threshold` al config store con default conservativi.
4. Aggiornare la decisione: soglia adattiva (§4.1 step 2) + rain delay esteso (§4.1 step 5).
5. Dropdown "Fase colturale" in Settings PWA (setta `kc` via `POST /api/config/irrigation/kc`).
6. Visualizzare ET₀ in WeatherCard ("oggi il terreno perde ~X mm").
7. Test in `dry_run` per 2 settimane prima dello switch ad `auto`.

Step successivi (solo se questa fase mostra limiti specifici dopo una stagione di osservazione): rivalutare. Senza dati, non promettere fasi B/C che potrebbero non servire mai.
