#!/usr/bin/env bash
# verify_rpi5.sh — Healthcheck completo stack Orto Digitale su Raspberry Pi 5.
# Esegue 10 controlli e stampa un report colorato. Exit code != 0 se almeno un check fallisce.
#
# Uso:
#   bash /opt/orto-digitale/scripts/verify_rpi5.sh
#   ssh as@192.168.1.46 "bash /opt/orto-digitale/scripts/verify_rpi5.sh"
#
# Richiede che /opt/orto-digitale/.env esista e definisca le credenziali necessarie
# (MQTT_PWD_MONITOR, INFLUXDB_ADMIN_TOKEN).

set -u
set -o pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/orto-digitale}"
ENV_FILE="${PROJECT_DIR}/.env"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  C_OK=$(tput setaf 2)
  C_KO=$(tput setaf 1)
  C_WARN=$(tput setaf 3)
  C_DIM=$(tput setaf 8 2>/dev/null || tput setaf 7)
  C_RESET=$(tput sgr0)
else
  C_OK=""; C_KO=""; C_WARN=""; C_DIM=""; C_RESET=""
fi

FAIL=0
WARN=0
CHECK_NUM=0

check_ok()   { printf "  ${C_OK}✓${C_RESET} %s\n" "$1"; }
check_ko()   { printf "  ${C_KO}✗${C_RESET} %s\n" "$1"; FAIL=$((FAIL + 1)); }
check_warn() { printf "  ${C_WARN}!${C_RESET} %s\n" "$1"; WARN=$((WARN + 1)); }
info()       { printf "    ${C_DIM}%s${C_RESET}\n" "$1"; }

section() {
  CHECK_NUM=$((CHECK_NUM + 1))
  printf "\n${C_DIM}[%02d]${C_RESET} %s\n" "$CHECK_NUM" "$1"
}

# ---------------------------------------------------------------------------
# [01] OS e Docker
# ---------------------------------------------------------------------------
section "OS e Docker"

ARCH=$(uname -m 2>/dev/null || echo "unknown")
if [ "$ARCH" = "aarch64" ]; then
  check_ok "Architettura: aarch64"
else
  check_ko "Architettura inattesa: $ARCH (atteso: aarch64)"
fi

if command -v docker >/dev/null 2>&1; then
  DOCKER_VER=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')
  check_ok "Docker presente: $DOCKER_VER"
else
  check_ko "Docker non installato"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "?")
  check_ok "Docker Compose v2 presente: $COMPOSE_VER"
else
  check_ko "Plugin 'docker compose' v2 mancante"
fi

if systemctl is-active --quiet docker 2>/dev/null; then
  check_ok "Daemon docker attivo"
else
  check_ko "Daemon docker NON attivo"
fi

# ---------------------------------------------------------------------------
# [02] Filesystem progetto
# ---------------------------------------------------------------------------
section "Filesystem progetto"

if [ -d "$PROJECT_DIR" ]; then
  check_ok "Directory progetto: $PROJECT_DIR"
else
  check_ko "Directory progetto mancante: $PROJECT_DIR"
fi

if [ -f "$COMPOSE_FILE" ]; then
  check_ok "docker-compose.yml presente"
else
  check_ko "docker-compose.yml mancante: $COMPOSE_FILE"
fi

if [ -f "$ENV_FILE" ]; then
  PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "?")
  if [ "$PERMS" = "600" ]; then
    check_ok ".env presente con permessi 600"
  else
    check_warn ".env presente ma permessi $PERMS (atteso 600) — 'chmod 600 $ENV_FILE'"
  fi
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE" 2>/dev/null || true; set +a
else
  check_ko ".env mancante: $ENV_FILE"
fi

for d in "$PROJECT_DIR/mosquitto/config" "$PROJECT_DIR/mosquitto/data" "$PROJECT_DIR/mosquitto/log"; do
  if [ -d "$d" ]; then
    OWNER=$(stat -c '%u:%g' "$d" 2>/dev/null)
    BASE=$(basename "$d")
    # config è montata read-only (:ro) nel container: qualsiasi owner host va bene
    # data e log sono r/w dal container: serve 1883:1883
    if [ "$BASE" = "config" ] || [ "$OWNER" = "1883:1883" ] || [ -n "${SKIP_OWNER_CHECK:-}" ]; then
      check_ok "mosquitto/$BASE owner=$OWNER"
    else
      check_warn "$d owner=$OWNER (atteso 1883:1883)"
    fi
  else
    check_ko "Directory mancante: $d"
  fi
done

for d in "$PROJECT_DIR/influxdb/data" "$PROJECT_DIR/influxdb/config"; do
  if [ -d "$d" ]; then
    OWNER=$(stat -c '%u:%g' "$d" 2>/dev/null)
    if [ "$OWNER" = "1000:1000" ] || [ -n "${SKIP_OWNER_CHECK:-}" ]; then
      check_ok "$(basename "$(dirname "$d")")/$(basename "$d") owner=$OWNER"
    else
      check_warn "$d owner=$OWNER (atteso 1000:1000)"
    fi
  else
    check_ko "Directory mancante: $d"
  fi
done

# ---------------------------------------------------------------------------
# [03] Container running
# ---------------------------------------------------------------------------
section "Container running"

if [ -f "$COMPOSE_FILE" ]; then
  for svc in mosquitto influxdb grafana; do
    STATE=$(docker inspect -f '{{.State.Status}}' "$svc" 2>/dev/null || echo "missing")
    RESTARTS=$(docker inspect -f '{{.RestartCount}}' "$svc" 2>/dev/null || echo "?")
    case "$STATE" in
      running)
        if [ "$RESTARTS" -gt 5 ] 2>/dev/null; then
          check_warn "$svc: running ma RestartCount=$RESTARTS (instabile?)"
        else
          check_ok "$svc: running (restarts=$RESTARTS)"
        fi
        ;;
      missing)
        check_ko "$svc: container inesistente (docker compose up -d?)"
        ;;
      *)
        check_ko "$svc: stato '$STATE'"
        ;;
    esac
  done
else
  check_warn "Skip container check: compose file mancante"
fi

# ---------------------------------------------------------------------------
# [04] Porte in ascolto
# ---------------------------------------------------------------------------
section "Porte in ascolto"

if command -v ss >/dev/null 2>&1; then
  LISTEN=$(ss -tlnH 2>/dev/null || true)
else
  LISTEN=$(netstat -tlnH 2>/dev/null || true)
fi

for port in 1883 8086 3000; do
  if echo "$LISTEN" | grep -qE "[:.]${port}\b"; then
    check_ok "Porta $port in LISTEN"
  else
    check_ko "Porta $port NON in LISTEN"
  fi
done

# ---------------------------------------------------------------------------
# [05] Mosquitto auth
# ---------------------------------------------------------------------------
section "Mosquitto auth (utente monitor)"

MQTT_MONITOR_PW="${MQTT_PASS_MONITOR:-${MQTT_PWD_MONITOR:-}}"
if [ -z "$MQTT_MONITOR_PW" ]; then
  check_warn "MQTT_PASS_MONITOR non definita in .env — skip auth test"
else
  if docker exec mosquitto mosquitto_pub \
      -h localhost -u monitor -P "$MQTT_MONITOR_PW" \
      -t 'healthcheck/ping' -m "$(date -u +%s)" -q 0 >/dev/null 2>&1; then
    check_ok "mosquitto_pub autenticato (utente monitor)"
  else
    check_ko "mosquitto_pub fallito — credenziali monitor errate o broker irraggiungibile"
  fi

  # Verifica negativa: credenziali sbagliate devono fallire (auth effettivamente on)
  if docker exec mosquitto mosquitto_pub \
      -h localhost -u monitor -P "wrong-password-on-purpose" \
      -t 'healthcheck/ping' -m 'x' -q 0 >/dev/null 2>&1; then
    check_ko "Auth broker permissiva: credenziali sbagliate accettate"
  else
    check_ok "Credenziali sbagliate rifiutate (allow_anonymous=false)"
  fi
fi

# ---------------------------------------------------------------------------
# [06] InfluxDB /health
# ---------------------------------------------------------------------------
section "InfluxDB health"

HEALTH_JSON=$(curl -sf --max-time 5 http://localhost:8086/health 2>/dev/null || echo "")
if echo "$HEALTH_JSON" | grep -q '"status":"pass"'; then
  check_ok "InfluxDB /health = pass"
else
  check_ko "InfluxDB /health NON pass (response: ${HEALTH_JSON:-<empty>})"
fi

# ---------------------------------------------------------------------------
# [07] InfluxDB bucket 'garden'
# ---------------------------------------------------------------------------
section "InfluxDB bucket 'garden'"

ADMIN_TOKEN="${INFLUXDB_ADMIN_TOKEN:-${DOCKER_INFLUXDB_INIT_ADMIN_TOKEN:-}}"
if [ -z "$ADMIN_TOKEN" ]; then
  check_warn "INFLUXDB_ADMIN_TOKEN non definito — skip bucket check"
else
  BUCKETS=$(docker exec influxdb influx bucket list \
    --org "${INFLUXDB_ORG:-orto-digitale}" \
    --token "$ADMIN_TOKEN" 2>/dev/null || echo "")
  if echo "$BUCKETS" | grep -qE '^\S+\s+garden\s'; then
    check_ok "Bucket 'garden' presente"
  else
    check_ko "Bucket 'garden' non trovato (org=${INFLUXDB_ORG:-orto-digitale})"
  fi
fi

# ---------------------------------------------------------------------------
# [08] Grafana health
# ---------------------------------------------------------------------------
section "Grafana health"

GRAFANA_JSON=$(curl -sf --max-time 5 http://localhost:3000/api/health 2>/dev/null || echo "")
# Tollera pretty-printed JSON con whitespace tra chiave e valore
if echo "$GRAFANA_JSON" | tr -d '[:space:]' | grep -q '"database":"ok"'; then
  check_ok "Grafana /api/health = ok"
else
  check_ko "Grafana /api/health NON ok (response: ${GRAFANA_JSON:-<empty>})"
fi

# ---------------------------------------------------------------------------
# [09] Spazio disco
# ---------------------------------------------------------------------------
section "Spazio disco"

DISK_USE=$(df -P / | awk 'NR==2 {gsub("%",""); print $5}')
DISK_AVAIL=$(df -Ph / | awk 'NR==2 {print $4}')
if [ "${DISK_USE:-100}" -lt 80 ]; then
  check_ok "Uso disco / = ${DISK_USE}% (liberi ${DISK_AVAIL})"
elif [ "${DISK_USE:-100}" -lt 90 ]; then
  check_warn "Uso disco / = ${DISK_USE}% (liberi ${DISK_AVAIL}) — attenzione"
else
  check_ko "Uso disco / = ${DISK_USE}% — critico"
fi

# ---------------------------------------------------------------------------
# [10] Simulatore (informativo)
# ---------------------------------------------------------------------------
section "Simulatore sensori (informativo)"

if pgrep -f sensor_simulator >/dev/null 2>&1; then
  check_warn "sensor_simulator ATTIVO — dati finti in arrivo su MQTT. Fermarlo prima di usare GW3000 reale."
else
  check_ok "sensor_simulator fermo"
fi

# ---------------------------------------------------------------------------
# Report finale
# ---------------------------------------------------------------------------
echo
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  printf "${C_OK}═══ TUTTO OK ═══${C_RESET}\n"
  exit 0
elif [ "$FAIL" -eq 0 ]; then
  printf "${C_WARN}═══ OK con %d warning ═══${C_RESET}\n" "$WARN"
  exit 0
else
  printf "${C_KO}═══ %d FAIL, %d warning ═══${C_RESET}\n" "$FAIL" "$WARN"
  exit 1
fi
