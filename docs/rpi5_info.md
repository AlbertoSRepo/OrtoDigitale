# Raspberry Pi 5 — Informazioni Iniziali

## Accesso al dispositivo

| Campo        | Valore     |
|--------------|------------|
| Hostname     | `as`       |
| Utente       | `as`       |
| Password     | `aru63`    |
| IP corrente  | `192.168.1.46` (assegnato via DHCP)                  |
| Hostname     | `as.local` (mDNS)                                    |
| SSH          | `ssh as@192.168.1.46`                                |

## Stato iniziale

- SD card appena formattata con RPi OS Lite 64-bit (Debian Bookworm)
- Raspberry Pi Connect abilitato (vedi screenshot `raspberrypiconnect.jpg`)
- Nessun software aggiuntivo installato

## Note

- L'hostname finale previsto dal progetto è `rpi5-orto` / `rpi5-orto.local` (da configurare in step1)
- IP statico da riservare via DHCP sul router prima di procedere con step1
- Le credenziali di accesso sopra sono quelle del sistema operativo (non dell'applicazione)
