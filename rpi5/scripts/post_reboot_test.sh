#!/usr/bin/env bash
# post_reboot_test.sh — Triggera reboot del RPi5, attende la riconnessione SSH,
# concede un periodo di stabilizzazione ai container Docker, poi esegue verify_rpi5.sh.
#
# Uso dal PC locale:
#   bash rpi5/scripts/post_reboot_test.sh [host] [user]
#
# Default: host=192.168.1.46, user=as
#
# Prerequisiti:
#   - chiave SSH configurata (ssh-copy-id) per evitare prompt password
#   - verify_rpi5.sh già deployato in /opt/orto-digitale/scripts/ sul RPi5
#
# Exit code:
#   0 = reboot + verify OK
#   1 = SSH non torna up entro il timeout
#   2 = verify_rpi5.sh ha ritornato errore

set -u
set -o pipefail

HOST="${1:-192.168.1.46}"
USER="${2:-as}"
TARGET="${USER}@${HOST}"

STABILIZE_SECONDS=30      # attesa container up dopo che SSH torna
SSH_WAIT_TIMEOUT=300      # max secondi di attesa per riavvio SSH
SSH_POLL_INTERVAL=5

SSH_OPTS=(-o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes)

say() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$1"; }

say "Target: $TARGET"
say "Invio 'sudo reboot'..."
# `sudo reboot` chiude la sessione SSH con errore (channel closed). Non è un fallimento.
ssh "${SSH_OPTS[@]}" "$TARGET" "sudo reboot" 2>/dev/null || true

say "Attendo la caduta di SSH..."
sleep 10

say "Polling riconnessione SSH (timeout ${SSH_WAIT_TIMEOUT}s, ogni ${SSH_POLL_INTERVAL}s)..."
DEADLINE=$(( $(date +%s) + SSH_WAIT_TIMEOUT ))
while :; do
  if ssh "${SSH_OPTS[@]}" "$TARGET" "echo up" >/dev/null 2>&1; then
    say "SSH riconnesso."
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    say "TIMEOUT: SSH non torna up entro ${SSH_WAIT_TIMEOUT}s"
    exit 1
  fi
  sleep "$SSH_POLL_INTERVAL"
done

say "Attendo ${STABILIZE_SECONDS}s di stabilizzazione dei container..."
sleep "$STABILIZE_SECONDS"

say "Eseguo verify_rpi5.sh sul RPi5..."
echo "---"
if ssh "${SSH_OPTS[@]}" "$TARGET" "bash /opt/orto-digitale/scripts/verify_rpi5.sh"; then
  echo "---"
  say "POST-REBOOT OK: lo stack si è auto-ripristinato."
  exit 0
else
  RC=$?
  echo "---"
  say "POST-REBOOT KO: verify_rpi5.sh ha ritornato $RC"
  exit 2
fi
