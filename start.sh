#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$ROOT"
umask 077
TEMP_ENV=''
finish() {
    rc=$?
    trap - EXIT
    if [[ -n "$TEMP_ENV" ]]; then rm -f -- "$TEMP_ENV"; fi
    if (( rc != 0 )); then
        printf '\nLauncher failed; existing data and ports were preserved.\n'
        printf 'Inspect: docker compose --env-file .env logs --tail 100 app gitea proxy\n'
        if [[ -n "${LOG:-}" ]]; then printf 'Launcher log: %s\n' "$LOG"; fi
        if [[ "${GITLEA_PAUSE_ON_ERROR:-0}" == 1 && -t 0 ]]; then read -r -p 'Press Enter to close...' ignored || true; fi
    fi
    exit "$rc"
}
trap finish EXIT
mkdir -p logs/launcher
LOG="$ROOT/logs/launcher/$(date -u +%Y%m%d-%H%M%S)-$$.log"
: > "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
fail() { say "ERROR: $*"; exit 1; }
run() { "$@" 2>&1 | tee -a "$LOG"; }
say 'SECURITY GATE OPEN: Next.js 15.1.3 requires security remediation. Local demo only; do not deploy or expose this stack publicly.'
command -v docker >/dev/null 2>&1 || fail 'Install Docker Desktop on macOS, or Docker Engine and Compose v2 on Linux; start the engine.'
command -v curl >/dev/null 2>&1 || fail 'Install curl for application readiness checks.'
run docker compose version
run docker info --format '{{.ServerVersion}}'
random_secret() {
    local value
    value="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ ${#value} -eq 64 && "$value" != *[!0-9a-f]* ]] || return 1
    printf '%s' "$value"
}
if [[ ! -e .env ]]; then
    [[ -f .env.example ]] || fail 'Missing .env.example. Restore it from the repository.'
    TEMP_ENV="$(mktemp "$ROOT/.env.launcher.XXXXXXXX")"
    session="$(random_secret)" || fail 'Could not generate session secret from the operating system CSPRNG.'
    admin="$(random_secret)" || fail 'Could not generate administrator password from the operating system CSPRNG.'
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(NODE_ENV|SESSION_SECRET|GITEA_ADMIN_PASSWORD)[[:space:]]*= ]]; then continue; fi
        printf '%s\n' "$line"
    done < .env.example > "$TEMP_ENV"
    printf '\nNODE_ENV=production\nSESSION_SECRET=%s\nGITEA_ADMIN_PASSWORD=%s\n' "$session" "$admin" >> "$TEMP_ENV"
    unset session admin
    chmod 600 "$TEMP_ENV"
    if ln "$TEMP_ENV" .env 2>/dev/null; then
        say 'Created .env from .env.example with random session and administrator secrets, mode 600.'
    elif [[ -f .env ]]; then
        say '.env appeared concurrently; preserving and validating it.'
    else
        fail 'Could not create .env without overwriting an existing path. Check directory permissions.'
    fi
    rm -f -- "$TEMP_ENV"
    TEMP_ENV=''
fi
[[ -f .env && -r .env ]] || fail '.env must be a readable regular file.'
trim() {
    REPLY="$1"
    REPLY="${REPLY#"${REPLY%%[![:space:]]*}"}"
    REPLY="${REPLY%"${REPLY##*[![:space:]]}"}"
}
# Read only launcher-owned validation keys; never execute dotenv content.
base='' node_environment='' session_value='' admin_value='' token='' smtp='' seen='|'
while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ ! "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then continue; fi
    key="${BASH_REMATCH[2]}"
    raw="${BASH_REMATCH[3]}"
    case "$key" in NODE_ENV|APP_BASE_URL|SESSION_SECRET|GITEA_ADMIN_PASSWORD|GITEA_ADMIN_TOKEN|SMTP_HOST) ;; *) continue ;; esac
    [[ "$seen" != *"|$key|"* ]] || fail "Duplicate $key in .env. Keep one explicit value; no file was overwritten."
    seen="$seen$key|"
    trim "$raw"; value="$REPLY"
    first="${value:0:1}"
    if [[ "$first" == '"' || "$first" == "'" ]]; then
        rest="${value:1}"
        [[ "$rest" == *"$first"* ]] || fail "Use a single-line literal for $key in .env."
        value="${rest%%"$first"*}"
        tail="${rest#*"$first"}"
        trim "$tail"
        [[ -z "$REPLY" || "$REPLY" == \#* ]] || fail "Unsupported quoting for $key in .env."
    else
        if [[ "$value" =~ ^(.*)[[:space:]]\#.*$ ]]; then value="${BASH_REMATCH[1]}"; fi
        trim "$value"; value="$REPLY"
    fi
    case "$value" in *'$'*|*'`'*|*'\'*) fail "Use an explicit literal for $key in .env; interpolation and escapes are unsupported." ;; esac
    # Inherited variables have precedence over --env-file in Docker Compose.
    if printenv "$key" >/dev/null 2>&1; then fail "Unset inherited $key before launching: it can override .env."; fi
    case "$key" in
        NODE_ENV) node_environment="$value" ;;
        APP_BASE_URL) base="$value" ;;
        SESSION_SECRET) session_value="$value" ;;
        GITEA_ADMIN_PASSWORD) admin_value="$value" ;;
        GITEA_ADMIN_TOKEN) token="$value" ;;
        SMTP_HOST) smtp="$value" ;;
    esac
done < .env
unsafe() {
    local lower remainder
    lower="$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    (( ${#1} >= $2 )) || return 0
    case "$lower" in local-github-dev-admin-password|*replace*|*placeholder*|*changeme*|*change-me*|*example*|*your-*|*your_*|*devknown*) return 0 ;; esac
    remainder="${1//${1:0:1}/}"
    [[ -z "$remainder" ]]
}
[[ "$node_environment" == production ]] || fail 'Set NODE_ENV=production in existing .env before launch; development identity issuance must remain disabled. Nothing was overwritten.'
if unsafe "$session_value" 32; then fail 'Existing .env needs a non-placeholder SESSION_SECRET of at least 32 characters from at least 32 random bytes. Update it manually; rotating it invalidates sessions. Nothing was overwritten.'; fi
if unsafe "$admin_value" 16; then fail 'Existing .env needs an explicit strong GITEA_ADMIN_PASSWORD (at least 16 characters). Update it manually and reconcile any existing Gitea administrator password. Volumes and credentials were not reset.'; fi
unset session_value admin_value
while [[ "$base" == */ ]]; do base="${base%/}"; done
case "$base" in http://*|https://*) ;; *) fail 'Set APP_BASE_URL to an explicit http(s) public application URL in .env.' ;; esac
case "$base" in *[[:space:]]*|*'?'*|*'#'*|*'@'*) fail 'APP_BASE_URL must not contain whitespace, credentials, query or fragment.' ;; esac
authority="${base#*://}"; authority="${authority%%/*}"
[[ -n "$authority" && "$authority" != :* && "$authority" != -* ]] || fail 'APP_BASE_URL needs a valid hostname and the existing proxy port.'
say 'AUTH STATUS: UI availability does not prove authentication. Gitea API token, OIDC and SMTP must be configured and verified separately; unset or placeholder settings mean UI-only operation. QR activation is not implemented by this launcher.'
if unsafe "$token" 16; then say 'WARNING: GITEA_ADMIN_TOKEN is missing or a placeholder; Gitea-backed authentication/provisioninging is not ready.'; fi
if [[ -z "$smtp" || "$smtp" == smtp.local ]]; then say 'WARNING: SMTP is unconfigured; email activation is not ready.'; fi
unset token smtp
run docker compose --env-file .env config --quiet
run docker compose --env-file .env up -d --build app gitea proxy
say 'Waiting up to 300 seconds for application /api/health (HTTP 200).'
deadline=$((SECONDS + 300))
ready=0
while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    timeout=5
    if (( remaining < timeout )); then timeout=$remaining; fi
    code=''
    if code="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout "$timeout" --max-time "$timeout" -- "$base/api/health")"; then
        if [[ "$code" == 200 ]] && (( SECONDS <= deadline )); then ready=1; break; fi
    fi
    remaining=$((deadline - SECONDS))
    if (( remaining > 0 )); then
        delay=2
        if (( remaining < delay )); then delay=$remaining; fi
        sleep "$delay"
    fi
done
(( ready == 1 )) || fail 'Application readiness timed out. Check APP_BASE_URL, proxy ports and service health. Data is preserved.'
say "Application returned HTTP 200: $base"
say 'This confirms UI readiness only. The security and full-auth gates remain OPEN.'
if [[ "${GITLEA_NO_BROWSER:-0}" != 1 ]]; then
    if [[ "$(uname -s)" == Darwin ]]; then
        open "$base" >/dev/null 2>&1 || say "Browser could not be opened. Visit $base"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$base" >/dev/null 2>&1 &
    else
        say "No browser opener found. Visit $base"
    fi
fi
say "Launcher log: $LOG"
