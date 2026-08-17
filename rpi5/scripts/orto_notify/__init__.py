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
BATTERIA_FINESTRA_GIORNI = 7       # G3: ampiezza della finestra di regressione
BATTERIA_GIORNI_CONFERMA = 3
ORE_BLOCCATE = 12             # G4
DELTA_SORELLA_PP = 3.0        # G4: variazione minima di un'altra sonda

# --- Isolation Forest (spec §4.4) -------------------------------------------
IF_ALBERI = 200
IF_CONTAMINAZIONE = 0.02
IF_SEED = 0                   # riproducibilita': stesso input, stesso esito
IF_ORE_FINESTRA = 6
IF_ORE_CONFERMA = 3
MIN_RIGHE_ADDESTRAMENTO = 200  # sotto questa soglia il modello non si addestra

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
FINESTRE_IRRIGAZIONE_GIORNI = 2   # quanti giorni di eventi valvola leggere ogni ciclo

# --- Telegram ---------------------------------------------------------------
TELEGRAM_URL = "https://api.telegram.org/bot{token}/sendMessage"
TELEGRAM_MAX_CHAR = 4096
# Nessun cap difensivo sul numero di messaggi/ora: il volume e' gia' delimitato
# dal timer ogni 15 minuti e dal cooldown per (sonda, tipo) in COOLDOWN_ORE.

# --- Stato ------------------------------------------------------------------
STATO_PATH = "/opt/orto-digitale/notify/state.json"
