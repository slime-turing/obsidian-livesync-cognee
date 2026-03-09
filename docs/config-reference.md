# Configuration Reference

This document is the full option-by-option reference for `plugins.entries.obsidian-livesync-cognee.config`.

Use [README.md](../README.md) for the fast path. Use this document when you need to understand what every option does, which values are allowed, whether the field is required, and what a normal example looks like.

## Config shape

Top-level plugin config shape:

```yaml
plugins:
  entries:
    obsidian-livesync-cognee:
      enabled: true
      config:
        defaults:
          ...
        vaults:
          - ...
```

- `vaults` is required and must be an array.
- `defaults` is optional and provides shared fallback values for vault entries.
- String values support environment placeholder expansion like `${EXAMPLE_NAME}`.

## Valid vault definition styles

Each vault must use exactly one of these patterns.

### Preferred: `setupUri` mode

```yaml
vaults:
  - id: team-notes
    setupUri: ${OBSIDIAN_LIVESYNC_SETUP_URI}
    setupUriPassphrase: ${OBSIDIAN_LIVESYNC_SETUP_URI_PASSPHRASE}
    cognee:
      enabled: true
      datasetName: team-notes
```

Use this for most setups. It keeps CouchDB connection details, E2EE settings, and path-obfuscation behavior aligned with the upstream Obsidian LiveSync export.

When `setupUri` is used, do not also set these manual fields on the same vault:

- `url`
- `database`
- `username`
- `password`
- `passphrase`
- `usePathObfuscation`
- `handleFilenameCaseSensitive`

### Manual CouchDB mode

```yaml
vaults:
  - id: team-notes
    url: https://couchdb.example.invalid
    database: obsidian-team-notes
    username: ${COUCHDB_USERNAME}
    password: ${COUCHDB_PASSWORD}
    passphrase: ${OBSIDIAN_VAULT_PASSPHRASE}
    usePathObfuscation: true
    handleFilenameCaseSensitive: false
```

Use this only when you are not configuring from a LiveSync setup URI.

## Defaults block

The `defaults` object is optional. It lets you define shared values once and reuse them across multiple vaults.

| Option | Purpose | Required | Allowed values / range | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `defaults.pollIntervalSeconds` | Shared sync polling interval for vaults that do not override it. | No | Number, minimum `5` | `300` | `120` |
| `defaults.requestTimeoutMs` | Shared HTTP timeout for CouchDB requests when a vault does not override it. | No | Number, minimum `1000` | `20000` | `15000` |
| `defaults.syncMode` | Shared sync strategy fallback. | No | `changes`, `full` | `changes` | `changes` |
| `defaults.mirrorRoot` | Shared mirror directory override. | No | Non-empty string path | Plugin-owned default mirror path | `/srv/openclaw/mirror` |
| `defaults.snapshotRoot` | Shared snapshot directory override. | No | Non-empty string path | Plugin-owned default snapshot path | `/srv/openclaw/snapshots` |
| `defaults.notifications` | Shared notification settings block. | No | Object | Built-in notification defaults | See below |
| `defaults.automation` | Shared automation settings block. Currently this means `automation.memify`. | No | Object | Built-in automation defaults | See below |
| `defaults.headers` | Shared extra HTTP headers for CouchDB requests. Vault-level headers are merged on top. | No | Object of string values | Empty object | `X-Forwarded-Host: livesync.example.invalid` |
| `defaults.cognee` | Shared Cognee target settings inherited by vaults. | No | Object | Empty / inherited from memory slot if available | See below |

## Vault options

Each item in `vaults` is one configured LiveSync vault.

| Option | Purpose | Required | Allowed values / range | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `vaults[].id` | Stable unique vault identifier used by CLI, tools, mirror paths, and snapshot paths. | Yes | Non-empty string, must be unique across all vaults | None | `team-notes` |
| `vaults[].setupUri` | Obsidian LiveSync setup URI copied from the upstream setup flow. | Required in `setupUri` mode | Non-empty string beginning with the LiveSync setup URI prefix | None | `${OBSIDIAN_LIVESYNC_SETUP_URI}` |
| `vaults[].setupUriPassphrase` | Passphrase used to decode `setupUri`. Must be provided together with `setupUri`. | Required in `setupUri` mode | Non-empty string | None | `${OBSIDIAN_LIVESYNC_SETUP_URI_PASSPHRASE}` |
| `vaults[].url` | CouchDB base URL when configuring manually instead of using `setupUri`. | Required in manual mode | Non-empty string URL | None | `https://couchdb.example.invalid` |
| `vaults[].database` | CouchDB database name for the vault when configuring manually. | Required in manual mode | Non-empty string | None | `obsidian-team-notes` |
| `vaults[].username` | CouchDB username for manual mode, if required by your server. | No | String | Unset | `${COUCHDB_USERNAME}` |
| `vaults[].password` | CouchDB password for manual mode, if required by your server. | No | String | Unset | `${COUCHDB_PASSWORD}` |
| `vaults[].headers` | Extra HTTP headers sent with CouchDB requests for this vault. Merged over `defaults.headers`. | No | Object of string values | Empty object | `Authorization: Bearer ${EXAMPLE_TOKEN}` |
| `vaults[].enabled` | Enables or disables the vault without removing its config. | No | `true`, `false` | `true` | `true` |
| `vaults[].mode` | Controls whether the plugin can write back supported changes to CouchDB. | No | `read-only`, `read-write` | `read-only` | `read-only` |
| `vaults[].syncMode` | Chooses incremental `_changes` sync or a full rebuild-style pass. | No | `changes`, `full` | `changes` | `full` |
| `vaults[].pollIntervalSeconds` | How often timer-based sync checks run for this vault. | No | Number, minimum `5` | `300` or `defaults.pollIntervalSeconds` | `120` |
| `vaults[].requestTimeoutMs` | Timeout for CouchDB HTTP requests for this vault. | No | Number, minimum `1000` | `20000` or `defaults.requestTimeoutMs` | `15000` |
| `vaults[].includeGlobs` | Optional allowlist of note paths to sync. Empty means no include filter. | No | Array of strings | Empty array | `['projects/**', 'daily/**']` |
| `vaults[].excludeGlobs` | Optional denylist of note paths to skip after include matching. | No | Array of strings | Empty array | `['attachments/**']` |
| `vaults[].mirrorRoot` | Override where the current working copy of notes is stored. | No | Non-empty string path | Plugin-owned default mirror path | `/var/lib/openclaw/mirror/team-notes` |
| `vaults[].snapshotRoot` | Override where append-only snapshot history is stored. | No | Non-empty string path | Plugin-owned default snapshot path | `/var/lib/openclaw/snapshots/team-notes` |
| `vaults[].passphrase` | Manual-mode vault passphrase used for E2EE or path obfuscation handling. | No | String | Unset | `${OBSIDIAN_VAULT_PASSPHRASE}` |
| `vaults[].usePathObfuscation` | Tells the plugin that LiveSync path obfuscation is enabled for this vault in manual mode. | No | `true`, `false` | `false` | `true` |
| `vaults[].handleFilenameCaseSensitive` | Tells the plugin to keep LiveSync filename case handling in sync with the upstream vault setting in manual mode. | No | `true`, `false` | `false` | `false` |
| `vaults[].autoResolveConflicts` | Automatically resolves supported conflict cases conservatively. | No | `true`, `false` | `true` | `true` |
| `vaults[].notifications` | Notification settings for sync errors, conflicts, and wakeups. | No | Object | Built-in notification defaults | See below |
| `vaults[].automation` | Automation settings. Currently supports automated memify. | No | Object | Built-in automation defaults | See below |
| `vaults[].cognee` | Cognee ingestion and retrieval settings for this vault. | No | Object | Shared defaults or inherited memory-slot config | See below |

## Notification options

`vaults[].notifications` and `defaults.notifications` use the same fields.

| Option | Purpose | Required | Allowed values / range | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `notifications.sessionKey` | OpenClaw session key that receives plugin notifications. If unset, the plugin still tracks status but does not send session-targeted notifications. | No | Non-empty string | Unset | `primary-session` |
| `notifications.onError` | Emit notifications for sync and processing failures. | No | `true`, `false` | `true` | `true` |
| `notifications.onConflict` | Emit notifications when unresolved or auto-resolved conflicts are detected. | No | `true`, `false` | `true` | `true` |
| `notifications.wakeAgent` | Ask OpenClaw to wake the target agent when a notification is emitted. | No | `true`, `false` | `true` | `false` |
| `notifications.dedupeWindowSeconds` | Suppresses duplicate notifications with the same content for this many seconds. | No | Number, minimum `0` | `300` | `600` |

## Automation options

`vaults[].automation.memify` and `defaults.automation.memify` use the same fields.

| Option | Purpose | Required | Allowed values / range | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `automation.memify.enabled` | Turns automated memify on for the vault. | No | `true`, `false` | `false` | `true` |
| `automation.memify.triggers` | Which automation events can start memify. Unknown values are ignored; supported values are `heartbeat` and `cron`. | No | Array containing `heartbeat` and/or `cron` | Empty array | `['heartbeat', 'cron']` |
| `automation.memify.minIntervalSeconds` | Minimum wait time between automated memify runs. | No | Number, minimum `0` | `3600` | `1800` |
| `automation.memify.allSnapshots` | When `true`, automation reports the run as considering all snapshot files instead of only recent ones. Memify still targets the existing dataset. | No | `true`, `false` | `false` | `false` |
| `automation.memify.notifyOnStart` | Emit a notification when automated memify starts. | No | `true`, `false` | `false` | `true` |
| `automation.memify.notifyOnSuccess` | Emit a notification when automated memify succeeds. | No | `true`, `false` | `true` | `true` |
| `automation.memify.notifyOnFailure` | Emit a notification when automated memify fails. | No | `true`, `false` | `true` | `true` |

## Cognee options

`vaults[].cognee` and `defaults.cognee` use the same option names. Vault-level values override defaults. If OpenClaw uses `cognee-openclaw` as the memory slot, this plugin can also inherit shared Cognee settings from that slot.

| Option | Purpose | Required | Allowed values / range | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `cognee.enabled` | Enables Cognee upload, memify, and graph-search behavior for the vault. | No | `true`, `false` | `false` unless inherited as enabled | `true` |
| `cognee.baseUrl` | Base URL for the Cognee API. | Usually required when Cognee is enabled unless inherited from `cognee-openclaw` | Non-empty string URL | Unset unless inherited | `https://cognee.example.invalid` |
| `cognee.datasetName` | Default dataset name for this vault. Also acts as the fallback dataset when no per-agent `datasetNames` entry matches. | Usually required when Cognee is enabled unless `datasetId` or inherited mapping is enough for your setup | Non-empty string | Unset unless inherited | `team-notes` |
| `cognee.datasetNames` | Per-agent mapping from OpenClaw agent id to Cognee dataset name. This is most commonly configured on the shared `cognee-openclaw` plugin, not per vault. | No | Object mapping string keys to string values | Empty object or inherited mapping | `agent_a: team-notes` |
| `cognee.datasetId` | Explicit Cognee dataset id to use when you already know the stable id and want to bypass name lookup. | No | Non-empty string | Unset | `dataset-12345` |
| `cognee.apiKey` | Static API key sent to Cognee. | No | String | Unset | `${EXAMPLE_COGNEE_API_KEY}` |
| `cognee.apiKeyEnv` | Name of the environment variable that contains the API key. If set, it overrides `cognee.apiKey`. | No | Non-empty string | Unset | `COGNEE_API_KEY` |
| `cognee.authToken` | Static bearer-style auth token sent to Cognee. | No | String | Unset | `${EXAMPLE_COGNEE_AUTH_TOKEN}` |
| `cognee.authTokenEnv` | Name of the environment variable that contains the auth token. If set, it overrides `cognee.authToken`. | No | Non-empty string | Unset | `COGNEE_AUTH_TOKEN` |
| `cognee.username` | Basic-auth username for Cognee, if your deployment uses it. | No | String | Unset | `${COGNEE_USERNAME}` |
| `cognee.password` | Basic-auth password for Cognee, if your deployment uses it. | No | String | Unset | `${COGNEE_PASSWORD}` |
| `cognee.nodeSet` | Optional list of Cognee node types passed to add and memify requests. | No | Array of strings | Empty array | `['Note']` |
| `cognee.cognify` | Run one dataset-level `/api/v1/cognify` at the end of a sync cycle after uploads finish. | No | `true`, `false` | `true` when inherited from `cognee-openclaw`, otherwise `true` inside resolved target defaults | `true` |
| `cognee.downloadHttpLinks` | Download inline text from supported external HTTP links found in notes and add that text to snapshots. | No | `true`, `false` | `false` | `true` |
| `cognee.maxLinksPerNote` | Maximum number of HTTP links to fetch per note when `downloadHttpLinks` is enabled. | No | Number, minimum `0` | `5` | `2` |
| `cognee.maxLinkBytes` | Maximum allowed response size for fetched HTTP links. Larger responses are skipped early. | No | Number, minimum `1024` | `262144` | `65536` |
| `cognee.searchType` | Default deep-graph search mode used by this vault. | No | `GRAPH_COMPLETION`, `CHUNKS` | `CHUNKS` unless inherited as `GRAPH_COMPLETION` | `GRAPH_COMPLETION` |
| `cognee.searchTopK` | Default result count limit for Cognee search requests. | No | Number, minimum `1` | `8` | `5` |

## Common minimal setups

### Minimal recommended setup

```yaml
plugins:
  slots:
    memory: cognee-openclaw
  entries:
    cognee-openclaw:
      enabled: true
      config:
        baseUrl: https://cognee.example.invalid
        datasetName: shared-dataset
        datasetNames:
          agent_a: team-notes
          agent_b: research-notes

    obsidian-livesync-cognee:
      enabled: true
      config:
        vaults:
          - id: team-notes
            setupUri: ${OBSIDIAN_LIVESYNC_SETUP_URI}
            setupUriPassphrase: ${OBSIDIAN_LIVESYNC_SETUP_URI_PASSPHRASE}
            cognee:
              enabled: true
              datasetName: team-notes
```

### Manual-mode vault with local overrides

```yaml
plugins:
  entries:
    obsidian-livesync-cognee:
      enabled: true
      config:
        defaults:
          pollIntervalSeconds: 120
          requestTimeoutMs: 15000
          notifications:
            onError: true
            onConflict: true
            wakeAgent: false
          cognee:
            enabled: true
            baseUrl: https://cognee.example.invalid
            searchType: CHUNKS
            searchTopK: 5
        vaults:
          - id: team-notes
            url: https://couchdb.example.invalid
            database: obsidian-team-notes
            username: ${COUCHDB_USERNAME}
            password: ${COUCHDB_PASSWORD}
            passphrase: ${OBSIDIAN_VAULT_PASSPHRASE}
            usePathObfuscation: true
            includeGlobs:
              - projects/**
              - daily/**
            excludeGlobs:
              - attachments/**
            automation:
              memify:
                enabled: true
                triggers:
                  - heartbeat
                minIntervalSeconds: 1800
            cognee:
              datasetName: team-notes
              downloadHttpLinks: true
              maxLinksPerNote: 2
              maxLinkBytes: 65536
```

## Notes and edge cases

- `setupUri` and `setupUriPassphrase` must be provided together.
- In manual mode, `url` and `database` are required.
- Vault ids must be unique.
- `datasetNames` maps OpenClaw agent ids to Cognee dataset names. `cognee.datasetName` on a vault should match one of those dataset names or the shared fallback dataset.
- If both `apiKeyEnv` and `apiKey` are set, the environment-variable form wins.
- If both `authTokenEnv` and `authToken` are set, the environment-variable form wins.
- `downloadHttpLinks` is off by default. Turn it on only if you want snapshots to include fetched external text context.
- `mirrorRoot` and `snapshotRoot` are usually best left unset unless you need to move plugin-owned storage.
- Keep real setup URIs, passphrases, passwords, API keys, and auth tokens out of tracked config files.
