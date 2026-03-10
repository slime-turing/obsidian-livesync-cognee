import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { ObsidianLivesyncCogneeController } from "./controller.js";
import type { ResolvedPluginConfig } from "./types.js";

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

type ToolOptions = {
  controller: ObsidianLivesyncCogneeController;
  updateConfig: (updater: (current: Record<string, unknown>) => Record<string, unknown>) => Promise<ResolvedPluginConfig>;
};

export const INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM = "__agentId";
export const OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES = [
  "obsidian_vault_status",
  "obsidian_vault_sync",
  "obsidian_vault_read",
  "obsidian_vault_write",
  "obsidian_vault_conflicts",
  "obsidian_vault_deep_graph_search",
  "obsidian_vault_resolve_conflict",
  "obsidian_vault_memify",
  "obsidian_vault_repair_local",
  "obsidian_vault_stop_task",
  "obsidian_vault_update_config",
] as const;
export const DEFAULT_EXPOSED_OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES = [
  "obsidian_vault_deep_graph_search",
] as const;

export type ObsidianLivesyncCogneeToolName = (typeof OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES)[number];

const statusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const syncSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    vaultId: { type: "string", description: "Optional vault id to sync. Omit to sync all configured vaults." },
  },
} as const;

const readSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vaultId", "path"],
  properties: {
    vaultId: { type: "string" },
    path: { type: "string" },
  },
} as const;

const writeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vaultId", "path", "content"],
  properties: {
    vaultId: { type: "string" },
    path: { type: "string" },
    content: { type: "string" },
  },
} as const;

const conflictListSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    vaultId: { type: "string", description: "Optional vault id to filter conflicts." },
    includeResolved: { type: "boolean", description: "Include previously resolved conflicts preserved in plugin state." },
  },
} as const;

const conflictResolveSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vaultId", "path", "strategy"],
  properties: {
    vaultId: { type: "string" },
    path: { type: "string" },
    strategy: {
      type: "string",
      enum: ["keep_current", "keep_latest_mtime", "use_revision"],
    },
    winnerRev: { type: "string", description: "Required when strategy is use_revision." },
    reason: { type: "string", description: "Optional operator note explaining why this resolution was chosen." },
  },
} as const;

const memifySchema = {
  type: "object",
  additionalProperties: false,
  required: ["datasetName"],
  properties: {
    datasetName: { type: "string", description: "Cognee dataset name for the current agent context." },
    allSnapshots: { type: "boolean" },
  },
} as const;

const deepGraphSearchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "Natural-language relationship or question to explore in Cognee.",
    },
    includeAnswer: {
      type: "boolean",
      description: "When true and graph search is enabled, ask Cognee for a synthesized answer as well as raw context.",
    },
    topK: {
      type: "number",
      minimum: 1,
      maximum: 12,
      description: "Maximum number of contexts to pull back. Keep this small.",
    },
    searchType: {
      type: "string",
      enum: ["GRAPH_COMPLETION", "CHUNKS"],
      description: "Prefer GRAPH_COMPLETION for nested relationship exploration. Use CHUNKS only if graph results are empty or off-topic.",
    },
  },
} as const;

const repairSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vaultId"],
  properties: {
    vaultId: { type: "string" },
    rebuildSnapshots: { type: "boolean" },
  },
} as const;

const stopSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vaultId"],
  properties: {
    vaultId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const configUpdateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["vaultId", "patch"],
  properties: {
    vaultId: { type: "string" },
    patch: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        database: { type: "string" },
        enabled: { type: "boolean" },
        mode: { type: "string", enum: ["read-only", "read-write"] },
        syncMode: { type: "string", enum: ["changes", "full"] },
        pollIntervalSeconds: { type: "number", minimum: 5 },
        requestTimeoutMs: { type: "number", minimum: 1000 },
        includeGlobs: { type: "array", items: { type: "string" } },
        excludeGlobs: { type: "array", items: { type: "string" } },
        usePathObfuscation: { type: "boolean" },
        handleFilenameCaseSensitive: { type: "boolean" },
        autoResolveConflicts: { type: "boolean" },
        notifications: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionKey: { type: "string" },
            onError: { type: "boolean" },
            onConflict: { type: "boolean" },
            wakeAgent: { type: "boolean" },
            dedupeWindowSeconds: { type: "number", minimum: 0 },
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
                enabled: { type: "boolean" },
                triggers: {
                  type: "array",
                  items: { type: "string", enum: ["heartbeat", "cron"] },
                },
                minIntervalSeconds: { type: "number", minimum: 0 },
                allSnapshots: { type: "boolean" },
                notifyOnStart: { type: "boolean" },
                notifyOnSuccess: { type: "boolean" },
                notifyOnFailure: { type: "boolean" },
              },
            },
          },
        },
        cognee: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            baseUrl: { type: "string" },
            datasetName: { type: "string" },
            datasetId: { type: "string" },
            apiKey: { type: "string" },
            authToken: { type: "string" },
            cognify: { type: "boolean" },
            downloadHttpLinks: { type: "boolean" },
            maxLinksPerNote: { type: "number", minimum: 0 },
            maxLinkBytes: { type: "number", minimum: 256 },
            searchType: { type: "string", enum: ["CHUNKS", "INSIGHTS", "GRAPH_COMPLETION"] },
            searchTopK: { type: "number", minimum: 1, maximum: 50 },
          },
        },
      },
    },
  },
} as const;

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${key} required`);
  }
  return value.trim();
}

function readOptionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function describeParamType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function warnOnUnexpectedOptionalParamType(
  params: Record<string, unknown>,
  key: string,
  expected: string,
  toolName: string,
  logger?: { warn?: (message: string) => void },
): void {
  if (!(key in params) || params[key] === undefined) {
    return;
  }
  const value = params[key];
  const isExpected =
    (expected === "string" && typeof value === "string") ||
    (expected === "boolean" && typeof value === "boolean") ||
    (expected === "number" && typeof value === "number" && Number.isFinite(value));
  if (isExpected) {
    return;
  }
  logger?.warn?.(
    `obsidian-livesync-cognee: tool ${toolName} ignored invalid optional param ${key}; expected ${expected}, got ${describeParamType(value)}`,
  );
}

function ensureAgentCanAccessVault(
  controller: Pick<ObsidianLivesyncCogneeController, "canAgentAccessVault">,
  vaultId: string,
  agentId: string | undefined,
  toolName: string,
  logger?: { warn?: (message: string) => void },
): void {
  if (!agentId) {
    return;
  }
  if (controller.canAgentAccessVault(vaultId, agentId)) {
    return;
  }
  logger?.warn?.(
    `obsidian-livesync-cognee: tool ${toolName} denied vaultId=${vaultId} for agentId=${agentId} because the vault dataset is not mapped to the current agent context`,
  );
  throw new ToolInputError(`vault ${vaultId} is not mapped to the current agent context`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function mergeConfigPatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = deepClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const current = next[key];
      next[key] = mergeConfigPatch(
        current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {},
        value as Record<string, unknown>,
      );
      continue;
    }
    next[key] = value;
  }
  return next;
}

/**
 * Keep tool definitions thin and predictable: validate inputs, delegate to the
 * controller, and only handle config persistence here.
 */
export function createObsidianLivesyncCogneeTools(options: ToolOptions): AnyAgentTool[] {
  const { controller, updateConfig } = options;

  return [
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[0],
      label: "Obsidian Vault Status",
      description: "List configured LiveSync vaults, sync status, conflict counts, and local mirror locations.",
      parameters: statusSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const statuses = controller
          .getStatuses()
          .filter((status) => !agentId || controller.canAgentAccessVault(status.vaultId, agentId));
        return {
          content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }],
          details: statuses,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[1],
      label: "Obsidian Vault Sync",
      description: "Run an on-demand sync from one LiveSync vault or all configured vaults.",
      parameters: syncSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        warnOnUnexpectedOptionalParamType(params, "vaultId", "string", "obsidian_vault_sync", controller["logger"]);
        const vaultId = typeof params.vaultId === "string" && params.vaultId.trim() ? params.vaultId.trim() : undefined;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        let result;
        if (vaultId) {
          ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_sync", controller["logger"]);
          result = [await controller.syncVault(vaultId, { trigger: "manual", requestedBy: "tool", agentId })];
        } else if (agentId) {
          const accessibleVaultIds = controller.getAccessibleVaultIds(agentId);
          if (accessibleVaultIds.length === 0) {
            controller["logger"]?.warn?.(
              `obsidian-livesync-cognee: tool obsidian_vault_sync denied because no vaults are mapped to agentId=${agentId}`,
            );
            throw new ToolInputError("no vaults are mapped to the current agent context");
          }
          result = await Promise.all(
            accessibleVaultIds.map((accessibleVaultId) =>
              controller.syncVault(accessibleVaultId, { trigger: "manual", requestedBy: "tool", agentId }),
            ),
          );
        } else {
          result = await controller.syncAll({ trigger: "manual", requestedBy: "tool", agentId });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[2],
      label: "Obsidian Vault Read",
      description: "Read a note from a configured LiveSync vault with source metadata and extracted links.",
      parameters: readSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = readRequiredString(params, "vaultId");
        ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_read", controller["logger"]);
        const notePath = readRequiredString(params, "path");
        const note = await controller.readNote(vaultId, notePath);
        return {
          content: [{ type: "text", text: note.content }],
          details: note,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[3],
      label: "Obsidian Vault Write",
      description: "Write plain markdown/text content back to a configured read-write LiveSync vault.",
      ownerOnly: true,
      parameters: writeSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = readRequiredString(params, "vaultId");
        ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_write", controller["logger"]);
        const notePath = readRequiredString(params, "path");
        const content = readRequiredString(params, "content");
        const result = await controller.writeNote(vaultId, notePath, content);
        return {
          content: [{ type: "text", text: `Wrote ${result.path}` }],
          details: result,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[4],
      label: "Obsidian Vault Conflicts",
      description: "List unresolved remote CouchDB conflicts detected during sync.",
      parameters: conflictListSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = typeof params.vaultId === "string" && params.vaultId.trim() ? params.vaultId.trim() : undefined;
        if (vaultId) {
          ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_conflicts", controller["logger"]);
        }
        const conflicts = controller.getConflicts(vaultId, {
          includeResolved: readOptionalBoolean(params, "includeResolved"),
        }).filter((conflict) => !agentId || controller.canAgentAccessVault(conflict.vaultId, agentId));
        return {
          content: [{ type: "text", text: JSON.stringify(conflicts, null, 2) }],
          details: conflicts,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[5],
      label: "Obsidian Vault Deep Graph Search",
      description:
          "Explore the knowledge graph with bounded multi-hop retrieval. Volunteer this when the current memory is not enough for a 3-5 hop question, indirect time reasoning, delegation chains, or cross-note causality. In normal thinking, usually stop after 1-2 calls. In high-thinking mode, you may spend up to about 4 calls if each step adds a real new bridge. Stop earlier if source paths repeat, the new excerpts stop improving the chain, or you already have enough evidence to answer or abstain.",
      parameters: deepGraphSearchSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        warnOnUnexpectedOptionalParamType(params, "includeAnswer", "boolean", "obsidian_vault_deep_graph_search", controller["logger"]);
        warnOnUnexpectedOptionalParamType(params, "topK", "number", "obsidian_vault_deep_graph_search", controller["logger"]);
        warnOnUnexpectedOptionalParamType(params, "searchType", "string", "obsidian_vault_deep_graph_search", controller["logger"]);
        const query = readRequiredString(params, "query");
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const includeAnswer = readOptionalBoolean(params, "includeAnswer");
        const topK = readOptionalNumber(params, "topK");
        const searchType = readOptionalString(params, "searchType") as "GRAPH_COMPLETION" | "CHUNKS" | undefined;
        controller["logger"]?.info?.(
          `obsidian-livesync-cognee: tool obsidian_vault_deep_graph_search start query=${JSON.stringify(query)} agentId=${agentId ?? "*"} searchType=${searchType ?? "GRAPH_COMPLETION(default)"} includeAnswer=${includeAnswer === true} topK=${topK ?? "default"}`,
        );
        const results = await controller.queryCogneeMemory({
          query,
          agentId,
          includeAnswer,
          topK,
          searchTypeOverride: searchType,
        });
        const uniqueSourcePaths = Array.from(
          new Set(results.flatMap((result) => result.sources.map((source) => source.sourcePath).filter(Boolean))),
        );
        const hasGroundedAnswer = results.some((result) => result.answer?.trim());
        const guidance = {
          recommendedSearchType: searchType ?? "GRAPH_COMPLETION",
          suggestedCallBudget: {
            normalThinking: 2,
            highThinking: 4,
          },
          continueWhen: [
            "the latest result introduces a new person, project, date, time, or dependency that plausibly bridges the user's question",
            "you are missing one or two causal or temporal links needed to justify the answer",
          ],
          stopWhen: [
            "results are irrelevant to the user's question",
            "source paths repeat without adding new relationships",
            "the latest result adds facts but no meaningful new bridge toward the answer",
            "the current evidence is already enough to answer",
          ],
          recommendation:
            uniqueSourcePaths.length === 0
              ? "stop_no_relevant_results"
              : uniqueSourcePaths.length === 1 && !hasGroundedAnswer
                ? "refine_once_if_a_new_bridge_emerged_otherwise_stop"
                : hasGroundedAnswer
                  ? "answer_if_grounded_or_continue_once_to_verify_the_final_link"
                  : "continue_only_if_more_relationship_context_is_needed",
        };
        const payload = {
          query,
          uniqueSourcePaths,
          guidance,
          results,
        };
        controller["logger"]?.info?.(
          `obsidian-livesync-cognee: tool obsidian_vault_deep_graph_search done query=${JSON.stringify(query)} results=${results.length} uniqueSourcePaths=${uniqueSourcePaths.length} recommendation=${guidance.recommendation}`,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[6],
      label: "Obsidian Vault Resolve Conflict",
      description: "Resolve an unresolved remote CouchDB conflict after the user confirms which revision should win.",
      ownerOnly: true,
      parameters: conflictResolveSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = readRequiredString(params, "vaultId");
        ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_resolve_conflict", controller["logger"]);
        const notePath = readRequiredString(params, "path");
        const strategy = readRequiredString(params, "strategy") as "keep_current" | "keep_latest_mtime" | "use_revision";
        const winnerRev = typeof params.winnerRev === "string" && params.winnerRev.trim() ? params.winnerRev.trim() : undefined;
        const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
        const result = await controller.resolveConflict(vaultId, notePath, strategy, winnerRev, reason);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[7],
      label: "Obsidian Vault Memify",
      description: "Run Cognee memify for the current agent's dataset and persist the run status for later inspection.",
      ownerOnly: true,
      parameters: memifySchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        warnOnUnexpectedOptionalParamType(params, "allSnapshots", "boolean", "obsidian_vault_memify", controller["logger"]);
        const datasetName = readRequiredString(params, "datasetName");
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const matchingVaultIds = controller.findCogneeVaultIdsByDatasetName(datasetName, agentId);
        if (matchingVaultIds.length === 0) {
          throw new ToolInputError(`unknown Cognee dataset for current agent context: ${datasetName}`);
        }
        const result = await controller.memifyVault(matchingVaultIds[0] as string, {
          allSnapshots: readOptionalBoolean(params, "allSnapshots"),
          trigger: "manual",
          requestedBy: "tool",
          agentId,
        });
        const payload = {
          requestedDatasetName: datasetName,
          matchingVaultIds,
          ...result,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[8],
      label: "Obsidian Vault Repair Local",
      description: "Rebuild deleted local mirror and snapshot directories by forcing a full vault resync.",
      ownerOnly: true,
      parameters: repairSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = readRequiredString(params, "vaultId");
        ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_repair_local", controller["logger"]);
        const result = await controller.repairLocalVault(vaultId, {
          rebuildSnapshots: readOptionalBoolean(params, "rebuildSnapshots"),
          requestedBy: "tool",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[9],
      label: "Obsidian Vault Stop Task",
      description: "Cancel the active sync, memify, or repair task for one vault.",
      ownerOnly: true,
      parameters: stopSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = readRequiredString(params, "vaultId");
        ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_stop_task", controller["logger"]);
        const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
        const result = await controller.stopVaultTask(vaultId, reason);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    {
      name: OBSIDIAN_LIVESYNC_COGNEE_TOOL_NAMES[10],
      label: "Obsidian Vault Update Config",
      description: "Persist a vault config change into OpenClaw config and reload the plugin without waiting for a gateway restart.",
      ownerOnly: true,
      parameters: configUpdateSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const agentId = readOptionalString(params, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM);
        const vaultId = readRequiredString(params, "vaultId");
        ensureAgentCanAccessVault(controller, vaultId, agentId, "obsidian_vault_update_config", controller["logger"]);
        const patch = ensureObject(params.patch, "patch");
        const nextConfig = await updateConfig((current) => {
          const currentVaults = Array.isArray(current.vaults) ? deepClone(current.vaults) : [];
          const vaultIndex = currentVaults.findIndex(
            (candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).id === vaultId,
          );
          if (vaultIndex < 0) {
            throw new ToolInputError(`unknown vault in config: ${vaultId}`);
          }
          const merged = mergeConfigPatch(currentVaults[vaultIndex] as Record<string, unknown>, patch);
          currentVaults[vaultIndex] = merged;
          return {
            ...current,
            vaults: currentVaults,
          };
        });

        return {
          content: [{ type: "text", text: JSON.stringify(nextConfig, null, 2) }],
          details: nextConfig,
        };
      },
    },
  ];
}