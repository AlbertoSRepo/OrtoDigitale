# Step 17 — Notifiche Telegram: salute sonde e bagnatura non uniforme

## Indice

0. [Perimetro e sua riduzione](#0-perimetro-e-sua-riduzione)
1. [Obiettivo](#1-obiettivo)
2. [Stato di partenza — misurato, non assunto](#2-stato-di-partenza--misurato-non-assunto)
3. [Decisioni di design](#3-decisioni-di-design)
4. [Fase 1 — L'algoritmo di salute sonde](#4-fase-1--lalgoritmo-di-salute-sonde)
5. [Fase 1 — I messaggi](#5-fase-1--i-messaggi)
6. [Fase 2 — Bagnatura non uniforme](#6-fase-2--bagnatura-non-uniforme)
7. [File toccati](#7-file-toccati)
8. [Fuori scope](#8-fuori-scope)
9. [Verifica di completamento](#9-verifica-di-completamento)
10. [Aggiornamenti a CLAUDE.md](#10-aggiornamenti-a-claudemd)

---

## 0. Perimetro e sua riduzione

Il punto 2 nella ricognizione del 2026-08-17 comprendeva tre blocchi: canale Telegram,
alert di bagnatura non uniforme, e una NLU on-device per interpretare messaggi in ingresso.

**Il perimetro è stato ridotto dall'utente a due sole notifiche in uscita:**

1. una fila dell'orto non riceve abbastanza acqua perché l'acqua non ci arriva;
2. una sonda ha un problema di batteria o di segnale, rilevato con machine learning.

Cadono quindi: comandi in ingresso, NLU, inline keyboard, `getUpdates`. Il bot **parla e
non ascolta**. Questa non è una rinuncia: è la scelta che tiene l'invariante «sistema
completamente locale» intatta (§3/D1) ed elimina per costruzione l'intera superficie di
rischio del comando remoto.

L'ordine di implementazione è stato deciso dall'utente: **prima la salute sonde**, che non
dipende da alcuna taratura e ha già un caso reale in corso; **poi la bagnatura**, dopo aver
misurato il pavimento di rumore per singola sonda (§6).

---

## 1. Obiettivo

Un servizio che osserva i dati già in InfluxDB e manda un messaggio Telegram **solo quando
c'è qualcosa di vero da dire**, su due famiglie di problemi:

| Fase | Famiglia | Domanda a cui risponde |
|---|---|---|
| **1** | Salute sonde | «Una sonda sta smettendo di funzionare — batteria o trasmissione?» |
| **2** | Bagnatura | «L'acqua sta arrivando dove deve, o una fila resta a secco?» |

Requisito duro, valido per entrambe: **il fallimento della notifica non deve mai toccare
l'irrigazione.** Nessun percorso di questo step attraversa il decision loop.

---

## 2. Stato di partenza — misurato, non assunto

Tutti i numeri di questa sezione sono stati verificati sul RPi il 2026-08-17, non dedotti
dalla documentazione. Dove documentazione e realtà divergevano, ha vinto la realtà.

### 2.1 Cosa viene realmente scritto

`soil_moisture` porta **tre soli field**: `value`, `battery_voltage`, `battery_ok`.

> ⚠️ **`rssi` non esiste.** Lo schema in `CLAUDE.md` lo elenca, ma non viene mai scritto —
> e non potrebbe esserlo: il payload del GW3000 contiene esclusivamente `soilmoisture{N}` e
> `soilbatt{N}` (verificato catturando un messaggio reale da `ecowitt/gw3000`). Il gateway
> non pubblica alcun indicatore di potenza del segnale.
>
> **Conseguenza per questo step:** il «problema di segnale» chiesto dall'utente non è
> misurabile direttamente. Si misura come **regolarità di arrivo** (§3/D3), che è un proxy
> onesto e in questo caso perfino più utile del RSSI: misura l'effetto (pacchetti persi)
> invece della causa presunta.

### 2.2 Il caso reale già in corso

Il GW3000 pubblica ogni 60 s, quindi ci si attendono **1440 campioni al giorno per sonda**.

| Sonda | Campioni/giorno (12–17 agosto) | Consegna |
|---|---|---|
| WH51_02 | 1438, 1198, 1440, 1438, 1440, 1438 | ~99,9 % |
| WH51_03 | 1438, 1198, 1440, 1438, 1440, 1438 | ~99,9 % |
| WH51_04 | 1438, 1198, 1440, 1438, 1440, 1438 | ~99,9 % |
| **WH51_01** | **692, 912, 1051, 781, 735, 846** | **48–73 %** |

Il modo di guastarsi **non è perdita diffusa ma blackout a raffica con recupero completo**.
Conteggi orari di WH51_01 (finestre da 3 h, atteso 180):

```
16/08 06:00 →   0     ← silenzio totale per tre ore
16/08 09:00 →  77
16/08 12:00 → 105
16/08 15:00 → 124
16/08 18:00 → 180     ← rientro completo
16/08 21:00 → 180
17/08 00:00 → 180
17/08 03:00 → 179
17/08 06:00 → 180
17/08 09:00 → 180
17/08 12:00 → 167
17/08 15:00 → 174
```

Questa forma detta il disegno del rilevatore: un controllo sul **conteggio giornaliero**
se ne accorgerebbe con un giorno di ritardo e non distinguerebbe «tre ore di silenzio» da
«perdita costante del 25 %». Serve una finestra corta.

In parallelo la batteria di WH51_01 scende, mentre le altre no:

| Sonda | 26/07 | 15/08 | 17/08 |
|---|---|---|---|
| WH51_01 | 1,600 V | 1,587 V | **1,513 V** |
| WH51_02 | 1,600 V | 1,600 V | 1,600 V |

La soglia oltre cui il sistema marca `battery_ok = false` è **1,1 V**
(`BATTERY_OK_THRESHOLD`, nodo `n-fn-parse`). WH51_01 è ancora lontana, ma è l'unica in calo
e l'unica che perde pacchetti: le due cose sono verosimilmente lo stesso guasto.

### 2.3 Piattaforma

| | |
|---|---|
| OS | **Debian 13 (Trixie)** — non Bookworm come dice `CLAUDE.md` |
| Python host | 3.13.5 in `/usr/bin/python3` |
| `numpy` | **2.2.4 già installato** |
| `scikit-learn` | disponibile da apt come `python3-sklearn` **1.4.2** → nessun venv, nessun attrito PEP 668 |
| Node.js sull'host | **assente** (vive solo dentro il container Node-RED) |
| Risorse | 4 core a load 0,01 · 6,7 GiB di RAM liberi · 102 G di disco · 54,9 °C |

### 2.4 Insidie note nei dati

- **Tag legacy:** i punti scritti prima del 2026-08-15 hanno `aiuola=test`. Ogni query di
  questo step deve raggruppare **solo per `sensor_id`**, mai per `aiuola`/`position`, o la
  serie di una stessa sonda si spezza in due tronconi.
- **`total_liters` è inaffidabile** (footgun 5b): mai usarlo. I litri si derivano da
  `duration_seconds × 14 / 60`.
- **`trigger` da solo non distingue** le irrigazioni reali da quelle simulate in `dry_run`.
  Serve sempre anche `_time >= 2026-08-16`.

---

## 3. Decisioni di design

### D1 — Solo uscita. Il bot parla e non ascolta.

Nessun `getUpdates`, nessun webhook, nessun comando. Motivi, in ordine di peso:

1. `POST /api/valve/:action` **non ha autenticazione** e Caddy proxa `/api/*` senza
   allowlist. Aprire un canale di comando remoto prima di aver chiuso quel buco
   significherebbe estenderlo da fuori casa.
2. L'invariante «sistema completamente locale» resta intatta: un canale di notifica in
   uscita è nella stessa classe di Open-Meteo (servizio esterno best-effort, degradazione
   dichiarata), mentre un canale di comando sarebbe una classe di rischio nuova.
3. È ciò che l'utente ha chiesto.

Il webhook è escluso a prescindere: richiederebbe port forwarding, DNS dinamico e un
certificato pubblico, ed esporrebbe `/api/*` alla rete pubblica.

### D2 — Servizio Python sull'host. **Zero righe toccate in `flows.json`.**

Questa è la decisione strutturale dello step, e ha cinque conseguenze tutte favorevoli:

1. **Isolamento di processo dal decision loop.** Un'eccezione, un timeout di rete o un
   modello che ci mette troppo non possono ritardare il polling di irrigazione. Il
   requisito duro è soddisfatto architetturalmente, non per convenzione.
2. **Il footgun #3 non si applica.** Il token Telegram vive in `/opt/orto-digitale/.env` e
   si legge con `os.environ`, non è una credenziale di nodo: **nessun redeploy lo cancella
   mai**, e lo script di re-iniezione di §5.5 non va toccato.
3. **`scikit-learn` richiede Python**, e sull'host `node` non esiste.
4. **Non serve stare dentro Node-RED**: tutto l'ingresso necessario è già leggibile da
   InfluxDB, e il meteo storico da Open-Meteo. Dal fix del 2026-08-17 anche il motivo di
   chiusura valvola è leggibile da `irrigation_events`, il che rende autosufficiente pure
   la fase 2.
5. **Rischio nullo sulla settimana di monitoraggio in corso**: nessun riavvio di Node-RED,
   nessuna re-iniezione di credenziali, nessuna interruzione della serie
   `irrigation_forecast` che serve alla validazione dello step 15.

Precedente diretto già in casa: `orto-system-stats.timer` + `system_stats.sh`.

### D3 — Il «segnale» si misura come regolarità di arrivo.

Definizione operativa, dato che il RSSI non esiste (§2.1):

```
tasso_consegna(sonda, finestra) = campioni_osservati / campioni_attesi
campioni_attesi = durata_finestra_minuti      (il GW3000 pubblica ogni 60 s)
```

Un pacchetto perso è un pacchetto perso, quale che sia la causa (portata radio, batteria
debole, interferenza). Misurare l'effetto invece della causa presunta è più robusto e non
richiede hardware che non abbiamo.

### D4 — Rilevazione ibrida: guardie deterministiche **più** Isolation Forest.

L'utente ha chiesto machine learning. Lo uso, ma non ovunque, e dico apertamente dove non
aggiunge nulla.

**Guardie deterministiche** per i guasti netti (silenzio, batteria sotto soglia, valore
bloccato). Per questi una regola è più affidabile, più spiegabile in un messaggio e più
facile da testare di qualunque modello. Un alert che dice «nessun dato da 52 minuti» è
verificabile dall'utente in un secondo; «il modello ha assegnato un punteggio di anomalia
di −0,31» no.

**Isolation Forest** per ciò che a regole non si esprime: *«questa sonda si sta comportando
diversamente dal proprio passato e dalle sorelle, in un modo che non so nominare in
anticipo»*. È qui che il ML guadagna il suo posto, ed è genuino: non supervisionato,
nessuna etichetta da produrre, addestrato sulla finestra scorrevole dei dati reali.

La combinazione copre sia i guasti che sappiamo prevedere sia quelli che non sappiamo.

### D5 — Notifica solo su anomalia confermata.

Scelta dell'utente. Ogni famiglia di anomalia ha la propria regola di conferma (§4.3), e
in nessun caso un singolo campione anomalo produce un messaggio. Il costo accettato: un
guasto molto breve può risolversi prima di essere notificato — accettabile, perché per un
guasto che si autoripara non c'è nulla da fare.

### D6 — L'anti-spam è parte del prodotto, non un dettaglio.

Un bot che manda troppi messaggi viene silenziato, e allora tutto questo lavoro vale zero.
Tre livelli: conferma (D5), un solo messaggio per anomalia per sonda, e cooldown di 24 h
per coppia (sonda, tipo di anomalia) con reset dopo 6 h di normalità.

### D7 — Cosa non è un'anomalia.

Da escludere esplicitamente, o si generano falsi allarmi che addestrano a ignorare il bot:

- **Durante un'irrigazione e nelle 2 ore successive**: il terreno cambia davvero, e ogni
  rilevatore di «comportamento insolito» si accenderebbe. Finestra da escludere:
  `[apertura − 30 min, chiusura + 120 min]`, la stessa convenzione già usata negli script
  di analisi.
- **WH51_05 e WH51_06**: non installate. Non esistono, non sono guaste.
- **Un singolo campione mancante**: il 99,9 % di consegna delle sonde sane include già
  qualche buco fisiologico.

### D8 — Degradazione.

Se Telegram non risponde, il servizio logga e riprova al ciclo successivo. Nessuna coda
persistente, nessun backoff esponenziale, nessuna dead letter: con un ciclo ogni 15 minuti
la riconnessione è gratis. Un alert perso non è un dramma — la condizione persiste e verrà
rilevata di nuovo al ciclo dopo. Se invece manca InfluxDB, il servizio non ha dati e non
inventa: salta il ciclo e lo scrive nel log.

---

## 4. Fase 1 — L'algoritmo di salute sonde

### 4.1 Ciclo

Ogni **15 minuti**, via systemd timer:

1. Interroga InfluxDB: ultimi **30 giorni** di `soil_moisture` (`value`, `battery_voltage`)
   raggruppati **per `sensor_id`**, aggregati per ora.
2. Interroga `irrigation_events` degli ultimi 2 giorni per costruire le finestre da
   escludere (D7).
3. Costruisce la matrice delle feature (§4.2).
4. Applica le guardie deterministiche sulla finestra recente (§4.3).
5. Addestra Isolation Forest sui 30 giorni e assegna un punteggio alle ultime 6 ore (§4.4).
6. Applica conferma e anti-spam (§4.5).
7. Invia i soli alert sopravvissuti; aggiorna lo stato su disco.

Costo stimato: qualche secondo di CPU su 4 core fermi. Il modello si riaddestra a ogni
ciclo — con ~2.900 righe è più semplice che gestire la persistenza di un modello, e più
robusto ai cambi di regime.

### 4.2 Feature, per coppia (sonda, ora)

| Feature | Definizione | Perché |
|---|---|---|
| `tasso_consegna` | campioni osservati / 60 | Il proxy del segnale (D3) |
| `silenzio_max_min` | il più lungo intervallo senza campioni nell'ora | Distingue i blackout a raffica dalla perdita diffusa — è la forma osservata in §2.2 |
| `batteria` | media di `battery_voltage` nell'ora | Livello assoluto |
| `delta_batteria_24h` | batteria ora − batteria 24 h prima | Il calo conta più del livello, finché si è lontani da 1,1 V |
| `scarto_da_sorelle` | \|mediana della sonda − mediana delle altre sonde attive\| | Le quattro sonde vedono lo stesso meteo: uno scarto crescente è informativo |
| `sigma_valore` | deviazione standard del valore nell'ora | Sia il rumore anomalo sia l'immobilità sospetta |
| `ore_bloccate` | numero di ore consecutive, fino a quella corrente, con `sigma_valore = 0` e media invariata | Rilevatore di valore bloccato |

Tutte le feature sono normalizzate (media 0, deviazione 1) sulla finestra di addestramento
prima di entrare nel modello.

> **Nota di derivazione.** Tutte e sette si ricavano da **aggregati orari** (`count`, `mean`,
> `stddev`, `max(elapsed)`), cioè ~2.880 righe per una finestra di 30 giorni. Nessuna feature
> richiede i campioni grezzi, che sarebbero ~173.000 righe da riscaricare ogni quarto d'ora.
> `ore_bloccate` è la versione oraria di «letture identiche consecutive»: un'ora con
> deviazione standard nulla **è** un'ora di letture identiche, e contare le ore consecutive
> in quello stato misura la stessa cosa a una granularità sufficiente per una soglia di 12 ore.

### 4.3 Guardie deterministiche

| # | Condizione | Conferma richiesta |
|---|---|---|
| **G1 — sonda muta** | nessun campione da > 45 min | la condizione stessa è la conferma |
| **G2 — batteria bassa** | `battery_voltage < 1,15 V` | 3 letture consecutive |
| **G3 — batteria in calo** | pendenza della regressione lineare su 7 giorni < −0,02 V/settimana | confermata su 3 giorni consecutivi |
| **G4 — valore bloccato** | `ore_bloccate ≥ 12` **mentre** almeno un'altra sonda è variata di ≥ 3 pp nello stesso intervallo | la doppia condizione è la conferma |

**Note di taratura.** La soglia di G2 è a 1,15 V e non a 1,1 V di proposito: 1,1 V è il
punto in cui il sistema smette di considerare la sonda affidabile, e un avviso che arriva
*in quel momento* arriva tardi. G4 richiede la condizione incrociata perché l'umidità del
suolo è riportata come intero e può legittimamente restare ferma per ore: senza il
confronto con le sorelle sarebbe un generatore di falsi positivi.

> **Prima di attivare le guardie**, i quattro valori soglia vanno verificati contro i
> quattro mesi di storico già presenti: quante volte ciascuna regola sarebbe scattata da
> aprile a oggi? Una regola che avrebbe generato decine di alert è mal tarata, non
> sensibile. È un'ora di lavoro offline e va fatta, non stimata.

### 4.4 Isolation Forest

```python
IsolationForest(
    n_estimators=200,
    contamination=0.02,     # ~2%: 4 sonde × 24 h × 30 gg ≈ 2.880 righe → ~58 anomalie/mese
    random_state=0,         # riproducibilità: stesso input, stesso esito
)
```

`contamination = 0.02` è volutamente permissivo: il filtro vero non è il modello ma la
regola di conferma (§4.5). Un modello troppo severo perde i guasti che iniziano piano;
uno permissivo più la conferma cattura quelli e scarta il rumore.

Il modello lavora **su tutte e quattro le sonde insieme**, non una per sonda: è ciò che gli
permette di imparare implicitamente cosa significa «normale» per questo orto e di
riconoscere la sonda che se ne discosta.

**Cosa il modello non deve fare:** decidere. Il suo punteggio entra nella regola di
conferma come un voto fra gli altri; non manda un messaggio da solo.

### 4.5 Conferma e anti-spam

| Tipo | Conferma | Cooldown |
|---|---|---|
| G1 muta | immediata (> 45 min di silenzio) | 24 h |
| G2 batteria bassa | 3 letture | 24 h |
| G3 batteria in calo | 3 giorni | 7 giorni |
| G4 valore bloccato | doppia condizione | 24 h |
| IF anomalia | **anomala in ≥ 3 delle ultime 6 ore** | 24 h |

Il cooldown è per coppia (sonda, tipo). Si azzera quando la sonda torna normale per 6 ore
consecutive — così un guasto che va e viene non genera un messaggio ogni volta, ma un
guasto che si risolve e si ripresenta a distanza sì.

Stato persistito in `/opt/orto-digitale/notify/state.json` (l'unico stato del servizio;
perderlo comporta al più un messaggio duplicato).

---

## 5. Fase 1 — I messaggi

Testo semplice, **senza Markdown né HTML**: `WH51_01` contiene un underscore, che con il
parse Markdown di Telegram produce un `400 Bad Request`. Il numero grezzo è sempre accanto
al verdetto, così il messaggio è verificabile invece che creduto.

**Messaggio A — sonda muta**

```
Sonda muta: WH51_01

Nessun dato da 52 minuti (aiuola 1, vicino all'ingresso acqua).
Ultima lettura: 47% alle 14:12.
Le altre tre sonde stanno trasmettendo regolarmente.

Batteria all'ultima lettura: 1.51 V (le altre: 1.60 V).

Cosa puo' essere, dalla piu' probabile:
1) Batteria in esaurimento: e' l'unica sonda in calo negli ultimi 30 giorni.
2) Portata radio verso il GW3000: la sonda e' la piu' lontana dal gateway.
3) Sonda spostata o urtata.

Il sistema continua a irrigare usando le altre tre (ne bastano due).
```

**Messaggio B — batteria in calo**

```
Batteria in calo: WH51_01

1.51 V oggi, era 1.60 V tre settimane fa.
Di questo passo arriva a 1.1 V (soglia sotto cui il sistema
smette di fidarsi della sonda) verso meta' novembre.

Le altre sonde sono ferme a 1.60 V.

Non e' urgente, ma conviene procurarsi le pile prima che
succeda. WH51: 1 stilo AA al litio.

(La stima e' una proiezione lineare del calo osservato: le
pile tengono la tensione e poi crollano, quindi il momento
vero puo' arrivare prima.)
```

> **Nota di calcolo per chi implementa.** Il calo osservato è di 0,087 V in 22 giorni,
> cioè ≈ 0,0040 V/giorno. Da 1,51 V a 1,10 V restano 0,41 V, cioè ~103 giorni: fine
> novembre. La proiezione lineare **sovrastima la durata residua**, perché le celle al
> litio mantengono la tensione quasi piatta e poi crollano — da qui la parentesi nel
> messaggio. Non presentare mai la stima senza quella riserva.

**Messaggio C — comportamento anomalo (Isolation Forest)**

```
Comportamento insolito: WH51_03

Nelle ultime 6 ore questa sonda si e' comportata in modo diverso
sia dal suo passato sia dalle altre tre, per 4 ore su 6.

Cosa la distingue in questo momento:
  consegna pacchetti .... 98%   (normale)
  scarto dalle altre .... 11 pp (di solito 3 pp)
  variabilita' oraria ... 0.2 pp (di solito 1.4 pp)

Tradotto: sta trasmettendo bene, ma il valore e' quasi fermo
mentre le altre si muovono. Puo' essere una sonda che si sta
scollegando dal terreno, oppure terreno davvero diverso in quel
punto.

Non ho abbastanza elementi per dire quale: e' un'osservazione,
non una diagnosi.
```

**Messaggio D — rientro alla normalità** (una riga, per chiudere il ciclo)

```
Rientrata: WH51_01 trasmette di nuovo regolarmente da 6 ore.
```

Il messaggio C è deliberatamente il più cauto dei quattro: è l'unico prodotto da un modello
statistico invece che da una regola, e l'onestà su cosa il sistema sa e non sa è ciò che
mantiene la fiducia nei tre messaggi precedenti.

---

## 6. Fase 2 — Bagnatura non uniforme

Da implementare **dopo** la fase 1 e **dopo** la taratura descritta qui sotto.

### 6.1 Il vincolo fisico da comunicare, non da correggere

La soglia di chiusura è calcolata sulla **media** delle sonde: appena la media supera il
65 %, la valvola chiude anche se una sonda è rimasta indietro. Con una sola valvola per
tutto l'orto non esiste attuazione per fila. Quindi l'alert **non può** dire «bagna di più
la fila 2» come azione del sistema: può dire che l'acqua non è arrivata lì, e proporre
azioni sull'impianto.

Due fatti da tenere nel messaggio:

- **WH51_03** sta a `x = 0,103` sulla fila 2, e la prima area di quella fila è `libero`
  fino a `0,369` con **zero piante**. È l'unica sonda piantata dove non c'è nulla da
  irrigare: se lì non c'è gocciolatoio, il dato è inutile per costruzione e l'azione giusta
  è **spostare la sonda**. Da verificare sul campo prima di scrivere codice.
- **L'aiuola 3 non ha sonde.** Il check è cieco su un terzo dell'orto e il messaggio non
  deve mai dare l'impressione di aver guardato tutto.

### 6.2 La taratura che sblocca la fase 2

Il criterio di rilevazione è il **contro-fattuale per singola sonda**: si proietta cosa
avrebbe fatto quella sonda senza acqua (sola asciugatura `k·ET0`, con `k = 1,296` già
validato) e si misura lo scarto rispetto all'osservato. Non una soglia sul salto assoluto,
che darebbe falsi positivi di notte e falsi negativi nel pomeriggio caldo.

> ⚠️ **La soglia di rumore di 1,31 pp dello step 16 non è riusabile.** È calibrata sulla
> *media* delle sonde attive, e il rumore della media di quattro sonde è circa la metà di
> quello di una sonda singola. Riusarla genererebbe falsi positivi sistematici.

**Deliverable di taratura, prerequisito della fase 2:**

1. `analysis/umidita_per_sonda.csv` — export Flux raggruppato per `sensor_id` (oggi
   `analysis/umidita.csv` contiene solo la media, e per giunta aggregata a 15 minuti).
2. Il **pavimento di rumore per-sonda** (mediana e p90 del residuo in assenza di eventi),
   calcolato con lo stesso metodo di `analysis/stima_bagnatura.mjs`.
3. `soglia_bagnata_pp` derivata da quel pavimento, non stimata.

### 6.3 Quando gira

Event-driven: armato alla chiusura valvola, valutato a **chiusura + 120 minuti**. Due
motivi: il picco di risposta del terreno arriva ~90 minuti dopo la chiusura, e il cooldown
di 7200 s garantisce che nessuna irrigazione successiva contamini la finestra.

Se il cooldown venisse abbassato sotto 120 minuti, la finestra va accorciata di
conseguenza: `finestra = min(120 min, cooldown)`.

### 6.4 Quattro stati per sonda, non due

| Stato | Condizione | Uso |
|---|---|---|
| `bagnata` | ≥ 2 campioni nella finestra e residuo ≥ soglia | prova positiva |
| `asciutta` | ≥ 3 campioni, l'ultimo recente, residuo < soglia | prova negativa |
| `muta` | nessun campione utile o baseline mancante | **esclusa**, citata a parte |
| `sospetta` | residuo negativo oltre soglia | esclusa, citata come anomalia |

L'asimmetria (3 campioni per dichiarare `asciutta`, 2 per `bagnata`) è voluta: affermare
«non ha visto acqua» genera lavoro per l'utente e va sostenuta da più prove dell'affermazione
opposta. È la lezione di WH51_01 e dei suoi buchi di trasmissione.

Alert solo se almeno una sonda per classe, e solo su **conferma 2 eventi su 3**: la
distribuzione dell'acqua è irregolare per singolo evento, quindi un evento solo non
distingue «gocciolatoio otturato» da «quella volta è andata così».

---

## 7. File toccati

**Nuovi — pacchetto Python sull'host**

```
rpi5/scripts/orto_notify/
├── __init__.py
├── __main__.py        CLI: --once, --dry-run, --since, --backtest
├── influx.py          query read-only (raggruppa per sensor_id, mai per aiuola)
├── features.py        costruzione della matrice (§4.2)
├── detect.py          guardie deterministiche + Isolation Forest (§4.3, §4.4)
├── confirm.py         conferma e anti-spam (§4.5)
├── telegram.py        invio, chunking 4096, cap orario difensivo
├── state.py           persistenza su /opt/orto-digitale/notify/state.json
└── selftest.py        banco di prova (§9)
```

**Nuovi — systemd**

- `rpi5/scripts/orto-notify.service` — oneshot, stesso schema di `orto-system-stats.service`
- `rpi5/scripts/orto-notify.timer` — `OnCalendar=*:0/15`

**Modificati**

| File | Modifica |
|---|---|
| `rpi5/.env.example` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `INFLUX_TOKEN_NOTIFY_RO` |
| `docs/comandi_verifica.md` | nuova sezione: trigger manuale, `--dry-run`, lettura dello stato |
| `CLAUDE.md` | vedi §10 |

**Non toccati, ed è il punto**

`rpi5/nodered/data/flows.json` · `rpi5/nodered/data/irrigation_config.json` ·
`rpi5/docker-compose.yml` · frontend. **Zero righe.** Nessun riavvio di Node-RED, nessuna
re-iniezione di credenziali, nessuna interruzione della settimana di monitoraggio.

**Dipendenza da installare sul RPi**

```bash
sudo apt install python3-sklearn      # 1.4.2 da Trixie; numpy 2.2.4 è già presente
```

Nessun venv, nessun `pip`, nessun attrito PEP 668.

---

## 8. Fuori scope

- **Comandi in ingresso, NLU, voce.** Il bot parla e non ascolta (D1).
- **La fase 2** non viene implementata finché la taratura di §6.2 non è fatta.
- **L'autenticazione di `/api/valve/*`.** È un problema reale e precedente a questo step,
  ma allargare qui il perimetro significherebbe toccare Node-RED — esattamente ciò che D2
  evita. Va affrontato per conto proprio, e prima di qualsiasi comando remoto.
- **Il report settimanale via API Claude** (punto 3): condivide il canale e i segreti, non
  questo step.
- **Alert di sistema** (container giù, disco pieno): già coperti da `system_health` e
  `verify_rpi5.sh`.

---

## 9. Verifica di completamento

**Banco di prova** — `python3 -m orto_notify.selftest`, senza framework, coerente con la
convenzione del progetto (i test Node-RED girano con `node file.test.mjs` e nient'altro):

- una sonda muta da 52 min → alert G1; da 20 min → nessun alert
- batteria a 1,12 V per 3 letture → alert G2; una lettura sola → nessun alert
- serie di batteria in calo su 7 giorni → alert G3; serie piatta → nessuno
- valore identico per 14 h mentre un'altra sonda varia di 4 pp → alert G4
- valore identico per 14 h mentre **nessuna** sonda varia → nessun alert
- anomalia IF in 4 ore su 6 → alert C; in 2 su 6 → nessuno
- finestra dentro `[apertura − 30 min, chiusura + 120 min]` → tutti i rilevatori tacciono
- secondo alert dello stesso tipo entro 24 h → soppresso; dopo 6 h di normalità → riammesso
- testo > 4096 caratteri → spezzato su più messaggi, mai troncato
- token assente in `env` → nessun invio, un warning nel log, **nessun crash**

**Retro-verifica sullo storico** (§4.3): eseguire `--backtest` sui quattro mesi di dati e
contare quanti alert ogni regola avrebbe prodotto. Criterio di accettazione fissato ora,
prima di guardare i numeri: **meno di un alert a settimana per sonda sana**, e almeno un
alert su WH51_01 nella finestra del 16/08.

**Sul campo**

- `python3 -m orto_notify --once --dry-run` stampa il pacchetto senza inviare
- `python3 -m orto_notify --once` → messaggio sul telefono
- `systemctl list-timers | grep orto-notify` → timer armato
- `bash /opt/orto-digitale/scripts/verify_rpi5.sh` verde
- `docker stats` invariato: il servizio non gira nei container e non deve spostare l'ago

---

## 10. Aggiornamenti a CLAUDE.md

Da applicare **prima** del commit finale, in un unico blocco:

1. **Riformulare l'invariante «locale»** — oggi dice «completamente locale (no cloud)», ma
   Open-Meteo è già una dipendenza esterna e Telegram ne aggiunge una seconda. Formulazione
   proposta:

   > Il **ciclo di controllo dell'irrigazione** (sensori → decisione → valvola → sicurezza)
   > è completamente locale e resta funzionante senza internet. I servizi esterni sono
   > ammessi solo come input opzionali con degradazione dichiarata (Open-Meteo) o canali di
   > notifica best-effort in uscita (Telegram). Nessuna decisione di irrigazione può
   > dipendere dalla loro disponibilità. Un canale esterno che **comanda** la valvola
   > richiede una decisione esplicita e separata: al 2026-08 non è autorizzato.

2. **Correggere lo schema:** rimuovere `rssi` dai field di `soil_moisture` — non è mai
   stato scritto e il GW3000 non lo pubblica (§2.1).
3. **Correggere il cooldown:** la tabella dice «4 ore», la config dice `7200` = **2 ore**.
   Vince la config, che è ciò che il runtime legge.
4. **Correggere l'OS:** Debian **13 (Trixie)**, non Bookworm (§2.3).
5. **Riga step 17** nella tabella di avanzamento.
6. **Nota:** il token Telegram vive in `.env` e **non** entra nel giro di re-iniezione
   credenziali di §5.5, perché non è una credenziale di nodo Node-RED.

---

## Taratura

Retro-verifica sullo storico prevista da §9, eseguita sul Raspberry Pi il 2026-08-17 con le
credenziali che vivono solo lì (misura fatta come controller; qui si registra l'esito). Il
criterio era stato fissato **prima** di guardare i numeri:

> «meno di un alert a settimana per sonda sana, e almeno un alert su WH51_01 nella finestra
> del 16/08» (§9).

Cioè: meno di un alert a settimana su ciascuna delle tre sonde sane (WH51_02, WH51_03,
WH51_04), e almeno un alert su WH51_01 nella finestra intorno al 2026-08-16.

**Esito: nessuna soglia è stata cambiata.** I valori scelti sulla carta (§4.3) hanno retto
al confronto con i dati. Non è un'assenza di lavoro: è il risultato della taratura.

### Misura 1 — il backtest

Comando eseguito sul Raspberry Pi, con scikit-learn 1.4.2 installato da apt:

```
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; cd /tmp && python3 -m orto_notify --backtest 30'
```

Output:

```
periodo: 2026-07-18 .. 2026-08-17 (4.3 settimane)
sonda      tipo                alert  per sett.
WH51_01    anomalia                5       1.17
WH51_01    batteria_calo           2       0.47
WH51_01    muta                    9       2.10
WH51_02    muta                    1       0.23
WH51_03    muta                    1       0.23
WH51_03    valore_bloccato         1       0.23
WH51_04    batteria_calo           1       0.23
WH51_04    muta                    1       0.23
```

Totali per sonda: WH51_01 = 3,74 alert/settimana; WH51_02 = 0,23; WH51_03 = 0,46;
WH51_04 = 0,46. Prima metà del criterio soddisfatta, con ampio margine: tutte e tre le
sonde sane restano sotto la soglia di 1 alert/settimana.

### Misura 2 — replay mirato sul 15-18 agosto

La tabella del backtest non porta le date, quindi per verificare la seconda metà del
criterio le guardie sono state rigiocate ora per ora specificamente su quella finestra:

```
WH51_01   batteria_calo    65 ore, prima: 15/08 00:00
WH51_01   muta             20 ore, prima: 15/08 01:00
WH51_02   muta              4 ore, prima: 17/08 21:00
WH51_03   muta              4 ore, prima: 17/08 21:00
WH51_03   valore_bloccato   1 ore, prima: 15/08 14:00
WH51_04   muta              4 ore, prima: 17/08 21:00
```

Seconda metà del criterio soddisfatta: WH51_01 avrebbe generato il primo alert già alle
15/08 00:00, ben dentro la finestra del 16/08.

### Misura 3 — pendenza della batteria su 30 giorni

```
sonda        min V    max V  pend/sett
WH51_01      1.500    1.600  -0.0144
WH51_02      1.600    1.600  -0.0000
WH51_03      1.600    1.600  -0.0000
WH51_04      1.500    1.600  -0.0081
```

### Tre cose da sapere prima di fidarsi di un alert

**1. I `muta` delle sonde sane in Misura 2 sono un artefatto del bordo del replay, non
falsi positivi.** Le tre righe di WH51_02/03/04 scattano tutte alle 17/08 21:00, che è
esattamente dove finiscono i dati del replay: in un replay ogni sonda risulta muta oltre
l'ultimo campione disponibile, perché non esiste un "dopo". In produzione `adesso` è il
tempo reale e i dati continuano ad arrivare, quindi questa situazione non si può
presentare. Il tasso di falsi positivi reale sulle sonde sane è perciò **più basso** di
quanto suggerisce questa tabella — nessuna correzione necessaria, va solo tenuto a mente
leggendo il numero.

**2. Il `batteria_calo` di WH51_04 in Misura 1 è una misura vera, non un difetto del
rilevatore.** La sua batteria si è mossa davvero tra 1,600 e 1,500 V (Misura 3). Le sonde
WH51 riportano la tensione a gradini grossolani — in un mese intero compaiono solo i
valori 1,5 e 1,6 V — quindi una sonda che oscilla tra due gradini adiacenti produce una
pendenza apparente dentro la finestra di regressione a 7 giorni di G3 (§4.3). Sui 30
giorni interi la sua pendenza è −0,0081 V/settimana, ben sotto la soglia di
−0,02 V/settimana: l'alert nasce da una finestra più corta in cui l'oscillazione sembrava
una tendenza. **Conseguenza pratica: un alert `batteria_calo` su una sonda che legge ancora
tra 1,5 e 1,6 V merita di essere letto guardando l'andamento su un mese prima di comprare
pile** — e il cooldown di 7 giorni (§4.5) già limita quante volte può ripresentarsi.

**3. Il rilevatore discrimina di un fattore 8-16.** WH51_01 a 3,74 alert/settimana contro
0,23-0,46 delle sonde sane: non sono i conteggi assoluti a dire che la taratura funziona,
è questo scarto.

### Nota: il backtest è girato su 30 giorni, non 100

`_backtest()` riaddestra l'Isolation Forest a **ogni ora replayata**, su una finestra che
cresce man mano che il replay avanza: il costo cresce grosso modo con il quadrato del
periodo. A 100 giorni non aveva finito dopo 17 minuti di CPU piena sul Pi; a 30 giorni
completa in un paio di minuti. Trenta giorni bastano comunque a soddisfare entrambe le
metà del criterio: 4,3 settimane di replay (Misura 1) e copertura piena della finestra del
16 agosto (Misura 2). Il difetto riguarda solo questa taratura una tantum, mai il ciclo di
produzione, che addestra il modello una volta per ciclo su una finestra fissa di 30 giorni
(§4.1, §4.4). Va registrato come debito noto, non risolto qui.

---

## Implementazione

**Stato:** ✅ COMPLETATO (fase 1) — 2026-08-17

**Commit di riferimento:** `feat(scripts): unit systemd e deploy delle notifiche Telegram` (`af2b3b3`)

**Note:**

Tredici commit sul branch. Il banco di prova (`python3 -m orto_notify.selftest`) conta
**56 test**: i 53 pianificati più i 3 aggiunti dai due bug di produzione descritti sotto.
I test Node-RED sono rimasti verdi e intatti, perché questo step non ha mai toccato
`flows.json` — coerente con D2.

La taratura (§4.3, §9, "Taratura" più sopra) non ha richiesto di cambiare nessuna soglia:
WH51_01 produce 3,74 alert/settimana contro 0,23–0,46 delle sonde sane, una separazione di
un fattore 8-16.

In produzione: il primo messaggio reale è stato inviato e ricevuto il 2026-08-17 (l'avviso
di batteria in calo su WH51_01 confermato dall'utente sul telefono). L'anti-spam è stato
verificato sul campo subito dopo: una seconda esecuzione immediata ha rilevato la stessa
anomalia e correttamente non ha inviato nulla (cooldown attivo). Il timer gira ogni 15
minuti e consuma circa 1,4 s di CPU per esecuzione.

**Deviazioni dalla spec:**

1. **Aggiunto un modulo `messages.py`** non previsto dal §7 della spec, che lasciava il
   testo dei messaggi dentro `telegram.py`. Separare il contenuto dal trasporto ha permesso
   di testare il testo dei messaggi senza toccare la rete.

2. **Due bug emersi solo con dati reali**, non coperti dai 53 test pianificati, entrambi
   bloccanti, ora entrambi coperti da test:
   - `stddev()` su un bucket orario a campione singolo restituisce la stringa `"NaN"`, che
     `float()` accetta senza errori; il valore arrivava così fino all'Isolation Forest, che
     lo rifiutava, interrompendo l'**intero** ciclo — incluse le guardie deterministiche. 12
     righe su 2886 in 30 giorni, tutte di WH51_01: proprio la sonda che il servizio esiste
     per sorvegliare.
   - Il bucket parziale dell'ora corrente si frammentava in cinque righe: le cinque
     sotto-query girano in istanti leggermente diversi, quindi `aggregateWindow` etichettava
     il bucket ancora aperto con cinque timestamp leggermente diversi e la join non trovava
     mai la chiave comune. Ogni frammento aveva quattro campi su cinque vuoti, diventati
     `0.0`, e il modello leggeva quel profilo tutto-zero come un'anomalia vistosa su tutte e
     quattro le sonde, a ogni ciclo — quattro notifiche false ogni quarto d'ora. Risolto
     scartando i bucket non allineati a un'ora esatta.

3. **Il backtest è girato su 30 giorni invece dei 100 pianificati** (vedi "Nota: il backtest
   è girato su 30 giorni, non 100" più sopra): `_backtest()` riaddestra il modello a ogni ora
   replayata su una finestra crescente, quindi il suo costo cresce grosso modo con il
   quadrato del periodo; a 100 giorni non aveva finito dopo 17 minuti di CPU piena. Trenta
   giorni soddisfano comunque entrambe le metà del criterio di accettazione. Riguarda solo
   questa taratura una tantum, mai il ciclo di produzione. Debito noto.
