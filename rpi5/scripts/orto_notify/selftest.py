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


SEZIONI = [_sezione_influx]


if __name__ == "__main__":
    sys.exit(esegui())
