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
