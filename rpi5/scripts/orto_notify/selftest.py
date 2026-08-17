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

    def ore_bloccate_riparte_da_uno_se_la_media_cambia():
        # sigma nulla ma media diversa dall'ora precedente: la sequenza
        # congelata precedente si interrompe e ne comincia una nuova, quindi
        # il contatore riparte da 1 (non prosegue, e non si azzera).
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
    prova("ore_bloccate riparte da 1 se la media cambia", ore_bloccate_riparte_da_uno_se_la_media_cambia)
    prova("le colonne della matrice sono sette", colonne_sono_sette)
    prova("nessun None arriva alla matrice", nessun_none_nella_matrice)


def _sezione_guardie():
    from datetime import datetime, timedelta, timezone
    from orto_notify import detect

    print("guardie deterministiche")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def serie(sonda="WH51_01", ore=48, **campi):
        fuori = []
        for h in range(ore, 0, -1):
            r = {
                "sensor_id": sonda, "ora": ADESSO - timedelta(hours=h),
                "campioni": 60, "media": 50.0, "sigma": 1.0, "batteria": 1.60,
                "silenzio_max_min": 1.0, "tasso_consegna": 1.0,
                "delta_batteria_24h": 0.0, "scarto_da_sorelle": 0.0,
                "ore_bloccate": 0,
            }
            r.update(campi)
            fuori.append(r)
        return fuori

    def tipi(anomalie):
        return sorted({a["tipo"] for a in anomalie})

    def vivo(quando_min=0):
        # ultimo campione "adesso meno quando_min minuti", per ogni sonda
        return {s: ADESSO - timedelta(minutes=quando_min)
                for s in ("WH51_01", "WH51_02", "WH51_03", "WH51_04")}

    def muta_dopo_45_minuti():
        out = detect.guardie(serie(), ADESSO, [], ultimi=vivo(52))
        assert "muta" in tipi(out), tipi(out)

    def non_muta_a_20_minuti():
        out = detect.guardie(serie(), ADESSO, [], ultimi=vivo(20))
        assert "muta" not in tipi(out), tipi(out)

    def bucket_orario_vecchio_non_e_silenzio():
        # Il bucket piu' recente e' sempre vecchio fino a 60 min per costruzione:
        # se il silenzio si misurasse da li', ogni sonda sarebbe sempre muta.
        out = detect.guardie(serie(), ADESSO, [], ultimi=vivo(2))
        assert "muta" not in tipi(out), tipi(out)

    def sonda_assente_da_ultimi_e_muta():
        ultimi = vivo(2)
        del ultimi["WH51_01"]
        out = detect.guardie(serie(), ADESSO, [], ultimi=ultimi)
        assert "muta" in tipi(out), tipi(out)

    def batteria_bassa_con_tre_letture():
        out = detect.guardie(serie(batteria=1.12), ADESSO, [], ultimi=vivo(2))
        assert "batteria_bassa" in tipi(out), tipi(out)

    def batteria_bassa_singola_non_basta():
        righe = serie()
        righe[-1]["batteria"] = 1.12
        out = detect.guardie(righe, ADESSO, [], ultimi=vivo(2))
        assert "batteria_bassa" not in tipi(out), tipi(out)

    def serie_batteria(pendenza_totale):
        righe = []
        for h in range(168, 0, -1):
            v = 1.60 - (168 - h) * (pendenza_totale / 168.0)
            riga = serie(ore=1, batteria=v)[0]
            riga["ora"] = ADESSO - timedelta(hours=h)
            righe.append(riga)
        return righe

    def batteria_in_calo():
        # -0.09 V in 7 giorni = -0.09 V/settimana, oltre la soglia -0.02
        out = detect.guardie(serie_batteria(0.09), ADESSO, [], ultimi=vivo(2))
        assert "batteria_calo" in tipi(out), tipi(out)

    def batteria_piatta_non_allerta():
        out = detect.guardie(serie_batteria(0.0), ADESSO, [], ultimi=vivo(2))
        assert "batteria_calo" not in tipi(out), tipi(out)

    def valore_bloccato_con_sorella_che_si_muove():
        righe = serie(sonda="WH51_01", ore_bloccate=14, sigma=0.0)
        sorella = serie(sonda="WH51_02")
        for i, r in enumerate(sorella):
            r["media"] = 50.0 + i * 0.5     # varia di 24 pp nell'arco
        out = detect.guardie(righe + sorella, ADESSO, [], ultimi=vivo(2))
        assert "valore_bloccato" in tipi(out), tipi(out)

    def valore_fermo_ma_tutte_ferme_non_allerta():
        righe = serie(sonda="WH51_01", ore_bloccate=14, sigma=0.0)
        sorella = serie(sonda="WH51_02", ore_bloccate=14, sigma=0.0)
        out = detect.guardie(righe + sorella, ADESSO, [], ultimi=vivo(2))
        assert "valore_bloccato" not in tipi(out), tipi(out)

    def irrigazione_zittisce_tutto():
        finestre = [(ADESSO - timedelta(hours=48), ADESSO + timedelta(hours=1))]
        out = detect.guardie(serie(batteria=1.12), ADESSO, finestre, ultimi=vivo(52))
        assert out == [], out

    def senza_ultimi_ripiega_sui_bucket():
        # Modalita' backtest: nessun "ultimo campione", si stima dai bucket.
        righe = serie()
        for r in righe[-3:]:
            r["campioni"] = 0
        out = detect.guardie(righe, ADESSO, [], ultimi=None)
        assert "muta" in tipi(out), tipi(out)

    prova("muta dopo 52 minuti di silenzio", muta_dopo_45_minuti)
    prova("non muta a 20 minuti", non_muta_a_20_minuti)
    prova("un bucket orario vecchio non e' silenzio", bucket_orario_vecchio_non_e_silenzio)
    prova("sonda assente dall'ultimo giro e' muta", sonda_assente_da_ultimi_e_muta)
    prova("batteria bassa con tre letture consecutive", batteria_bassa_con_tre_letture)
    prova("una sola lettura bassa non basta", batteria_bassa_singola_non_basta)
    prova("batteria in calo oltre la pendenza di soglia", batteria_in_calo)
    prova("batteria piatta non allerta", batteria_piatta_non_allerta)
    prova("valore bloccato solo se una sorella si muove", valore_bloccato_con_sorella_che_si_muove)
    prova("se tutte sono ferme non e' un guasto", valore_fermo_ma_tutte_ferme_non_allerta)
    prova("dentro la finestra di irrigazione tutti tacciono", irrigazione_zittisce_tutto)
    prova("senza ultimi si ripiega sui bucket orari", senza_ultimi_ripiega_sui_bucket)


def _sezione_modello():
    from datetime import datetime, timedelta, timezone
    from orto_notify import detect, IF_ORE_FINESTRA

    print("isolation forest")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def normale(sonda, h, **campi):
        r = {
            "sensor_id": sonda, "ora": ADESSO - timedelta(hours=h),
            "campioni": 60, "media": 50.0, "sigma": 1.2, "batteria": 1.60,
            "silenzio_max_min": 1.0, "tasso_consegna": 1.0,
            "delta_batteria_24h": 0.0, "scarto_da_sorelle": 0.5,
            "ore_bloccate": 0,
        }
        r.update(campi)
        return r

    def popolazione():
        righe = []
        for sonda in ("WH51_01", "WH51_02", "WH51_03", "WH51_04"):
            for h in range(400, 0, -1):
                # un filo di varieta', altrimenti la deviazione e' nulla
                righe.append(normale(sonda, h, media=50.0 + (h % 5) * 0.1))
        return righe

    def sonda_deviante_viene_segnalata():
        righe = popolazione()
        for r in righe:
            if r["sensor_id"] == "WH51_03" and (ADESSO - r["ora"]).total_seconds() <= IF_ORE_FINESTRA * 3600:
                r["scarto_da_sorelle"] = 18.0
                r["sigma"] = 0.0
                r["ore_bloccate"] = 6
        out = detect.anomalie_modello(righe, ADESSO, [])
        sonde = {a["sensor_id"] for a in out}
        assert "WH51_03" in sonde, sonde

    def popolazione_omogenea_non_produce_allarmi():
        out = detect.anomalie_modello(popolazione(), ADESSO, [])
        assert out == [], out

    def esito_riproducibile():
        righe = popolazione()
        for r in righe:
            if r["sensor_id"] == "WH51_02" and (ADESSO - r["ora"]).total_seconds() <= IF_ORE_FINESTRA * 3600:
                r["scarto_da_sorelle"] = 15.0
        a = detect.anomalie_modello(righe, ADESSO, [])
        b = detect.anomalie_modello(righe, ADESSO, [])
        assert [x["sensor_id"] for x in a] == [x["sensor_id"] for x in b]

    def dati_insufficienti_non_esplode():
        pochi = [normale("WH51_01", h) for h in range(5, 0, -1)]
        assert detect.anomalie_modello(pochi, ADESSO, []) == []

    def spiegazione_presente():
        righe = popolazione()
        for r in righe:
            if r["sensor_id"] == "WH51_04" and (ADESSO - r["ora"]).total_seconds() <= IF_ORE_FINESTRA * 3600:
                r["tasso_consegna"] = 0.1
                r["silenzio_max_min"] = 40.0
        out = detect.anomalie_modello(righe, ADESSO, [])
        if out:
            assert out[0]["dettagli"]["spiegazione"], out[0]
            assert out[0]["dettagli"]["su_ore"] == IF_ORE_FINESTRA

    prova("una sonda che devia viene segnalata", sonda_deviante_viene_segnalata)
    prova("popolazione omogenea: nessun allarme", popolazione_omogenea_non_produce_allarmi)
    prova("stesso input, stesso esito", esito_riproducibile)
    prova("con pochi dati non esplode", dati_insufficienti_non_esplode)
    prova("l'anomalia porta con se' la spiegazione", spiegazione_presente)


def _sezione_conferma():
    from datetime import datetime, timedelta, timezone
    from orto_notify import confirm, state

    print("conferma e anti-spam")

    ADESSO = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)

    def anomalia(sonda="WH51_01", tipo="muta"):
        return {"sensor_id": sonda, "tipo": tipo, "ora": ADESSO, "dettagli": {}}

    def primo_alert_passa():
        da_inviare, _ = confirm.filtra([anomalia()], {}, ADESSO)
        assert len(da_inviare) == 1, da_inviare

    def secondo_alert_entro_cooldown_soppresso():
        da_inviare, stato = confirm.filtra([anomalia()], {}, ADESSO)
        assert len(da_inviare) == 1
        dopo, _ = confirm.filtra([anomalia()], stato, ADESSO + timedelta(hours=3))
        assert dopo == [], dopo

    def dopo_il_cooldown_riparte():
        _, stato = confirm.filtra([anomalia()], {}, ADESSO)
        dopo, _ = confirm.filtra([anomalia()], stato, ADESSO + timedelta(hours=25))
        assert len(dopo) == 1, dopo

    def cooldown_batteria_calo_e_settimanale():
        _, stato = confirm.filtra([anomalia(tipo="batteria_calo")], {}, ADESSO)
        a_2_giorni, _ = confirm.filtra(
            [anomalia(tipo="batteria_calo")], stato, ADESSO + timedelta(days=2))
        assert a_2_giorni == [], a_2_giorni
        a_8_giorni, _ = confirm.filtra(
            [anomalia(tipo="batteria_calo")], stato, ADESSO + timedelta(days=8))
        assert len(a_8_giorni) == 1

    def tipi_diversi_non_si_zittiscono():
        _, stato = confirm.filtra([anomalia(tipo="muta")], {}, ADESSO)
        altro, _ = confirm.filtra([anomalia(tipo="batteria_bassa")], stato, ADESSO)
        assert len(altro) == 1, altro

    def sonde_diverse_non_si_zittiscono():
        _, stato = confirm.filtra([anomalia(sonda="WH51_01")], {}, ADESSO)
        altra, _ = confirm.filtra([anomalia(sonda="WH51_02")], stato, ADESSO)
        assert len(altra) == 1, altra

    def normalita_prolungata_azzera():
        _, stato = confirm.filtra([anomalia()], {}, ADESSO)
        # sei ore senza anomalie
        _, stato = confirm.filtra([], stato, ADESSO + timedelta(hours=7))
        di_nuovo, _ = confirm.filtra([anomalia()], stato, ADESSO + timedelta(hours=8))
        assert len(di_nuovo) == 1, di_nuovo

    def rientro_segnalato_una_volta_sola():
        _, stato = confirm.filtra([anomalia()], {}, ADESSO)
        tornate = confirm.rientri([], stato, ADESSO + timedelta(hours=7))
        assert "WH51_01" in tornate, tornate
        _, stato2 = confirm.filtra([], stato, ADESSO + timedelta(hours=7))
        ancora = confirm.rientri([], stato2, ADESSO + timedelta(hours=8))
        assert "WH51_01" not in ancora, ancora

    def stato_gira_su_json(tmp="/tmp/orto_notify_prova_stato.json"):
        import os
        originale = {"WH51_01": {"muta": {"ultimo_invio": ADESSO.isoformat()}}}
        state.salva(tmp, originale)
        riletto = state.carica(tmp)
        assert riletto == originale, riletto
        os.remove(tmp)

    def stato_mancante_e_dizionario_vuoto():
        assert state.carica("/tmp/non-esiste-affatto-12345.json") == {}

    prova("il primo alert passa", primo_alert_passa)
    prova("il secondo entro 24 h e' soppresso", secondo_alert_entro_cooldown_soppresso)
    prova("dopo il cooldown riparte", dopo_il_cooldown_riparte)
    prova("batteria_calo ha cooldown di 7 giorni", cooldown_batteria_calo_e_settimanale)
    prova("tipi diversi non si zittiscono a vicenda", tipi_diversi_non_si_zittiscono)
    prova("sonde diverse non si zittiscono a vicenda", sonde_diverse_non_si_zittiscono)
    prova("sei ore di normalita' azzerano il cooldown", normalita_prolungata_azzera)
    prova("il rientro si annuncia una volta sola", rientro_segnalato_una_volta_sola)
    prova("lo stato fa andata e ritorno su JSON", stato_gira_su_json)
    prova("stato mancante = dizionario vuoto", stato_mancante_e_dizionario_vuoto)


def _sezione_messaggi():
    from datetime import datetime, timezone
    from orto_notify import messages, telegram, TELEGRAM_MAX_CHAR

    print("messaggi e telegram")

    ORA = datetime(2026, 8, 17, 14, 12, tzinfo=timezone.utc)
    CONTESTO = {
        "batterie": {"WH51_01": 1.51, "WH51_02": 1.60, "WH51_03": 1.60, "WH51_04": 1.60},
        "aiuola": {"WH51_01": "aiuola 1, vicino all'ingresso acqua"},
    }

    def muta_nomina_i_numeri():
        testo = messages.componi(
            {"sensor_id": "WH51_01", "tipo": "muta", "ora": ORA,
             "dettagli": {"silenzio_min": 52, "ultima_lettura": 47.0, "batteria": 1.51}},
            CONTESTO)
        assert "WH51_01" in testo
        assert "52" in testo
        assert "1.51" in testo

    def niente_costrutti_markdown():
        # ATTENZIONE: NON si puo' pretendere l'assenza di "_", perche' i nomi
        # delle sonde lo contengono (WH51_01). E' proprio questo il motivo per
        # cui parse_mode non va MAI impostato: in testo semplice l'underscore
        # e' innocuo, con parse_mode=Markdown fa fallire l'invio con 400.
        # Qui si controllano i soli costrutti che scriveremmo noi.
        for tipo, dett in (
            ("muta", {"silenzio_min": 52, "ultima_lettura": 47.0, "batteria": 1.51}),
            ("batteria_bassa", {"batteria": 1.12}),
            ("batteria_calo", {"pendenza_v_settimana": -0.029, "batteria": 1.51,
                               "batteria_iniziale": 1.60}),
            ("valore_bloccato", {"ore": 14, "valore": 50.0}),
            ("anomalia", {"ore_anomale": 4, "su_ore": 6,
                          "spiegazione": {"tasso_consegna": (0.98, 1.0)}}),
        ):
            testo = messages.componi(
                {"sensor_id": "WH51_01", "tipo": tipo, "ora": ORA, "dettagli": dett},
                CONTESTO)
            for vietato in ("*", "`", "[", "](" ):
                assert vietato not in testo, (tipo, vietato, testo)
            # l'underscore c'e' e va bene: e' nel nome della sonda
            assert "WH51_01" in testo, testo

    def anomalia_e_cauta():
        testo = messages.componi(
            {"sensor_id": "WH51_03", "tipo": "anomalia", "ora": ORA,
             "dettagli": {"ore_anomale": 4, "su_ore": 6,
                          "spiegazione": {"scarto_da_sorelle": (11.0, 3.0)}}},
            CONTESTO)
        assert "osservazione" in testo.lower(), testo

    def batteria_calo_dichiara_la_riserva():
        testo = messages.componi(
            {"sensor_id": "WH51_01", "tipo": "batteria_calo", "ora": ORA,
             "dettagli": {"pendenza_v_settimana": -0.029, "batteria": 1.51,
                          "batteria_iniziale": 1.60}},
            CONTESTO)
        # La proiezione lineare sovrastima: la riserva va sempre detta.
        assert "prima" in testo.lower(), testo

    def spezza_sotto_il_limite():
        assert telegram.spezza("breve") == ["breve"]

    def spezza_sopra_il_limite():
        testo = "\n\n".join("blocco %d %s" % (i, "x" * 500) for i in range(20))
        pezzi = telegram.spezza(testo)
        assert len(pezzi) > 1
        for p in pezzi:
            assert len(p) <= TELEGRAM_MAX_CHAR, len(p)
        # nulla si perde
        assert "blocco 19" in pezzi[-1]

    def invio_usa_il_trasporto():
        visti = []

        def finto(url, payload):
            visti.append((url, payload))
            return '{"ok":true}'

        n = telegram.invia("ciao", "TOK", "42", trasporto=finto)
        assert n == 1, n
        assert "TOK" in visti[0][0]
        assert visti[0][1]["chat_id"] == "42"
        assert "parse_mode" not in visti[0][1], visti[0][1]

    def senza_token_non_invia_e_non_esplode():
        n = telegram.invia("ciao", "", "42", trasporto=None)
        assert n == 0, n

    prova("il messaggio di sonda muta porta i numeri", muta_nomina_i_numeri)
    prova("nessun messaggio usa costrutti Markdown", niente_costrutti_markdown)
    prova("il messaggio del modello resta cauto", anomalia_e_cauta)
    prova("la proiezione batteria dichiara la riserva", batteria_calo_dichiara_la_riserva)
    prova("testo breve resta un messaggio", spezza_sotto_il_limite)
    prova("testo lungo si spezza senza perdere nulla", spezza_sopra_il_limite)
    prova("l'invio passa dal trasporto iniettato", invio_usa_il_trasporto)
    prova("senza token non invia e non esplode", senza_token_non_invia_e_non_esplode)


SEZIONI = [_sezione_influx, _sezione_features, _sezione_guardie, _sezione_modello, _sezione_conferma, _sezione_messaggi]


if __name__ == "__main__":
    sys.exit(esegui())
