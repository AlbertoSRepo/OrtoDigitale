"""Rilevazione ibrida: guardie deterministiche + Isolation Forest.

Le guardie coprono i guasti che sappiamo nominare (silenzio, batteria, valore
bloccato) — piu' affidabili e soprattutto spiegabili in un messaggio.
L'Isolation Forest copre cio' che a regole non si esprime.
"""
from datetime import timedelta
from statistics import median

from orto_notify import (
    BATTERIA_BASSA_V,
    BATTERIA_FINESTRA_GIORNI,
    BATTERIA_GIORNI_CONFERMA,
    BATTERIA_LETTURE_CONFERMA,
    BATTERIA_PENDENZA_V_SETT,
    DELTA_SORELLA_PP,
    IF_ALBERI,
    IF_CONTAMINAZIONE,
    IF_ORE_CONFERMA,
    IF_ORE_FINESTRA,
    IF_SEED,
    MIN_RIGHE_ADDESTRAMENTO,
    ORE_BLOCCATE,
    SILENZIO_MIN,
)
from orto_notify.features import COLONNE, matrice
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
        soglia_giorni = adesso - timedelta(days=BATTERIA_FINESTRA_GIORNI)
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
            valore_r = round(float(campione[colonna]), 2)
            atteso_r = round(float(atteso), 2)
            # Una feature identica al suo valore normale (agli stessi due
            # decimali mostrati nel messaggio) non distingue nulla: mostrarla
            # come "1.00 (di solito 1.00)" e' rumore travestito da indizio.
            if valore_r == atteso_r:
                continue
            spiegazione[colonna] = (valore_r, atteso_r)
        fuori.append({
            "sensor_id": sonda, "tipo": "anomalia", "ora": campione["ora"],
            "dettagli": {
                "ore_anomale": quante,
                "su_ore": IF_ORE_FINESTRA,
                "spiegazione": spiegazione,
            },
        })
    return fuori
