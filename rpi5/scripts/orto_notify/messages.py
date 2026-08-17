"""Dai fatti al testo italiano.

Testo semplice: niente Markdown, niente HTML. WH51_01 contiene un underscore
e con parse_mode Markdown Telegram risponde 400 Bad Request.
"""
from zoneinfo import ZoneInfo

from orto_notify import BATTERIA_CRITICA_V, SONDE

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
    """Formatta un istante come ora locale HH:MM.

    `dt` arriva sempre timezone-aware in UTC (da InfluxDB o da `adesso()`):
    formattarlo cosi' com'e' stamperebbe l'ora UTC, non quella che il
    lettore vede sul suo orologio a Europe/Rome (impostare TZ nell'
    EnvironmentFile di systemd non serve: non ha effetto su un datetime gia'
    consapevole del fuso). zoneinfo e' stdlib, ma il database IANA puo'
    mancare su un sistema minimale: in quel caso si ripiega sul fuso di
    sistema, cosi' questa funzione non solleva mai.
    """
    try:
        locale = dt.astimezone(ZoneInfo("Europe/Rome"))
    except Exception:
        locale = dt.astimezone()
    return locale.strftime("%H:%M")


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
        intestazione = [
            "Sonda muta: %s" % sonda,
            "",
            "Nessun dato %s (%s)." % (da_quando, dove),
            "Ultima lettura: %s%% alle %s." % (
                _fmt(d.get("ultima_lettura")), _ora(anomalia["ora"])),
            "",
            "Batteria all'ultima lettura: %s V (le altre: %s)." % (
                _fmt(d.get("batteria")), _altre_batterie(sonda, contesto)),
            "",
        ]

        # Quante sonde sono mute in questo stesso ciclo: se sono tutte,
        # il problema non e' questa sonda ma qualcosa a monte (GW3000,
        # Mosquitto), e in quel caso non c'e' nessuna "altra" sonda a cui
        # appoggiarsi. Dirlo esplicitamente evita di rassicurare a vuoto.
        if (contesto.get("sonde_mute") or 0) >= len(SONDE):
            return "\n".join(intestazione + [
                "Sono mute tutte le sonde insieme: non e' un problema di",
                "questa sonda in particolare. Il sospetto principale e' un",
                "guasto a monte, il gateway GW3000 o il broker MQTT.",
                "",
                "Senza nessuna sonda che trasmette la lettura di umidita'",
                "non e' affidabile: non fidartene finche' non ricominciano",
                "a trasmettere.",
            ])

        return "\n".join(intestazione + [
            "Cosa puo' essere, dalla piu' probabile:",
            "1) Batteria in esaurimento.",
            "2) Portata radio verso il GW3000.",
            "3) Sonda spostata o urtata.",
            "",
            "Le altre sonde continuano a trasmettere: il sistema puo'",
            "ancora irrigare basandosi su quelle.",
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
