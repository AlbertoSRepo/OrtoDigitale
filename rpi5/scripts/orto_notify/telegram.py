"""Invio su Telegram. Sola uscita: il bot parla e non ascolta."""
import json
import urllib.parse
import urllib.request

from orto_notify import TELEGRAM_MAX_CHAR, TELEGRAM_URL

TELEGRAM_TIMEOUT_S = 15


def _trasporto_http(url, payload):
    dati = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(url, data=dati, method="POST")
    with urllib.request.urlopen(req, timeout=TELEGRAM_TIMEOUT_S) as resp:
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
