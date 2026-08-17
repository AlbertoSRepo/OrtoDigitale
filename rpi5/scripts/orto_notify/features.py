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
