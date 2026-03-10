#!/usr/bin/env bash

# Assertion companion for scripts/e2e-live.sh.
#
# Expected path:
# - 4 CouchDB docs seeded
# - sync succeeds for the disposable vault
# - agent answer contains Maya Chen and blocker R-17 with note-path citations
# - backend tool exposure for the channel-shaped gateway turn includes
#   `obsidian_vault_deep_graph_search`
# - backend tool exposure excludes the other Obsidian vault tools by default

set -euo pipefail

META_PATH="${1:-/tmp/openclaw-obsidian-e2e/meta.env}"

if [[ ! -f "$META_PATH" ]]; then
  echo "meta file not found: $META_PATH" >&2
  exit 1
fi

source "$META_PATH"

need_file() {
  if [[ ! -f "$1" ]]; then
    echo "missing expected file: $1" >&2
    exit 1
  fi
}

need_file "$E2E_CONFIG"
need_file "$AGENT_OUTPUT_FILE"
need_file "$USAGE_OUTPUT_FILE"
need_file "$PROMPT_FILE"

if grep -Fq 'obsidian_vault_deep_graph_search' "$PROMPT_FILE"; then
  echo "prompt file still explicitly names obsidian_vault_deep_graph_search" >&2
  exit 1
fi

db_rows="$(curl --max-time 5 -fsS -u "${COUCHDB_USER}:${COUCHDB_PASSWORD}" "${COUCH_SCHEME_HOST}:${COUCH_PORT}/${DB_NAME}/_all_docs" | jq '.total_rows')"
if [[ "$db_rows" != "4" ]]; then
  echo "expected 4 CouchDB docs, got $db_rows" >&2
  exit 1
fi

if ! grep -Fq 'Maya Chen' "$AGENT_OUTPUT_FILE"; then
  echo "agent output missing Maya Chen" >&2
  exit 1
fi
if ! grep -Fq 'R-17' "$AGENT_OUTPUT_FILE"; then
  echo "agent output missing R-17" >&2
  exit 1
fi
if ! grep -Fq 'ops/cedar-blockers.md' "$AGENT_OUTPUT_FILE"; then
  echo "agent output missing ops/cedar-blockers.md citation" >&2
  exit 1
fi

tool_names="$(jq -r '.sessions[0].contextWeight.tools.entries[].name' "$USAGE_OUTPUT_FILE")"
if [[ -z "$tool_names" ]]; then
  echo "usage report missing contextWeight.tools.entries" >&2
  exit 1
fi

if ! printf '%s\n' "$tool_names" | grep -Fxq 'obsidian_vault_deep_graph_search'; then
  echo "tool catalog missing obsidian_vault_deep_graph_search" >&2
  exit 1
fi

for forbidden_tool in \
  obsidian_vault_status \
  obsidian_vault_sync \
  obsidian_vault_read \
  obsidian_vault_write \
  obsidian_vault_conflicts \
  obsidian_vault_resolve_conflict \
  obsidian_vault_memify \
  obsidian_vault_repair_local \
  obsidian_vault_stop_task \
  obsidian_vault_update_config
do
  if printf '%s\n' "$tool_names" | grep -Fxq "$forbidden_tool"; then
    echo "tool catalog still exposes forbidden default tool: $forbidden_tool" >&2
    exit 1
  fi
done

printf '[e2e-live-assert] ok: db_rows=%s default_tool=obsidian_vault_deep_graph_search tool_entries=%s\n' \
  "$db_rows" \
  "$(printf '%s\n' "$tool_names" | wc -l | tr -d ' ')"