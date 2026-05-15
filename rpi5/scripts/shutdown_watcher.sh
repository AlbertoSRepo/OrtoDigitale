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
POLL_SECONDS="${ORTO_SHUTDOWN_POLL:-5}"

echo "[orto-shutdown-watcher] monitoring $FLAG (poll ${POLL_SECONDS}s)"

while true; do
    if [ -f "$FLAG" ]; then
        ts=$(date -Iseconds)
        content=$(cat "$FLAG" 2>/dev/null || echo "<read error>")
        echo "[$ts] flag detected: $content"
        rm -f "$FLAG"
        logger -t orto-shutdown "shutdown requested via API at $ts: $content"
        /usr/bin/sudo -n /sbin/shutdown -h +1 "Shutdown via Orto Digitale PWA" || {
            echo "[$ts] sudo shutdown FAILED (sudoers missing?)"
            logger -t orto-shutdown "sudo shutdown FAILED"
        }
        # Attende che lo shutdown effettivo avvenga (1 minuto).
        sleep 70
    fi
    sleep "$POLL_SECONDS"
done
