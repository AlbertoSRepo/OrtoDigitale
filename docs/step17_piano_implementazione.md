# Step 17 (fase 1) — Notifiche Telegram: salute sonde — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un servizio che osserva i dati già in InfluxDB e manda un messaggio Telegram quando una sonda ha un problema di batteria o di trasmissione — solo su anomalia confermata, mai su rumore transitorio.

**Architecture:** pacchetto Python eseguito **sull'host** del RPi (fuori da Docker), avviato da un systemd timer ogni 15 minuti, sullo schema già in uso per `orto-system-stats`. Legge InfluxDB via HTTP in sola lettura, rileva le anomalie con guardie deterministiche più un Isolation Forest non supervisionato, e invia su Telegram. **Zero righe toccate in `flows.json`**: il fallimento della notifica non può raggiungere il decision loop, e non serve nessun riavvio di Node-RED.

**Tech Stack:** Python 3.13 (stdlib: `urllib`, `csv`, `json`, `statistics`), `numpy` 2.2.4 (già installato), `scikit-learn` 1.4.2 (da `apt install python3-sklearn`), InfluxDB 2 via HTTP `/api/v2/query` (Flux), Telegram Bot API `sendMessage`.

**Spec:** [`docs/step17_notifiche_telegram.md`](./step17_notifiche_telegram.md)

## Global Constraints

Valori copiati dalla spec. Valgono per **ogni** task.

- **Branch:** `step/17-notifiche-fase1`. `main` deve restare deployabile in ogni momento.
- **Zero modifiche a produzione Node-RED**: mai toccare `rpi5/nodered/data/flows.json`, `rpi5/nodered/data/irrigation_config.json`, `rpi5/docker-compose.yml`, il frontend. Se un task sembra richiederlo, è il task a essere sbagliato.
- **Nessun `pip`, nessun venv.** Le sole dipendenze sono `numpy` (già presente) e `python3-sklearn` (da apt). Il RPi è Debian 13 Trixie, Python 3.13.5 in `/usr/bin/python3`.
- **Token InfluxDB**: riusare `INFLUX_TOKEN_EXPORT_RO`, che **esiste già** in `/opt/orto-digitale/.env` ed è di sola lettura (verificato). Non generare token nuovi.
  > ⚠️ Il nome in `.env` è `INFLUX_TOKEN_EXPORT_RO`; `rpi5/.env.example` lo chiama `INFLUXDB_TOKEN_EXPORT_RO`. È la stessa incongruenza documentata nel footgun #1 di `CLAUDE.md`: **il codice segue `.env`**, e non si aggiungono alias nuovi.
- **Endpoint InfluxDB**: `http://localhost:8086/api/v2/query?org=orto-digitale`, header `Authorization: Token <t>`, `Content-Type: application/vnd.flux`, `Accept: application/csv`. Bucket `garden`.
- **Raggruppare SOLO per `sensor_id`.** Mai per `aiuola` o `position`: i punti scritti prima del 2026-08-15 hanno `aiuola=test` e la serie di una stessa sonda si spezzerebbe in due tronconi.
- **Sonde reali:** `WH51_01`, `WH51_02`, `WH51_03`, `WH51_04`. `WH51_05`/`06` non sono installate: non esistono, non sono guaste.
- **Campioni attesi:** `60` all'ora (il GW3000 pubblica ogni 60 s), `1440` al giorno.
- **Soglie di rilevazione** (spec §4.3): `SILENZIO_MIN = 45` minuti · `BATTERIA_BASSA_V = 1.15` · `BATTERIA_PENDENZA_V_SETT = -0.02` · `ORE_BLOCCATE = 12` con almeno un'altra sonda variata di `≥ 3` pp · IF anomala in `≥ 3` delle ultime `6` ore.
- **La soglia di produzione `battery_ok` è 1.1 V** (`BATTERIA_CRITICA_V`), definita in `n-fn-parse`. Non modificarla: serve solo come riferimento nei messaggi.
- **Isolation Forest:** `n_estimators=200`, `contamination=0.02`, `random_state=0`. Il `random_state` fisso è obbligatorio: stesso input, stesso esito, altrimenti i test non sono riproducibili.
- **Anti-spam:** cooldown `24 h` per coppia (sonda, tipo); `7 giorni` per il tipo `batteria_calo`; azzeramento dopo `6 h` di normalità continua.
- **Finestra di esclusione irrigazione:** `[apertura − 30 min, chiusura + 120 min]`. Dentro, tutti i rilevatori tacciono.
- **Telegram:** testo semplice, **mai Markdown né HTML** (`WH51_01` contiene un underscore che fa fallire il parse con `400 Bad Request`). Limite `4096` caratteri per messaggio: si spezza sui paragrafi, non si tronca.
- **Stato persistito:** `/opt/orto-digitale/notify/state.json`.
- **Test senza framework**: `python3 -m orto_notify.selftest`, con `assert` nudi, coerente con la convenzione del progetto (i test Node-RED girano con `node file.test.mjs` e nient'altro). Niente pytest.
- **Nessuna rete nei test.** Il selftest non deve mai chiamare InfluxDB né Telegram: si inietta un finto trasporto.
- **Deploy/accesso RPi:** `ssh as@192.168.1.12` (Ethernet, primario, verificato funzionante il 2026-08-17) — se non risponde, `ssh as@192.168.1.46` (WiFi).
- **Commit in italiano**, Conventional Commits, scope `scripts` o `docs`.

---

## Struttura dei file

| File | Responsabilità |
|---|---|
| `rpi5/scripts/orto_notify/__init__.py` | costanti condivise (sonde, soglie, percorsi) — **unica sede** dei valori numerici |
| `rpi5/scripts/orto_notify/influx.py` | client HTTP di sola lettura + query Flux degli aggregati orari |
| `rpi5/scripts/orto_notify/features.py` | dalle righe grezze alla matrice delle feature per (sonda, ora) |
| `rpi5/scripts/orto_notify/detect.py` | guardie deterministiche + Isolation Forest → lista di anomalie |
| `rpi5/scripts/orto_notify/confirm.py` | politica di conferma e anti-spam |
| `rpi5/scripts/orto_notify/state.py` | lettura/scrittura di `state.json` |
| `rpi5/scripts/orto_notify/messages.py` | dai fatti al testo italiano dei messaggi — **modulo in più rispetto alla spec §7**, che affidava anche il testo a `telegram.py`: separare contenuto e trasporto rende i messaggi verificabili senza toccare la rete, ed è l'unico scostamento di questo piano dalla spec |
| `rpi5/scripts/orto_notify/telegram.py` | invio, spezzatura a 4096, cap orario difensivo |
| `rpi5/scripts/orto_notify/__main__.py` | orchestrazione e CLI (`--once`, `--dry-run`, `--backtest`) |
| `rpi5/scripts/orto_notify/selftest.py` | banco di prova, nessuna rete |
| `rpi5/scripts/orto-notify.service` | unit systemd oneshot |
| `rpi5/scripts/orto-notify.timer` | timer ogni 15 minuti |
| `rpi5/.env.example` | placeholder `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `docs/comandi_verifica.md` | nuova sezione §11 con i comandi di verifica |
| `CLAUDE.md` | quattro correzioni + riga step 17 (task 10) |

---

## Task 0: Branch

- [ ] **Passo 1: creare il branch**

```bash
cd /c/Users/user/Desktop/Workspace/OrtoDigitale/dev
git checkout main
git pull
git checkout -b step/17-notifiche-fase1
```

---

## Task 1: Scheletro del pacchetto, costanti e banco di prova

**File:**
- Crea: `rpi5/scripts/orto_notify/__init__.py`
- Crea: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: niente.
- Produce: le costanti che ogni task successivo importa, e la funzione `prova(nome, fn)` con cui ogni task successivo aggiunge i propri casi.

- [ ] **Passo 1: scrivere le costanti**

`rpi5/scripts/orto_notify/__init__.py`:

```python
"""Notifiche Telegram sulla salute delle sonde (step 17, fase 1).

Gira sull'host del RPi, fuori da Docker: un errore qui non puo' raggiungere
il decision loop dell'irrigazione.
"""

# --- Sonde ------------------------------------------------------------------
# WH51_05 e WH51_06 non sono installate: non esistono, non sono guaste.
SONDE = ("WH51_01", "WH51_02", "WH51_03", "WH51_04")

# --- InfluxDB ---------------------------------------------------------------
INFLUX_URL = "http://localhost:8086/api/v2/query"
INFLUX_ORG = "orto-digitale"
INFLUX_BUCKET = "garden"
# Il nome e' quello di /opt/orto-digitale/.env, non quello di .env.example
# (footgun #1 di CLAUDE.md: due nomi per lo stesso token, non aggiungere alias).
INFLUX_TOKEN_ENV = "INFLUX_TOKEN_EXPORT_RO"

# --- Cadenza dei dati -------------------------------------------------------
CAMPIONI_ATTESI_ORA = 60      # il GW3000 pubblica ogni 60 s
GIORNI_ADDESTRAMENTO = 30

# --- Soglie delle guardie (spec §4.3) ---------------------------------------
SILENZIO_MIN = 45             # G1: minuti di silenzio oltre cui la sonda e' muta
BATTERIA_BASSA_V = 1.15       # G2: soglia di avviso
BATTERIA_CRITICA_V = 1.10     # soglia di produzione (n-fn-parse), solo riferimento
BATTERIA_LETTURE_CONFERMA = 3
BATTERIA_PENDENZA_V_SETT = -0.02   # G3: pendenza su 7 giorni
BATTERIA_GIORNI_CONFERMA = 3
ORE_BLOCCATE = 12             # G4
DELTA_SORELLA_PP = 3.0        # G4: variazione minima di un'altra sonda

# --- Isolation Forest (spec §4.4) -------------------------------------------
IF_ALBERI = 200
IF_CONTAMINAZIONE = 0.02
IF_SEED = 0                   # riproducibilita': stesso input, stesso esito
IF_ORE_FINESTRA = 6
IF_ORE_CONFERMA = 3

# --- Anti-spam (spec §4.5) --------------------------------------------------
COOLDOWN_ORE = {
    "muta": 24,
    "batteria_bassa": 24,
    "batteria_calo": 24 * 7,
    "valore_bloccato": 24,
    "anomalia": 24,
}
ORE_NORMALITA_PER_RESET = 6

# --- Esclusione irrigazione (spec §3/D7) ------------------------------------
ESCLUSIONE_PRIMA_MIN = 30
ESCLUSIONE_DOPO_MIN = 120

# --- Telegram ---------------------------------------------------------------
TELEGRAM_URL = "https://api.telegram.org/bot{token}/sendMessage"
TELEGRAM_MAX_CHAR = 4096
TELEGRAM_MAX_MSG_ORA = 20     # cap difensivo contro noi stessi, non contro Telegram

# --- Stato ------------------------------------------------------------------
STATO_PATH = "/opt/orto-digitale/notify/state.json"
```

- [ ] **Passo 2: scrivere il banco di prova**

`rpi5/scripts/orto_notify/selftest.py`:

```python
"""Banco di prova. Nessuna rete: Influx e Telegram non vengono mai chiamati.

    python3 -m orto_notify.selftest
"""
import sys
import traceback

_ok = 0
_ko = 0


def prova(nome, fn):
    global _ok, _ko
    try:
        fn()
        print("  ok   " + nome)
        _ok += 1
    except Exception as e:
        print("  FAIL " + nome)
        for riga in traceback.format_exc().strip().splitlines()[-3:]:
            print("       " + riga)
        _ko += 1


def esegui():
    print("\norto_notify — banco di prova\n")
    # I task successivi registrano qui le proprie sezioni.
    for sezione in SEZIONI:
        sezione()
    print("\n%d passati, %d falliti" % (_ok, _ko))
    return 1 if _ko else 0


SEZIONI = []


if __name__ == "__main__":
    sys.exit(esegui())
```

- [ ] **Passo 3: verificare che il pacchetto si importi e il banco giri a vuoto**

```bash
cd /c/Users/user/Desktop/Workspace/OrtoDigitale/dev/rpi5/scripts
python3 -m orto_notify.selftest
```

Atteso: stampa l'intestazione e `0 passati, 0 falliti`, uscita 0.

- [ ] **Passo 4: commit**

```bash
git add rpi5/scripts/orto_notify/__init__.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): scheletro del pacchetto notifiche e banco di prova"
```

---

## Task 2: Client InfluxDB di sola lettura

**File:**
- Crea: `rpi5/scripts/orto_notify/influx.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py` (registra la sezione)

**Interfaces:**
- Consuma: costanti da `orto_notify`.
- Produce:
  - `interroga(flux: str, token: str, trasporto=None) -> list[dict]`
  - `serie_oraria(token: str, giorni: int, trasporto=None) -> list[dict]` — righe `{"sensor_id": str, "ora": datetime, "campioni": int, "media": float|None, "sigma": float|None, "silenzio_max_min": float|None, "batteria": float|None}`
  - `ultimo_campione(token: str, trasporto=None) -> dict[str, datetime]` — istante dell'ultima lettura per sonda
  - `finestre_irrigazione(token: str, giorni: int, trasporto=None) -> list[tuple[datetime, datetime]]` — già allargate di `ESCLUSIONE_PRIMA_MIN`/`ESCLUSIONE_DOPO_MIN`
  - `dentro_finestra(istante: datetime, finestre: list[tuple]) -> bool`
  - `FLUX_AGGREGATO` — template della query, esportato perché il selftest lo ispezioni

> **Perché serve `ultimo_campione` e non basta l'aggregato.** Un bucket orario è etichettato
> dall'istante di chiusura della finestra, quindi la riga più recente può essere vecchia fino
> a 60 minuti *per costruzione*. Misurare il silenzio come `adesso − ora_ultimo_bucket`
> farebbe risultare **muta ogni sonda a ogni ciclo**, con una soglia di 45 minuti. Il
> timestamp esatto dell'ultima lettura costa una query da quattro righe: si paga.

Il parametro `trasporto` è una funzione `(url, headers, body) -> str` iniettabile: in produzione vale `None` e si usa `urllib`, nei test si passa una funzione che restituisce CSV finto. **È così che il banco di prova resta senza rete.**

- [ ] **Passo 1: scrivere i casi di prova**

In `selftest.py`, aggiungere prima di `SEZIONI = []`:

```python
def _sezione_influx():
    from datetime import datetime, timezone
    from orto_notify import influx

    print("influx")

    CSV_FINTO = (
        ",result,table,_time,_value,sensor_id\r\n"
        ",_result,0,2026-08-17T10:00:00Z,60,WH51_01\r\n"
        ",_result,0,2026-08-17T11:00:00Z,42,WH51_01\r\n"
        ",_result,1,2026-08-17T10:00:00Z,60,WH51_02\r\n"
        "\r\n"
    )

    def trasporto_finto(url, headers, body):
        return CSV_FINTO

    def parsing():
        righe = influx.interroga("qualsiasi", "TOKEN", trasporto=trasporto_finto)
        assert len(righe) == 3, righe
        assert righe[0]["sensor_id"] == "WH51_01"
        assert righe[0]["_value"] == "60"
        assert isinstance(righe[0]["_time"], datetime)
        assert righe[0]["_time"].tzinfo is not None, "il timestamp deve essere consapevole del fuso"

    def righe_vuote_ignorate():
        def vuoto(url, headers, body):
            return ",result,table,_time,_value,sensor_id\r\n\r\n\r\n"
        assert influx.interroga("q", "T", trasporto=vuoto) == []

    def token_nel_header():
        visti = {}

        def spia(url, headers, body):
            visti.update(headers)
            return CSV_FINTO

        influx.interroga("q", "SEGRETO", trasporto=spia)
        assert visti["Authorization"] == "Token SEGRETO"
        assert visti["Content-Type"] == "application/vnd.flux"

    def query_raggruppa_solo_per_sensor_id():
        # Il tag aiuola vale "test" sui punti anteriori al 2026-08-15:
        # raggrupparci sopra spezzerebbe la serie di una stessa sonda.
        assert 'group(columns: ["sensor_id"])' in influx.FLUX_AGGREGATO
        assert "aiuola" not in influx.FLUX_AGGREGATO
        assert "position" not in influx.FLUX_AGGREGATO

    def ultimo_campione_per_sonda():
        def due_sonde(url, headers, body):
            return (
                ",result,table,_time,_value,sensor_id\r\n"
                ",_result,0,2026-08-17T11:58:00Z,47,WH51_01\r\n"
                ",_result,1,2026-08-17T11:59:30Z,50,WH51_02\r\n"
                "\r\n"
            )
        ultimi = influx.ultimo_campione("TOKEN", trasporto=due_sonde)
        assert set(ultimi) == {"WH51_01", "WH51_02"}, ultimi
        assert ultimi["WH51_01"].minute == 58, ultimi["WH51_01"]

    def finestre_allargate():
        def un_evento(url, headers, body):
            return (
                ",result,table,_time,_value\r\n"
                ",_result,0,2026-08-17T12:00:00Z,900\r\n"
                "\r\n"
            )
        finestre = influx.finestre_irrigazione("TOKEN", 2, trasporto=un_evento)
        assert len(finestre) == 1, finestre
        inizio, fine = finestre[0]
        # apertura = 12:00 - 900s = 11:45, meno 30 min di margine = 11:15
        assert inizio.hour == 11 and inizio.minute == 15, inizio
        # chiusura 12:00 + 120 min = 14:00
        assert fine.hour == 14 and fine.minute == 0, fine

    prova("il CSV annotato viene letto in dizionari", parsing)
    prova("le righe vuote non diventano record", righe_vuote_ignorate)
    prova("il token viaggia nell'header, non nell'URL", token_nel_header)
    prova("la query raggruppa solo per sensor_id", query_raggruppa_solo_per_sensor_id)
    prova("ultimo_campione da' un istante per sonda", ultimo_campione_per_sonda)
    prova("le finestre di irrigazione sono gia' allargate", finestre_allargate)
```

e registrarla:

```python
SEZIONI = [_sezione_influx]
```

- [ ] **Passo 2: eseguire e vedere il fallimento**

```bash
cd rpi5/scripts && python3 -m orto_notify.selftest
```

Atteso: 6 `FAIL` con `ModuleNotFoundError: No module named 'orto_notify.influx'`.

- [ ] **Passo 3: implementare il client**

`rpi5/scripts/orto_notify/influx.py`:

```python
"""Client InfluxDB di sola lettura. Nessuna scrittura, mai."""
import csv
import io
import urllib.request
from datetime import datetime, timedelta, timezone

from orto_notify import (
    ESCLUSIONE_DOPO_MIN,
    ESCLUSIONE_PRIMA_MIN,
    INFLUX_BUCKET,
    INFLUX_ORG,
    INFLUX_URL,
)

TIMEOUT_S = 20

# Aggregato orario di un campo, con la funzione richiesta.
# Raggruppa SOLO per sensor_id: aiuola/position sono inaffidabili sui punti
# anteriori al 2026-08-15 (valevano la stringa "test").
FLUX_AGGREGATO = '''
from(bucket: "{bucket}")
  |> range(start: -{giorni}d)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "{campo}")
  |> group(columns: ["sensor_id"])
  |> aggregateWindow(every: 1h, fn: {fn}, createEmpty: true)
  |> keep(columns: ["_time", "_value", "sensor_id"])
'''

# Il piu' lungo intervallo fra due campioni consecutivi, per ora.
# elapsed() da' la distanza in minuti fra record successivi.
FLUX_SILENZIO = '''
from(bucket: "{bucket}")
  |> range(start: -{giorni}d)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> group(columns: ["sensor_id"])
  |> elapsed(unit: 1m)
  |> aggregateWindow(every: 1h, fn: max, column: "elapsed", createEmpty: true)
  |> keep(columns: ["_time", "elapsed", "sensor_id"])
'''

# Istante dell'ultima lettura per sonda. Serve perche' un bucket orario e'
# vecchio fino a 60 min per costruzione: usarlo per misurare il silenzio
# farebbe risultare muta ogni sonda a ogni ciclo.
FLUX_ULTIMO = '''
from(bucket: "{bucket}")
  |> range(start: -6h)
  |> filter(fn: (r) => r._measurement == "soil_moisture" and r._field == "value")
  |> group(columns: ["sensor_id"])
  |> last()
  |> keep(columns: ["_time", "_value", "sensor_id"])
'''

# Chiusure valvola: servono per escludere le finestre di irrigazione.
FLUX_EVENTI = '''
from(bucket: "{bucket}")
  |> range(start: -{giorni}d)
  |> filter(fn: (r) => r._measurement == "irrigation_events" and r._field == "duration_seconds")
  |> keep(columns: ["_time", "_value"])
'''


def _trasporto_http(url, headers, body):
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read().decode("utf-8")


def interroga(flux, token, trasporto=None):
    """Esegue una query Flux e restituisce le righe come dizionari.

    Il timestamp `_time`, se presente, viene convertito in datetime con fuso.
    """
    inviare = trasporto or _trasporto_http
    url = "%s?org=%s" % (INFLUX_URL, INFLUX_ORG)
    headers = {
        "Authorization": "Token %s" % token,
        "Content-Type": "application/vnd.flux",
        "Accept": "application/csv",
    }
    testo = inviare(url, headers, flux)

    righe = []
    for record in csv.DictReader(io.StringIO(testo)):
        # Le tabelle Flux sono separate da righe vuote: DictReader le rende
        # dizionari con sole chiavi None/vuote. Si scartano.
        if not record.get("result") and not record.get("_time"):
            continue
        pulito = {k: v for k, v in record.items() if k}
        if "_time" in pulito and pulito["_time"]:
            pulito["_time"] = datetime.fromisoformat(pulito["_time"].replace("Z", "+00:00"))
        righe.append(pulito)
    return righe


def _num(valore):
    try:
        return float(valore)
    except (TypeError, ValueError):
        return None


def serie_oraria(token, giorni, trasporto=None):
    """Aggregati orari per sonda: campioni, media, sigma, silenzio, batteria.

    Tutte le feature dello step si ricavano da qui: ~2.880 righe per 30 giorni,
    invece delle ~173.000 dei campioni grezzi.
    """
    def q(campo, fn):
        return interroga(
            FLUX_AGGREGATO.format(bucket=INFLUX_BUCKET, giorni=giorni, campo=campo, fn=fn),
            token, trasporto=trasporto,
        )

    unite = {}

    def deposita(righe, chiave, colonna="_value"):
        for r in righe:
            k = (r.get("sensor_id"), r.get("_time"))
            if not k[0] or not k[1]:
                continue
            unite.setdefault(k, {"sensor_id": k[0], "ora": k[1]})[chiave] = _num(r.get(colonna))

    deposita(q("value", "count"), "campioni")
    deposita(q("value", "mean"), "media")
    deposita(q("value", "stddev"), "sigma")
    deposita(q("battery_voltage", "mean"), "batteria")
    deposita(
        interroga(FLUX_SILENZIO.format(bucket=INFLUX_BUCKET, giorni=giorni), token, trasporto=trasporto),
        "silenzio_max_min", colonna="elapsed",
    )

    fuori = []
    for riga in unite.values():
        riga["campioni"] = int(riga.get("campioni") or 0)
        fuori.append(riga)
    fuori.sort(key=lambda r: (r["sensor_id"], r["ora"]))
    return fuori


def ultimo_campione(token, trasporto=None):
    """Istante dell'ultima lettura per sonda: {sensor_id: datetime}.

    E' il solo modo esatto di misurare il silenzio: gli aggregati orari non
    bastano (vedi commento su FLUX_ULTIMO).
    """
    righe = interroga(FLUX_ULTIMO.format(bucket=INFLUX_BUCKET), token, trasporto=trasporto)
    fuori = {}
    for r in righe:
        sonda, quando = r.get("sensor_id"), r.get("_time")
        if sonda and quando:
            fuori[sonda] = quando
    return fuori


def finestre_irrigazione(token, giorni, trasporto=None):
    """Intervalli da escludere, gia' allargati secondo la spec §3/D7.

    irrigation_events viene scritto solo alla chiusura, con duration_seconds:
    l'apertura si ricava all'indietro, come fa gia' /api/valve/intervals.
    """
    righe = interroga(
        FLUX_EVENTI.format(bucket=INFLUX_BUCKET, giorni=giorni), token, trasporto=trasporto
    )
    finestre = []
    for r in righe:
        fine = r.get("_time")
        durata = _num(r.get("_value"))
        if not fine or not durata:
            continue
        inizio = fine - timedelta(seconds=durata)
        finestre.append((
            inizio - timedelta(minutes=ESCLUSIONE_PRIMA_MIN),
            fine + timedelta(minutes=ESCLUSIONE_DOPO_MIN),
        ))
    return finestre


def dentro_finestra(istante, finestre):
    return any(a <= istante <= b for a, b in finestre)
```

- [ ] **Passo 4: eseguire e vedere il verde**

```bash
cd rpi5/scripts && python3 -m orto_notify.selftest
```

Atteso: `6 passati, 0 falliti`.

- [ ] **Passo 5: verifica contro InfluxDB vero (una volta, a mano)**

```bash
scp -r rpi5/scripts/orto_notify as@192.168.1.12:/tmp/
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; cd /tmp && python3 -c "
from orto_notify import influx, INFLUX_TOKEN_ENV, GIORNI_ADDESTRAMENTO
import os
righe = influx.serie_oraria(os.environ[INFLUX_TOKEN_ENV], 2)
print(len(righe), \"righe\")
print(righe[0])
print(righe[-1])
"'
```

Atteso: ~192 righe (4 sonde × 48 ore), ciascuna con `campioni`, `media`, `sigma`, `batteria`, `silenzio_max_min` valorizzati. Se `silenzio_max_min` è `None` ovunque, la query `elapsed` è sbagliata: correggerla prima di proseguire.

- [ ] **Passo 6: commit**

```bash
git add rpi5/scripts/orto_notify/influx.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): client InfluxDB di sola lettura per le notifiche"
```

---

## Task 3: Matrice delle feature

**File:**
- Crea: `rpi5/scripts/orto_notify/features.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: `influx.serie_oraria()` (righe con `sensor_id`, `ora`, `campioni`, `media`, `sigma`, `silenzio_max_min`, `batteria`).
- Produce: `costruisci(righe: list[dict]) -> list[dict]`, dove ogni riga guadagna `tasso_consegna`, `delta_batteria_24h`, `scarto_da_sorelle`, `ore_bloccate`; e `COLONNE` — la tupla ordinata dei nomi delle sette feature, usata da `detect.py` per costruire la matrice numerica.

- [ ] **Passo 1: scrivere i casi di prova**

In `selftest.py`:

```python
def _sezione_features():
    from datetime import datetime, timedelta, timezone
    from orto_notify import features

    print("features")

    T0 = datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc)

    def riga(sonda, ore, campioni=60, media=50.0, sigma=1.0, batteria=1.6, silenzio=1.0):
        return {
            "sensor_id": sonda, "ora": T0 + timedelta(hours=ore),
            "campioni": campioni, "media": media, "sigma": sigma,
            "batteria": batteria, "silenzio_max_min": silenzio,
        }

    def tasso_consegna():
        out = features.costruisci([riga("WH51_01", 0, campioni=30)])
        assert out[0]["tasso_consegna"] == 0.5, out[0]

    def delta_batteria():
        righe = [riga("WH51_01", h, batteria=1.60) for h in range(24)]
        righe.append(riga("WH51_01", 24, batteria=1.50))
        out = features.costruisci(righe)
        ultima = out[-1]
        assert abs(ultima["delta_batteria_24h"] + 0.10) < 1e-9, ultima

    def delta_batteria_senza_storia_e_zero():
        out = features.costruisci([riga("WH51_01", 0)])
        assert out[0]["delta_batteria_24h"] == 0.0

    def scarto_da_sorelle():
        righe = [
            riga("WH51_01", 0, media=70.0),
            riga("WH51_02", 0, media=50.0),
            riga("WH51_03", 0, media=50.0),
            riga("WH51_04", 0, media=50.0),
        ]
        out = {r["sensor_id"]: r for r in features.costruisci(righe)}
        assert out["WH51_01"]["scarto_da_sorelle"] == 20.0, out["WH51_01"]
        assert out["WH51_02"]["scarto_da_sorelle"] == 0.0

    def ore_bloccate_cresce_e_si_azzera():
        righe = [riga("WH51_01", h, sigma=0.0, media=50.0) for h in range(5)]
        righe.append(riga("WH51_01", 5, sigma=1.2, media=51.0))
        out = features.costruisci(righe)
        assert out[4]["ore_bloccate"] == 5, [r["ore_bloccate"] for r in out]
        assert out[5]["ore_bloccate"] == 0

    def ore_bloccate_richiede_media_invariata():
        # sigma nulla ma media che cambia: non e' bloccata, sta salendo a gradini
        righe = [riga("WH51_01", h, sigma=0.0, media=50.0 + h) for h in range(4)]
        out = features.costruisci(righe)
        assert out[-1]["ore_bloccate"] == 1, [r["ore_bloccate"] for r in out]

    def colonne_sono_sette():
        assert len(features.COLONNE) == 7, features.COLONNE

    def nessun_none_nella_matrice():
        righe = [riga("WH51_01", 0, campioni=0, media=None, sigma=None,
                      batteria=None, silenzio=None)]
        out = features.costruisci(righe)
        for c in features.COLONNE:
            assert out[0][c] is not None, (c, out[0])

    prova("tasso_consegna = campioni / 60", tasso_consegna)
    prova("delta_batteria_24h guarda 24 ore indietro", delta_batteria)
    prova("senza 24 ore di storia il delta e' 0", delta_batteria_senza_storia_e_zero)
    prova("scarto_da_sorelle usa la mediana delle altre", scarto_da_sorelle)
    prova("ore_bloccate cresce e si azzera", ore_bloccate_cresce_e_si_azzera)
    prova("ore_bloccate richiede anche la media invariata", ore_bloccate_richiede_media_invariata)
    prova("le colonne della matrice sono sette", colonne_sono_sette)
    prova("nessun None arriva alla matrice", nessun_none_nella_matrice)
```

Registrare: `SEZIONI = [_sezione_influx, _sezione_features]`.

- [ ] **Passo 2: eseguire e vedere il fallimento**

```bash
cd rpi5/scripts && python3 -m orto_notify.selftest
```

Atteso: 8 `FAIL` con `ModuleNotFoundError`.

- [ ] **Passo 3: implementare**

`rpi5/scripts/orto_notify/features.py`:

```python
"""Dalla serie oraria alla matrice delle feature.

Sette colonne per coppia (sonda, ora), tutte derivate dagli aggregati orari:
nessuna richiede i campioni grezzi.
"""
from datetime import timedelta
from statistics import median

from orto_notify import CAMPIONI_ATTESI_ORA

COLONNE = (
    "tasso_consegna",
    "silenzio_max_min",
    "batteria",
    "delta_batteria_24h",
    "scarto_da_sorelle",
    "sigma",
    "ore_bloccate",
)


def costruisci(righe):
    """Arricchisce le righe orarie con le feature derivate.

    Restituisce una lista ordinata per (sensor_id, ora). Nessun valore None
    sopravvive nelle colonne di COLONNE: i buchi diventano 0.0, perche' un
    Isolation Forest non accetta NaN.
    """
    righe = sorted(righe, key=lambda r: (r["sensor_id"], r["ora"]))

    # Indice per (sonda, ora) e per ora, servono per delta e scarto.
    per_chiave = {(r["sensor_id"], r["ora"]): r for r in righe}
    per_ora = {}
    for r in righe:
        per_ora.setdefault(r["ora"], []).append(r)

    per_sonda = {}
    for r in righe:
        per_sonda.setdefault(r["sensor_id"], []).append(r)

    for sonda, serie in per_sonda.items():
        bloccate = 0
        media_precedente = None
        for r in serie:
            campioni = r.get("campioni") or 0
            r["tasso_consegna"] = campioni / float(CAMPIONI_ATTESI_ORA)

            sigma = r.get("sigma")
            media = r.get("media")
            # Un'ora con deviazione nulla e media invariata e' un'ora di
            # letture identiche: e' la versione oraria di "valore bloccato".
            if sigma is not None and sigma == 0.0 and media is not None and media == media_precedente:
                bloccate += 1
            elif sigma is not None and sigma == 0.0 and media_precedente is None:
                bloccate = 1
            else:
                bloccate = 1 if (sigma is not None and sigma == 0.0) else 0
            r["ore_bloccate"] = bloccate
            media_precedente = media

            # Batteria: variazione sulle 24 ore, 0 se manca la storia.
            prima = per_chiave.get((sonda, r["ora"] - timedelta(hours=24)))
            if prima and prima.get("batteria") is not None and r.get("batteria") is not None:
                r["delta_batteria_24h"] = r["batteria"] - prima["batteria"]
            else:
                r["delta_batteria_24h"] = 0.0

            # Scarto dalla mediana delle altre sonde nella stessa ora.
            altre = [
                x.get("media") for x in per_ora.get(r["ora"], [])
                if x["sensor_id"] != sonda and x.get("media") is not None
            ]
            if altre and r.get("media") is not None:
                r["scarto_da_sorelle"] = abs(r["media"] - median(altre))
            else:
                r["scarto_da_sorelle"] = 0.0

    # Normalizza i None residui: la matrice numerica non li tollera.
    for r in righe:
        for colonna in COLONNE:
            if r.get(colonna) is None:
                r[colonna] = 0.0
    return righe


def matrice(righe):
    """Le sole colonne numeriche, nell'ordine di COLONNE."""
    return [[float(r[c]) for c in COLONNE] for r in righe]
```

- [ ] **Passo 4: eseguire e vedere il verde**

```bash
cd rpi5/scripts && python3 -m orto_notify.selftest
```

Atteso: `14 passati, 0 falliti`.

- [ ] **Passo 5: commit**

```bash
git add rpi5/scripts/orto_notify/features.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): matrice delle feature per la salute sonde"
```

---

## Task 4: Guardie deterministiche

**File:**
- Crea: `rpi5/scripts/orto_notify/detect.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: `features.costruisci()`, `influx.dentro_finestra()`, `influx.ultimo_campione()`.
- Produce: `guardie(righe: list[dict], adesso: datetime, finestre: list[tuple], ultimi: dict|None = None) -> list[dict]`. Ogni anomalia è `{"sensor_id": str, "tipo": str, "ora": datetime, "dettagli": dict}` con `tipo` fra `muta`, `batteria_bassa`, `batteria_calo`, `valore_bloccato`.

`ultimi` è `{sensor_id: datetime}` da `influx.ultimo_campione()`. Quando è `None` — cioè
nel backtest storico, dove non esiste un "ultimo campione" riferito a un istante passato —
il silenzio si stima dall'ultimo bucket orario con `campioni > 0`. È un'approssimazione
grossolana fino a un'ora, accettabile per contare gli alert a posteriori, **mai** in
produzione.

- [ ] **Passo 1: scrivere i casi di prova**

```python
def _sezione_guardie():
    from datetime import datetime, timedelta, timezone
    from orto_notify import detect

    print("guardie deterministiche")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def serie(sonda="WH51_01", ore=48, **campi):
        fuori = []
        for h in range(ore, 0, -1):
            r = {
                "sensor_id": sonda, "ora": ADESSO - timedelta(hours=h),
                "campioni": 60, "media": 50.0, "sigma": 1.0, "batteria": 1.60,
                "silenzio_max_min": 1.0, "tasso_consegna": 1.0,
                "delta_batteria_24h": 0.0, "scarto_da_sorelle": 0.0,
                "ore_bloccate": 0,
            }
            r.update(campi)
            fuori.append(r)
        return fuori

    def tipi(anomalie):
        return sorted({a["tipo"] for a in anomalie})

    def vivo(quando_min=0):
        # ultimo campione "adesso meno quando_min minuti", per ogni sonda
        return {s: ADESSO - timedelta(minutes=quando_min)
                for s in ("WH51_01", "WH51_02", "WH51_03", "WH51_04")}

    def muta_dopo_45_minuti():
        out = detect.guardie(serie(), ADESSO, [], ultimi=vivo(52))
        assert "muta" in tipi(out), tipi(out)

    def non_muta_a_20_minuti():
        out = detect.guardie(serie(), ADESSO, [], ultimi=vivo(20))
        assert "muta" not in tipi(out), tipi(out)

    def bucket_orario_vecchio_non_e_silenzio():
        # Il bucket piu' recente e' sempre vecchio fino a 60 min per costruzione:
        # se il silenzio si misurasse da li', ogni sonda sarebbe sempre muta.
        out = detect.guardie(serie(), ADESSO, [], ultimi=vivo(2))
        assert "muta" not in tipi(out), tipi(out)

    def sonda_assente_da_ultimi_e_muta():
        ultimi = vivo(2)
        del ultimi["WH51_01"]
        out = detect.guardie(serie(), ADESSO, [], ultimi=ultimi)
        assert "muta" in tipi(out), tipi(out)

    def batteria_bassa_con_tre_letture():
        out = detect.guardie(serie(batteria=1.12), ADESSO, [], ultimi=vivo(2))
        assert "batteria_bassa" in tipi(out), tipi(out)

    def batteria_bassa_singola_non_basta():
        righe = serie()
        righe[-1]["batteria"] = 1.12
        out = detect.guardie(righe, ADESSO, [], ultimi=vivo(2))
        assert "batteria_bassa" not in tipi(out), tipi(out)

    def serie_batteria(pendenza_totale):
        righe = []
        for h in range(168, 0, -1):
            v = 1.60 - (168 - h) * (pendenza_totale / 168.0)
            riga = serie(ore=1, batteria=v)[0]
            riga["ora"] = ADESSO - timedelta(hours=h)
            righe.append(riga)
        return righe

    def batteria_in_calo():
        # -0.09 V in 7 giorni = -0.09 V/settimana, oltre la soglia -0.02
        out = detect.guardie(serie_batteria(0.09), ADESSO, [], ultimi=vivo(2))
        assert "batteria_calo" in tipi(out), tipi(out)

    def batteria_piatta_non_allerta():
        out = detect.guardie(serie_batteria(0.0), ADESSO, [], ultimi=vivo(2))
        assert "batteria_calo" not in tipi(out), tipi(out)

    def valore_bloccato_con_sorella_che_si_muove():
        righe = serie(sonda="WH51_01", ore_bloccate=14, sigma=0.0)
        sorella = serie(sonda="WH51_02")
        for i, r in enumerate(sorella):
            r["media"] = 50.0 + i * 0.5     # varia di 24 pp nell'arco
        out = detect.guardie(righe + sorella, ADESSO, [], ultimi=vivo(2))
        assert "valore_bloccato" in tipi(out), tipi(out)

    def valore_fermo_ma_tutte_ferme_non_allerta():
        righe = serie(sonda="WH51_01", ore_bloccate=14, sigma=0.0)
        sorella = serie(sonda="WH51_02", ore_bloccate=14, sigma=0.0)
        out = detect.guardie(righe + sorella, ADESSO, [], ultimi=vivo(2))
        assert "valore_bloccato" not in tipi(out), tipi(out)

    def irrigazione_zittisce_tutto():
        finestre = [(ADESSO - timedelta(hours=48), ADESSO + timedelta(hours=1))]
        out = detect.guardie(serie(batteria=1.12), ADESSO, finestre, ultimi=vivo(52))
        assert out == [], out

    def senza_ultimi_ripiega_sui_bucket():
        # Modalita' backtest: nessun "ultimo campione", si stima dai bucket.
        righe = serie()
        for r in righe[-3:]:
            r["campioni"] = 0
        out = detect.guardie(righe, ADESSO, [], ultimi=None)
        assert "muta" in tipi(out), tipi(out)

    prova("muta dopo 52 minuti di silenzio", muta_dopo_45_minuti)
    prova("non muta a 20 minuti", non_muta_a_20_minuti)
    prova("un bucket orario vecchio non e' silenzio", bucket_orario_vecchio_non_e_silenzio)
    prova("sonda assente dall'ultimo giro e' muta", sonda_assente_da_ultimi_e_muta)
    prova("batteria bassa con tre letture consecutive", batteria_bassa_con_tre_letture)
    prova("una sola lettura bassa non basta", batteria_bassa_singola_non_basta)
    prova("batteria in calo oltre la pendenza di soglia", batteria_in_calo)
    prova("batteria piatta non allerta", batteria_piatta_non_allerta)
    prova("valore bloccato solo se una sorella si muove", valore_bloccato_con_sorella_che_si_muove)
    prova("se tutte sono ferme non e' un guasto", valore_fermo_ma_tutte_ferme_non_allerta)
    prova("dentro la finestra di irrigazione tutti tacciono", irrigazione_zittisce_tutto)
    prova("senza ultimi si ripiega sui bucket orari", senza_ultimi_ripiega_sui_bucket)
```

Registrare la sezione in `SEZIONI`.

- [ ] **Passo 2: eseguire e vedere il fallimento**

Atteso: 12 `FAIL` con `ModuleNotFoundError: No module named 'orto_notify.detect'`.

- [ ] **Passo 3: implementare**

`rpi5/scripts/orto_notify/detect.py`:

```python
"""Rilevazione ibrida: guardie deterministiche + Isolation Forest.

Le guardie coprono i guasti che sappiamo nominare (silenzio, batteria, valore
bloccato) — piu' affidabili e soprattutto spiegabili in un messaggio.
L'Isolation Forest copre cio' che a regole non si esprime.
"""
from datetime import timedelta

from orto_notify import (
    BATTERIA_BASSA_V,
    BATTERIA_GIORNI_CONFERMA,
    BATTERIA_LETTURE_CONFERMA,
    BATTERIA_PENDENZA_V_SETT,
    DELTA_SORELLA_PP,
    ORE_BLOCCATE,
    SILENZIO_MIN,
)
from orto_notify.influx import dentro_finestra


def _pendenza_settimanale(punti):
    """Regressione lineare ai minimi quadrati; restituisce V/settimana."""
    if len(punti) < 2:
        return 0.0
    t0 = punti[0][0]
    xs = [(t - t0).total_seconds() / (7 * 86400.0) for t, _ in punti]  # in settimane
    ys = [v for _, v in punti]
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    return num / den if den else 0.0


def _istante_ultima_lettura(sonda, serie, ultimi):
    """Quando questa sonda ha trasmesso l'ultima volta.

    In produzione arriva da influx.ultimo_campione(): esatto al secondo.
    Nel backtest `ultimi` e' None e si ripiega sull'ultimo bucket orario con
    campioni: approssimazione fino a un'ora, buona per contare, non per agire.
    """
    if ultimi is not None:
        return ultimi.get(sonda)
    con_dati = [r for r in serie if (r.get("campioni") or 0) > 0]
    return con_dati[-1]["ora"] if con_dati else None


def guardie(righe, adesso, finestre, ultimi=None):
    """Applica G1..G4. Restituisce la lista delle anomalie rilevate."""
    per_sonda = {}
    for r in righe:
        per_sonda.setdefault(r["sensor_id"], []).append(r)
    for serie in per_sonda.values():
        serie.sort(key=lambda r: r["ora"])

    anomalie = []
    for sonda, serie in per_sonda.items():
        if not serie:
            continue
        ultima = serie[-1]

        # Dentro la finestra di irrigazione (e nelle 2 ore successive) il
        # terreno cambia davvero: ogni rilevatore va zittito. Spec §3/D7.
        if dentro_finestra(ultima["ora"], finestre):
            continue

        # --- G1: sonda muta -------------------------------------------------
        # Attenzione: NON usare ultima["ora"], che e' l'estremo di un bucket
        # orario e quindi vecchio fino a 60 min per costruzione.
        vista = _istante_ultima_lettura(sonda, serie, ultimi)
        silenzio_min = (
            (adesso - vista).total_seconds() / 60.0 if vista else float("inf")
        )
        if silenzio_min > SILENZIO_MIN:
            anomalie.append({
                "sensor_id": sonda, "tipo": "muta", "ora": vista or ultima["ora"],
                "dettagli": {
                    "silenzio_min": round(silenzio_min) if vista else None,
                    "ultima_lettura": ultima.get("media"),
                    "batteria": ultima.get("batteria"),
                },
            })

        # --- G2: batteria bassa ---------------------------------------------
        ultime = [r for r in serie[-BATTERIA_LETTURE_CONFERMA:] if r.get("batteria")]
        if len(ultime) == BATTERIA_LETTURE_CONFERMA and all(
            r["batteria"] < BATTERIA_BASSA_V for r in ultime
        ):
            anomalie.append({
                "sensor_id": sonda, "tipo": "batteria_bassa", "ora": ultima["ora"],
                "dettagli": {"batteria": ultima["batteria"]},
            })

        # --- G3: batteria in calo -------------------------------------------
        soglia_giorni = adesso - timedelta(days=7)
        punti = [(r["ora"], r["batteria"]) for r in serie
                 if r["ora"] >= soglia_giorni and r.get("batteria")]
        if len(punti) >= 24 * BATTERIA_GIORNI_CONFERMA:
            pendenza = _pendenza_settimanale(punti)
            if pendenza < BATTERIA_PENDENZA_V_SETT:
                anomalie.append({
                    "sensor_id": sonda, "tipo": "batteria_calo", "ora": ultima["ora"],
                    "dettagli": {
                        "pendenza_v_settimana": round(pendenza, 4),
                        "batteria": ultima.get("batteria"),
                        "batteria_iniziale": punti[0][1],
                    },
                })

        # --- G4: valore bloccato --------------------------------------------
        if (ultima.get("ore_bloccate") or 0) >= ORE_BLOCCATE:
            da = ultima["ora"] - timedelta(hours=ORE_BLOCCATE)
            mossa = False
            for altra, serie_altra in per_sonda.items():
                if altra == sonda:
                    continue
                medie = [r["media"] for r in serie_altra
                         if r["ora"] >= da and r.get("media") is not None]
                if medie and (max(medie) - min(medie)) >= DELTA_SORELLA_PP:
                    mossa = True
                    break
            if mossa:
                anomalie.append({
                    "sensor_id": sonda, "tipo": "valore_bloccato", "ora": ultima["ora"],
                    "dettagli": {
                        "ore": int(ultima["ore_bloccate"]),
                        "valore": ultima.get("media"),
                    },
                })

    return anomalie
```

- [ ] **Passo 4: eseguire e vedere il verde**

Atteso: `26 passati, 0 falliti`.

- [ ] **Passo 5: commit**

```bash
git add rpi5/scripts/orto_notify/detect.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): guardie deterministiche sulla salute delle sonde"
```

---

## Task 5: Isolation Forest

**File:**
- Modifica: `rpi5/scripts/orto_notify/detect.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: `features.matrice()`, `features.COLONNE`.
- Produce: `anomalie_modello(righe: list[dict], adesso: datetime, finestre: list[tuple]) -> list[dict]` con `tipo = "anomalia"`; i `dettagli` contengono `ore_anomale` (int), `su_ore` (int) e `spiegazione` (dict colonna → (valore, mediana_normale)).

- [ ] **Passo 1: scrivere i casi di prova**

```python
def _sezione_modello():
    from datetime import datetime, timedelta, timezone
    from orto_notify import detect, IF_ORE_FINESTRA

    print("isolation forest")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def normale(sonda, h, **campi):
        r = {
            "sensor_id": sonda, "ora": ADESSO - timedelta(hours=h),
            "campioni": 60, "media": 50.0, "sigma": 1.2, "batteria": 1.60,
            "silenzio_max_min": 1.0, "tasso_consegna": 1.0,
            "delta_batteria_24h": 0.0, "scarto_da_sorelle": 0.5,
            "ore_bloccate": 0,
        }
        r.update(campi)
        return r

    def popolazione():
        righe = []
        for sonda in ("WH51_01", "WH51_02", "WH51_03", "WH51_04"):
            for h in range(400, 0, -1):
                # un filo di varieta', altrimenti la deviazione e' nulla
                righe.append(normale(sonda, h, media=50.0 + (h % 5) * 0.1))
        return righe

    def sonda_deviante_viene_segnalata():
        righe = popolazione()
        for r in righe:
            if r["sensor_id"] == "WH51_03" and (ADESSO - r["ora"]).total_seconds() <= IF_ORE_FINESTRA * 3600:
                r["scarto_da_sorelle"] = 18.0
                r["sigma"] = 0.0
                r["ore_bloccate"] = 6
        out = detect.anomalie_modello(righe, ADESSO, [])
        sonde = {a["sensor_id"] for a in out}
        assert "WH51_03" in sonde, sonde

    def popolazione_omogenea_non_produce_allarmi():
        out = detect.anomalie_modello(popolazione(), ADESSO, [])
        assert out == [], out

    def esito_riproducibile():
        righe = popolazione()
        for r in righe:
            if r["sensor_id"] == "WH51_02" and (ADESSO - r["ora"]).total_seconds() <= IF_ORE_FINESTRA * 3600:
                r["scarto_da_sorelle"] = 15.0
        a = detect.anomalie_modello(righe, ADESSO, [])
        b = detect.anomalie_modello(righe, ADESSO, [])
        assert [x["sensor_id"] for x in a] == [x["sensor_id"] for x in b]

    def dati_insufficienti_non_esplode():
        pochi = [normale("WH51_01", h) for h in range(5, 0, -1)]
        assert detect.anomalie_modello(pochi, ADESSO, []) == []

    def spiegazione_presente():
        righe = popolazione()
        for r in righe:
            if r["sensor_id"] == "WH51_04" and (ADESSO - r["ora"]).total_seconds() <= IF_ORE_FINESTRA * 3600:
                r["tasso_consegna"] = 0.1
                r["silenzio_max_min"] = 40.0
        out = detect.anomalie_modello(righe, ADESSO, [])
        if out:
            assert out[0]["dettagli"]["spiegazione"], out[0]
            assert out[0]["dettagli"]["su_ore"] == IF_ORE_FINESTRA

    prova("una sonda che devia viene segnalata", sonda_deviante_viene_segnalata)
    prova("popolazione omogenea: nessun allarme", popolazione_omogenea_non_produce_allarmi)
    prova("stesso input, stesso esito", esito_riproducibile)
    prova("con pochi dati non esplode", dati_insufficienti_non_esplode)
    prova("l'anomalia porta con se' la spiegazione", spiegazione_presente)
```

- [ ] **Passo 2: eseguire e vedere il fallimento**

Atteso: 5 `FAIL` con `AttributeError: module 'orto_notify.detect' has no attribute 'anomalie_modello'`.

- [ ] **Passo 3: implementare**

Aggiungere la funzione **in fondo** a `detect.py`, ma i suoi import **in cima**, nel blocco
di import già esistente (non lasciarli a metà file: è la prima cosa che una review
segnala). Il blocco in cima diventa:

```python
from datetime import timedelta
from statistics import median

from orto_notify import (
    BATTERIA_BASSA_V,
    BATTERIA_GIORNI_CONFERMA,
    BATTERIA_LETTURE_CONFERMA,
    BATTERIA_PENDENZA_V_SETT,
    DELTA_SORELLA_PP,
    IF_ALBERI,
    IF_CONTAMINAZIONE,
    IF_ORE_CONFERMA,
    IF_ORE_FINESTRA,
    IF_SEED,
    ORE_BLOCCATE,
    SILENZIO_MIN,
)
from orto_notify.features import COLONNE, matrice
from orto_notify.influx import dentro_finestra

MIN_RIGHE_ADDESTRAMENTO = 200
```

`features` non importa `detect`, quindi non c'è ciclo. E in fondo al file:

```python
def anomalie_modello(righe, adesso, finestre):
    """Isolation Forest sulle sette feature, addestrato su tutte le sonde.

    Il modello non decide: assegna un punteggio. La notifica parte solo se la
    sonda risulta anomala in almeno IF_ORE_CONFERMA delle ultime
    IF_ORE_FINESTRA ore (spec §4.5).
    """
    utili = [r for r in righe if not dentro_finestra(r["ora"], finestre)]
    if len(utili) < MIN_RIGHE_ADDESTRAMENTO:
        return []

    try:
        from sklearn.ensemble import IsolationForest
    except ImportError:
        # Senza sklearn le guardie deterministiche continuano a funzionare:
        # meglio meno rilevazione che un servizio che non parte.
        return []

    X = matrice(utili)
    modello = IsolationForest(
        n_estimators=IF_ALBERI,
        contamination=IF_CONTAMINAZIONE,
        random_state=IF_SEED,
    )
    etichette = modello.fit_predict(X)   # -1 = anomalia, 1 = normale

    limite = adesso - timedelta(hours=IF_ORE_FINESTRA)
    conteggio = {}
    recenti_anomale = {}
    for riga, etichetta in zip(utili, etichette):
        if riga["ora"] < limite:
            continue
        sonda = riga["sensor_id"]
        conteggio.setdefault(sonda, 0)
        if etichetta == -1:
            conteggio[sonda] += 1
            recenti_anomale.setdefault(sonda, []).append(riga)

    # Mediana delle righe giudicate normali: serve a spiegare lo scostamento.
    normali = [r for r, e in zip(utili, etichette) if e == 1]

    fuori = []
    for sonda, quante in conteggio.items():
        if quante < IF_ORE_CONFERMA:
            continue
        campione = recenti_anomale[sonda][-1]
        spiegazione = {}
        for colonna in COLONNE:
            valori_normali = [r[colonna] for r in normali if r["sensor_id"] == sonda]
            if not valori_normali:
                valori_normali = [r[colonna] for r in normali]
            if not valori_normali:
                continue
            atteso = median(valori_normali)
            spiegazione[colonna] = (round(float(campione[colonna]), 2), round(float(atteso), 2))
        fuori.append({
            "sensor_id": sonda, "tipo": "anomalia", "ora": campione["ora"],
            "dettagli": {
                "ore_anomale": quante,
                "su_ore": IF_ORE_FINESTRA,
                "spiegazione": spiegazione,
            },
        })
    return fuori
```

- [ ] **Passo 4: installare sklearn in locale e verificare**

Sul PC di sviluppo serve `scikit-learn` per far girare il banco:

```bash
python3 -m pip install --user scikit-learn    # solo sul PC, NON sul RPi
cd rpi5/scripts && python3 -m orto_notify.selftest
```

Atteso: `31 passati, 0 falliti`.

> Sul RPi si userà `apt install python3-sklearn` (task 9): sull'host Debian non si usa `pip`.

- [ ] **Passo 5: commit**

```bash
git add rpi5/scripts/orto_notify/detect.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): isolation forest sulla salute delle sonde"
```

---

## Task 6: Conferma, anti-spam e stato

**File:**
- Crea: `rpi5/scripts/orto_notify/state.py`
- Crea: `rpi5/scripts/orto_notify/confirm.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: le anomalie di `detect.guardie()` e `detect.anomalie_modello()`.
- Produce:
  - `state.carica(path) -> dict` / `state.salva(path, stato) -> None`
  - `confirm.filtra(anomalie, stato, adesso) -> tuple[list[dict], dict]` — restituisce le anomalie da notificare **e** lo stato aggiornato
  - `confirm.rientri(anomalie, stato, adesso) -> list[str]` — sonde tornate normali da almeno `ORE_NORMALITA_PER_RESET` ore

- [ ] **Passo 1: scrivere i casi di prova**

```python
def _sezione_conferma():
    from datetime import datetime, timedelta, timezone
    from orto_notify import confirm, state

    print("conferma e anti-spam")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def anomalia(sonda="WH51_01", tipo="muta"):
        return {"sensor_id": sonda, "tipo": tipo, "ora": ADESSO, "dettagli": {}}

    def primo_alert_passa():
        da_inviare, _ = confirm.filtra([anomalia()], {}, ADESSO)
        assert len(da_inviare) == 1, da_inviare

    def secondo_alert_entro_cooldown_soppresso():
        da_inviare, stato = confirm.filtra([anomalia()], {}, ADESSO)
        assert len(da_inviare) == 1
        dopo, _ = confirm.filtra([anomalia()], stato, ADESSO + timedelta(hours=3))
        assert dopo == [], dopo

    def dopo_il_cooldown_riparte():
        _, stato = confirm.filtra([anomalia()], {}, ADESSO)
        dopo, _ = confirm.filtra([anomalia()], stato, ADESSO + timedelta(hours=25))
        assert len(dopo) == 1, dopo

    def cooldown_batteria_calo_e_settimanale():
        _, stato = confirm.filtra([anomalia(tipo="batteria_calo")], {}, ADESSO)
        a_2_giorni, _ = confirm.filtra(
            [anomalia(tipo="batteria_calo")], stato, ADESSO + timedelta(days=2))
        assert a_2_giorni == [], a_2_giorni
        a_8_giorni, _ = confirm.filtra(
            [anomalia(tipo="batteria_calo")], stato, ADESSO + timedelta(days=8))
        assert len(a_8_giorni) == 1

    def tipi_diversi_non_si_zittiscono():
        _, stato = confirm.filtra([anomalia(tipo="muta")], {}, ADESSO)
        altro, _ = confirm.filtra([anomalia(tipo="batteria_bassa")], stato, ADESSO)
        assert len(altro) == 1, altro

    def sonde_diverse_non_si_zittiscono():
        _, stato = confirm.filtra([anomalia(sonda="WH51_01")], {}, ADESSO)
        altra, _ = confirm.filtra([anomalia(sonda="WH51_02")], stato, ADESSO)
        assert len(altra) == 1, altra

    def normalita_prolungata_azzera():
        _, stato = confirm.filtra([anomalia()], {}, ADESSO)
        # sei ore senza anomalie
        _, stato = confirm.filtra([], stato, ADESSO + timedelta(hours=7))
        di_nuovo, _ = confirm.filtra([anomalia()], stato, ADESSO + timedelta(hours=8))
        assert len(di_nuovo) == 1, di_nuovo

    def rientro_segnalato_una_volta_sola():
        _, stato = confirm.filtra([anomalia()], {}, ADESSO)
        tornate = confirm.rientri([], stato, ADESSO + timedelta(hours=7))
        assert "WH51_01" in tornate, tornate
        _, stato2 = confirm.filtra([], stato, ADESSO + timedelta(hours=7))
        ancora = confirm.rientri([], stato2, ADESSO + timedelta(hours=8))
        assert "WH51_01" not in ancora, ancora

    def stato_gira_su_json(tmp="/tmp/orto_notify_prova_stato.json"):
        import os
        originale = {"WH51_01": {"muta": {"ultimo_invio": ADESSO.isoformat()}}}
        state.salva(tmp, originale)
        riletto = state.carica(tmp)
        assert riletto == originale, riletto
        os.remove(tmp)

    def stato_mancante_e_dizionario_vuoto():
        assert state.carica("/tmp/non-esiste-affatto-12345.json") == {}

    prova("il primo alert passa", primo_alert_passa)
    prova("il secondo entro 24 h e' soppresso", secondo_alert_entro_cooldown_soppresso)
    prova("dopo il cooldown riparte", dopo_il_cooldown_riparte)
    prova("batteria_calo ha cooldown di 7 giorni", cooldown_batteria_calo_e_settimanale)
    prova("tipi diversi non si zittiscono a vicenda", tipi_diversi_non_si_zittiscono)
    prova("sonde diverse non si zittiscono a vicenda", sonde_diverse_non_si_zittiscono)
    prova("sei ore di normalita' azzerano il cooldown", normalita_prolungata_azzera)
    prova("il rientro si annuncia una volta sola", rientro_segnalato_una_volta_sola)
    prova("lo stato fa andata e ritorno su JSON", stato_gira_su_json)
    prova("stato mancante = dizionario vuoto", stato_mancante_e_dizionario_vuoto)
```

- [ ] **Passo 2: eseguire e vedere il fallimento**

Atteso: 10 `FAIL` con `ModuleNotFoundError`.

- [ ] **Passo 3: implementare lo stato**

`rpi5/scripts/orto_notify/state.py`:

```python
"""Persistenza dello stato anti-spam. Perderlo costa al piu' un duplicato."""
import json
import os
import tempfile


def carica(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        # Uno stato illeggibile non deve impedire il ciclo: si riparte da zero.
        return {}


def salva(path, stato):
    cartella = os.path.dirname(path) or "."
    os.makedirs(cartella, exist_ok=True)
    # Scrittura atomica: un'interruzione non lascia un JSON monco.
    fd, tmp = tempfile.mkstemp(dir=cartella, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(stato, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
```

- [ ] **Passo 4: implementare la conferma**

`rpi5/scripts/orto_notify/confirm.py`:

```python
"""Politica di conferma e anti-spam.

Un bot che manda troppi messaggi viene silenziato, e allora tutto il resto
vale zero: questo modulo e' parte del prodotto, non un dettaglio.
"""
from datetime import datetime, timedelta

from orto_notify import COOLDOWN_ORE, ORE_NORMALITA_PER_RESET


def _quando(valore):
    return datetime.fromisoformat(valore) if valore else None


def filtra(anomalie, stato, adesso):
    """Restituisce (da_notificare, stato_aggiornato).

    Lo stato e' {sonda: {tipo: {"ultimo_invio": iso, "ultimo_visto": iso}}}.
    """
    stato = {s: {t: dict(v) for t, v in tipi.items()} for s, tipi in stato.items()}
    presenti = {(a["sensor_id"], a["tipo"]) for a in anomalie}

    # Azzera cio' che e' tornato normale da abbastanza tempo.
    for sonda, tipi in list(stato.items()):
        for tipo, voce in list(tipi.items()):
            if (sonda, tipo) in presenti:
                continue
            visto = _quando(voce.get("ultimo_visto"))
            if visto and adesso - visto >= timedelta(hours=ORE_NORMALITA_PER_RESET):
                voce["rientrata"] = True
                voce.pop("ultimo_invio", None)

    da_notificare = []
    for a in anomalie:
        sonda, tipo = a["sensor_id"], a["tipo"]
        voce = stato.setdefault(sonda, {}).setdefault(tipo, {})
        voce["ultimo_visto"] = adesso.isoformat()
        voce.pop("rientrata", None)

        ultimo = _quando(voce.get("ultimo_invio"))
        cooldown = timedelta(hours=COOLDOWN_ORE.get(tipo, 24))
        if ultimo and adesso - ultimo < cooldown:
            continue
        voce["ultimo_invio"] = adesso.isoformat()
        da_notificare.append(a)

    return da_notificare, stato


def rientri(anomalie, stato, adesso):
    """Sonde tornate normali da almeno ORE_NORMALITA_PER_RESET ore.

    Non modifica lo stato: e' `filtra` a marcare il rientro come annunciato.
    """
    presenti = {a["sensor_id"] for a in anomalie}
    tornate = []
    for sonda, tipi in stato.items():
        if sonda in presenti:
            continue
        for voce in tipi.values():
            if voce.get("rientrata"):
                continue
            visto = _quando(voce.get("ultimo_visto"))
            inviato = _quando(voce.get("ultimo_invio"))
            if inviato and visto and adesso - visto >= timedelta(hours=ORE_NORMALITA_PER_RESET):
                tornate.append(sonda)
                break
    return tornate
```

- [ ] **Passo 5: eseguire e vedere il verde**

Atteso: `41 passati, 0 falliti`.

- [ ] **Passo 6: commit**

```bash
git add rpi5/scripts/orto_notify/state.py rpi5/scripts/orto_notify/confirm.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): conferma e anti-spam delle notifiche"
```

---

## Task 7: Messaggi e client Telegram

**File:**
- Crea: `rpi5/scripts/orto_notify/messages.py`
- Crea: `rpi5/scripts/orto_notify/telegram.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: le anomalie filtrate da `confirm.filtra()`.
- Produce:
  - `messages.componi(anomalia: dict, contesto: dict) -> str` — `contesto` porta `{"batterie": {sonda: volt}, "aiuola": {sonda: str}}`
  - `messages.rientro(sonda: str) -> str`
  - `telegram.invia(testo: str, token: str, chat_id: str, trasporto=None) -> int` — numero di messaggi effettivamente inviati
  - `telegram.spezza(testo: str) -> list[str]`

- [ ] **Passo 1: scrivere i casi di prova**

```python
def _sezione_messaggi():
    from datetime import datetime, timezone
    from orto_notify import messages, telegram, TELEGRAM_MAX_CHAR

    print("messaggi e telegram")

    ORA = datetime(2026, 8, 17, 14, 12, tzinfo=timezone.utc)
    CONTESTO = {
        "batterie": {"WH51_01": 1.51, "WH51_02": 1.60, "WH51_03": 1.60, "WH51_04": 1.60},
        "aiuola": {"WH51_01": "aiuola 1, vicino all'ingresso acqua"},
    }

    def muta_nomina_i_numeri():
        testo = messages.componi(
            {"sensor_id": "WH51_01", "tipo": "muta", "ora": ORA,
             "dettagli": {"silenzio_min": 52, "ultima_lettura": 47.0, "batteria": 1.51}},
            CONTESTO)
        assert "WH51_01" in testo
        assert "52" in testo
        assert "1.51" in testo

    def niente_costrutti_markdown():
        # ATTENZIONE: NON si puo' pretendere l'assenza di "_", perche' i nomi
        # delle sonde lo contengono (WH51_01). E' proprio questo il motivo per
        # cui parse_mode non va MAI impostato: in testo semplice l'underscore
        # e' innocuo, con parse_mode=Markdown fa fallire l'invio con 400.
        # Qui si controllano i soli costrutti che scriveremmo noi.
        for tipo, dett in (
            ("muta", {"silenzio_min": 52, "ultima_lettura": 47.0, "batteria": 1.51}),
            ("batteria_bassa", {"batteria": 1.12}),
            ("batteria_calo", {"pendenza_v_settimana": -0.029, "batteria": 1.51,
                               "batteria_iniziale": 1.60}),
            ("valore_bloccato", {"ore": 14, "valore": 50.0}),
            ("anomalia", {"ore_anomale": 4, "su_ore": 6,
                          "spiegazione": {"tasso_consegna": (0.98, 1.0)}}),
        ):
            testo = messages.componi(
                {"sensor_id": "WH51_01", "tipo": tipo, "ora": ORA, "dettagli": dett},
                CONTESTO)
            for vietato in ("*", "`", "[", "](" ):
                assert vietato not in testo, (tipo, vietato, testo)
            # l'underscore c'e' e va bene: e' nel nome della sonda
            assert "WH51_01" in testo, testo

    def anomalia_e_cauta():
        testo = messages.componi(
            {"sensor_id": "WH51_03", "tipo": "anomalia", "ora": ORA,
             "dettagli": {"ore_anomale": 4, "su_ore": 6,
                          "spiegazione": {"scarto_da_sorelle": (11.0, 3.0)}}},
            CONTESTO)
        assert "osservazione" in testo.lower(), testo

    def batteria_calo_dichiara_la_riserva():
        testo = messages.componi(
            {"sensor_id": "WH51_01", "tipo": "batteria_calo", "ora": ORA,
             "dettagli": {"pendenza_v_settimana": -0.029, "batteria": 1.51,
                          "batteria_iniziale": 1.60}},
            CONTESTO)
        # La proiezione lineare sovrastima: la riserva va sempre detta.
        assert "prima" in testo.lower(), testo

    def spezza_sotto_il_limite():
        assert telegram.spezza("breve") == ["breve"]

    def spezza_sopra_il_limite():
        testo = "\n\n".join("blocco %d %s" % (i, "x" * 500) for i in range(20))
        pezzi = telegram.spezza(testo)
        assert len(pezzi) > 1
        for p in pezzi:
            assert len(p) <= TELEGRAM_MAX_CHAR, len(p)
        # nulla si perde
        assert "blocco 19" in pezzi[-1]

    def invio_usa_il_trasporto():
        visti = []

        def finto(url, payload):
            visti.append((url, payload))
            return '{"ok":true}'

        n = telegram.invia("ciao", "TOK", "42", trasporto=finto)
        assert n == 1, n
        assert "TOK" in visti[0][0]
        assert visti[0][1]["chat_id"] == "42"
        assert "parse_mode" not in visti[0][1], visti[0][1]

    def senza_token_non_invia_e_non_esplode():
        n = telegram.invia("ciao", "", "42", trasporto=None)
        assert n == 0, n

    prova("il messaggio di sonda muta porta i numeri", muta_nomina_i_numeri)
    prova("nessun messaggio usa costrutti Markdown", niente_costrutti_markdown)
    prova("il messaggio del modello resta cauto", anomalia_e_cauta)
    prova("la proiezione batteria dichiara la riserva", batteria_calo_dichiara_la_riserva)
    prova("testo breve resta un messaggio", spezza_sotto_il_limite)
    prova("testo lungo si spezza senza perdere nulla", spezza_sopra_il_limite)
    prova("l'invio passa dal trasporto iniettato", invio_usa_il_trasporto)
    prova("senza token non invia e non esplode", senza_token_non_invia_e_non_esplode)
```

- [ ] **Passo 2: eseguire e vedere il fallimento**

Atteso: 8 `FAIL` con `ModuleNotFoundError`.

- [ ] **Passo 3: implementare i messaggi**

`rpi5/scripts/orto_notify/messages.py`:

```python
"""Dai fatti al testo italiano.

Testo semplice: niente Markdown, niente HTML. WH51_01 contiene un underscore
e con parse_mode Markdown Telegram risponde 400 Bad Request.
"""
from orto_notify import BATTERIA_CRITICA_V

NOMI_FEATURE = {
    "tasso_consegna": "consegna pacchetti",
    "silenzio_max_min": "pausa massima (min)",
    "batteria": "batteria (V)",
    "delta_batteria_24h": "variazione batteria 24h",
    "scarto_da_sorelle": "scarto dalle altre (pp)",
    "sigma": "variabilita' oraria",
    "ore_bloccate": "ore con valore fermo",
}


def _ora(dt):
    return dt.strftime("%H:%M")


def _altre_batterie(sonda, contesto):
    valori = [v for s, v in (contesto.get("batterie") or {}).items() if s != sonda]
    return ("%.2f V" % (sum(valori) / len(valori))) if valori else "n/d"


def componi(anomalia, contesto):
    sonda = anomalia["sensor_id"]
    d = anomalia.get("dettagli") or {}
    dove = (contesto.get("aiuola") or {}).get(sonda, "posizione non nota")
    tipo = anomalia["tipo"]

    if tipo == "muta":
        quanto = d.get("silenzio_min")
        da_quando = ("da %d minuti" % quanto) if quanto else "da un tempo imprecisato"
        return "\n".join([
            "Sonda muta: %s" % sonda,
            "",
            "Nessun dato %s (%s)." % (da_quando, dove),
            "Ultima lettura: %s%% alle %s." % (
                _fmt(d.get("ultima_lettura")), _ora(anomalia["ora"])),
            "",
            "Batteria all'ultima lettura: %s V (le altre: %s)." % (
                _fmt(d.get("batteria")), _altre_batterie(sonda, contesto)),
            "",
            "Cosa puo' essere, dalla piu' probabile:",
            "1) Batteria in esaurimento.",
            "2) Portata radio verso il GW3000.",
            "3) Sonda spostata o urtata.",
            "",
            "Il sistema continua a irrigare usando le altre (ne bastano due).",
        ])

    if tipo == "batteria_bassa":
        return "\n".join([
            "Batteria quasi esaurita: %s" % sonda,
            "",
            "%s V, sotto la soglia di avviso." % _fmt(d.get("batteria")),
            "A %.2f V il sistema smette di considerare affidabile la sonda." % BATTERIA_CRITICA_V,
            "",
            "Da sostituire: 1 stilo AA al litio.",
        ])

    if tipo == "batteria_calo":
        return "\n".join([
            "Batteria in calo: %s" % sonda,
            "",
            "%s V oggi, era %s V all'inizio della settimana osservata." % (
                _fmt(d.get("batteria")), _fmt(d.get("batteria_iniziale"))),
            "Ritmo: %s V a settimana." % _fmt(d.get("pendenza_v_settimana"), 3),
            "",
            "Non e' urgente, ma conviene procurarsi le pile.",
            "",
            "(La stima e' una proiezione lineare: le pile tengono la tensione",
            "e poi crollano, quindi il momento vero puo' arrivare prima.)",
        ])

    if tipo == "valore_bloccato":
        return "\n".join([
            "Valore fermo: %s" % sonda,
            "",
            "Stessa lettura (%s%%) da %d ore, mentre le altre sonde si muovono." % (
                _fmt(d.get("valore")), d.get("ore", 0)),
            "",
            "Puo' essere una sonda scollegata dal terreno o un guasto",
            "dell'elettronica di misura. Vale un controllo sul posto.",
        ])

    if tipo == "anomalia":
        righe = [
            "Comportamento insolito: %s" % sonda,
            "",
            "Nelle ultime %d ore questa sonda si e' comportata in modo diverso" % d.get("su_ore", 0),
            "sia dal suo passato sia dalle altre, per %d ore su %d." % (
                d.get("ore_anomale", 0), d.get("su_ore", 0)),
            "",
            "Cosa la distingue in questo momento:",
        ]
        for chiave, coppia in (d.get("spiegazione") or {}).items():
            valore, atteso = coppia
            righe.append("  %-24s %s  (di solito %s)" % (
                NOMI_FEATURE.get(chiave, chiave), _fmt(valore), _fmt(atteso)))
        righe += [
            "",
            "E' un'osservazione, non una diagnosi: il modello segnala che",
            "qualcosa e' cambiato, non sa dire che cosa.",
        ]
        return "\n".join(righe)

    return "Anomalia %s su %s." % (tipo, sonda)


def rientro(sonda):
    return "Rientrata: %s trasmette di nuovo regolarmente." % sonda


def _fmt(valore, decimali=2):
    if valore is None:
        return "n/d"
    try:
        return ("%%.%df" % decimali) % float(valore)
    except (TypeError, ValueError):
        return str(valore)
```

- [ ] **Passo 4: implementare il client Telegram**

`rpi5/scripts/orto_notify/telegram.py`:

```python
"""Invio su Telegram. Sola uscita: il bot parla e non ascolta."""
import json
import urllib.parse
import urllib.request

from orto_notify import TELEGRAM_MAX_CHAR, TELEGRAM_URL

TIMEOUT_S = 15


def _trasporto_http(url, payload):
    dati = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(url, data=dati, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read().decode("utf-8")


def spezza(testo):
    """Divide sui paragrafi rispettando il limite di 4096 caratteri.

    Non tronca mai: troncare perde informazione, spezzare no.
    """
    if len(testo) <= TELEGRAM_MAX_CHAR:
        return [testo]

    pezzi = []
    corrente = ""
    for blocco in testo.split("\n\n"):
        candidato = (corrente + "\n\n" + blocco) if corrente else blocco
        if len(candidato) <= TELEGRAM_MAX_CHAR:
            corrente = candidato
            continue
        if corrente:
            pezzi.append(corrente)
        # Un singolo blocco piu' lungo del limite si taglia per righe.
        while len(blocco) > TELEGRAM_MAX_CHAR:
            taglio = blocco.rfind("\n", 0, TELEGRAM_MAX_CHAR)
            if taglio <= 0:
                taglio = TELEGRAM_MAX_CHAR
            pezzi.append(blocco[:taglio])
            blocco = blocco[taglio:].lstrip("\n")
        corrente = blocco
    if corrente:
        pezzi.append(corrente)
    return pezzi


def invia(testo, token, chat_id, trasporto=None):
    """Invia il testo, spezzandolo se serve. Restituisce quanti messaggi.

    Senza token non fa nulla e non solleva: la mancanza di configurazione non
    deve far cadere il ciclo.
    """
    if not token or not chat_id:
        return 0
    inviare = trasporto or _trasporto_http
    url = TELEGRAM_URL.format(token=token)
    inviati = 0
    for pezzo in spezza(testo):
        payload = {"chat_id": chat_id, "text": pezzo}
        # Nessun parse_mode: il testo e' semplice di proposito (underscore).
        risposta = inviare(url, payload)
        try:
            if json.loads(risposta).get("ok"):
                inviati += 1
        except (ValueError, AttributeError):
            pass
    return inviati
```

- [ ] **Passo 5: eseguire e vedere il verde**

Atteso: `49 passati, 0 falliti`.

- [ ] **Passo 6: commit**

```bash
git add rpi5/scripts/orto_notify/messages.py rpi5/scripts/orto_notify/telegram.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): messaggi in italiano e client Telegram"
```

---

## Task 8: Orchestrazione e CLI

**File:**
- Crea: `rpi5/scripts/orto_notify/__main__.py`
- Modifica: `rpi5/scripts/orto_notify/selftest.py`

**Interfaces:**
- Consuma: tutti i moduli precedenti.
- Produce: `ciclo(token_influx, token_tg, chat_id, adesso=None, dry_run=False, trasporti=None) -> dict` con `{"anomalie": int, "inviati": int, "righe": int}`; e la CLI `python3 -m orto_notify [--once] [--dry-run] [--backtest N]`.

- [ ] **Passo 1: scrivere i casi di prova**

```python
def _sezione_ciclo():
    from datetime import datetime, timedelta, timezone
    from orto_notify import __main__ as principale

    print("ciclo completo")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def serie_finta(n_ore=400, muta=False):
        righe = []
        for sonda in ("WH51_01", "WH51_02", "WH51_03", "WH51_04"):
            for h in range(n_ore, 0, -1):
                if muta and sonda == "WH51_01" and h < 3:
                    continue
                righe.append({
                    "sensor_id": sonda, "ora": ADESSO - timedelta(hours=h),
                    "campioni": 60, "media": 50.0 + (h % 5) * 0.1,
                    "sigma": 1.2, "batteria": 1.60, "silenzio_max_min": 1.0,
                })
        return righe

    def trasporti(righe, muta=False):
        inviati = []
        sonde = ("WH51_01", "WH51_02", "WH51_03", "WH51_04")
        ultimi = {s: ADESSO - timedelta(minutes=2) for s in sonde}
        if muta:
            ultimi["WH51_01"] = ADESSO - timedelta(minutes=70)
        return {
            "serie": lambda *a, **k: righe,
            "finestre": lambda *a, **k: [],
            "ultimi": lambda *a, **k: ultimi,
            "telegram": lambda url, payload: (inviati.append(payload) or '{"ok":true}'),
            "_inviati": inviati,
        }

    def orto_sano_non_manda_nulla():
        t = trasporti(serie_finta())
        esito = principale.ciclo("TI", "TT", "42", adesso=ADESSO, trasporti=t)
        assert esito["inviati"] == 0, esito
        assert t["_inviati"] == [], t["_inviati"]

    def sonda_muta_produce_un_messaggio():
        t = trasporti(serie_finta(muta=True), muta=True)
        esito = principale.ciclo("TI", "TT", "42", adesso=ADESSO, trasporti=t,
                                 stato_path="/tmp/orto_notify_ciclo_1.json")
        assert esito["inviati"] >= 1, esito
        assert "WH51_01" in t["_inviati"][0]["text"], t["_inviati"][0]

    def dry_run_non_invia():
        t = trasporti(serie_finta(muta=True), muta=True)
        esito = principale.ciclo("TI", "TT", "42", adesso=ADESSO, trasporti=t,
                                 dry_run=True, stato_path="/tmp/orto_notify_ciclo_2.json")
        assert esito["anomalie"] >= 1, esito
        assert t["_inviati"] == [], t["_inviati"]

    def influx_giu_non_esplode():
        def esplode(*a, **k):
            raise OSError("connessione rifiutata")
        t = {"serie": esplode, "finestre": lambda *a, **k: [],
             "ultimi": lambda *a, **k: {},
             "telegram": lambda url, payload: '{"ok":true}'}
        esito = principale.ciclo("TI", "TT", "42", adesso=ADESSO, trasporti=t)
        assert esito["righe"] == 0, esito
        assert esito["inviati"] == 0, esito

    import os
    for f in ("/tmp/orto_notify_ciclo_1.json", "/tmp/orto_notify_ciclo_2.json"):
        if os.path.exists(f):
            os.remove(f)

    prova("orto sano: nessun messaggio", orto_sano_non_manda_nulla)
    prova("sonda muta: un messaggio con il suo nome", sonda_muta_produce_un_messaggio)
    prova("--dry-run rileva ma non invia", dry_run_non_invia)
    prova("InfluxDB irraggiungibile non fa cadere il ciclo", influx_giu_non_esplode)
```

- [ ] **Passo 2: eseguire e vedere il fallimento**

Atteso: 4 `FAIL`.

- [ ] **Passo 3: implementare**

`rpi5/scripts/orto_notify/__main__.py`:

```python
"""Orchestrazione e CLI.

    python3 -m orto_notify --once
    python3 -m orto_notify --once --dry-run
    python3 -m orto_notify --backtest 120
"""
import argparse
import os
import sys
from datetime import datetime, timezone

from orto_notify import (
    GIORNI_ADDESTRAMENTO,
    INFLUX_TOKEN_ENV,
    SONDE,
    STATO_PATH,
)
from orto_notify import confirm, detect, features, influx, messages, state, telegram

AIUOLE = {
    "WH51_01": "aiuola 1, vicino all'ingresso acqua",
    "WH51_02": "aiuola 1, in fondo alla fila",
    "WH51_03": "aiuola 2, vicino all'ingresso acqua",
    "WH51_04": "aiuola 2, in fondo alla fila",
}


def ciclo(token_influx, token_tg, chat_id, adesso=None, dry_run=False,
          trasporti=None, stato_path=STATO_PATH, giorni=GIORNI_ADDESTRAMENTO):
    """Un giro completo. Non solleva mai: al peggio non fa nulla e lo dice."""
    adesso = adesso or datetime.now(timezone.utc)
    trasporti = trasporti or {}

    leggi_serie = trasporti.get("serie", influx.serie_oraria)
    leggi_finestre = trasporti.get("finestre", influx.finestre_irrigazione)
    leggi_ultimi = trasporti.get("ultimi", influx.ultimo_campione)
    invio = trasporti.get("telegram")

    try:
        righe = leggi_serie(token_influx, giorni)
        finestre = leggi_finestre(token_influx, 2)
        ultimi = leggi_ultimi(token_influx)
    except Exception as e:
        print("[notify] InfluxDB non raggiungibile: %s" % e, file=sys.stderr)
        return {"anomalie": 0, "inviati": 0, "righe": 0}

    righe = [r for r in righe if r["sensor_id"] in SONDE]
    if not righe:
        print("[notify] nessun dato nella finestra", file=sys.stderr)
        return {"anomalie": 0, "inviati": 0, "righe": 0}

    arricchite = features.costruisci(righe)
    anomalie = detect.guardie(arricchite, adesso, finestre, ultimi=ultimi)
    anomalie += detect.anomalie_modello(arricchite, adesso, finestre)

    stato = state.carica(stato_path)
    da_inviare, stato_nuovo = confirm.filtra(anomalie, stato, adesso)
    tornate = confirm.rientri(anomalie, stato, adesso)

    contesto = {
        "batterie": {
            r["sensor_id"]: r.get("batteria")
            for r in sorted(arricchite, key=lambda x: x["ora"])
            if r.get("batteria")
        },
        "aiuola": AIUOLE,
    }

    inviati = 0
    testi = [messages.componi(a, contesto) for a in da_inviare]
    testi += [messages.rientro(s) for s in tornate]

    for testo in testi:
        if dry_run:
            print("--- messaggio (non inviato) ---")
            print(testo)
            continue
        try:
            inviati += telegram.invia(testo, token_tg, chat_id, trasporto=invio)
        except Exception as e:
            # Telegram giu' non deve impedire di aggiornare lo stato.
            print("[notify] invio fallito: %s" % e, file=sys.stderr)

    if not dry_run:
        state.salva(stato_path, stato_nuovo)

    return {"anomalie": len(anomalie), "inviati": inviati, "righe": len(righe)}


def principale(argv=None):
    p = argparse.ArgumentParser(prog="orto_notify")
    p.add_argument("--once", action="store_true", help="un solo giro (default)")
    p.add_argument("--dry-run", action="store_true", help="rileva e stampa, non invia")
    p.add_argument("--backtest", type=int, metavar="GIORNI",
                   help="conta gli alert che sarebbero scattati sullo storico")
    args = p.parse_args(argv)

    token_influx = os.environ.get(INFLUX_TOKEN_ENV, "")
    token_tg = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")

    if not token_influx:
        print("manca %s nell'ambiente" % INFLUX_TOKEN_ENV, file=sys.stderr)
        return 2

    if args.backtest:
        return _backtest(token_influx, args.backtest)

    esito = ciclo(token_influx, token_tg, chat_id, dry_run=args.dry_run)
    print("righe=%(righe)d anomalie=%(anomalie)d inviati=%(inviati)d" % esito)
    return 0


def _backtest(token_influx, giorni):
    """Quante volte ogni regola sarebbe scattata sullo storico."""
    from datetime import timedelta

    righe = features.costruisci(
        [r for r in influx.serie_oraria(token_influx, giorni) if r["sensor_id"] in SONDE]
    )
    finestre = influx.finestre_irrigazione(token_influx, giorni)
    if not righe:
        print("nessun dato")
        return 1

    conteggi = {}
    inizio = min(r["ora"] for r in righe)
    fine = max(r["ora"] for r in righe)
    istante = inizio + timedelta(days=8)     # serve storia per G3
    stato = {}
    while istante <= fine:
        finestra = [r for r in righe if r["ora"] <= istante]
        trovate = detect.guardie(finestra, istante, finestre)
        trovate += detect.anomalie_modello(finestra, istante, finestre)
        da_inviare, stato = confirm.filtra(trovate, stato, istante)
        for a in da_inviare:
            chiave = (a["sensor_id"], a["tipo"])
            conteggi[chiave] = conteggi.get(chiave, 0) + 1
        istante += timedelta(hours=1)

    settimane = max(1.0, (fine - inizio).total_seconds() / (7 * 86400.0))
    print("periodo: %s .. %s (%.1f settimane)" % (
        inizio.date(), fine.date(), settimane))
    print("%-10s %-16s %8s %10s" % ("sonda", "tipo", "alert", "per sett."))
    for (sonda, tipo), n in sorted(conteggi.items()):
        print("%-10s %-16s %8d %10.2f" % (sonda, tipo, n, n / settimane))
    if not conteggi:
        print("nessun alert sarebbe scattato")
    return 0


if __name__ == "__main__":
    sys.exit(principale())
```

- [ ] **Passo 4: eseguire e vedere il verde**

Atteso: `53 passati, 0 falliti`.

- [ ] **Passo 5: commit**

```bash
git add rpi5/scripts/orto_notify/__main__.py rpi5/scripts/orto_notify/selftest.py
git commit -m "feat(scripts): orchestrazione del ciclo di notifica e CLI"
```

---

## Task 9: Taratura sullo storico

**File:**
- Modifica: `docs/step17_notifiche_telegram.md` (sezione «Taratura», nuova)
- Eventualmente modifica: `rpi5/scripts/orto_notify/__init__.py` (solo le soglie, se la retro-verifica lo impone)

**Interfaces:**
- Consuma: `python3 -m orto_notify --backtest`.
- Produce: le soglie definitive e la loro giustificazione scritta.

> **Criterio di accettazione, fissato ora e prima di guardare i numeri** (spec §9):
> meno di **un alert a settimana per sonda sana** (WH51_02/03/04), e **almeno un alert su
> WH51_01** nella finestra del 2026-08-16. Una regola che avrebbe generato decine di alert
> è mal tarata, non sensibile.

- [ ] **Passo 1: copiare il pacchetto sul RPi ed eseguire la retro-verifica**

```bash
scp -r rpi5/scripts/orto_notify as@192.168.1.12:/tmp/
ssh as@192.168.1.12 'sudo apt-get install -y python3-sklearn'
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; cd /tmp && python3 -m orto_notify --backtest 100'
```

- [ ] **Passo 2: leggere l'esito contro il criterio**

Confrontare la colonna `per sett.` con il criterio sopra. Tre esiti possibili:

| Esito | Azione |
|---|---|
| Sonde sane sotto 1 alert/settimana **e** WH51_01 segnalata | soglie confermate, si prosegue |
| Sonde sane sopra 1 alert/settimana | **alzare** la soglia del tipo che spara di più, e ripetere il backtest |
| WH51_01 mai segnalata | **abbassare** la soglia pertinente, e ripetere |

Ogni modifica di soglia va fatta **solo** in `rpi5/scripts/orto_notify/__init__.py`, mai
sparsa nei moduli.

- [ ] **Passo 3: scrivere l'esito nella spec**

Aggiungere in `docs/step17_notifiche_telegram.md`, prima di `## Implementazione`, una
sezione `## Taratura` con: la tabella prodotta dal backtest, le soglie finali, e — se sono
state cambiate — perché.

- [ ] **Passo 4: commit**

```bash
git add docs/step17_notifiche_telegram.md rpi5/scripts/orto_notify/__init__.py
git commit -m "docs(step17): taratura delle soglie sullo storico"
```

---

## Task 10: Deploy sul RPi

**File:**
- Crea: `rpi5/scripts/orto-notify.service`
- Crea: `rpi5/scripts/orto-notify.timer`
- Modifica: `rpi5/.env.example`
- Modifica: `docs/comandi_verifica.md`

**Interfaces:**
- Consuma: il pacchetto completo.
- Produce: il servizio attivo sul RPi.

> **Prerequisito umano:** il bot Telegram va creato a mano su @BotFather, e il `chat_id` si
> ottiene scrivendo al bot e leggendo `https://api.telegram.org/bot<TOKEN>/getUpdates`.
> Entrambi i valori vanno messi in `/opt/orto-digitale/.env` **dall'utente**: non devono
> mai comparire nel repo.

- [ ] **Passo 1: scrivere le unit systemd**

`rpi5/scripts/orto-notify.service`:

```ini
[Unit]
Description=Orto Digitale - notifiche Telegram sulla salute delle sonde
After=multi-user.target docker.service

[Service]
Type=oneshot
User=as
WorkingDirectory=/opt/orto-digitale/scripts
EnvironmentFile=/opt/orto-digitale/.env
ExecStart=/usr/bin/python3 -m orto_notify --once
```

`rpi5/scripts/orto-notify.timer`:

```ini
[Unit]
Description=Orto Digitale - timer notifiche salute sonde (ogni 15 min)

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
AccuracySec=30s
Unit=orto-notify.service

[Install]
WantedBy=timers.target
```

- [ ] **Passo 2: aggiungere i placeholder in `.env.example`**

In fondo a `rpi5/.env.example`:

```bash
# ---- Telegram (step 17) ------------------------------------------------------
# Bot creato a mano su @BotFather. Il chat_id si legge da
#   https://api.telegram.org/bot<TOKEN>/getUpdates
# dopo aver scritto un messaggio qualsiasi al bot.
# NOTA: questi valori NON sono credenziali di nodo Node-RED, quindi non entrano
# nel giro di ri-iniezione di docs/comandi_verifica.md §5.5.
TELEGRAM_BOT_TOKEN=<da-botfather>
TELEGRAM_CHAT_ID=<numerico>
# Il servizio di notifica riusa il token InfluxDB di sola lettura gia' presente
# in .env come INFLUX_TOKEN_EXPORT_RO (attenzione: qui sopra si chiama
# INFLUXDB_TOKEN_EXPORT_RO — e' il footgun #1, non aggiungere alias nuovi).
```

- [ ] **Passo 3: installare sul RPi**

```bash
ssh as@192.168.1.12 'sudo apt-get install -y python3-sklearn'
scp -r rpi5/scripts/orto_notify as@192.168.1.12:/tmp/
scp rpi5/scripts/orto-notify.service rpi5/scripts/orto-notify.timer as@192.168.1.12:/tmp/
ssh as@192.168.1.12 'echo aru63 | sudo -S bash -c "
  rm -rf /opt/orto-digitale/scripts/orto_notify &&
  cp -r /tmp/orto_notify /opt/orto-digitale/scripts/ &&
  chown -R as:as /opt/orto-digitale/scripts/orto_notify &&
  mkdir -p /opt/orto-digitale/notify && chown as:as /opt/orto-digitale/notify &&
  cp /tmp/orto-notify.service /tmp/orto-notify.timer /etc/systemd/system/ &&
  systemctl daemon-reload
"'
```

- [ ] **Passo 4: prova a secco prima di attivare il timer**

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; cd /opt/orto-digitale/scripts && python3 -m orto_notify --once --dry-run'
```

Atteso: stampa `righe=...` e gli eventuali messaggi, **senza** inviare nulla. Se stampa
`manca INFLUX_TOKEN_EXPORT_RO nell'ambiente`, il `.env` non è stato caricato.

- [ ] **Passo 5: primo invio vero**

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; cd /opt/orto-digitale/scripts && python3 -m orto_notify --once'
```

Atteso: il messaggio arriva sul telefono. Se Telegram risponde `400`, controllare che il
testo non contenga sintassi Markdown (il test lo esclude, ma la verifica sul campo è la
prova vera).

- [ ] **Passo 6: attivare il timer**

```bash
ssh as@192.168.1.12 'echo aru63 | sudo -S systemctl enable --now orto-notify.timer'
ssh as@192.168.1.12 'systemctl list-timers | grep orto-notify'
```

- [ ] **Passo 7: verificare che non abbia disturbato niente**

```bash
ssh as@192.168.1.12 'bash /opt/orto-digitale/scripts/verify_rpi5.sh 2>&1 | tail -5'
ssh as@192.168.1.12 'docker ps --format "{{.Names}} {{.Status}}"'
curl -s -k --max-time 15 --resolve orto.local:443:192.168.1.12 https://orto.local/api/state | head -c 200
```

Atteso: healthcheck verde, i sei container `Up`, `mode` invariato. **Nessun container è
stato riavviato** — è il punto di tutto il disegno.

- [ ] **Passo 8: documentare i comandi**

Aggiungere in `docs/comandi_verifica.md` una sezione `## 11. Notifiche Telegram (step 17)`
con i comandi dei passi 4, 5, 6 e la lettura dello stato:

```bash
ssh as@192.168.1.12 'cat /opt/orto-digitale/notify/state.json'
ssh as@192.168.1.12 'journalctl -u orto-notify.service --since "1 day ago" | tail -30'
```

- [ ] **Passo 9: commit**

```bash
git add rpi5/scripts/orto-notify.service rpi5/scripts/orto-notify.timer rpi5/.env.example docs/comandi_verifica.md
git commit -m "feat(scripts): unit systemd e deploy delle notifiche Telegram"
```

---

## Task 11: Documentazione e chiusura

**File:**
- Modifica: `CLAUDE.md`
- Modifica: `docs/step17_notifiche_telegram.md`

- [ ] **Passo 1: applicare le quattro correzioni a `CLAUDE.md`**

Tutte e quattro sono state verificate sul campo il 2026-08-17 (spec §10):

1. **Cooldown**: la tabella «Logica irrigazione» dice `4 ore`; `irrigation_config.json` dice
   `cooldown_seconds: 7200` = **2 ore**. Correggere in `2 ore`.
2. **`rssi`**: rimuoverlo dai field di `soil_moisture` nello schema — non è mai stato
   scritto e il GW3000 non lo pubblica.
3. **OS**: `RPi OS Lite 64-bit, Debian **Trixie**` (Debian 13), non Bookworm.
4. **Invariante «locale»**: sostituire con la formulazione della spec §10.1.

- [ ] **Passo 2: aggiungere la riga dello step 17**

Nella tabella «Stato avanzamento»:

```markdown
| 17 | Notifiche Telegram (fase 1 — salute sonde) | ✅ salute sonde; ⏳ bagnatura (fase 2, serve la taratura per-sonda — vedi docs/step17_notifiche_telegram.md §6.2) |
```

- [ ] **Passo 3: aggiungere la riga nella tabella «File chiave»**

```markdown
| `rpi5/scripts/orto_notify/` | Servizio di notifica Telegram — gira sull'**host**, fuori da Docker. Non tocca `flows.json`: un suo errore non puo' raggiungere il decision loop. Il token Telegram sta in `.env`, quindi **non** entra nel giro di ri-iniezione credenziali di §5.5 |
```

- [ ] **Passo 4: compilare la sezione `## Implementazione` della spec**

Secondo il pattern obbligatorio di `CLAUDE.md`:

```markdown
---
## Implementazione
**Stato:** ✅ COMPLETATO (fase 1) — 2026-MM-DD
**Commit di riferimento:** `feat(scripts): unit systemd e deploy delle notifiche Telegram` (hash breve)
**Note:** [cosa ha funzionato, cosa si e' dovuto adattare]
**Deviazioni dalla spec:** [nessuna | descrizione e motivazione]
```

- [ ] **Passo 5: eseguire l'intera batteria un'ultima volta**

```bash
cd rpi5/scripts && python3 -m orto_notify.selftest
cd ../.. && for f in rpi5/nodered/test/*.test.mjs; do node "$f" | tail -1; done
```

Atteso: `53 passati, 0 falliti` per Python, e **126 verdi** per i test Node-RED — che
devono essere rimasti intatti, perché questo step non ha toccato `flows.json`.

- [ ] **Passo 6: commit**

```bash
git add CLAUDE.md docs/step17_notifiche_telegram.md
git commit -m "docs(step17): marca la fase 1 come COMPLETATA e corregge CLAUDE.md"
```

- [ ] **Passo 7: chiusura del branch**

Usare la skill `superpowers:finishing-a-development-branch`.

---

## Nota sulla verifica di questo piano

Il codice di questo documento **non è stato scritto a occhio**: i blocchi sono stati
estratti, assemblati in un pacchetto e il banco di prova è stato eseguito davvero, con
esito **53 passati, 0 falliti** (2026-08-17, Python 3.13 + scikit-learn 1.9).

Conseguenza pratica per chi implementa: se un test fallisce, la causa più probabile è una
trascrizione imprecisa, non un difetto della logica. Confrontare il proprio file con il
blocco del piano prima di mettersi a debuggare.

Due difetti sono già stati trovati e corretti proprio grazie a quell'esecuzione, e vale la
pena conoscerli perché sono facili da reintrodurre:

- **Il silenzio non si misura dagli aggregati orari.** Un bucket è vecchio fino a 60 minuti
  per costruzione: misurare `adesso − ora_bucket` farebbe risultare muta ogni sonda a ogni
  ciclo, con una soglia di 45 minuti. Da qui `influx.ultimo_campione()`.
- **Non si può pretendere l'assenza di `_` nei messaggi**, perché i nomi delle sonde lo
  contengono. La protezione contro il `400 Bad Request` di Telegram non è evitare il
  carattere: è non impostare mai `parse_mode`.

---

## Verifica finale (checklist)

- [x] `python3 -m orto_notify.selftest` → **56 passati, 0 falliti** (53 del piano + 3 aggiunti dai fix di produzione)
- [x] I test Node-RED sono ancora verdi — **148 su 8 file**, non 126: nel frattempo un'altra sessione ha aggiunto `id_fisici.test.mjs` (16) e ampliato `registro_sensori.test.mjs` (23 → 29). Il criterio è «tutti verdi», non un numero fisso, perché un conteggio assoluto è fragile quando due sessioni lavorano sullo stesso repo
- [x] `git diff main --name-only` **non** contiene `flows.json`, `irrigation_config.json`, `docker-compose.yml`, né file del frontend
- [x] `--backtest` rispetta il criterio: < 1 alert/settimana per sonda sana, ≥ 1 su WH51_01 — vedi §Taratura della spec
- [x] `--dry-run` sul RPi stampa senza inviare
- [ ] **Un messaggio vero è arrivato sul telefono** — bloccato: manca il bot, vedi §Come creare il bot
- [ ] **`systemctl list-timers` mostra `orto-notify.timer` armato** — bloccato dallo stesso motivo
- [x] `verify_rpi5.sh` verde e i sei container `Up` senza riavvii
- [x] Nessun token compare nel repo
- [ ] Le quattro correzioni a `CLAUDE.md` sono applicate — task 11, ancora da fare

---

## Stato al 2026-08-17

**Dieci task su undici completi.** Il servizio è installato e verificato sul Raspberry, ma
non invia ancora: manca il bot Telegram, che va creato a mano (sezione successiva).

| Task | Stato | Commit |
|---|---|---|
| 0 Branch | ✅ | — |
| 1 Scheletro e banco di prova | ✅ | `782183d` |
| 2 Client InfluxDB | ✅ | `ed5005c` |
| 3 Matrice delle feature | ✅ dopo 1 fix | `6899569`, `89f9545` |
| 4 Guardie deterministiche | ✅ pulito al primo giro | `559e168` |
| 5 Isolation Forest | ✅ pulito al primo giro | `a5e9e3f` |
| 6 Conferma e anti-spam | ✅ pulito al primo giro | `763ad76` |
| 7 Messaggi e Telegram | ✅ pulito al primo giro | `73f7dd1` |
| 8 Orchestrazione e CLI | ✅ dopo 1 fix | `e02fe50`, `192d34c` |
| 9 Taratura | ✅ nessuna soglia cambiata | `f071dc3` |
| 10 Deploy | ✅ parziale — timer non attivato | `af2b3b3` |
| — Fix da dati reali | ✅ | `e1ff64b` |
| 11 Documentazione | ⏳ da fare | — |

### I due bug che solo i dati reali hanno rivelato

Il dry-run contro il sistema vero ha fatto emergere due difetti che le 53 prove sintetiche
non potevano cogliere. Entrambi erano bloccanti; entrambi ora hanno un test che li copre.

**NaN da `stddev` su bucket con un solo campione.** InfluxDB serializza una deviazione
indefinita come la stringa `"NaN"`, e `float("NaN")` la accetta senza sollevare. Quel NaN
arrivava all'Isolation Forest, che lo rifiuta, e faceva fallire **l'intero ciclo** —
comprese le guardie deterministiche, perché `ciclo()` le racchiude nello stesso
`try/except`. Misurato sui dati veri: 12 righe su 2886 in 30 giorni, **tutte di
`WH51_01`**, cioè proprio la sonda che perde pacchetti.

**Il bucket dell'ora corrente si frammentava in cinque righe.** Le cinque sotto-query di
`serie_oraria` girano in istanti diversi; per l'ora ancora aperta `aggregateWindow`
etichetta il bucket parziale con il momento dell'esecuzione, quindi i cinque timestamp
differivano di microsecondi e la chiave `(sensor_id, ora)` non combaciava: le righe non si
fondevano. Ogni frammento aveva quattro campi su cinque vuoti, che diventavano `0.0`, e il
modello leggeva quel profilo tutto-zeri come un'anomalia clamorosa su **tutte e quattro le
sonde, a ogni ciclo**. Misurato: 20 righe parziali su 212, 20 su 20 incomplete. In
produzione sarebbero state quattro notifiche false ogni quarto d'ora — abbastanza da farsi
silenziare il bot nel giro di un pomeriggio, e da rendere inutile tutto il resto.

Il secondo era la forma acuta di un difetto annotato come «minore» al task 3 (bucket non
allineati all'ora). Quella classificazione era sbagliata.

**Dopo il fix, contro il sistema reale:**

```
righe=2880 anomalie=1 inviati=0
```

Una sola anomalia, quella vera: batteria di `WH51_01` in calo. Le quattro false sono
sparite.

---

## Come creare il bot Telegram

Questi passaggi richiedono il tuo telefono e non possono essere automatizzati: BotFather
parla solo con una persona dentro Telegram. Servono cinque minuti.

### 1. Creare il bot

Apri Telegram e cerca **@BotFather** (quello con la spunta di verifica). Scrivigli:

```
/newbot
```

Ti chiederà due cose in sequenza:
- **il nome visualizzato** — quello che vedrai in cima alla chat. Per esempio `Orto Digitale`
- **lo username** — deve essere unico su tutto Telegram e finire per `bot`. Per esempio
  `orto_digitale_casa_bot`. Se è già preso te lo dice e puoi riprovare

Alla fine BotFather risponde con un messaggio che contiene il token, in questa forma:

```
123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
```

**Quel token è una credenziale**: chi ce l'ha può scrivere a nome del tuo bot. Non
incollarlo in chat, non metterlo nel repo, non mandarlo per email. Se ti scappa, da
BotFather puoi revocarlo con `/revoke` e generarne uno nuovo.

### 2. Ottenere il tuo `chat_id`

Il bot può scrivere solo a chi gli ha parlato per primo. Quindi:

1. Cerca il tuo bot con lo username che hai scelto e apri la chat
2. Premi **Avvia** (o scrivi `/start`) e manda un messaggio qualsiasi, anche solo `ciao`

Poi, dal PC, chiedi a Telegram cosa ha ricevuto — sostituisci `<TOKEN>` con il tuo:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | tr ',' '\n' | grep -A2 '"chat"'
```

Nella risposta cerca `"chat":{"id":...}`: quel numero è il tuo `chat_id`. È un intero, di
solito 9-10 cifre, e può essere negativo se un giorno userai un gruppo invece della chat
personale.

Se `getUpdates` restituisce una lista vuota, il messaggio del punto 2 non è arrivato:
controlla di aver scritto **al tuo bot** e non a BotFather.

### 3. Metterli sul Raspberry

I segreti vivono solo in `/opt/orto-digitale/.env`, mai nel repo. Aggiungili in coda:

```bash
ssh as@192.168.1.12
sudo tee -a /opt/orto-digitale/.env >/dev/null <<'EOF'

# ---- Telegram (step 17) ----
TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
TELEGRAM_CHAT_ID=987654321
EOF
```

Sostituisci i due valori con i tuoi. Verifica che siano stati letti correttamente, senza
stamparli:

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  echo "token: ${#TELEGRAM_BOT_TOKEN} caratteri"; echo "chat_id: ${#TELEGRAM_CHAT_ID} cifre"'
```

Attesi: un token di **44-46 caratteri** (l'id numerico del bot, i due punti, e 34 caratteri
di segreto) e un chat_id di **9-10 cifre**. Se leggi `0` per uno dei due, la riga nel `.env`
ha un errore di battitura.

### 4. Prova a vuoto, poi invio vero

Prima senza inviare nulla — deve stampare i messaggi e `inviati=0`:

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  cd /opt/orto-digitale/scripts && python3 -m orto_notify --once --dry-run'
```

Poi per davvero. Questo **manda il messaggio sul telefono**:

```bash
ssh as@192.168.1.12 'set -a; . /opt/orto-digitale/.env; set +a; \
  cd /opt/orto-digitale/scripts && python3 -m orto_notify --once'
```

Deve stampare `inviati=1` (o più) e il messaggio deve comparire in chat. Allo stato attuale
del sistema il primo messaggio sarà l'avviso di batteria in calo su `WH51_01`.

Se Telegram risponde `400 Bad Request`, il testo contiene qualcosa che l'API rifiuta:
segnalalo invece di aggirarlo, perché il codice è scritto apposta per non farlo accadere
(nessun `parse_mode`, testo semplice).

Se stampa `inviati=0` senza errori, il token o il chat_id non sono stati letti: torna al
punto 3.

### 5. Attivare il timer

Solo dopo che un messaggio è arrivato davvero:

```bash
ssh as@192.168.1.12 'echo aru63 | sudo -S systemctl enable --now orto-notify.timer'
ssh as@192.168.1.12 'systemctl list-timers | grep orto-notify'
```

Da quel momento il controllo gira ogni 15 minuti. Per vedere cosa ha fatto:

```bash
ssh as@192.168.1.12 'journalctl -u orto-notify.service --since "1 day ago" | tail -30'
ssh as@192.168.1.12 'cat /opt/orto-digitale/notify/state.json'
```

Lo `state.json` è la memoria dell'anti-spam: contiene, per ogni sonda e tipo di problema,
quando è stato mandato l'ultimo avviso. Cancellarlo non rompe nulla — al più fa ripetere
un avviso già visto.

### Come fermarlo

Se il bot diventa molesto o vuoi sospenderlo durante dei lavori sull'orto:

```bash
ssh as@192.168.1.12 'echo aru63 | sudo -S systemctl disable --now orto-notify.timer'
```

Nulla di ciò che riguarda l'irrigazione ne risente: il servizio di notifica è un processo
separato che legge soltanto. Fermarlo non tocca né Node-RED né la valvola.
