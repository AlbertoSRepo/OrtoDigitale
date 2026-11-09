# Gateway Ecowitt GW3000 — come è configurato e come fornisce l'umidità

**Rilevato dal gateway:** 2026-11-09, leggendo la sua API HTTP locale (solo `GET`, nessuna
modifica). Le risposte grezze, con le password oscurate, sono nell'archivio di chiusura:
`archivio_v1.1_2026-11-09/rpi/gw3000_snapshot_2026-11-09/`.
**Documenti collegati:** `docs/step2_gw3000_mqtt.md` (setup originale, aprile 2026),
`docs/step14_registro_sensori.md` (scoperta dei canali), `docs/step18_id_fisico_sonde.md`
(id fisici dal gateway).

> Questo documento descrive lo stato **reale** del gateway, non quello previsto dallo
> step 2. In tre punti differisce dallo step 2; le differenze sono elencate in §9.

---

## 1. In breve

```
WH51 ×4 ──RF 868 MHz──> GW3000 ──WiFi──> MQTT  192.168.1.46:1883  topic ecowitt/gw3000  (ogni 60 s)
                          │                     (form-urlencoded, tutte le sonde in un messaggio)
                          └── HTTP :80  API locale senza autenticazione (letta ogni 15 min per gli id fisici)
```

Il gateway riceve le sonde via radio e **spinge** i dati con MQTT verso il broker del RPi.
Il RPi non deve interrogarlo per avere l'umidità. L'API HTTP serve solo per le informazioni
che MQTT non porta (id fisico, RSSI, valore grezzo AD in tempo reale).

---

## 2. Identità e rete

| Voce | Valore |
|---|---|
| Modello | Ecowitt **GW3000A** (radio 868 MHz) |
| Firmware | **GW3000A_V1.2.1**. Disponibile la **V1.2.5** (note di rilascio: "migliorata affidabilità di rete, corretto errore RSSI"), **non installata** |
| MAC | `88:57:21:D3:C4:A7` |
| Connessione | **solo WiFi**. Ethernet non configurata (`0.0.0.0`) |
| IP | `192.168.1.5` via DHCP: va mantenuta la **reservation sul router** |
| DNS / gateway | `192.168.1.1` |
| Fuso orario | `Europe/Rome`, ora legale attiva, NTP `pool.ntp.org` |
| Access point di configurazione | `GW3000A-WIFIC4A7`: compare se il gateway perde la WiFi |
| Interfaccia web | `http://192.168.1.5` (login richiesto per la UI, **non** per l'API, vedi §8) |

---

## 3. Invio dati verso il RPi — sezione "Customized" della UI

Valori letti da `GET /get_ws_settings`:

| Campo UI | Valore attuale | Note |
|---|---|---|
| Customized | `enable` | |
| Protocol | `MQTT` | Non il protocollo HTTP "Ecowitt" |
| Host | **`192.168.1.46`** | ⚠️ È l'IP **WiFi** del RPi, non l'Ethernet `.12` (vedi §9) |
| Port | `1883` | MQTT in chiaro, solo LAN |
| Transport | `0` = MQTT over TCP | |
| Publish Topic | `ecowitt/gw3000` | Sostituisce il default `ecowitt/<MAC>` |
| Client Name | `GW3000-Orto` | |
| Client ID | `gw3000-orto-01` | Deve essere unico sul broker |
| Username | `gw3000` | Utente in `mosquitto/config/password_file` |
| Password | valore di `MQTT_PASS_GW3000` nel `.env` | |
| Keep Alive | `60` s | |
| Upload interval | `60` s | Un messaggio al minuto |

**Altri invii esterni** (Weather Underground, WeatherCloud, WOW, server "Ecowitt" custom):
credenziali tutte vuote, quindi inattivi. **Non è verificato** se il gateway carichi dati sul
cloud ecowitt.net: l'API riporta `platform: ecowitt` e `ost_interval: 1`, che potrebbero
indicarlo, ma questo si configura dall'app Ecowitt/WS View ed è lì che va controllato. In
ogni caso il ciclo di irrigazione non dipende da quel cloud.

---

## 4. Sonde accoppiate (fotografia del 2026-11-09)

Da `GET /get_sensors_info?page=3`, `GET /get_cli_soilad` e `GET /get_livedata_info`:

| Canale | `sensor_id` (registro) | Id fisico | RSSI | Segnale | Batteria | AD grezzo | Umidità |
|---|---|---|---|---|---|---|---|
| CH1 | `WH51_01` | `0FC98F` | −69 dBm | 4/4 | 1,50 V | 70 | 1% |
| CH2 | `WH51_02` | `0FD067` | −74 dBm | 4/4 | 1,50 V | 68 | 0% |
| CH3 | `WH51_03` | `0FD04E` | −59 dBm | 4/4 | 1,50 V | 51 | 0% |
| CH4 | `WH51_04` | `0FCDF2` | **−93 dBm** | 4/4 | 1,50 V | 232 | 47% |

- Il gateway ha **16 slot WH51** (CH1–CH16). Ne sono accoppiati 4, gli altri hanno id
  `FFFFFFFF` (= vuoto). Il parser Node-RED legge solo i canali 1–8 (`MAX_CANALI = 8`).
- Nessun altro sensore è accoppiato. L'unico dato extra è il sensore **interno** del gateway
  (`wh25`: temperatura, umidità e pressione indoor).
- CH4 ha il segnale più debole (−93 dBm). Il gateway lo dà comunque a 4/4 e i campioni arrivano
  regolari, ma in v2.0 conviene spostare o il gateway o la sonda.

---

## 5. Come il gateway calcola la percentuale (calibrazione)

Le WH51 non misurano una percentuale ma un valore elettrico grezzo (**AD**). È il gateway a
convertirlo in %.

**La curva effettivamente usata è quella di fabbrica.** Undici coppie AD → % raccolte in tre
momenti diversi (aprile, agosto, novembre) rientrano tutte entro ±1,2 punti nella retta:

```
umidità % ≈ (AD − 67) × 0,285        →  0% ≈ AD 67   ·   100% ≈ AD 418
```

| AD | % gateway | % dalla formula |
|---|---|---|
| 165 | 28 | 27,9 |
| 212 | 41 | 41,3 |
| 232 | 47 | 47,0 |
| 244 | 50 | 50,4 |
| 70 | 1 | 0,9 |

La formula è una **stima empirica**, non documentazione Ecowitt.

**Il pannello di calibrazione** (`/get_cli_soilad`) contiene per tutte e quattro le sonde
`minVal 170` / `maxVal 320`, ma con `checked: false`: la calibrazione personalizzata **non è
attiva**. Se lo fosse, CH4 (AD 232) leggerebbe ~41% e non 47%. Prima di attivarla in v2.0,
ricordare che quei due valori non sono mai stati tarati su questo terreno.

**Le letture a 0% di CH1–CH3** corrispondono ad AD 51–70, il fondo della scala. È lo stesso
intervallo di una sonda in aria o in terra completamente secca. Il gateway non le tronca: il
valore grezzo è davvero lì. Per capire se le sonde sono fuori terra o guaste serve un
controllo sul campo (vedi `LEGGIMI.md` dell'archivio, "Problema trovato").

---

## 6. Il messaggio MQTT

Un solo messaggio ogni 60 s su `ecowitt/gw3000`, **stringa form-urlencoded** (non JSON).
Esempio reale (step 14, firmware 1.2.1), qui spezzato su più righe:

```
runtime=894773&soilmoisture1=50&soilad1=244&soilmoisture2=44&soilad2=225
&soilmoisture3=41&soilad3=212&soilmoisture4=46&soilad4=229
&soilbatt1=1.5&soilbatt2=1.6&soilbatt3=1.6&soilbatt4=1.5
&freq=868M&model=GW3000A&interval=60
```

Il payload completo contiene anche `PASSKEY`, `stationtype`, `heap`, `dateutc`,
`tempinf`, `humidityin`, `baromrelin`, `baromabsin` (esempio integrale in
`step2_gw3000_mqtt.md` §4).

| Chiave | Significato | Uso in v1.1 |
|---|---|---|
| `soilmoisture{N}` | umidità % del canale N | → field `value` di `soil_moisture` |
| `soilbatt{N}` | tensione batteria (V) | → `battery_voltage`, e `battery_ok = V ≥ 1.1` |
| `soilad{N}` | valore grezzo AD | **scartato** ⚠️ |
| `tempinf`, `humidityin`, `barom*` | sensore interno del gateway (°F, %, inHg) | scartati |
| `PASSKEY`, `runtime`, `heap`, `dateutc`, `freq`, `model`, `interval`, … | metadati | scartati. Il timestamp è quello di scrittura in InfluxDB, non `dateutc` |

**Il messaggio MQTT non contiene l'RSSI**: si ottiene solo via HTTP (§8).

> **Lezione per la v2.0:** salvare anche `soilad{N}`. Con il solo % arrotondato all'intero
> e troncato a 0 non si può ricalibrare a posteriori né distinguere "secco" da "fuori terra".

---

## 7. Come lo consuma Node-RED (v1.1)

| Nodo | Cosa fa |
|---|---|
| `cfg-mqtt-mosquitto` | broker `mosquitto:1883`, client `nodered-orto`, utente `nodered` |
| `n-mqtt-in-ecowitt` | sottoscrive `ecowitt/gw3000`, payload come stringa UTF-8 |
| `n-fn-parse` (*parse WH51*) | decodifica la stringa, legge i canali 1–8 e annota tutti quelli presenti in `global.gw_seen`. Scrive solo i canali presenti nel **registro** (`orto_sensors.json`: canale → `sensor_id`), con i tag `aiuola`/`position` presi dal layout. Aggiorna `global.soil_moisture_cache`, che è l'input del decision loop |
| `n-fn-hwids-req` → `n-req-hwids` → `n-fn-hwids-parse` | ogni 15 min fa `GET http://$GW3000_HOST/get_sensors_info?page=1..4`, tiene gli slot `wh51` e costruisce canale → id fisico (`global.gw_hw_ids`, non persistito) |

Il registro lega le sonde al **canale**, non all'id fisico. Se si sostituisce una sonda
riaccoppiandola sullo stesso canale, Node-RED non se ne accorge: lo storico continua sotto lo
stesso `sensor_id`.

---

## 8. API HTTP locale (porta 80)

Endpoint verificati sul firmware 1.2.1. Sono tutti `GET`, **senza autenticazione**:

| Endpoint | Contenuto utile |
|---|---|
| `/get_version` | firmware, aggiornamento disponibile |
| `/get_device_info` | radio, fuso orario, NTP, note della nuova versione |
| `/get_network_info` | MAC, IP, SSID ⚠️ **e password WiFi** (in base64) |
| `/get_ws_settings` | configurazione degli upload ⚠️ **inclusa la password MQTT in chiaro** |
| `/get_sensors_info?page=1..4` | slot sensori: tipo, id fisico, **RSSI**, segnale, batteria. I WH51 oggi sono a pagina 3 |
| `/get_livedata_info` | letture correnti (umidità %, tensione, sensore interno) |
| `/get_cli_soilad` | per sonda: **AD corrente**, min/max di calibrazione, `checked` |
| `/get_calibration_data` | offset dei sensori meteo (non usati) |
| `/get_units_info` | unità di misura della UI |

> ⚠️ **Sicurezza:** chiunque sia sulla rete di casa può leggere la password WiFi e quella
> MQTT con un semplice `curl`, senza login. È un limite del firmware: tenere il gateway su
> una rete fidata ed evitare di riusare quelle password altrove.

In v2.0 l'API può dare in polling (es. ogni 5 min) **AD grezzo e RSSI per sonda**, i due dati
che oggi mancano. In v1.1 il polling ogni 15 min di 4 pagine non ha mai dato problemi.

---

## 9. Differenze rispetto a `step2_gw3000_mqtt.md`

| Step 2 diceva | Realtà al 2026-11-09 | Conseguenza |
|---|---|---|
| Host MQTT `192.168.1.12` (Ethernet RPi) | **`192.168.1.46`** (WiFi RPi) | Il flusso dipende dalla WiFi del RPi. Se il RPi cambia indirizzo WiFi o la disattiva, i dati smettono di arrivare anche con l'Ethernet su |
| Firmware `V1.2.0` | `V1.2.1` (1.2.5 disponibile) | — |
| RSSI non disponibile | Non è nel messaggio MQTT, **ma c'è via HTTP** (`/get_sensors_info`) | Il "qualità del segnale" della v1.1 dedotto dalla regolarità dei campioni si può sostituire con l'RSSI reale |

---

## 10. Per riusarlo (nuovo progetto o v2.0)

Il gateway **continua a funzionare da solo**: riceve le sonde e prova a pubblicare ogni 60 s.
Con il broker spento i messaggi semplicemente si perdono, il gateway **non bufferizza**.

Per far ripartire l'acquisizione su un RPi nuovo:

1. **Broker MQTT** raggiungibile su `192.168.1.46:1883` (oppure cambiare Host nella UI del
   gateway, es. `192.168.1.12`). Utente `gw3000` con la password del `.env` archiviato.
   In alternativa crearne uno nuovo e aggiornarlo nella sezione Customized.
2. **Sottoscrivere** `ecowitt/gw3000` e decodificare la stringa form-urlencoded: va bene la
   funzione `n-fn-parse` di `flows.json`, o qualunque parser di query-string.
3. Test rapido:
   ```bash
   mosquitto_sub -h localhost -u monitor -P "$MQTT_PASS_MONITOR" -t 'ecowitt/#' -v
   curl -s http://192.168.1.5/get_livedata_info      # le stesse letture, senza broker
   ```
4. Valutare l'**aggiornamento a firmware 1.2.5** *prima* di iniziare la stagione, non a
   metà. Dopo l'aggiornamento, riverificare il formato del payload e l'ordine delle pagine di
   `/get_sensors_info`.
5. Le sonde restano accoppiate al gateway: non serve rifare il pairing. Una sonda nuova o
   sostituita si accoppia dal gateway (sezione degli id sensori nella UI o nell'app) e poi si
   aggiunge al registro sonde con il suo canale.
