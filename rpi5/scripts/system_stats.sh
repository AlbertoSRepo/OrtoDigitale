#!/bin/bash
# system_stats.sh — Snapshot risorse host RPi5 -> JSON atomico per il container Node-RED.
#
# Pattern: il container nodered vede solo il proprio filesystem e /proc del container.
# Questo script gira sull'host (via systemd timer ogni 10s), legge df/proc/sys reali e
# scrive un JSON in /opt/orto-digitale/system-out/stats.json, bind-mountato RO nel
# container come /data/host-system/stats.json.
#
# Installazione: vedi rpi5/scripts/orto-system-stats.{service,timer}
# Endpoint che lo consuma: GET /api/system/stats (flow Node-RED tab f-system)

set -euo pipefail

OUT="${ORTO_SYSTEM_STATS_OUT:-/opt/orto-digitale/system-out/stats.json}"
TMP="${OUT}.tmp"

# --- DISCO (root filesystem) ---
df_line=$(df -B1 --output=size,used,avail / | tail -n1)
disk_total=$(echo "$df_line" | awk '{print $1}')
disk_used=$(echo  "$df_line" | awk '{print $2}')
disk_avail=$(echo "$df_line" | awk '{print $3}')
disk_used_pct=$(awk -v u="$disk_used" -v t="$disk_total" 'BEGIN{ if(t==0) print 0; else printf "%.1f", (u/t)*100 }')

# --- RAM (da /proc/meminfo) ---
mem_total_kb=$(awk '/^MemTotal:/     {print $2}' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
mem_used_kb=$((mem_total_kb - mem_avail_kb))
mem_used_pct=$(awk -v u="$mem_used_kb" -v t="$mem_total_kb" 'BEGIN{ if(t==0) print 0; else printf "%.1f", (u/t)*100 }')

# --- CPU: delta tra due snapshot di /proc/stat a 1s ---
read_cpu() {
  awk '/^cpu / {idle=$5+$6; total=$2+$3+$4+$5+$6+$7+$8; print idle, total}' /proc/stat
}
read s1_idle s1_total <<< "$(read_cpu)"
sleep 1
read s2_idle s2_total <<< "$(read_cpu)"
delta_idle=$((s2_idle  - s1_idle))
delta_total=$((s2_total - s1_total))
cpu_used_pct=$(awk -v di="$delta_idle" -v dt="$delta_total" \
  'BEGIN{ if(dt==0) print 0; else printf "%.1f", (1 - di/dt)*100 }')

# --- Load average ---
loadavg=$(awk '{printf "%.2f, %.2f, %.2f", $1, $2, $3}' /proc/loadavg)

# --- Temperatura SoC (opzionale) ---
temp_c="null"
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  temp_raw=$(cat /sys/class/thermal/thermal_zone0/temp)
  temp_c=$(awk -v t="$temp_raw" 'BEGIN{ printf "%.1f", t/1000 }')
fi

# --- Output JSON atomico ---
cat > "$TMP" <<EOF
{
  "generated_at": "$(date -Iseconds)",
  "disk": {
    "total_bytes": $disk_total,
    "used_bytes": $disk_used,
    "free_bytes": $disk_avail,
    "used_pct": $disk_used_pct
  },
  "ram": {
    "total_bytes": $((mem_total_kb * 1024)),
    "used_bytes":  $((mem_used_kb  * 1024)),
    "free_bytes":  $((mem_avail_kb * 1024)),
    "used_pct": $mem_used_pct
  },
  "cpu": {
    "used_pct": $cpu_used_pct,
    "load_avg_1_5_15": [$loadavg]
  },
  "thermal": {
    "soc_temp_c": $temp_c
  }
}
EOF

mv -f "$TMP" "$OUT"
chmod 644 "$OUT"
