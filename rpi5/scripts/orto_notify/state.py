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
