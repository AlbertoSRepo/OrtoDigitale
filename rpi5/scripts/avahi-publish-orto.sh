#!/usr/bin/env bash
# avahi-publish-orto.sh
# Pubblica `orto.local` via mDNS puntando all'IP primario del RPi5.
# Preferisce eth0 (primario per CLAUDE.md), fallback su wlan0.
# Lanciato in foreground da systemd unit orto-local-mdns.service.
set -euo pipefail

detect_ip() {
    local ip
    ip=$(ip -4 -br addr show dev eth0 2>/dev/null | awk '{print $3}' | cut -d/ -f1 || true)
    if [[ -n "${ip:-}" ]]; then
        echo "$ip"
        return
    fi
    ip=$(ip -4 -br addr show dev wlan0 2>/dev/null | awk '{print $3}' | cut -d/ -f1 || true)
    if [[ -n "${ip:-}" ]]; then
        echo "$ip"
        return
    fi
    echo "[avahi-publish-orto] no eth0/wlan0 IP found" >&2
    exit 1
}

IP=$(detect_ip)
echo "[avahi-publish-orto] publishing orto.local -> $IP"
exec /usr/bin/avahi-publish-address -R orto.local "$IP"
