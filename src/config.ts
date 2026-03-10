import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import type {
  AgentToolExposureConfig,
  ResolvedCogneeTarget,
  ResolvedPluginConfig,
  ResolvedVaultConfig,
  VaultMemifyAutomationConfig,
  VaultNotificationConfig,
  VaultSyncMode,
} from "./types.js";
import { decodeSetupUri, isSetupUriFieldPresent } from "./setup-uri.js";
import {
  DEFAULT_EXPOSED_OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES,
  OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES,
} from "./tools.js";

const DEFAULT_POLL_INTERVAL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LINKS = 5;
const DEFAULT_MAX_LINK_BYTES = 256 * 1024;
const DEFAULT_SEARCH_TOP_K = 8;
const DEFAULT_NOTIFICATION_DEDUPE_WINDOW_SECONDS = 300;
const DEFAULT_MEMIFY_MIN_INTERVAL_SECONDS = 3600;

type ResolvePluginConfigOptions = {
  openclawConfig?: unknown;
};

function parseAgentToolExposure(value: unknown, label: string): AgentToolExposureConfig {
  if (value === undefined) {
    return {
      defaultExpose: [...DEFAULT_EXPOSED_OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES],
    };
  }
  const objectValue = asObject(value, label);
  const defaultExpose =
    objectValue.defaultExpose === undefined
      ? [...DEFAULT_EXPOSED_OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES]
      : readStringArray(objectValue.defaultExpose, `${label}.defaultExpose`);
  const knownToolNames = new Set<string>(OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES);
  for (const toolName of defaultExpose) {
    if (!knownToolNames.has(toolName)) {
      throw new Error(`${label}.defaultExpose contains unknown tool: ${toolName}`);
    }
  }
  return {
    defaultExpose: Array.from(new Set(defaultExpose)),
  };
}

function parseMemifyAutomation(value: unknown, label: string): VaultMemifyAutomationConfig {
  if (value === undefined) {
    return {
      enabled: false,
      triggers: [],
      minIntervalSeconds: DEFAULT_MEMIFY_MIN_INTERVAL_SECONDS,
      allSnapshots: false,
      notifyOnStart: false,
      notifyOnSuccess: true,
      notifyOnFailure: true,
    };
  }
  const objectValue = asObject(value, label);
  const triggers = readStringArray(objectValue.triggers, `${label}.triggers`).filter(
    (trigger): trigger is "heartbeat" | "cron" => trigger === "heartbeat" || trigger === "cron",
  );
  return {
    enabled: readBoolean(objectValue.enabled, true),
    triggers,
    minIntervalSeconds: readNumber(
      objectValue.minIntervalSeconds,
      `${label}.minIntervalSeconds`,
      DEFAULT_MEMIFY_MIN_INTERVAL_SECONDS,
      0,
    ),
    allSnapshots: readBoolean(objectValue.allSnapshots, false),
    notifyOnStart: readBoolean(objectValue.notifyOnStart, false),
    notifyOnSuccess: readBoolean(objectValue.notifyOnSuccess, true),
    notifyOnFailure: readBoolean(objectValue.notifyOnFailure, true),
  };
}

/**
 * The plugin config is intentionally strict because it is persisted back into
 * `plugins.entries.obsidian-livesync-cognee.config` and later round-tripped by tools.
 */

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string, required = false): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      return resolveEnvPlaceholders(trimmed);
    }
  }
  if (required) {
    throw new Error(`${label} is required`);
  }
  return undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function readNumber(value: unknown, label: string, fallback: number, min?: number): number {
  let parsed: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    parsed = value;
  } else if (typeof value === "string" && value.trim()) {
    const numeric = Number.parseFloat(value.trim());
    if (Number.isFinite(numeric)) {
      parsed = numeric;
    }
  }
  if (parsed === undefined) {
    return fallback;
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${label} must be >= ${min}`);
  }
  return parsed;
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolveEnvPlaceholders(entry.trim()))
    .filter(Boolean);
}

function readHeaders(value: unknown, label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const objectValue = asObject(value, label);
  return Object.fromEntries(
    Object.entries(objectValue)
      .filter(([, entry]) => typeof entry === "string" && entry.trim())
      .map(([key, entry]) => [key, resolveEnvPlaceholders((entry as string).trim())]),
  );
}

function resolveEnvPlaceholders(input: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? "");
}

function parseNotifications(value: unknown, label: string): VaultNotificationConfig {
  if (value === undefined) {
    return {
      onConflict: true,
      onError: true,
      wakeAgent: true,
      dedupeWindowSeconds: DEFAULT_NOTIFICATION_DEDUPE_WINDOW_SECONDS,
    };
  }
  const objectValue = asObject(value, label);
  return {
    sessionKey: readString(objectValue.sessionKey, `${label}.sessionKey`),
    onError: readBoolean(objectValue.onError, true),
    onConflict: readBoolean(objectValue.onConflict, true),
    wakeAgent: readBoolean(objectValue.wakeAgent, true),
    dedupeWindowSeconds: readNumber(
      objectValue.dedupeWindowSeconds,
      `${label}.dedupeWindowSeconds`,
      DEFAULT_NOTIFICATION_DEDUPE_WINDOW_SECONDS,
      0,
    ),
  };
}

function normalizeSyncMode(value: unknown, fallback: VaultSyncMode): VaultSyncMode {
  return value === "full" ? "full" : fallback;
}

function parseDatasetNames(value: unknown, label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const objectValue = asObject(value, label);
  return Object.fromEntries(
    Object.entries(objectValue)
      .filter(([key, entry]) => typeof key === "string" && typeof entry === "string")
      .map(([key, entry]) => [key.trim(), resolveEnvPlaceholders((entry as string).trim())])
      .filter(([key, entry]) => key.length > 0 && entry.length > 0),
  );
}

function parseMemorySlotCogneeTarget(openclawConfig: unknown): Partial<ResolvedCogneeTarget> | undefined {
  if (!openclawConfig || typeof openclawConfig !== "object" || Array.isArray(openclawConfig)) {
    return undefined;
  }
  const root = openclawConfig as Record<string, unknown>;
  const plugins =
    root.plugins && typeof root.plugins === "object" && !Array.isArray(root.plugins)
      ? (root.plugins as Record<string, unknown>)
      : undefined;
  const slots =
    plugins?.slots && typeof plugins.slots === "object" && !Array.isArray(plugins.slots)
      ? (plugins.slots as Record<string, unknown>)
      : undefined;
  if (slots?.memory !== "cognee-openclaw") {
    return undefined;
  }
  const entries =
    plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : undefined;
  const memoryEntry =
    entries?.["cognee-openclaw"] && typeof entries["cognee-openclaw"] === "object" && !Array.isArray(entries["cognee-openclaw"])
      ? (entries["cognee-openclaw"] as Record<string, unknown>)
      : undefined;
  if (!memoryEntry || memoryEntry.enabled === false) {
    return undefined;
  }
  const memoryConfig =
    memoryEntry.config && typeof memoryEntry.config === "object" && !Array.isArray(memoryEntry.config)
      ? (memoryEntry.config as Record<string, unknown>)
      : undefined;
  if (!memoryConfig) {
    return undefined;
  }

  const inheritedSearchType = readString(memoryConfig.searchType, "plugins.entries.cognee-openclaw.config.searchType");
  return {
    enabled: true,
    baseUrl: readString(memoryConfig.baseUrl, "plugins.entries.cognee-openclaw.config.baseUrl"),
    datasetName: readString(memoryConfig.datasetName, "plugins.entries.cognee-openclaw.config.datasetName"),
    datasetNames: parseDatasetNames(memoryConfig.datasetNames, "plugins.entries.cognee-openclaw.config.datasetNames"),
    apiKey: readString(memoryConfig.apiKey, "plugins.entries.cognee-openclaw.config.apiKey"),
    username: readString(memoryConfig.username, "plugins.entries.cognee-openclaw.config.username"),
    password: readString(memoryConfig.password, "plugins.entries.cognee-openclaw.config.password"),
    nodeSet: [],
    cognify: readBoolean(memoryConfig.autoCognify, true),
    downloadHttpLinks: false,
    maxLinksPerNote: DEFAULT_MAX_LINKS,
    maxLinkBytes: DEFAULT_MAX_LINK_BYTES,
    searchType: inheritedSearchType === "GRAPH_COMPLETION" ? "GRAPH_COMPLETION" : "CHUNKS",
    searchTopK: readNumber(memoryConfig.maxResults, "plugins.entries.cognee-openclaw.config.maxResults", DEFAULT_SEARCH_TOP_K, 1),
    inheritedFrom: "memory-slot",
  };
}

function parseCogneeTarget(
  value: unknown,
  label: string,
  inherited?: Partial<ResolvedCogneeTarget>,
): ResolvedCogneeTarget {
  const base: ResolvedCogneeTarget = {
    enabled: inherited?.enabled ?? false,
    baseUrl: inherited?.baseUrl,
    datasetName: inherited?.datasetName,
    datasetNames: inherited?.datasetNames ?? {},
    datasetId: inherited?.datasetId,
    apiKey: inherited?.apiKey,
    authToken: inherited?.authToken,
    username: inherited?.username,
    password: inherited?.password,
    nodeSet: inherited?.nodeSet ?? [],
    cognify: inherited?.cognify ?? true,
    downloadHttpLinks: inherited?.downloadHttpLinks ?? false,
    maxLinksPerNote: inherited?.maxLinksPerNote ?? DEFAULT_MAX_LINKS,
    maxLinkBytes: inherited?.maxLinkBytes ?? DEFAULT_MAX_LINK_BYTES,
    searchType: inherited?.searchType ?? "CHUNKS",
    searchTopK: inherited?.searchTopK ?? DEFAULT_SEARCH_TOP_K,
    inheritedFrom: inherited?.inheritedFrom,
  };
  if (value === undefined) {
    return base;
  }
  const objectValue = asObject(value, label);
  const apiKeyEnv = readString(objectValue.apiKeyEnv, `${label}.apiKeyEnv`);
  const authTokenEnv = readString(objectValue.authTokenEnv, `${label}.authTokenEnv`);
  const searchType = readString(objectValue.searchType, `${label}.searchType`) ?? base.searchType;
  if (searchType !== "GRAPH_COMPLETION" && searchType !== "CHUNKS") {
    throw new Error(`${label}.searchType must be GRAPH_COMPLETION or CHUNKS`);
  }
  return {
    enabled: readBoolean(objectValue.enabled, base.enabled),
    baseUrl: readString(objectValue.baseUrl, `${label}.baseUrl`) ?? base.baseUrl,
    datasetName: readString(objectValue.datasetName, `${label}.datasetName`) ?? base.datasetName,
    datasetNames:
      Object.keys(parseDatasetNames(objectValue.datasetNames, `${label}.datasetNames`)).length > 0
        ? parseDatasetNames(objectValue.datasetNames, `${label}.datasetNames`)
        : base.datasetNames,
    datasetId: readString(objectValue.datasetId, `${label}.datasetId`) ?? base.datasetId,
    apiKey:
      apiKeyEnv
        ? process.env[apiKeyEnv]
        : readString(objectValue.apiKey, `${label}.apiKey`) ?? base.apiKey,
    authToken: authTokenEnv
      ? process.env[authTokenEnv]
      : readString(objectValue.authToken, `${label}.authToken`) ?? base.authToken,
    username: readString(objectValue.username, `${label}.username`) ?? base.username,
    password: readString(objectValue.password, `${label}.password`) ?? base.password,
    nodeSet:
      objectValue.nodeSet === undefined ? base.nodeSet : readStringArray(objectValue.nodeSet, `${label}.nodeSet`),
    cognify: readBoolean(objectValue.cognify, base.cognify),
    downloadHttpLinks: readBoolean(objectValue.downloadHttpLinks, base.downloadHttpLinks),
    maxLinksPerNote: readNumber(
      objectValue.maxLinksPerNote,
      `${label}.maxLinksPerNote`,
      base.maxLinksPerNote,
      0,
    ),
    maxLinkBytes: readNumber(
      objectValue.maxLinkBytes,
      `${label}.maxLinkBytes`,
      base.maxLinkBytes,
      1024,
    ),
    searchType,
    searchTopK: readNumber(objectValue.searchTopK, `${label}.searchTopK`, base.searchTopK, 1),
    inheritedFrom: value === undefined ? base.inheritedFrom : "vault",
  };
}

function parseVault(
  value: unknown,
  defaults: Record<string, unknown>,
  index: number,
  inheritedCognee?: Partial<ResolvedCogneeTarget>,
): ResolvedVaultConfig {
  const label = `vaults[${index}]`;
  const objectValue = asObject(value, label);
  const id = readString(objectValue.id, `${label}.id`, true) as string;
  const setupUri = readString(objectValue.setupUri, `${label}.setupUri`);
  const setupUriPassphrase = readString(objectValue.setupUriPassphrase, `${label}.setupUriPassphrase`);
  if ((setupUri && !setupUriPassphrase) || (!setupUri && setupUriPassphrase)) {
    throw new Error(`${label}.setupUri and ${label}.setupUriPassphrase must be provided together`);
  }
  const decodedSetupUri = setupUri ? decodeSetupUri(setupUri, setupUriPassphrase as string) : undefined;
  if (decodedSetupUri) {
    const conflictingFields = [
      "url",
      "database",
      "username",
      "password",
      "passphrase",
      "usePathObfuscation",
      "handleFilenameCaseSensitive",
    ].filter((field) => isSetupUriFieldPresent(objectValue, field));
    if (conflictingFields.length > 0) {
      throw new Error(`${label} cannot set ${conflictingFields.join(", ")} when setupUri is used`);
    }
  }
  const url = decodedSetupUri?.url ?? (readString(objectValue.url, `${label}.url`, true) as string);
  const database = decodedSetupUri?.database ?? (readString(objectValue.database, `${label}.database`, true) as string);
  const modeRaw = readString(objectValue.mode, `${label}.mode`) ?? "read-only";
  if (modeRaw !== "read-only" && modeRaw !== "read-write") {
    throw new Error(`${label}.mode must be read-only or read-write`);
  }

  const syncMode = normalizeSyncMode(
    objectValue.syncMode ?? defaults.syncMode,
    "changes",
  );
  const notifications = parseNotifications(
    objectValue.notifications ?? defaults.notifications,
    `${label}.notifications`,
  );

  return {
    id,
    configSource: decodedSetupUri ? "setup-uri" : "manual",
    url: url.replace(/\/+$/, ""),
    database,
    username: decodedSetupUri?.username ?? readString(objectValue.username, `${label}.username`),
    password: decodedSetupUri?.password ?? readString(objectValue.password, `${label}.password`),
    headers: {
      ...readHeaders(defaults.headers, "defaults.headers"),
      ...decodedSetupUri?.headers,
      ...readHeaders(objectValue.headers, `${label}.headers`),
    },
    enabled: readBoolean(objectValue.enabled, true),
    mode: modeRaw,
    syncMode,
    pollIntervalSeconds: readNumber(
      objectValue.pollIntervalSeconds ?? defaults.pollIntervalSeconds,
      `${label}.pollIntervalSeconds`,
      DEFAULT_POLL_INTERVAL_SECONDS,
      5,
    ),
    requestTimeoutMs: readNumber(
      objectValue.requestTimeoutMs ?? defaults.requestTimeoutMs,
      `${label}.requestTimeoutMs`,
      DEFAULT_TIMEOUT_MS,
      1000,
    ),
    includeGlobs: readStringArray(objectValue.includeGlobs, `${label}.includeGlobs`),
    excludeGlobs: readStringArray(objectValue.excludeGlobs, `${label}.excludeGlobs`),
    mirrorRoot: readString(objectValue.mirrorRoot ?? defaults.mirrorRoot, `${label}.mirrorRoot`),
    snapshotRoot: readString(
      objectValue.snapshotRoot ?? defaults.snapshotRoot,
      `${label}.snapshotRoot`,
    ),
    encrypt:
      decodedSetupUri?.encrypt ??
      Boolean(readString(objectValue.passphrase, `${label}.passphrase`) || readBoolean(objectValue.usePathObfuscation, false)),
    passphrase: decodedSetupUri?.passphrase ?? readString(objectValue.passphrase, `${label}.passphrase`),
    usePathObfuscation: decodedSetupUri?.usePathObfuscation ?? readBoolean(objectValue.usePathObfuscation, false),
    handleFilenameCaseSensitive:
      decodedSetupUri?.handleFilenameCaseSensitive ?? readBoolean(objectValue.handleFilenameCaseSensitive, false),
    e2eeAlgorithm: decodedSetupUri?.e2eeAlgorithm,
    setupUriSettingVersion: decodedSetupUri?.settingVersion,
    autoResolveConflicts: readBoolean(objectValue.autoResolveConflicts, true),
    notifications,
    automation: {
      memify: parseMemifyAutomation(
        objectValue.automation && typeof objectValue.automation === "object" && !Array.isArray(objectValue.automation)
          ? (objectValue.automation as Record<string, unknown>).memify
          : undefined,
        `${label}.automation.memify`,
      ),
    },
    cognee: parseCogneeTarget(objectValue.cognee ?? defaults.cognee, `${label}.cognee`, inheritedCognee),
  };
}

export function resolvePluginConfig(input: unknown, options: ResolvePluginConfigOptions = {}): ResolvedPluginConfig {
  if (input === undefined) {
    return {
      defaults: {
        agentTools: parseAgentToolExposure(undefined, "defaults.agentTools"),
      },
      vaults: [],
    };
  }
  const objectValue = asObject(input, "plugin config");
  const defaults = objectValue.defaults ? asObject(objectValue.defaults, "defaults") : {};
  const agentTools = parseAgentToolExposure(defaults.agentTools, "defaults.agentTools");
  const inheritedCognee = parseMemorySlotCogneeTarget(options.openclawConfig);
  const vaultsValue = objectValue.vaults;
  if (!Array.isArray(vaultsValue)) {
    throw new Error("vaults must be an array");
  }
  const vaults = vaultsValue.map((vault, index) => parseVault(vault, defaults, index, inheritedCognee));
  const uniqueIds = new Set<string>();
  for (const vault of vaults) {
    if (uniqueIds.has(vault.id)) {
      throw new Error(`duplicate vault id: ${vault.id}`);
    }
    uniqueIds.add(vault.id);
  }
  return {
    defaults: {
      agentTools,
    },
    vaults,
  };
}

export const obsidianLivesyncCogneeConfigSchema: OpenClawPluginConfigSchema = {
  parse(value: unknown) {
    return resolvePluginConfig(value);
  },
  safeParse(value: unknown) {
    try {
      return { success: true, data: resolvePluginConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [
            {
              path: [],
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      };
    }
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["vaults"],
    properties: {
      defaults: {
        type: "object",
        additionalProperties: false,
        properties: {
          pollIntervalSeconds: { type: "number", minimum: 5, default: DEFAULT_POLL_INTERVAL_SECONDS },
          requestTimeoutMs: { type: "number", minimum: 1000, default: DEFAULT_TIMEOUT_MS },
          syncMode: { type: "string", enum: ["changes", "full"], default: "changes" },
          mirrorRoot: { type: "string" },
          snapshotRoot: { type: "string" },
          agentTools: {
            type: "object",
            additionalProperties: false,
            properties: {
              defaultExpose: {
                type: "array",
                items: {
                  type: "string",
                  enum: [...OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES],
                },
                default: [...DEFAULT_EXPOSED_OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES],
              },
            },
          },
          notifications: { type: "object" },
          automation: { type: "object" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          cognee: { type: "object" },
        },
      },
      vaults: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          oneOf: [
            {
              required: ["id", "url", "database"],
              not: {
                anyOf: [
                  { required: ["setupUri"] },
                  { required: ["setupUriPassphrase"] },
                ],
              },
            },
            {
              required: ["id", "setupUri", "setupUriPassphrase"],
              not: {
                anyOf: [
                  { required: ["url"] },
                  { required: ["database"] },
                  { required: ["username"] },
                  { required: ["password"] },
                  { required: ["passphrase"] },
                  { required: ["usePathObfuscation"] },
                  { required: ["handleFilenameCaseSensitive"] },
                ],
              },
            },
          ],
          properties: {
            id: { type: "string" },
            setupUri: { type: "string" },
            setupUriPassphrase: { type: "string" },
            url: { type: "string" },
            database: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            enabled: { type: "boolean", default: true },
            mode: { type: "string", enum: ["read-only", "read-write"], default: "read-only" },
            syncMode: { type: "string", enum: ["changes", "full"], default: "changes" },
            pollIntervalSeconds: { type: "number", minimum: 5 },
            requestTimeoutMs: { type: "number", minimum: 1000 },
            includeGlobs: { type: "array", items: { type: "string" } },
            excludeGlobs: { type: "array", items: { type: "string" } },
            mirrorRoot: { type: "string" },
            snapshotRoot: { type: "string" },
            passphrase: { type: "string" },
            usePathObfuscation: { type: "boolean", default: false },
            handleFilenameCaseSensitive: { type: "boolean", default: false },
            autoResolveConflicts: { type: "boolean", default: true },
            notifications: {
              type: "object",
              additionalProperties: false,
              properties: {
                sessionKey: { type: "string" },
                onError: { type: "boolean", default: true },
                onConflict: { type: "boolean", default: true },
                wakeAgent: { type: "boolean", default: true },
                dedupeWindowSeconds: {
                  type: "number",
                  minimum: 0,
                  default: DEFAULT_NOTIFICATION_DEDUPE_WINDOW_SECONDS,
                },
              },
            },
            automation: {
              type: "object",
              additionalProperties: false,
              properties: {
                memify: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    enabled: { type: "boolean", default: false },
                    triggers: {
                      type: "array",
                      items: { type: "string", enum: ["heartbeat", "cron"] },
                    },
                    minIntervalSeconds: {
                      type: "number",
                      minimum: 0,
                      default: DEFAULT_MEMIFY_MIN_INTERVAL_SECONDS,
                    },
                    allSnapshots: { type: "boolean", default: false },
                    notifyOnStart: { type: "boolean", default: false },
                    notifyOnSuccess: { type: "boolean", default: true },
                    notifyOnFailure: { type: "boolean", default: true },
                  },
                },
              },
            },
            cognee: { type: "object" },
          },
        },
      },
    },
  },
};