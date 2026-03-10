#!/usr/bin/env bash

# Live gateway e2e harness for obsidian-livesync-cognee.
#
# Main flow:
#   1. Back up the active OpenClaw config.
#   2. Start a disposable CouchDB container on a non-default loopback port.
#   3. Patch the live OpenClaw config so only a disposable vault/dataset is active for this plugin.
#   4. Restart the user-level gateway service and wait for it to become healthy.
#   5. Seed a small LiveSync-style note corpus with a multi-hop relationship chain.
#   6. Run `openclaw obsidian-vault sync` against that disposable vault.
#   7. Run a real gateway-backed agent turn with a channel-shaped session key.
#   8. Query `sessions.usage` with `includeContextWeight=true` and assert the backend tool catalog.
#   9. Restore the original config and restart the gateway.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

SOURCE_CONFIG="${OPENCLAW_SOURCE_CONFIG:-$HOME/.openclaw/openclaw.json}"
E2E_ROOT="${OPENCLAW_OBSIDIAN_E2E_ROOT:-/tmp/openclaw-obsidian-e2e}"
E2E_CONFIG="$E2E_ROOT/openclaw.e2e.json"
SOURCE_CONFIG_BACKUP="$E2E_ROOT/openclaw.source.backup.json"
E2E_META="$E2E_ROOT/meta.env"
PROMPT_FILE="$E2E_ROOT/prompt.txt"
SYNC_OUTPUT_FILE="$E2E_ROOT/sync-output.txt"
AGENT_OUTPUT_RAW_FILE="$E2E_ROOT/agent-output.raw.txt"
AGENT_OUTPUT_FILE="$E2E_ROOT/agent-output.json"
USAGE_OUTPUT_RAW_FILE="$E2E_ROOT/session-usage.raw.txt"
USAGE_OUTPUT_FILE="$E2E_ROOT/session-usage.json"
HEALTH_OUTPUT_RAW_FILE="$E2E_ROOT/gateway-health.raw.txt"
COUCH_PORT="${OPENCLAW_OBSIDIAN_E2E_COUCH_PORT:-15994}"
CONTAINER_NAME="${OPENCLAW_OBSIDIAN_E2E_CONTAINER_NAME:-obsidian-livesync-couchdb-e2e}"
KEEP_CONTAINER="${OPENCLAW_OBSIDIAN_E2E_KEEP_CONTAINER:-0}"
KEEP_ROOT="${OPENCLAW_OBSIDIAN_E2E_KEEP_ROOT:-1}"
QUESTION="${OPENCLAW_OBSIDIAN_E2E_QUESTION:-After Iris delegated the Cedar launch review, who became the approver of record once the blocker was closed, and what blocker was it? Cite the supporting note paths.}"
AGENT_ID="${OPENCLAW_OBSIDIAN_E2E_AGENT_ID:-asst}"
SESSION_KEY="${OPENCLAW_OBSIDIAN_E2E_SESSION_KEY:-agent:${AGENT_ID}:signal:dm:obsidian-e2e-user}"
GATEWAY_UNIT="${OPENCLAW_OBSIDIAN_E2E_GATEWAY_UNIT:-openclaw-gateway.service}"
GATEWAY_HEALTH_TIMEOUT_SECONDS="${OPENCLAW_OBSIDIAN_E2E_GATEWAY_HEALTH_TIMEOUT_SECONDS:-60}"
GATEWAY_CALL_TIMEOUT_MS="${OPENCLAW_OBSIDIAN_E2E_GATEWAY_CALL_TIMEOUT_MS:-120000}"
AGENT_TIMEOUT_SECONDS="${OPENCLAW_OBSIDIAN_E2E_AGENT_TIMEOUT_SECONDS:-180}"
COGNEE_BASE_URL="${OPENCLAW_OBSIDIAN_E2E_COGNEE_BASE_URL:-http://127.0.0.1:8000}"
COUCH_SCHEME_HOST="${OPENCLAW_OBSIDIAN_E2E_COUCH_SCHEME_HOST:-http://127.0.0.1}"
COUCHDB_USER="${OPENCLAW_OBSIDIAN_E2E_COUCHDB_USER:-admin}"
COUCHDB_PASSWORD="${OPENCLAW_OBSIDIAN_E2E_COUCHDB_PASSWORD:-admin}"

STAMP="$(date +%Y%m%d-%H%M%S)"
DB_NAME="livesync_e2e_${STAMP}"
DATASET_NAME="obsidian_e2e_${STAMP}"
VAULT_ID="livesync-e2e"
REQUEST_ID="obsidian-e2e-${STAMP}"

LIVE_CONFIG_RESTORED=0

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

log() {
  printf '[e2e-live] %s\n' "$*"
}

extract_json() {
  local raw_file="$1"
  local json_file="$2"
  awk 'BEGIN { capture = 0 } /^[[:space:]]*[{[]/ { capture = 1 } capture { print }' "$raw_file" > "$json_file"
  if [[ ! -s "$json_file" ]]; then
    echo "failed to extract JSON payload from $raw_file" >&2
    exit 1
  fi
  jq . "$json_file" >/dev/null
}

write_meta_var() {
  local key="$1"
  local value="$2"
  printf '%s=%q\n' "$key" "$value" >> "$E2E_META"
}

service_env_value() {
  local key="$1"
  systemctl --user show "$GATEWAY_UNIT" --property=Environment --value \
    | tr ' ' '\n' \
    | sed -n "s/^${key}=//p" \
    | tail -n 1
}

restore_live_config() {
  if [[ "$LIVE_CONFIG_RESTORED" == "1" ]]; then
    return
  fi
  if [[ -f "$SOURCE_CONFIG_BACKUP" ]]; then
    cp "$SOURCE_CONFIG_BACKUP" "$SOURCE_CONFIG"
    systemctl --user restart "$GATEWAY_UNIT" >/dev/null 2>&1 || true
  fi
  LIVE_CONFIG_RESTORED=1
}

cleanup() {
  local exit_code=$?
  restore_live_config
  if [[ "$KEEP_CONTAINER" != "1" ]]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_ROOT" != "1" && -d "$E2E_ROOT" ]]; then
    rm -rf "$E2E_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

wait_for_gateway_health() {
  local start_ts now elapsed
  start_ts="$(date +%s)"
  while true; do
    if openclaw gateway call health --url "$GATEWAY_URL" --token "$GATEWAY_TOKEN" --json > "$HEALTH_OUTPUT_RAW_FILE" 2>&1; then
      extract_json "$HEALTH_OUTPUT_RAW_FILE" "$E2E_ROOT/gateway-health.json"
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - start_ts))
    if [[ "$elapsed" -ge "$GATEWAY_HEALTH_TIMEOUT_SECONDS" ]]; then
      echo "gateway health did not recover within ${GATEWAY_HEALTH_TIMEOUT_SECONDS}s" >&2
      cat "$HEALTH_OUTPUT_RAW_FILE" >&2 || true
      exit 1
    fi
    sleep 2
  done
}

call_gateway_json() {
  local method="$1"
  local params_json="$2"
  local raw_file="$3"
  local json_file="$4"
  shift 4
  openclaw gateway call "$method" --url "$GATEWAY_URL" --token "$GATEWAY_TOKEN" --timeout "$GATEWAY_CALL_TIMEOUT_MS" --json --params "$params_json" "$@" > "$raw_file" 2>&1
  extract_json "$raw_file" "$json_file"
}

need_cmd docker
need_cmd curl
need_cmd jq
need_cmd node
need_cmd openclaw

if [[ ! -f "$SOURCE_CONFIG" ]]; then
  echo "source config not found: $SOURCE_CONFIG" >&2
  exit 1
fi

rm -rf "$E2E_ROOT"
mkdir -p "$E2E_ROOT"

printf '%s\n' "$QUESTION" > "$PROMPT_FILE"
cp "$SOURCE_CONFIG" "$SOURCE_CONFIG_BACKUP"

GATEWAY_PORT="${OPENCLAW_OBSIDIAN_E2E_GATEWAY_PORT:-$(service_env_value OPENCLAW_GATEWAY_PORT)}"
GATEWAY_TOKEN="${OPENCLAW_OBSIDIAN_E2E_GATEWAY_TOKEN:-$(service_env_value OPENCLAW_GATEWAY_TOKEN)}"

if [[ -z "$GATEWAY_PORT" ]]; then
  echo "failed to resolve gateway port from $GATEWAY_UNIT" >&2
  exit 1
fi
if [[ -z "$GATEWAY_TOKEN" ]]; then
  echo "failed to resolve gateway token from $GATEWAY_UNIT" >&2
  exit 1
fi

GATEWAY_URL="${OPENCLAW_OBSIDIAN_E2E_GATEWAY_URL:-ws://127.0.0.1:${GATEWAY_PORT}}"

: > "$E2E_META"
write_meta_var REPO_ROOT "$REPO_ROOT"
write_meta_var SOURCE_CONFIG "$SOURCE_CONFIG"
write_meta_var SOURCE_CONFIG_BACKUP "$SOURCE_CONFIG_BACKUP"
write_meta_var E2E_ROOT "$E2E_ROOT"
write_meta_var E2E_CONFIG "$E2E_CONFIG"
write_meta_var E2E_META "$E2E_META"
write_meta_var PROMPT_FILE "$PROMPT_FILE"
write_meta_var SYNC_OUTPUT_FILE "$SYNC_OUTPUT_FILE"
write_meta_var AGENT_OUTPUT_RAW_FILE "$AGENT_OUTPUT_RAW_FILE"
write_meta_var AGENT_OUTPUT_FILE "$AGENT_OUTPUT_FILE"
write_meta_var USAGE_OUTPUT_RAW_FILE "$USAGE_OUTPUT_RAW_FILE"
write_meta_var USAGE_OUTPUT_FILE "$USAGE_OUTPUT_FILE"
write_meta_var COUCH_PORT "$COUCH_PORT"
write_meta_var COUCH_SCHEME_HOST "$COUCH_SCHEME_HOST"
write_meta_var COUCHDB_USER "$COUCHDB_USER"
write_meta_var COUCHDB_PASSWORD "$COUCHDB_PASSWORD"
write_meta_var CONTAINER_NAME "$CONTAINER_NAME"
write_meta_var DB_NAME "$DB_NAME"
write_meta_var DATASET_NAME "$DATASET_NAME"
write_meta_var VAULT_ID "$VAULT_ID"
write_meta_var AGENT_ID "$AGENT_ID"
write_meta_var SESSION_KEY "$SESSION_KEY"
write_meta_var REQUEST_ID "$REQUEST_ID"
write_meta_var GATEWAY_UNIT "$GATEWAY_UNIT"
write_meta_var GATEWAY_URL "$GATEWAY_URL"
write_meta_var GATEWAY_CALL_TIMEOUT_MS "$GATEWAY_CALL_TIMEOUT_MS"
write_meta_var AGENT_TIMEOUT_SECONDS "$AGENT_TIMEOUT_SECONDS"
write_meta_var QUESTION "$QUESTION"

log "writing disposable live config patch"
SOURCE_CONFIG="$SOURCE_CONFIG" \
E2E_CONFIG="$E2E_CONFIG" \
COGNEE_BASE_URL="$COGNEE_BASE_URL" \
DATASET_NAME="$DATASET_NAME" \
COUCH_SCHEME_HOST="$COUCH_SCHEME_HOST" \
COUCH_PORT="$COUCH_PORT" \
COUCHDB_USER="$COUCHDB_USER" \
COUCHDB_PASSWORD="$COUCHDB_PASSWORD" \
DB_NAME="$DB_NAME" \
VAULT_ID="$VAULT_ID" \
AGENT_ID="$AGENT_ID" \
node <<'NODE'
const fs = require('fs');

const env = process.env;
const config = JSON.parse(fs.readFileSync(env.SOURCE_CONFIG, 'utf8'));

config.plugins = config.plugins || {};
config.plugins.allow = Array.from(new Set([...(config.plugins.allow || []), 'cognee-openclaw', 'obsidian-livesync-cognee']));
config.plugins.entries = config.plugins.entries || {};
config.plugins.slots = { ...(config.plugins.slots || {}), memory: 'cognee-openclaw' };

const cogneeEntry = config.plugins.entries['cognee-openclaw'] || {};
config.plugins.entries['cognee-openclaw'] = {
  ...cogneeEntry,
  enabled: true,
  config: {
    ...(cogneeEntry.config || {}),
    baseUrl: env.COGNEE_BASE_URL,
    datasetName: env.DATASET_NAME,
    datasetNames: { ...((cogneeEntry.config || {}).datasetNames || {}), [env.AGENT_ID]: env.DATASET_NAME },
    autoRecall: true,
    autoIndex: true,
    autoCognify: true,
    searchType: 'GRAPH_COMPLETION',
    maxResults: 6,
    minScore: 0,
    requestTimeoutMs: 60000,
  },
};

const obsidianEntry = config.plugins.entries['obsidian-livesync-cognee'] || {};
config.plugins.entries['obsidian-livesync-cognee'] = {
  ...obsidianEntry,
  enabled: true,
  config: {
    ...(obsidianEntry.config || {}),
    defaults: {
      ...((obsidianEntry.config || {}).defaults || {}),
      agentTools: {
        ...(((obsidianEntry.config || {}).defaults || {}).agentTools || {}),
        defaultExpose: ['obsidian_vault_deep_graph_search'],
      },
    },
    vaults: [
      {
        id: env.VAULT_ID,
        url: `${env.COUCH_SCHEME_HOST}:${env.COUCH_PORT}`,
        database: env.DB_NAME,
        username: env.COUCHDB_USER,
        password: env.COUCHDB_PASSWORD,
        enabled: true,
        mode: 'read-only',
        syncMode: 'changes',
        pollIntervalSeconds: 300,
        requestTimeoutMs: 15000,
        includeGlobs: ['daily/**', 'projects/**', 'ops/**'],
        excludeGlobs: ['attachments/**'],
        autoResolveConflicts: true,
        notifications: {
          onError: false,
          onConflict: false,
          wakeAgent: false,
          dedupeWindowSeconds: 60,
        },
        automation: {
          memify: {
            enabled: false,
            triggers: [],
            minIntervalSeconds: 1800,
            allSnapshots: false,
            notifyOnStart: false,
            notifyOnSuccess: false,
            notifyOnFailure: false,
          },
        },
        cognee: {
          enabled: true,
          baseUrl: env.COGNEE_BASE_URL,
          datasetName: env.DATASET_NAME,
          cognify: true,
          downloadHttpLinks: false,
          maxLinksPerNote: 2,
          maxLinkBytes: 65536,
          searchType: 'GRAPH_COMPLETION',
          searchTopK: 5,
        },
      },
    ],
  },
};

fs.writeFileSync(env.E2E_CONFIG, JSON.stringify(config, null, 2) + '\n');
NODE

log "starting disposable CouchDB container $CONTAINER_NAME on port $COUCH_PORT"
if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi
docker run -d --rm --name "$CONTAINER_NAME" -p "127.0.0.1:${COUCH_PORT}:5984" -e COUCHDB_USER="$COUCHDB_USER" -e COUCHDB_PASSWORD="$COUCHDB_PASSWORD" couchdb:3.4 >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS -u "${COUCHDB_USER}:${COUCHDB_PASSWORD}" "${COUCH_SCHEME_HOST}:${COUCH_PORT}/_up" >/dev/null; then
    break
  fi
  sleep 1
done

curl -fsS -u "${COUCHDB_USER}:${COUCHDB_PASSWORD}" -X PUT "${COUCH_SCHEME_HOST}:${COUCH_PORT}/${DB_NAME}" >/dev/null

log "applying disposable config to live gateway"
cp "$E2E_CONFIG" "$SOURCE_CONFIG"
systemctl --user restart "$GATEWAY_UNIT"
wait_for_gateway_health

log "seeding disposable CouchDB with linked notes"
put_doc() {
  local doc_id="$1"
  local note_path="$2"
  local note_text="$3"
  local now
  now="$(date +%s%3N)"
  jq -nc \
    --arg id "$doc_id" \
    --arg path "$note_path" \
    --arg text "$note_text" \
    --argjson now "$now" \
    '{_id:$id,path:$path,type:"plain",datatype:"plain",data:[$text],mtime:$now,ctime:$now,size:($text|length),children:[],eden:{}}' \
    | curl -fsS -u "${COUCHDB_USER}:${COUCHDB_PASSWORD}" -X PUT \
      "${COUCH_SCHEME_HOST}:${COUCH_PORT}/${DB_NAME}/$(printf '%s' "$doc_id" | jq -sRr @uri)" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null
}

put_doc 'daily/2026-03-08.md' 'daily/2026-03-08.md' $'Iris delegated the Cedar launch review to the release captain.\n'
put_doc 'projects/cedar/handoff.md' 'projects/cedar/handoff.md' $'For Cedar, the release captain is Jonah Vale.\n'
put_doc 'ops/cedar-blockers.md' 'ops/cedar-blockers.md' $'When Jonah Vale confirmed blocker R-17 was closed, the approver of record switched to Maya Chen.\n'
put_doc 'projects/cedar/blockers.md' 'projects/cedar/blockers.md' $'Blocker R-17 is the expired vendor key rotation ticket.\n'

log "running disposable vault sync"
OPENCLAW_CONFIG_PATH="$SOURCE_CONFIG" \
openclaw obsidian-vault sync --vault "$VAULT_ID" | tee "$SYNC_OUTPUT_FILE"

log "running live gateway agent turn"
AGENT_PARAMS="$(jq -nc \
  --arg message "$QUESTION" \
  --arg agentId "$AGENT_ID" \
  --arg sessionKey "$SESSION_KEY" \
  --arg channel 'signal' \
  --arg to 'obsidian-e2e-user' \
  --arg replyChannel 'signal' \
  --arg replyTo 'obsidian-e2e-user' \
  --arg thinking 'high' \
  --argjson timeout "$AGENT_TIMEOUT_SECONDS" \
  --arg idempotencyKey "$REQUEST_ID" \
  '{message:$message,agentId:$agentId,sessionKey:$sessionKey,channel:$channel,to:$to,replyChannel:$replyChannel,replyTo:$replyTo,thinking:$thinking,timeout:$timeout,idempotencyKey:$idempotencyKey}')"
call_gateway_json agent "$AGENT_PARAMS" "$AGENT_OUTPUT_RAW_FILE" "$AGENT_OUTPUT_FILE" --expect-final

log "collecting live session usage report"
USAGE_PARAMS="$(jq -nc --arg key "$SESSION_KEY" '{key:$key,includeContextWeight:true,limit:1}')"
for _ in $(seq 1 20); do
  call_gateway_json sessions.usage "$USAGE_PARAMS" "$USAGE_OUTPUT_RAW_FILE" "$USAGE_OUTPUT_FILE"
  if jq -e '.sessions[0].contextWeight.tools.entries | length >= 1' "$USAGE_OUTPUT_FILE" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

log "running assertion script"
"$SCRIPT_DIR/e2e-live-assert.sh" "$E2E_META"

log "restoring live config"
restore_live_config
wait_for_gateway_health

log "done"
log "artifacts:"
log "  meta:         $E2E_META"
log "  config:       $E2E_CONFIG"
log "  sync output:  $SYNC_OUTPUT_FILE"
log "  agent output: $AGENT_OUTPUT_FILE"
log "  usage output: $USAGE_OUTPUT_FILE"