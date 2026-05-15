#!/usr/bin/env bash
# orto-shutdown-watcher: monitora il flag file scritto dal container Node-RED
# (POST /api/system/shutdown) ed esegue lo shutdown del RPi.
#
# Pattern: il container Alpine di Node-RED non puo' eseguire `sudo shutdown`
# (no sudo, no /sbin/shutdown, no privileged). Soluzione: NR scrive un flag
# file in /data/system/, questo watcher gira sull'host come utente `as` con
# sudoers per /sbin/shutdown.
#
# Installazione: vedi rpi5/scripts/orto-shutdown-watcher.service

set -u

FLAG="${ORTO_SHUTDOWN_FLAG:-/opt/orto-digitale/nodered/data/system/shutdown_requested.flag}"
CANCEL="${ORTO_SHUTDOWN_CANCEL:-/opt/orto-digitale/nodered/data/system/shutdown_cancel.flag}"
COUNTDOWN_MINUTES="${ORTO_SHUTDOWN_COUNTDOWN:-5}"
POLL_SECONDS="${ORTO_SHUTDOWN_POLL:-3}"

echo "[orto-shutdown-watcher] monitoring $FLAG (cancel: $CANCEL, countdown: +${COUNTDOWN_MINUTES}min, poll ${POLL_SECONDS}s)"

while true; do
    # Cancel ha priorita': se entrambi i flag esistono, cancella e pulisci entrambi.
    if [ -f "$CANCEL" ]; then
        ts=$(date -Iseconds)
        echo "[$ts] cancel flag detected"
        rm -f "$CANCEL" "$FLAG"
        logger -t orto-shutdown "shutdown cancel via API at $ts"
        /usr/bin/sudo -n /sbin/shutdown -c 2>&1 | head -3 || {
            echo "[$ts] sudo shutdown -c failed (nessun shutdown pendente?)"
        }
    elif [ -f "$FLAG" ]; then
        ts=$(date -Iseconds)
        content=$(cat "$FLAG" 2>/dev/null || echo "<read error>")
        echo "[$ts] flag detected: $content"
        rm -f "$FLAG"
        logger -t orto-shutdown "shutdown requested via API at $ts: $content (countdown: +${COUNTDOWN_MINUTES}m)"
        /usr/bin/sudo -n /sbin/shutdown -h "+${COUNTDOWN_MINUTES}" "Shutdown via Orto Digitale PWA" || {
            echo "[$ts] sudo shutdown FAILED (sudoers missing?)"
            logger -t orto-shutdown "sudo shutdown FAILED"
            continue
        }
        # Loop di check per cancel anche durante il countdown. Esce solo quando il sistema va giu'.
        # PAM nologin blocchera' nuove sessioni SSH, ma il watcher gira gia' come servizio quindi continua.
        cancel_deadline=$(( $(date +%s) + COUNTDOWN_MINUTES * 60 + 10 ))
        while [ $(date +%s) -lt $cancel_deadline ]; do
            if [ -f "$CANCEL" ]; then
                cts=$(date -Iseconds)
                echo "[$cts] cancel during countdown"
                rm -f "$CANCEL"
                logger -t orto-shutdown "shutdown CANCELLED during countdown at $cts"
                /usr/bin/sudo -n /sbin/shutdown -c 2>&1 | head -3
                break
            fi
            sleep "$POLL_SECONDS"
        done
    fi
    sleep "$POLL_SECONDS"
done
