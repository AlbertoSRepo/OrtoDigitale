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


SEZIONI = [_sezione_influx, _sezione_features]


if __name__ == "__main__":
    sys.exit(esegui())
