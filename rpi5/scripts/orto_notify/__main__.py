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

    try:
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

        testi = [messages.componi(a, contesto) for a in da_inviare]
        testi += [messages.rientro(s) for s in tornate]
    except Exception as e:
        # Stato in memoria inaffidabile a meta' rilevazione: non salvare,
        # si riparte dall'ultimo stato buono al prossimo giro.
        print("[notify] rilevazione fallita: %s" % e, file=sys.stderr)
        return {"anomalie": 0, "inviati": 0, "righe": len(righe)}

    inviati = 0
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

    if args.backtest is not None:
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
