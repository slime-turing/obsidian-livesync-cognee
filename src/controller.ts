import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { decrypt as decryptLegacy, isPathProbablyObfuscated } from "octagonal-wheels/encryption/encryption";
import {
  decrypt as decryptHkdf,
  decryptWithEphemeralSalt,
} from "octagonal-wheels/encryption/hkdf";
import { EnvHttpProxyAgent } from "undici";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type {
  CogneeMemoryResult,
  ConflictRecord,
  ConflictRevisionState,
  ControllerStateFile,
  CouchChangesResponse,
  CouchLeafDoc,
  CouchNoteDoc,
  NoteRecord,
  ResolvedPluginConfig,
  ResolvedVaultConfig,
  StoredConflictState,
  StoredMemifyRunState,
  StoredNoteState,
  StoredVaultTaskState,
  SyncRunStats,
  VaultCompactionResult,
  VaultMemifyResult,
  VaultMemifyTrigger,
  VaultPurgeOptions,
  VaultPurgeResult,
  VaultRepairResult,
  VaultRuntimeState,
  VaultStatus,
  VaultTaskKind,
  VaultTaskStopResult,
} from "./types.js";

const STATE_VERSION = 1;
const PLUGIN_DIR = path.join("plugins", "obsidian-livesync-cognee");
const AUTOMATION_TRIGGER_GRACE_MS = 1000;
const COGNEE_MUTATION_TIMEOUT_MS = 60_000;
const COGNEE_MEMIFY_TIMEOUT_MS = 1_000;
const COGNEE_MAX_UPLOAD_LINE_LENGTH = 8191;
const CHANGES_PAGE_LIMIT = 200;
const EXTERNAL_HTTP_FETCH_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const EXTERNAL_LINK_FETCH_TIMEOUT_MS = 15_000;
const ENCRYPTED_META_PREFIX = "/\\:";
const EDEN_ENCRYPTED_KEY = "h:++encrypted";
const EDEN_ENCRYPTED_KEY_HKDF = "h:++encrypted-hkdf";
const SYNC_PARAMETERS_DOC_ID = "_local/obsidian_livesync_sync_parameters";

let externalHttpProxyAgent: EnvHttpProxyAgent | undefined;

type ControllerNotifyParams = {
  sessionKey: string;
  contextKey: string;
  wakeAgent: boolean;
};

type ControllerOptions = {
  config: ResolvedPluginConfig;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  stateDir: string;
  notifySystemEvent?: (text: string, params: ControllerNotifyParams) => void;
};

type RevisionContent = {
  doc: CouchNoteDoc;
  rev: string;
  content: string | null;
  deleted: boolean;
};

type ConflictBundle = {
  current: RevisionContent;
  conflicts: RevisionContent[];
};

type CogneeMemifyRunResult = {
  memified: boolean;
  pending?: boolean;
  status?: string;
  pipelineRunId?: string;
  checkHint?: string;
};

type CogneeUploadResult = {
  uploaded: boolean;
  datasetId?: string;
};

type CogneeUploadPayload = {
  fileName: string;
  content: string;
};

type SnapshotLinkedContentFile = {
  fileName: string;
  url: string;
  contentType: string;
  content: string;
};

type OpenRevisionEntry = {
  ok?: CouchNoteDoc;
  missing?: string;
};

type SearchApiResult = {
  search_result?: string | string[] | Array<Record<string, unknown>>;
  dataset_id?: string;
  dataset_name?: string;
  id?: string;
  text?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

type DecryptedMetaProps = {
  path: string;
  mtime: number;
  ctime: number;
  size: number;
  children?: string[];
};

type CouchSyncParametersDoc = {
  _id: string;
  _rev?: string;
  type?: string;
  protocolVersion?: number;
  pbkdf2salt?: string;
};

type ActiveVaultTask = {
  state: StoredVaultTaskState;
  controller: AbortController;
};

type TaskExecutionContext = {
  signal: AbortSignal;
  state: StoredVaultTaskState;
};

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function formatUnixMsAsIso(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

/**
 * Keep the on-disk mirror deterministic so the same vault path always lands in
 * the same local file even when the remote database is case-insensitive.
 */
function normalizePathForId(input: string, caseSensitive: boolean): string {
  let value = input.replace(/^\.\//, "").replace(/\\/g, "/");
  value = value
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .reduce<string[]>((parts, segment) => {
      if (segment === "..") {
        parts.pop();
        return parts;
      }
      parts.push(segment);
      return parts;
    }, [])
    .join("/");
  if (!caseSensitive) {
    value = value.toLowerCase();
  }
  if (value.startsWith("_")) {
    value = `/${value}`;
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getExternalFetchDispatcher(): EnvHttpProxyAgent | undefined {
  if (!(
    process.env.https_proxy
    || process.env.HTTPS_PROXY
    || process.env.http_proxy
    || process.env.HTTP_PROXY
  )) {
    return undefined;
  }
  externalHttpProxyAgent ??= new EnvHttpProxyAgent();
  return externalHttpProxyAgent;
}

/**
 * LiveSync ids are path-based unless path obfuscation is enabled. Matching that
 * rule lets this plugin address the same document ids as the Obsidian client.
 */
function pathToDocumentId(vault: ResolvedVaultConfig, filePath: string): string {
  if (filePath.startsWith("f:")) {
    return filePath;
  }
  const normalized = normalizePathForId(filePath, vault.handleFilenameCaseSensitive);
  const prefixSplit = normalized.split(":", 2);
  let prefix = "";
  let body = normalized;
  if (prefixSplit[1]) {
    prefix = `${prefixSplit[0]}:`;
    body = prefixSplit[1];
  }
  if (!vault.usePathObfuscation) {
    return `${prefix}${body}`;
  }
  const hashedPassphrase = sha256(vault.passphrase ?? "");
  return `${prefix}f:${sha256(`${hashedPassphrase}:${body}`)}`;
}

function escapeFrontmatterScalar(value: string): string {
  return JSON.stringify(value);
}

function matchesGlob(glob: string, value: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "::DOUBLE_STAR::");
  const pattern = escaped.replace(/\*/g, "[^/]*").replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${pattern}$`, "i").test(value);
}

function shouldIncludePath(vault: ResolvedVaultConfig, notePath: string): boolean {
  const normalized = notePath.replace(/^\.\//, "");
  if (vault.includeGlobs.length > 0 && !vault.includeGlobs.some((glob) => matchesGlob(glob, normalized))) {
    return false;
  }
  if (vault.excludeGlobs.some((glob) => matchesGlob(glob, normalized))) {
    return false;
  }
  return true;
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "item";
}

function stripHtml(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLinkedContentFileName(index: number, sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    const host = sanitizeSegment(parsed.hostname || "link");
    const tail = sanitizeSegment(parsed.pathname.split("/").filter(Boolean).pop() || "content");
    return `${String(index + 1).padStart(4, "0")}-${host}-${tail}.md`;
  } catch {
    return `${String(index + 1).padStart(4, "0")}-${sanitizeSegment(sourceUrl)}.md`;
  }
}

function buildLinkedContentDocument(
  notePath: string,
  linked: { url: string; contentType: string; content: string },
): string {
  return ensureTrailingNewline([
    "---",
    `source_note: ${escapeFrontmatterScalar(notePath)}`,
    `source_url: ${escapeFrontmatterScalar(linked.url)}`,
    `content_type: ${escapeFrontmatterScalar(linked.contentType)}`,
    `captured_at: ${escapeFrontmatterScalar(new Date().toISOString())}`,
    "---",
    "",
    linked.content,
  ].join("\n"));
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function isInlineTextContentType(contentType: string): boolean {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("text/")) {
    return true;
  }
  return [
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/x-javascript",
    "image/svg+xml",
  ].includes(normalized) || normalized.endsWith("+json") || normalized.endsWith("+xml");
}

function extractLinks(content: string): Array<{ url: string; kind: "http" | "relative" | "wiki" }> {
  const links: Array<{ url: string; kind: "http" | "relative" | "wiki" }> = [];
  const seen = new Set<string>();
  const add = (url: string, kind: "http" | "relative" | "wiki") => {
    if (!url || seen.has(`${kind}:${url}`)) {
      return;
    }
    seen.add(`${kind}:${url}`);
    links.push({ url, kind });
  };

  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = (match[1] ?? "").trim();
    if (target.startsWith("http://") || target.startsWith("https://")) {
      add(target, "http");
    } else if (target) {
      add(target, "relative");
    }
  }

  for (const match of content.matchAll(/\bhttps?:\/\/[^\s)>]+/g)) {
    add(match[0], "http");
  }

  for (const match of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]]+)?(?:\|[^\]]+)?\]\]/g)) {
    add((match[1] ?? "").trim(), "wiki");
  }

  return links;
}

function extractFilenameHints(notePath: string): { dates: string[]; people: string[]; tokens: string[] } {
  const base = path.basename(notePath, path.extname(notePath));
  const tokens = base
    .split(/[^a-zA-Z0-9@_-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const dates = Array.from(
    new Set(
      [...base.matchAll(/\b\d{4}-\d{2}-\d{2}(?:[ T_]\d{2}[-:]\d{2}(?:[-:]\d{2})?)?\b/g)].map(
        (match) => match[0],
      ),
    ),
  );
  const people = Array.from(
    new Set(
      tokens
        .filter((token) => /^@?[A-Z][a-z]{2,}$/.test(token) || /^@[a-z0-9._-]{2,}$/i.test(token))
        .map((token) => token.replace(/^@/, "")),
    ),
  );
  return { dates, people, tokens };
}

function summarizeConflictContent(content: string | null, deleted: boolean): string {
  if (deleted) {
    return "deleted revision";
  }
  if (!content) {
    return "empty revision";
  }
  return content.replace(/\s+/g, " ").slice(0, 140);
}

function normalizeConflictComparableContent(content: string | null, deleted: boolean): string {
  return `${deleted ? "deleted" : "active"}:${(content ?? "").replace(/\r\n/g, "\n").trim()}`;
}

function findLongestLineLength(value: string): number {
  let longest = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line.length > longest) {
      longest = line.length;
    }
  }
  return longest;
}

function buildDiffPreview(baseContent: string | null, nextContent: string | null): string | undefined {
  const baseLines = (baseContent ?? "").replace(/\r\n/g, "\n").split("\n");
  const nextLines = (nextContent ?? "").replace(/\r\n/g, "\n").split("\n");
  const preview: string[] = [];
  const maxLines = Math.max(baseLines.length, nextLines.length);

  for (let index = 0; index < maxLines; index += 1) {
    const before = baseLines[index] ?? "";
    const after = nextLines[index] ?? "";
    if (before === after) {
      continue;
    }
    preview.push(`- ${before}`);
    preview.push(`+ ${after}`);
    if (preview.length >= 8) {
      break;
    }
  }

  if (preview.length === 0) {
    return undefined;
  }
  return preview.join("\n").slice(0, 600);
}

function injectVersionMetadata(
  snapshotMarkdown: string,
  metadata: {
    previousRevision: string;
    sourceRevision: string;
    changeType: "modified" | "deleted";
  },
): string {
  const lines = snapshotMarkdown.split("\n");
  const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line === "---");
  if (frontmatterEnd <= 0) {
    return snapshotMarkdown;
  }

  const insertAt = lines.findIndex((line) => line.startsWith("source_deleted:"));
  const metadataLines = [
    `previous_revision: ${escapeFrontmatterScalar(metadata.previousRevision)}`,
    `change_type: ${escapeFrontmatterScalar(metadata.changeType)}`,
    `version_document_for_revision: ${escapeFrontmatterScalar(metadata.sourceRevision)}`,
  ];

  if (insertAt > 0) {
    lines.splice(insertAt, 0, ...metadataLines);
  } else {
    lines.splice(frontmatterEnd, 0, ...metadataLines);
  }
  return ensureTrailingNewline(lines.join("\n"));
}

function createIdleMemifyState(allSnapshots: boolean): StoredMemifyRunState {
  return {
    status: "idle",
    allSnapshots,
    snapshotsConsidered: 0,
    memified: false,
  };
}

function extractSourcePathFromContext(excerpt: string): string | undefined {
  const match = excerpt.match(/source_path:\s*(?:"([^"]+)"|([^\n]+))/i);
  const value = (match?.[1] ?? match?.[2] ?? "").trim();
  return value || undefined;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function collectFiles(root: string, extension: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return collectFiles(fullPath, extension);
        }
        return fullPath.endsWith(extension) ? [fullPath] : [];
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

/**
 * The controller owns the full integration lifecycle: remote polling, local
 * mirrors, conflict tracking, and Cognee retrieval. Tools stay thin by routing
 * everything through this class.
 */
export class ObsidianLivesyncCogneeController {
  private config: ResolvedPluginConfig;
  private readonly logger: PluginLogger;
  private readonly resolvePath: (input: string) => string;
  private readonly baseStateDir: string;
  private readonly stateFilePath: string;
  private readonly notifySystemEvent?: (text: string, params: ControllerNotifyParams) => void;
  private state: ControllerStateFile = { version: STATE_VERSION, vaults: {} };
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<SyncRunStats>>();
  private readonly memifyInFlight = new Map<string, Promise<VaultMemifyResult>>();
  private readonly automationTriggerInFlight = new Map<string, Promise<void>>();
  private readonly vaultOperationTails = new Map<string, Promise<void>>();
  private readonly cogneeAuthTokens = new Map<string, string>();
  private readonly cogneeLoginInFlight = new Map<string, Promise<string>>();
  private readonly activeTasks = new Map<string, ActiveVaultTask>();
  private readonly replicationSaltCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private initialized = false;

  constructor(options: ControllerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.resolvePath = options.resolvePath;
    this.baseStateDir = path.join(options.stateDir, PLUGIN_DIR);
    this.stateFilePath = path.join(this.baseStateDir, "state.json");
    this.notifySystemEvent = options.notifySystemEvent;
  }

  async ensureReady(): Promise<void> {
    await this.initialise();
  }

  async initialise(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(this.baseStateDir, { recursive: true });
    this.state = await readJsonFile<ControllerStateFile>(this.stateFilePath, {
      version: STATE_VERSION,
      vaults: {},
    });
    if (this.state.version !== STATE_VERSION) {
      this.state = { version: STATE_VERSION, vaults: {} };
    }
    this.initialized = true;
  }

  async start(): Promise<void> {
    await this.initialise();
    this.configureTimers();
  }

  async stop(): Promise<void> {
    for (const vaultId of this.activeTasks.keys()) {
      await this.stopVaultTask(vaultId, "Controller shutdown requested");
    }
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    await this.writeState();
  }

  async reloadConfig(config: ResolvedPluginConfig): Promise<void> {
    this.config = config;
    await this.stop();
    this.configureTimers();
  }

  getStatuses(): VaultStatus[] {
    return this.config.vaults.map((vault) => {
      const runtime = this.ensureVaultState(vault.id);
      return {
        vaultId: vault.id,
        enabled: vault.enabled,
        mode: vault.mode,
        syncMode: vault.syncMode,
        lastSeq: runtime.lastSeq,
        lastSyncAt: runtime.lastSyncAt,
        lastError: runtime.lastError,
        noteCount: Object.values(runtime.notes).filter((note) => !note.deleted).length,
        openConflictCount: Object.keys(runtime.conflicts).length,
        mirrorRoot: this.resolveMirrorRoot(vault),
        snapshotRoot: this.resolveSnapshotRoot(vault),
        cogneeEnabled: vault.cognee.enabled && Boolean(vault.cognee.baseUrl),
        notifySessionKey: vault.notifications.sessionKey,
        memify: runtime.memify ?? createIdleMemifyState(vault.automation.memify.allSnapshots),
        currentTask: runtime.currentTask,
        lastTask: runtime.lastTask,
      };
    });
  }

  async stopVaultTask(vaultId: string, reason = "User requested stop"): Promise<VaultTaskStopResult> {
    await this.initialise();
    const activeTask = this.activeTasks.get(vaultId);
    const runtime = this.ensureVaultState(vaultId);
    if (!activeTask) {
      return {
        vaultId,
        stopped: false,
        task: runtime.currentTask,
      };
    }

    const cancellingState: StoredVaultTaskState = {
      ...activeTask.state,
      status: "cancelling",
      cancelRequestedAt: new Date().toISOString(),
      cancelReason: reason,
    };
    activeTask.state = cancellingState;
    runtime.currentTask = cancellingState;
    await this.writeState();
    activeTask.controller.abort(new Error(reason));
    return {
      vaultId,
      stopped: true,
      task: cancellingState,
    };
  }

  getConflicts(vaultId?: string, options: { includeResolved?: boolean } = {}): ConflictRecord[] {
    const vaults = vaultId ? [this.requireVault(vaultId)] : this.config.vaults;
    return vaults.flatMap((vault) => {
      const runtime = this.ensureVaultState(vault.id);
      const conflicts = Object.values(runtime.conflicts);
      const resolvedConflicts = options.includeResolved ? Object.values(runtime.resolvedConflicts ?? {}) : [];
      return [...conflicts, ...resolvedConflicts].map((conflict) => ({
        vaultId: vault.id,
        path: conflict.path,
        docId: conflict.docId,
        winnerRev: conflict.winnerRev,
        revisions: conflict.revisions,
        detectedAt: conflict.detectedAt,
        resolution: conflict.resolution,
        resolutionReason: conflict.resolutionReason,
        resolvedAt: conflict.resolvedAt,
      }));
    });
  }

  getAccessibleVaultIds(agentId?: string): string[] {
    return this.config.vaults
      .filter((vault) => this.isVaultAccessibleToAgent(vault, agentId))
      .map((vault) => vault.id);
  }

  canAgentAccessVault(vaultId: string, agentId?: string): boolean {
    const vault = this.requireVault(vaultId);
    return this.isVaultAccessibleToAgent(vault, agentId);
  }

  async syncAll(options: {
    trigger?: "timer" | "manual";
    requestedBy?: "tool" | "cli" | "automation" | "service";
    agentId?: string;
  } = {}): Promise<SyncRunStats[]> {
    const results: SyncRunStats[] = [];
    for (const vault of this.config.vaults) {
      if (!vault.enabled) {
        continue;
      }
      results.push(await this.syncVault(vault.id, options));
    }
    return results;
  }

  async syncVault(
    vaultId: string,
    options: {
      forceFull?: boolean;
      trigger?: "timer" | "manual";
      requestedBy?: "tool" | "cli" | "automation" | "service";
      agentId?: string;
    } = {},
  ): Promise<SyncRunStats> {
    await this.initialise();
    await this.preemptBackgroundTaskForManualRun(vaultId, "sync", options.requestedBy);
    const existing = this.inFlight.get(vaultId);
    if (existing) {
      return existing;
    }
    const run = this.runExclusive(vaultId, async () => {
      const task = this.beginVaultTask(vaultId, "sync", {
        trigger: options.trigger ?? "manual",
        requestedBy: options.requestedBy ?? "tool",
      });
      await this.writeState();
      try {
        const stats = await this.syncVaultInternal(vaultId, options, task);
        await this.finishVaultTask(vaultId, task.state, { status: "succeeded" });
        return stats;
      } catch (error) {
        const cancelled = task.signal.aborted || this.isCancellationError(error);
        await this.finishVaultTask(vaultId, task.state, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
          cancelReason: cancelled ? task.signal.reason instanceof Error ? task.signal.reason.message : String(task.signal.reason ?? "Task cancelled") : undefined,
        });
        throw error;
      }
    }).finally(() => {
      this.inFlight.delete(vaultId);
    });
    this.inFlight.set(vaultId, run);
    return run;
  }

  async readNote(vaultId: string, notePath: string): Promise<NoteRecord> {
    await this.initialise();
    const vault = this.requireVault(vaultId);
    const runtime = this.ensureVaultState(vaultId);
    const content = await this.fetchNoteContentByPath(vault, notePath, runtime.notes[notePath]?.docId);
    const mirrorPath = this.resolveMirrorPath(vault, notePath);
    const links = extractLinks(content.content);
    return {
      vaultId,
      path: notePath,
      content: content.content,
      mirrorPath,
      snapshotPath: runtime.notes[notePath]?.lastSnapshotPath,
      exists: !content.deleted,
      mtime: content.doc.mtime,
      ctime: content.doc.ctime,
      rev: content.doc._rev,
      filenameHints: extractFilenameHints(notePath),
      links,
    };
  }

  async writeNote(vaultId: string, notePath: string, content: string): Promise<{ path: string; rev?: string }> {
    await this.initialise();
    return this.runExclusive(vaultId, async () => {
      const vault = this.requireVault(vaultId);
      this.assertVaultWritebackCompatible(vault, vaultId);

      const docId = pathToDocumentId(vault, notePath);
      const existing = await this.tryGetDoc(vault, docId);
      const now = Date.now();
      const normalizedContent = ensureTrailingNewline(content);
      const payload: CouchNoteDoc = {
        _id: docId,
        _rev: existing?._rev,
        path: notePath,
        type: "plain",
        datatype: "plain",
        data: [normalizedContent],
        mtime: now,
        ctime: existing?.ctime ?? now,
        size: Buffer.byteLength(normalizedContent, "utf8"),
        children: [],
        eden: {},
      };
      const response = await this.fetchJson<{ ok: boolean; rev?: string }>(vault, `/${encodeURIComponent(docId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

      const runtime = this.ensureVaultState(vaultId);
      runtime.notes[notePath] = {
        path: notePath,
        docId,
        rev: response.rev,
        ctime: existing?.ctime ?? now,
        mtime: now,
        deleted: false,
        lastSyncedAt: new Date().toISOString(),
        lastSnapshotPath: runtime.notes[notePath]?.lastSnapshotPath,
      };
      await this.writeMirror(vault, notePath, normalizedContent, false);
      await this.writeState();
      return { path: notePath, rev: response.rev };
    });
  }

  async resolveConflict(
    vaultId: string,
    notePath: string,
    strategy: "keep_current" | "keep_latest_mtime" | "use_revision",
    winnerRev?: string,
    resolutionReason?: string,
  ): Promise<{ path: string; strategy: string; resolvedRev?: string; resolutionReason?: string }> {
    await this.initialise();
    return this.runExclusive(vaultId, async () => {
      const vault = this.requireVault(vaultId);
      this.assertVaultWritebackCompatible(vault, vaultId);
      const currentDoc = await this.fetchConflictProbeByPath(
        vault,
        notePath,
        this.ensureVaultState(vaultId).notes[notePath]?.docId,
      );
      const bundle = await this.fetchConflictBundle(vault, currentDoc);
      if (!bundle || bundle.conflicts.length === 0) {
        throw new Error(`no open conflict found for ${notePath}`);
      }

      const chosen = this.chooseConflictWinner(bundle, strategy, winnerRev);
      if (chosen.deleted) {
        throw new Error("resolving to a deleted revision is not supported by this plugin yet");
      }
      if (chosen.content === null) {
        throw new Error("selected conflict revision uses unsupported encoding");
      }

      let resolvedRev = bundle.current.rev;
      const normalizedContent = ensureTrailingNewline(chosen.content);
      if (strategy !== "keep_current" || chosen.rev !== bundle.current.rev) {
        const payload: CouchNoteDoc = {
          _id: bundle.current.doc._id,
          _rev: bundle.current.doc._rev,
          path: bundle.current.doc.path,
          type: "plain",
          datatype: "plain",
          data: [normalizedContent],
          mtime: Date.now(),
          ctime: bundle.current.doc.ctime ?? Date.now(),
          size: Buffer.byteLength(normalizedContent, "utf8"),
          children: [],
          eden: {},
        };
        const writeResult = await this.fetchJson<{ ok: boolean; rev?: string }>(
          vault,
          `/${encodeURIComponent(bundle.current.doc._id)}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
          },
        );
        resolvedRev = writeResult.rev ?? resolvedRev;
        await this.writeMirror(vault, notePath, normalizedContent, false);
        const snapshotPath = await this.writeSnapshot(vault, notePath, {
          deleted: false,
          content: normalizedContent,
          doc: { ...bundle.current.doc, _rev: resolvedRev, mtime: Date.now() },
          links: extractLinks(normalizedContent),
          linkedContent: [],
        });
        this.ensureVaultState(vaultId).notes[notePath] = {
          path: notePath,
          docId: bundle.current.doc._id,
          rev: resolvedRev,
          ctime: bundle.current.doc.ctime,
          mtime: Date.now(),
          deleted: false,
          lastSnapshotPath: snapshotPath,
          lastSyncedAt: new Date().toISOString(),
        };
      }

      await this.deleteConflictRevisions(vault, bundle.current.doc._id, bundle.conflicts.map((entry) => entry.rev));
      const runtime = this.ensureVaultState(vaultId);
      const existingConflict = runtime.conflicts[notePath] ?? this.buildConflictState(currentDoc, bundle);
      runtime.resolvedConflicts ??= {};
      runtime.resolvedConflicts[notePath] = {
        ...existingConflict,
        winnerRev: resolvedRev,
        resolution: strategy,
        resolutionReason,
        resolvedAt: new Date().toISOString(),
      };
      delete runtime.conflicts[notePath];
      await this.writeState();
      return { path: notePath, strategy, resolvedRev, resolutionReason };
    });
  }

  async handleAutomationTrigger(params: {
    trigger: VaultMemifyTrigger;
    agentId?: string;
    sessionKey?: string;
  }): Promise<void> {
    await this.initialise();
    if (!params.agentId) {
      this.logger.warn(
        `obsidian-livesync-cognee: skipped ${params.trigger} automation because the trigger did not include an agentId`,
      );
      return;
    }
    for (const vault of this.config.vaults) {
      // Heartbeat and cron can both target the same vault nearly at once.
      // Collapse that overlap before another memify run gets scheduled.
      const existing = this.automationTriggerInFlight.get(vault.id);
      if (existing) {
        await existing;
        continue;
      }

      const observedAt = Date.now();
      const automation = vault.automation.memify;
      if (!vault.enabled || !automation.enabled || !automation.triggers.includes(params.trigger)) {
        continue;
      }
      if (!this.isVaultAccessibleToAgent(vault, params.agentId)) {
        this.logger.warn(
          `obsidian-livesync-cognee: skipped ${params.trigger} automation for vault=${vault.id} because agentId=${params.agentId} is not mapped to that vault's Cognee dataset context`,
        );
        continue;
      }
      const runtime = this.ensureVaultState(vault.id);
      const lastRunAt = runtime.memify?.finishedAt ?? runtime.memify?.startedAt;
      if (automation.minIntervalSeconds > 0 && lastRunAt) {
        const elapsedMs = Date.now() - Date.parse(lastRunAt);
        if (Number.isFinite(elapsedMs) && elapsedMs < automation.minIntervalSeconds * 1000) {
            this.logger.warn(
              `obsidian-livesync-cognee: skipped ${params.trigger} automation for vault=${vault.id} because the previous memify run finished ${elapsedMs}ms ago, below minIntervalSeconds=${automation.minIntervalSeconds}`,
            );
          continue;
        }
      }
      if (lastRunAt) {
        const elapsedMs = Date.now() - Date.parse(lastRunAt);
        if (Number.isFinite(elapsedMs) && elapsedMs < Math.max(automation.minIntervalSeconds * 1000, AUTOMATION_TRIGGER_GRACE_MS)) {
            this.logger.warn(
              `obsidian-livesync-cognee: skipped ${params.trigger} automation for vault=${vault.id} because the previous memify run finished ${elapsedMs}ms ago, below graceWindowMs=${Math.max(automation.minIntervalSeconds * 1000, AUTOMATION_TRIGGER_GRACE_MS)}`,
            );
          continue;
        }
      }
      const run = this.memifyVault(vault.id, {
        allSnapshots: automation.allSnapshots,
        trigger: params.trigger,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        automated: true,
        observedAt,
        requestedBy: "automation",
      })
        .then(() => undefined)
        .finally(() => {
          if (this.automationTriggerInFlight.get(vault.id) === run) {
            this.automationTriggerInFlight.delete(vault.id);
          }
        });
      this.automationTriggerInFlight.set(vault.id, run);
      await run;
    }
  }

  async queryCogneeMemory(params: {
    query: string;
    vaultId?: string;
    includeAnswer?: boolean;
    topK?: number;
    agentId?: string;
    searchTypeOverride?: "GRAPH_COMPLETION" | "CHUNKS";
  }): Promise<CogneeMemoryResult[]> {
    await this.initialise();
    this.logger.debug?.(
      `obsidian-livesync-cognee: queryCogneeMemory start query=${JSON.stringify(params.query)} vaultId=${params.vaultId ?? "*"} searchType=${params.searchTypeOverride ?? "default"} includeAnswer=${params.includeAnswer === true} topK=${params.topK ?? "default"}`,
    );
    const vaults = this.resolveQueryCogneeVaults(params.vaultId, params.agentId);
    const results: CogneeMemoryResult[] = [];

    if (vaults.length === 0) {
      this.logger.warn(
        `obsidian-livesync-cognee: queryCogneeMemory skipped because no Cognee-mapped vault matched vaultId=${params.vaultId ?? "*"} agentId=${params.agentId ?? "*"}`,
      );
      return results;
    }

    for (const vault of vaults) {
      if (!vault.cognee.enabled || !vault.cognee.baseUrl) {
        this.logger.warn(`obsidian-livesync-cognee: queryCogneeMemory skipped vault=${vault.id} because Cognee is disabled or baseUrl is missing`);
        continue;
      }
      const target = this.resolveEffectiveCogneeTarget(vault, params.agentId);
      if (!this.hasResolvableCogneeDatasetTarget(target)) {
        this.logger.warn(
          `obsidian-livesync-cognee: queryCogneeMemory skipped vault=${vault.id} because no datasetName or datasetId resolved for agentId=${params.agentId ?? "*"}`,
        );
        continue;
      }
      const effectiveSearchType = params.searchTypeOverride ?? target.searchType;
      const searchSelector = await this.resolveCogneeSearchSelector(vault, target);
      const rawResponse = await this.runCogneeSearchRequest(target, vault, {
        query: params.query,
        searchType: effectiveSearchType,
        topK: params.topK ?? target.searchTopK,
        onlyContext: true,
        selector: searchSelector,
      });
      const raw = this.normalizeCogneeSearchResponse(rawResponse, target, searchSelector);

      let answer: string | undefined;
      if (params.includeAnswer && effectiveSearchType === "GRAPH_COMPLETION") {
        const answerResponse = await this.runCogneeSearchRequest(target, vault, {
          query: params.query,
          searchType: effectiveSearchType,
          topK: params.topK ?? target.searchTopK,
          onlyContext: false,
          selector: searchSelector,
        });
        const answerPayload = this.normalizeCogneeSearchResponse(answerResponse, target, searchSelector);
        answer = answerPayload
          .flatMap((entry) => {
            const value = entry.search_result;
            return Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
          })
          .join("\n\n")
          .trim();
      }

      const sources = raw.flatMap((entry) => {
        const value = entry.search_result;
        const items = Array.isArray(value)
          ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
          : value
            ? [String(value)]
            : [];
        return items.map((item) => ({
          sourcePath: extractSourcePathFromContext(item),
          excerpt: item.slice(0, 1200),
          datasetName: entry.dataset_name,
          datasetId: entry.dataset_id,
        }));
      });

      results.push({
        vaultId: vault.id,
        datasetName: raw[0]?.dataset_name ?? target.datasetName,
        datasetId: raw[0]?.dataset_id ?? target.datasetId,
        answer,
        sources,
        raw,
      });

      this.logger.debug?.(
        `obsidian-livesync-cognee: queryCogneeMemory result vault=${vault.id} searchType=${effectiveSearchType} sources=${sources.length} uniqueSources=${new Set(sources.map((source) => source.sourcePath).filter(Boolean)).size} answer=${answer ? "yes" : "no"}`,
      );
    }

    this.logger.debug?.(`obsidian-livesync-cognee: queryCogneeMemory done vaults=${results.length}`);

    return results;
  }

  private async resolveCogneeSearchSelector(
    vault: ResolvedVaultConfig,
    target: ResolvedVaultConfig["cognee"],
  ): Promise<{ datasetId?: string; datasetName?: string }> {
    if (target.datasetId) {
      return { datasetId: target.datasetId, datasetName: target.datasetName };
    }
    const datasetName = target.datasetName;
    if (!datasetName) {
      return {};
    }
    const dataset = await this.resolveCogneeDataset(vault, target).catch(() => undefined);
    return {
      datasetId: dataset?.id,
      datasetName,
    };
  }

  private async runCogneeSearchRequest(
    target: ResolvedVaultConfig["cognee"],
    vault: ResolvedVaultConfig,
    params: {
      query: string;
      searchType: string;
      topK: number;
      onlyContext: boolean;
      selector: { datasetId?: string; datasetName?: string };
    },
  ): Promise<unknown> {
    const requestBodies = this.buildCogneeSearchBodies(params);
    let lastError: unknown;
    for (const body of requestBodies) {
      try {
        return await this.fetchCogneeJson<unknown>(
          target,
          "/api/v1/search",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          vault.requestTimeoutMs,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildCogneeSearchBodies(params: {
    query: string;
    searchType: string;
    topK: number;
    onlyContext: boolean;
    selector: { datasetId?: string; datasetName?: string };
  }): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    const datasetIds = params.selector.datasetId ? [params.selector.datasetId] : undefined;
    const datasets = !datasetIds && params.selector.datasetName ? [params.selector.datasetName] : undefined;

    bodies.push({
      ...(datasetIds ? { dataset_ids: datasetIds } : {}),
      ...(datasets ? { datasets } : {}),
      query: params.query,
      search_type: params.searchType,
      top_k: params.topK,
      only_context: params.onlyContext,
      verbose: true,
    });

    bodies.push({
      ...(datasetIds ? { datasetIds } : {}),
      ...(datasets ? { datasets } : {}),
      queryText: params.query,
      searchType: params.searchType,
      max_tokens: params.topK,
      onlyContext: params.onlyContext,
    });

    bodies.push({
      ...(datasetIds ? { datasetIds } : {}),
      ...(datasets ? { datasetNames: datasets } : {}),
      query: params.query,
      searchType: params.searchType,
      topK: params.topK,
      onlyContext: params.onlyContext,
    });

    return bodies.filter((body, index, list) => index === list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(body)));
  }

  private normalizeCogneeSearchResponse(
    response: unknown,
    target: ResolvedVaultConfig["cognee"],
    selector: { datasetId?: string; datasetName?: string },
  ): SearchApiResult[] {
    const normalized = this.unwrapCogneeSearchResponse(response);
    if (!Array.isArray(normalized)) {
      return [];
    }
    return normalized.map((entry, index) => {
      if (typeof entry === "string") {
        return {
          id: `result-${index}`,
          text: entry,
          search_result: entry,
          dataset_id: selector.datasetId ?? target.datasetId,
          dataset_name: selector.datasetName ?? target.datasetName,
        };
      }
      if (!entry || typeof entry !== "object") {
        const value = String(entry);
        return {
          id: `result-${index}`,
          text: value,
          search_result: value,
          dataset_id: selector.datasetId ?? target.datasetId,
          dataset_name: selector.datasetName ?? target.datasetName,
        };
      }
      const record = entry as SearchApiResult & { results?: unknown };
      if (record.search_result !== undefined) {
        return {
          ...record,
          dataset_id: record.dataset_id ?? selector.datasetId ?? target.datasetId,
          dataset_name: record.dataset_name ?? selector.datasetName ?? target.datasetName,
        };
      }
      const text = typeof record.text === "string" ? record.text : JSON.stringify(record);
      return {
        ...record,
        text,
        search_result: text,
        dataset_id: record.dataset_id ?? selector.datasetId ?? target.datasetId,
        dataset_name: record.dataset_name ?? selector.datasetName ?? target.datasetName,
      };
    });
  }

  private unwrapCogneeSearchResponse(response: unknown): unknown {
    if (Array.isArray(response)) {
      return response;
    }
    if (!response || typeof response !== "object") {
      return [];
    }
    const record = response as { results?: unknown; data?: unknown; search_results?: unknown };
    if (record.results !== undefined) {
      return this.unwrapCogneeSearchResponse(record.results);
    }
    if (record.data !== undefined) {
      return this.unwrapCogneeSearchResponse(record.data);
    }
    if (record.search_results !== undefined) {
      return this.unwrapCogneeSearchResponse(record.search_results);
    }
    return [response];
  }

  async compactVault(vaultId: string): Promise<VaultCompactionResult> {
    await this.initialise();
    const vault = this.requireVault(vaultId);
    const response = await this.fetchJson<{ ok?: boolean }>(vault, "/_compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return {
      vaultId,
      accepted: response.ok === true,
    };
  }

  async memifyVault(
    vaultId: string,
    options: {
      allSnapshots?: boolean;
      trigger?: "manual" | VaultMemifyTrigger;
      agentId?: string;
      sessionKey?: string;
      automated?: boolean;
      observedAt?: number;
      requestedBy?: "tool" | "cli" | "automation" | "service";
    } = {},
  ): Promise<VaultMemifyResult> {
    await this.initialise();
    const existing = this.memifyInFlight.get(vaultId);
    if (existing) {
      return existing;
    }
    const run = this.runExclusive(vaultId, async () => {
      const task = this.beginVaultTask(vaultId, "memify", {
        trigger: options.trigger ?? "manual",
        requestedBy: options.requestedBy ?? (options.automated ? "automation" : "tool"),
      });
      await this.writeState();
      try {
        const result = await this.memifyVaultInternal(vaultId, options, task);
        await this.finishVaultTask(vaultId, task.state, { status: "succeeded" });
        return result;
      } catch (error) {
        const cancelled = task.signal.aborted || this.isCancellationError(error);
        await this.finishVaultTask(vaultId, task.state, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
          cancelReason: cancelled ? task.signal.reason instanceof Error ? task.signal.reason.message : String(task.signal.reason ?? "Task cancelled") : undefined,
        });
        throw error;
      }
    }).finally(() => {
      this.memifyInFlight.delete(vaultId);
    });
    this.memifyInFlight.set(vaultId, run);
    return run;
  }

  findCogneeVaultIdsByDatasetName(datasetName: string, agentId?: string): string[] {
    const normalizedDatasetName = datasetName.trim();
    if (!normalizedDatasetName) {
      return [];
    }
    return this.config.vaults
      .filter((vault) => vault.enabled && vault.cognee.enabled && vault.cognee.baseUrl)
      .filter((vault) => this.resolveEffectiveCogneeTarget(vault, agentId).datasetName === normalizedDatasetName)
      .map((vault) => vault.id);
  }

  private async memifyVaultInternal(
    vaultId: string,
    options: {
      allSnapshots?: boolean;
      trigger?: "manual" | VaultMemifyTrigger;
      agentId?: string;
      sessionKey?: string;
      automated?: boolean;
      observedAt?: number;
      requestedBy?: "tool" | "cli" | "automation" | "service";
    },
    task: TaskExecutionContext,
  ): Promise<VaultMemifyResult> {
    const vault = this.requireVault(vaultId);
    if (!vault.cognee.enabled || !vault.cognee.baseUrl) {
      throw new Error(`vault ${vaultId} does not have Cognee enabled`);
    }
    const target = this.resolveEffectiveCogneeTarget(vault, options.agentId);

    const runtime = this.ensureVaultState(vaultId);
    const lastRunAt = runtime.memify?.finishedAt ?? runtime.memify?.startedAt;
    if (options.automated && options.observedAt && lastRunAt) {
      const lastRunAtMs = Date.parse(lastRunAt);
      if (Number.isFinite(lastRunAtMs) && lastRunAtMs >= options.observedAt) {
        return {
          vaultId,
          snapshotsConsidered: runtime.memify?.snapshotsConsidered ?? 0,
          memified: runtime.memify?.memified ?? false,
          datasetId: target.datasetId,
          datasetName: target.datasetName,
        };
      }
    }
    const allSnapshots = Boolean(options.allSnapshots);
    runtime.memify = {
      status: "running",
      trigger: options.trigger ?? "manual",
      agentId: options.agentId,
      sessionKey: options.sessionKey,
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      allSnapshots,
      snapshotsConsidered: 0,
      memified: false,
      error: undefined,
    };
    await this.writeState();

    const automation = vault.automation.memify;
    if (options.automated && automation.notifyOnStart) {
      this.notifyMemify(
        vault,
        `Vault ${vault.id}: started ${options.trigger ?? "manual"} memify run.`,
        options.sessionKey,
        `vault:${vault.id}:memify:start`,
      );
    }

    try {
      this.throwIfCancelled(task.signal);
      const snapshotPaths = allSnapshots
        ? await collectFiles(this.resolveSnapshotRoot(vault), ".md")
        : Array.from(
            new Set(
              Object.values(runtime.notes)
                .map((note) => note.lastSnapshotPath)
                .filter((entry): entry is string => Boolean(entry)),
            ),
          );

      runtime.memify = {
        ...runtime.memify,
        snapshotsConsidered: snapshotPaths.length,
      };
      await this.writeState();

      this.throwIfCancelled(task.signal);
      const memifyResult = snapshotPaths.length > 0
        ? await this.runCogneeMemify(vault, target, task.signal)
        : { memified: false };
      runtime.memify = {
        ...runtime.memify,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        snapshotsConsidered: snapshotPaths.length,
        memified: memifyResult.memified,
      };
      await this.writeState();
      if (options.automated && automation.notifyOnSuccess) {
        const memifySummary = memifyResult.pending
          ? `queued a background Cognee memify run${memifyResult.pipelineRunId ? ` (${memifyResult.pipelineRunId})` : ""}`
          : memifyResult.memified
            ? "ran Cognee memify"
            : "skipped memify because no snapshots were staged locally";
        this.notifyMemify(
          vault,
          `Vault ${vault.id}: ${options.trigger ?? "manual"} memify run finished. Considered ${snapshotPaths.length} local snapshots and ${memifySummary}.`,
          options.sessionKey,
          `vault:${vault.id}:memify:success`,
        );
      }
      return {
        vaultId,
        snapshotsConsidered: snapshotPaths.length,
        memified: memifyResult.memified,
        pending: memifyResult.pending,
        status: memifyResult.status,
        pipelineRunId: memifyResult.pipelineRunId,
        checkHint: memifyResult.checkHint,
        datasetId: target.datasetId,
        datasetName: target.datasetName,
      };
    } catch (error) {
      runtime.memify = {
        ...runtime.memify,
        status: this.isCancellationError(error) ? "idle" : "failed",
        finishedAt: new Date().toISOString(),
        error: this.isCancellationError(error) ? undefined : error instanceof Error ? error.message : String(error),
      };
      await this.writeState();
      if (!this.isCancellationError(error) && options.automated && automation.notifyOnFailure) {
        this.notifyMemify(
          vault,
          `Vault ${vault.id}: ${options.trigger ?? "manual"} memify run failed. ${runtime.memify.error}`,
          options.sessionKey,
          `vault:${vault.id}:memify:failure`,
        );
      }
      throw error;
    }
  }

  async purgeVaultData(vaultId: string, options: VaultPurgeOptions): Promise<VaultPurgeResult> {
    await this.initialise();
    return this.runExclusive(vaultId, async () => {
      const vault = this.requireVault(vaultId);
      const runtime = this.ensureVaultState(vaultId);
      const removedPaths: string[] = [];

      if (options.mirror) {
        const mirrorRoot = this.resolveMirrorRoot(vault);
        await fs.rm(mirrorRoot, { recursive: true, force: true });
        removedPaths.push(mirrorRoot);
      }

      if (options.snapshots) {
        const snapshotRoot = this.resolveSnapshotRoot(vault);
        await fs.rm(snapshotRoot, { recursive: true, force: true });
        removedPaths.push(snapshotRoot);
        if (!options.state) {
          for (const note of Object.values(runtime.notes)) {
            delete note.lastSnapshotPath;
          }
        }
      }

      let datasetId: string | undefined;
      let datasetName: string | undefined;
      let cogneeDatasetDeleted = false;
      if (options.cogneeDataset) {
        const dataset = await this.resolveCogneeDataset(vault);
        datasetId = dataset?.id;
        datasetName = dataset?.name;
        if (dataset) {
          const target = this.resolveEffectiveCogneeTarget(vault);
          await this.fetchCogneeJson<unknown>(
            target,
            `/api/v1/datasets/${dataset.id}`,
            { method: "DELETE" },
            vault.requestTimeoutMs,
          );
          cogneeDatasetDeleted = true;
        }
      }

      if (options.state) {
        this.state.vaults[vaultId] = {
          lastSeq: "0",
          notes: {},
          conflicts: {},
          resolvedConflicts: {},
          notifications: {},
          memify: createIdleMemifyState(vault.automation.memify.allSnapshots),
        };
      }

      await this.writeState();
      return {
        vaultId,
        removedPaths,
        stateReset: options.state,
        cogneeDatasetDeleted,
        datasetId,
        datasetName,
      };
    });
  }

  async repairLocalVault(
    vaultId: string,
    options: {
      rebuildSnapshots?: boolean;
      requestedBy?: "tool" | "cli" | "automation" | "service";
    } = {},
  ): Promise<VaultRepairResult> {
    await this.initialise();
    await this.preemptBackgroundTaskForManualRun(vaultId, "repair", options.requestedBy);
    return this.runExclusive(vaultId, async () => {
      const task = this.beginVaultTask(vaultId, "repair", {
        trigger: "manual",
        requestedBy: options.requestedBy ?? "tool",
      });
      await this.writeState();
      const vault = this.requireVault(vaultId);
      const runtime = this.ensureVaultState(vaultId);
      const mirrorRoot = this.resolveMirrorRoot(vault);
      const snapshotRoot = this.resolveSnapshotRoot(vault);
      try {
        this.throwIfCancelled(task.signal);
        await fs.mkdir(mirrorRoot, { recursive: true });
        if (options.rebuildSnapshots) {
          await fs.rm(snapshotRoot, { recursive: true, force: true });
          for (const note of Object.values(runtime.notes)) {
            delete note.lastSnapshotPath;
          }
        }
        await fs.mkdir(snapshotRoot, { recursive: true });
        runtime.lastSeq = "0";
        runtime.lastError = undefined;
        await this.writeState();

        const sync = await this.syncVaultInternal(vaultId, { forceFull: true, trigger: "manual", requestedBy: options.requestedBy }, task);
        await this.finishVaultTask(vaultId, task.state, { status: "succeeded" });
        return {
          vaultId,
          mirrorRoot,
          snapshotRoot,
          rebuildSnapshots: Boolean(options.rebuildSnapshots),
          sync,
        };
      } catch (error) {
        const cancelled = task.signal.aborted || this.isCancellationError(error);
        await this.finishVaultTask(vaultId, task.state, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
          cancelReason: cancelled ? task.signal.reason instanceof Error ? task.signal.reason.message : String(task.signal.reason ?? "Task cancelled") : undefined,
        });
        throw error;
      }
    });
  }

  private configureTimers(): void {
    for (const vault of this.config.vaults) {
      if (!vault.enabled) {
        continue;
      }
      void this.syncVault(vault.id, { trigger: "timer", requestedBy: "service" }).catch((error) => {
        this.logger.warn(`obsidian-livesync-cognee: startup sync failed for ${vault.id}: ${String(error)}`);
      });
      const timer = setInterval(() => {
        void this.syncVault(vault.id, { trigger: "timer", requestedBy: "service" }).catch((error) => {
          this.logger.warn(`obsidian-livesync-cognee: interval sync failed for ${vault.id}: ${String(error)}`);
        });
      }, vault.pollIntervalSeconds * 1000);
      this.timers.set(vault.id, timer);
    }
  }

  private findTrackedNoteStateByDocId(runtime: VaultRuntimeState, docId: string): StoredNoteState | undefined {
    return Object.values(runtime.notes).find((note) => note.docId === docId);
  }

  private async syncVaultInternal(
    vaultId: string,
    options: {
      forceFull?: boolean;
      trigger?: "timer" | "manual";
      requestedBy?: "tool" | "cli" | "automation" | "service";
      agentId?: string;
    } = {},
    task?: TaskExecutionContext,
  ): Promise<SyncRunStats> {
    const vault = this.requireVault(vaultId);
    const runtime = this.ensureVaultState(vaultId);
    const stats: SyncRunStats = {
      vaultId,
      changesSeen: 0,
      notesUpserted: 0,
      notesDeleted: 0,
      snapshotsWritten: 0,
      cogneeUploads: 0,
      cogneeFailures: 0,
      unsupportedEntries: 0,
      conflictsDetected: 0,
      conflictsAutoResolved: 0,
      lastSeq: runtime.lastSeq,
    };

    try {
      if (task) {
        this.throwIfCancelled(task.signal);
      }
      const changes = await this.fetchChanges(
        vault,
        runtime.lastSeq,
        options.forceFull || vault.syncMode === "full",
        task?.signal,
      );
      let cycleCogneeTarget = this.resolveEffectiveCogneeTarget(vault, options.agentId);
      let cycleHasCogneeUploads = false;
      stats.lastSeq = String(changes.last_seq ?? runtime.lastSeq);
      for (const row of changes.results) {
        if (task) {
          this.throwIfCancelled(task.signal);
        }
        stats.changesSeen += 1;
        const rawDoc = row.doc as CouchNoteDoc | undefined;
        const trackedNoteState = this.findTrackedNoteStateByDocId(runtime, row.id);
        const deleted = Boolean(row.deleted || rawDoc?.deleted || rawDoc?._deleted);
        let doc = rawDoc;
        if (!deleted && doc && this.isNoteDoc(doc)) {
          try {
            doc = await this.decodeNoteDoc(vault, doc);
          } catch (error) {
            stats.unsupportedEntries += 1;
            const noteHint = doc.path ?? doc._id;
            this.notifyVault(vault, `Vault ${vault.id}: failed to decode encrypted note at ${noteHint}. ${String(error)}`, {
              kind: "error",
              contextKey: `vault:${vault.id}:decode:${doc._id}`,
            });
            continue;
          }
        }
        const currentPath = doc?.path ?? trackedNoteState?.path;
        if (!deleted) {
          if (!doc || !this.isNoteDoc(doc) || !doc.path) {
            continue;
          }
          if (!shouldIncludePath(vault, doc.path)) {
            continue;
          }
        } else if (!currentPath) {
          continue;
        }
        const noteDoc = deleted ? undefined : (doc as CouchNoteDoc);

        let currentDoc = doc;
        if (noteDoc?.path) {
          const conflictResult = await this.inspectConflicts(vault, noteDoc.path, noteDoc, trackedNoteState?.docId);
          if (conflictResult.conflictDetected) {
            stats.conflictsDetected += 1;
          }
          if (conflictResult.autoResolved) {
            stats.conflictsAutoResolved += 1;
          }
          currentDoc = conflictResult.currentDoc ?? noteDoc;
        }

        const resolvedPath = currentDoc?.path ?? currentPath;
        if (!resolvedPath) {
          continue;
        }
        if (deleted && !trackedNoteState && !shouldIncludePath(vault, resolvedPath)) {
          continue;
        }

        const existingNoteState = runtime.notes[resolvedPath] ?? trackedNoteState;
        if (deleted) {
          const tombstoneDoc: CouchNoteDoc = {
            _id: row.id,
            _rev: doc?._rev ?? existingNoteState?.rev,
            path: resolvedPath,
            type: "plain",
            datatype: "plain",
            ctime: existingNoteState?.ctime,
            mtime: existingNoteState?.mtime,
            deleted: true,
            _deleted: true,
          };
          await this.writeMirror(vault, resolvedPath, "", true);
          const snapshotPath = await this.writeSnapshot(vault, resolvedPath, {
            deleted: true,
            content: "",
            doc: tombstoneDoc,
            links: [],
            linkedContent: [],
          });
          runtime.notes[resolvedPath] = {
            path: resolvedPath,
            docId: row.id,
            rev: tombstoneDoc._rev,
            ctime: existingNoteState?.ctime,
            mtime: existingNoteState?.mtime,
            deleted: true,
            lastSnapshotPath: snapshotPath,
            lastSyncedAt: new Date().toISOString(),
            lastCogneeRevision: existingNoteState?.lastCogneeRevision,
            lastCogneeDatasetKey: existingNoteState?.lastCogneeDatasetKey,
          };
          stats.notesDeleted += 1;
          stats.snapshotsWritten += 1;
          const cogneeUpload = await this.uploadSnapshotToCognee(vault, cycleCogneeTarget, snapshotPath, {
            notePath: resolvedPath,
            noteRevision: tombstoneDoc._rev,
            previousRevision: existingNoteState?.rev,
            deleted: true,
            skipCognify: true,
            signal: task?.signal,
          });
          if (cogneeUpload.datasetId && cogneeUpload.datasetId !== cycleCogneeTarget.datasetId) {
            cycleCogneeTarget = { ...cycleCogneeTarget, datasetId: cogneeUpload.datasetId };
          }
          if (cogneeUpload.uploaded) {
            stats.cogneeUploads += 1;
            cycleHasCogneeUploads = true;
          }
          continue;
        }

        const liveDoc = currentDoc as CouchNoteDoc;
        const content = await this.loadNoteContent(vault, liveDoc);
        if (content === null) {
          stats.unsupportedEntries += 1;
          this.notifyVault(vault, `Vault ${vault.id}: unsupported note encoding encountered at ${resolvedPath}.`, {
            kind: "error",
            contextKey: `vault:${vault.id}:encoding:${resolvedPath}`,
          });
          continue;
        }

        await this.writeMirror(vault, resolvedPath, content, false);
        const links = extractLinks(content);
        const linkedContent = await this.fetchLinkedHttpContent(vault, resolvedPath, links);
        const snapshotPath = await this.writeSnapshot(vault, resolvedPath, {
          deleted: false,
          content,
          doc: liveDoc,
          links,
          linkedContent,
        });
        runtime.notes[resolvedPath] = {
          path: resolvedPath,
          docId: liveDoc._id,
          rev: liveDoc._rev,
          ctime: liveDoc.ctime,
          mtime: liveDoc.mtime,
          deleted: false,
          lastSnapshotPath: snapshotPath,
          lastSyncedAt: new Date().toISOString(),
          lastCogneeRevision: existingNoteState?.lastCogneeRevision,
          lastCogneeDatasetKey: existingNoteState?.lastCogneeDatasetKey,
        };
        stats.notesUpserted += 1;
        stats.snapshotsWritten += 1;
        const cogneeUpload = await this.uploadSnapshotToCognee(vault, cycleCogneeTarget, snapshotPath, {
          notePath: resolvedPath,
          noteRevision: liveDoc._rev,
          previousRevision: existingNoteState?.rev,
          deleted: false,
          skipCognify: true,
          signal: task?.signal,
        });
        if (cogneeUpload.datasetId && cogneeUpload.datasetId !== cycleCogneeTarget.datasetId) {
          cycleCogneeTarget = { ...cycleCogneeTarget, datasetId: cogneeUpload.datasetId };
        }
        if (cogneeUpload.uploaded) {
          stats.cogneeUploads += 1;
          cycleHasCogneeUploads = true;
        }
      }
      if (cycleHasCogneeUploads) {
        await this.runCogneeCognify(vault, cycleCogneeTarget, task?.signal);
      }
      runtime.lastSeq = stats.lastSeq;
      runtime.lastSyncAt = new Date().toISOString();
      runtime.lastError = undefined;
      const activeNoteCount = Object.values(runtime.notes).filter((note) => !note.deleted).length;
      await this.writeState();
      this.logger.info(
        `obsidian-livesync-cognee: sync finished for ${vault.id}: activeNotes=${activeNoteCount} changesSeen=${stats.changesSeen} notesUpserted=${stats.notesUpserted} notesDeleted=${stats.notesDeleted} snapshotsWritten=${stats.snapshotsWritten}`,
      );
      return stats;
    } catch (error) {
      runtime.lastError = this.isCancellationError(error) ? undefined : error instanceof Error ? error.message : String(error);
      if (!this.isCancellationError(error)) {
        this.notifyVault(vault, `Vault ${vault.id}: sync failed. ${runtime.lastError}`, {
          kind: "error",
          contextKey: `vault:${vault.id}:sync-error`,
        });
      }
      await this.writeState();
      throw error;
    }
  }

  private resolveMirrorRoot(vault: ResolvedVaultConfig): string {
    return vault.mirrorRoot
      ? this.resolvePath(vault.mirrorRoot)
      : path.join(this.baseStateDir, "mirror", sanitizeSegment(vault.id));
  }

  private resolveSnapshotRoot(vault: ResolvedVaultConfig): string {
    return vault.snapshotRoot
      ? this.resolvePath(vault.snapshotRoot)
      : path.join(this.baseStateDir, "snapshots", sanitizeSegment(vault.id));
  }

  private resolveSnapshotLinkedContentRoot(snapshotPath: string): string {
    return `${snapshotPath}.links`;
  }

  private resolveMirrorPath(vault: ResolvedVaultConfig, notePath: string): string {
    return path.join(this.resolveMirrorRoot(vault), notePath);
  }

  private async writeMirror(vault: ResolvedVaultConfig, notePath: string, content: string, deleted: boolean) {
    const filePath = this.resolveMirrorPath(vault, notePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (deleted) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await fs.writeFile(filePath, content, "utf8");
  }

  private async writeSnapshot(
    vault: ResolvedVaultConfig,
    notePath: string,
    params: {
      deleted: boolean;
      content: string;
      doc: CouchNoteDoc;
      links: Array<{ url: string; kind: "http" | "relative" | "wiki" }>;
      linkedContent: Array<{ url: string; contentType: string; content: string }>;
    },
  ): Promise<string> {
    const snapshotRoot = this.resolveSnapshotRoot(vault);
    await fs.mkdir(snapshotRoot, { recursive: true });
    const slug = sanitizeSegment(notePath.replace(/[/.]+/g, "-"));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(snapshotRoot, `${timestamp}-${slug}.md`);
    const linkedContentFiles = await this.writeSnapshotLinkedContentFiles(filePath, notePath, params.linkedContent);
    const hints = extractFilenameHints(notePath);
    const linkedSources = params.linkedContent.map((item) => item.url);
    const sourceCtimeIso = formatUnixMsAsIso(params.doc.ctime);
    const sourceMtimeIso = formatUnixMsAsIso(params.doc.mtime);
    const frontmatter = [
      "---",
      `vault_id: ${escapeFrontmatterScalar(vault.id)}`,
      `source_path: ${escapeFrontmatterScalar(notePath)}`,
      `source_revision: ${escapeFrontmatterScalar(params.doc._rev ?? "")}`,
      `source_ctime: ${escapeFrontmatterScalar(sourceCtimeIso ?? "")}`,
      `source_mtime: ${escapeFrontmatterScalar(sourceMtimeIso ?? "")}`,
      `source_ctime_unix_ms: ${params.doc.ctime ?? 0}`,
      `source_mtime_unix_ms: ${params.doc.mtime ?? 0}`,
      `source_deleted: ${params.deleted ? "true" : "false"}`,
      `filename_tokens: ${escapeFrontmatterScalar(JSON.stringify(hints.tokens))}`,
      `filename_dates: ${escapeFrontmatterScalar(JSON.stringify(hints.dates))}`,
      `filename_people: ${escapeFrontmatterScalar(JSON.stringify(hints.people))}`,
      `links: ${escapeFrontmatterScalar(JSON.stringify(params.links))}`,
      `downloaded_links: ${escapeFrontmatterScalar(JSON.stringify(linkedSources))}`,
      `downloaded_link_files: ${escapeFrontmatterScalar(JSON.stringify(linkedContentFiles.map((item) => item.fileName)))}`,
      `synced_at: ${escapeFrontmatterScalar(new Date().toISOString())}`,
      "---",
      "",
      `# ${notePath}`,
      "",
      params.deleted ? "_This note was deleted in the remote vault._" : params.content,
    ];

    await fs.writeFile(filePath, ensureTrailingNewline(frontmatter.join("\n")), "utf8");
    return filePath;
  }

  private async writeSnapshotLinkedContentFiles(
    snapshotPath: string,
    notePath: string,
    linkedContent: Array<{ url: string; contentType: string; content: string }>,
  ): Promise<SnapshotLinkedContentFile[]> {
    const linkedRoot = this.resolveSnapshotLinkedContentRoot(snapshotPath);
    if (linkedContent.length === 0) {
      await fs.rm(linkedRoot, { recursive: true, force: true });
      return [];
    }
    await fs.mkdir(linkedRoot, { recursive: true });
    const written: SnapshotLinkedContentFile[] = [];
    for (const [index, linked] of linkedContent.entries()) {
      const fileName = buildLinkedContentFileName(index, linked.url);
      await fs.writeFile(
        path.join(linkedRoot, fileName),
        buildLinkedContentDocument(notePath, linked),
        "utf8",
      );
      written.push({ fileName, ...linked });
    }
    return written;
  }

  private async readSnapshotLinkedContentFiles(snapshotPath: string): Promise<string[]> {
    const linkedRoot = this.resolveSnapshotLinkedContentRoot(snapshotPath);
    try {
      const entries = (await fs.readdir(linkedRoot)).sort((left, right) => left.localeCompare(right));
      const contents: string[] = [];
      for (const entry of entries) {
        const filePath = path.join(linkedRoot, entry);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          continue;
        }
        contents.push(await fs.readFile(filePath, "utf8"));
      }
      return contents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  private async uploadSnapshotToCognee(
    vault: ResolvedVaultConfig,
    target: ResolvedVaultConfig["cognee"],
    snapshotPath: string,
    options: {
      skipCognify?: boolean;
      notePath?: string;
      noteRevision?: string;
      previousRevision?: string;
      deleted?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<CogneeUploadResult> {
    if (!target.enabled || !target.baseUrl) {
      return { uploaded: false };
    }
    const datasetKey = target.datasetId ?? target.datasetName ?? `vault_${vault.id}`;
    if (options.notePath && options.noteRevision) {
      const storedNote = this.ensureVaultState(vault.id).notes[options.notePath];
      if (
        storedNote?.lastCogneeRevision === options.noteRevision &&
        storedNote.lastCogneeDatasetKey === datasetKey
      ) {
        return { uploaded: false, datasetId: target.datasetId };
      }
    }
    try {
      if (options.signal) {
        this.throwIfCancelled(options.signal);
      }
      const uploadPayload = await this.buildCogneeUploadPayload(vault, snapshotPath, options);
      if (!uploadPayload) {
        this.rememberCogneeRevision(vault.id, options.notePath, options.noteRevision, datasetKey);
        return { uploaded: false, datasetId: target.datasetId };
      }
      const invalidReason = this.validateCogneeUploadPayload(uploadPayload);
      if (invalidReason) {
        this.logger.warn(
          `obsidian-livesync-cognee: skipped Cognee upload for vault=${vault.id} note=${options.notePath ?? path.basename(snapshotPath)} because ${invalidReason}`,
        );
        this.rememberCogneeRevision(vault.id, options.notePath, options.noteRevision, datasetKey);
        return { uploaded: false, datasetId: target.datasetId };
      }
      const form = new FormData();
      form.append("data", new Blob([uploadPayload.content], { type: "text/markdown" }), uploadPayload.fileName);
      if (target.datasetId) {
        form.append("datasetId", target.datasetId);
      } else {
        form.append("datasetName", target.datasetName ?? `vault_${vault.id}`);
      }
      for (const node of target.nodeSet) {
        form.append("node_set", node);
      }

      const addResponse = await this.fetchCogneeJson<Record<string, unknown>>(target, "/api/v1/add", {
        method: "POST",
        body: form,
        signal: options.signal,
      }, this.getCogneeTimeoutMs(vault, COGNEE_MUTATION_TIMEOUT_MS));
      const datasetId = typeof addResponse.dataset_id === "string"
        ? addResponse.dataset_id
        : typeof addResponse.datasetId === "string"
          ? addResponse.datasetId
          : target.datasetId;

      this.rememberCogneeRevision(vault.id, options.notePath, options.noteRevision, datasetId ?? datasetKey);

      if (!options.skipCognify) {
        await this.runCogneeCognify(vault, target, options.signal);
      }
      return { uploaded: true, datasetId };
    } catch (error) {
      this.logger.warn(`obsidian-livesync-cognee: Cognee upload failed for ${vault.id}: ${String(error)}`);
      this.notifyVault(vault, `Vault ${vault.id}: Cognee upload failed for ${path.basename(snapshotPath)}. ${String(error)}`, {
        kind: "error",
        contextKey: `vault:${vault.id}:cognee-upload`,
      });
      return { uploaded: false, datasetId: target.datasetId };
    }
  }

  private async buildCogneeUploadPayload(
    vault: ResolvedVaultConfig,
    snapshotPath: string,
    options: {
      notePath?: string;
      noteRevision?: string;
      previousRevision?: string;
      deleted?: boolean;
    },
  ): Promise<CogneeUploadPayload | null> {
    const snapshotMarkdown = await fs.readFile(snapshotPath, "utf8");
    const linkedContentDocuments = await this.readSnapshotLinkedContentFiles(snapshotPath);
    const uploadMarkdown = linkedContentDocuments.length > 0
      ? ensureTrailingNewline(snapshotMarkdown) + ["", "## Downloaded Link Files", "", ...linkedContentDocuments].join("\n\n")
      : snapshotMarkdown;
    if (!options.notePath || !options.noteRevision || !options.previousRevision) {
      return {
        fileName: path.basename(snapshotPath),
        content: uploadMarkdown,
      };
    }

    if (options.deleted) {
      return {
        fileName: path.basename(snapshotPath).replace(/\.md$/i, "-version.md"),
        content: injectVersionMetadata(uploadMarkdown, {
          previousRevision: options.previousRevision,
          sourceRevision: options.noteRevision,
          changeType: "deleted",
        }),
      };
    }

    return {
      fileName: path.basename(snapshotPath).replace(/\.md$/i, "-version.md"),
      content: injectVersionMetadata(uploadMarkdown, {
        previousRevision: options.previousRevision,
        sourceRevision: options.noteRevision,
        changeType: "modified",
      }),
    };
  }

  private validateCogneeUploadPayload(payload: CogneeUploadPayload): string | undefined {
    const longestLineLength = findLongestLineLength(payload.content);
    if (longestLineLength > COGNEE_MAX_UPLOAD_LINE_LENGTH) {
      return `line length ${longestLineLength} exceeds Cognee chunking limit ${COGNEE_MAX_UPLOAD_LINE_LENGTH}`;
    }
    return undefined;
  }

  private rememberCogneeRevision(
    vaultId: string,
    notePath: string | undefined,
    noteRevision: string | undefined,
    datasetKey: string | undefined,
  ): void {
    if (!notePath || !noteRevision || !datasetKey) {
      return;
    }
    const storedNote = this.ensureVaultState(vaultId).notes[notePath];
    if (!storedNote) {
      return;
    }
    storedNote.lastCogneeRevision = noteRevision;
    storedNote.lastCogneeDatasetKey = datasetKey;
  }

  private async runCogneeCognify(
    vault: ResolvedVaultConfig,
    target: ResolvedVaultConfig["cognee"],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!target.enabled || !target.baseUrl || !target.cognify) {
      return false;
    }

    const cognifyBodies = this.buildCogneeCognifyBodies(vault, target);
    let lastError: unknown;
    for (const body of cognifyBodies) {
      try {
        await this.fetchCogneeJson<Record<string, unknown>>(
          target,
          "/api/v1/cognify",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          },
          this.getCogneeTimeoutMs(vault, COGNEE_MUTATION_TIMEOUT_MS),
        );
        return true;
      } catch (error) {
        if (this.isCogneeContextLimitError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `obsidian-livesync-cognee: skipped Cognee cognify for vault=${vault.id} because the target rejected oversized text: ${message}`,
          );
          return false;
                  const activeNoteCount = Object.values(this.ensureVaultState(vaultId).notes).filter((note) => !note.deleted).length;
                  this.logger.info(
                    `obsidian-livesync-cognee: repair finished for ${vault.id}: activeNotes=${activeNoteCount} rebuildSnapshots=${Boolean(options.rebuildSnapshots)}`,
                  );
        }
        lastError = error;
      }
    }

    if (lastError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      this.logger.warn(`obsidian-livesync-cognee: Cognee cognify failed for ${vault.id}: ${message}`);
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildCogneeCognifyBodies(
    vault: ResolvedVaultConfig,
    target: ResolvedVaultConfig["cognee"],
  ): Array<Record<string, unknown>> {
    const datasetId = target.datasetId;
    const datasetName = target.datasetName ?? `vault_${vault.id}`;
    if (datasetId) {
      return [
        { datasetIds: [datasetId] },
        { dataset_ids: [datasetId] },
      ];
    }
    return [
      { datasetNames: [datasetName] },
      { datasets: [datasetName] },
    ];
  }

  private async runCogneeMemify(
    vault: ResolvedVaultConfig,
    target: ResolvedVaultConfig["cognee"],
    signal?: AbortSignal,
  ): Promise<CogneeMemifyRunResult> {
    if (!target.enabled || !target.baseUrl) {
      return { memified: false };
    }

    const memifyPayload: Record<string, unknown> = target.datasetId
      ? { dataset_id: target.datasetId }
      : { dataset_name: target.datasetName ?? `vault_${vault.id}` };
    if (target.nodeSet.length > 0) {
      memifyPayload.node_name = target.nodeSet;
    }
    try {
      const backgroundResponse = await this.fetchCogneeJson<unknown>(
        target,
        "/api/v1/memify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...memifyPayload, run_in_background: true }),
          signal,
        },
        COGNEE_MEMIFY_TIMEOUT_MS,
      );
      const backgroundRun = this.extractCogneeBackgroundRun(backgroundResponse);
      if (backgroundRun) {
        return {
          memified: false,
          pending: true,
          status: backgroundRun.status,
          pipelineRunId: backgroundRun.pipelineRunId,
          checkHint: backgroundRun.pipelineRunId
            ? `Cognee accepted the memify run in background. Track pipeline_run_id ${backgroundRun.pipelineRunId} from Cognee, then rerun this command or inspect Cognee progress.`
            : "Cognee accepted the memify run in background. Rerun this command later or inspect Cognee progress.",
        };
      }
      return { memified: true };
    } catch (error) {
      if (!this.isCogneeBackgroundMemifyCompatibilityError(error)) {
        throw error;
      }
      this.logger.warn(
        `obsidian-livesync-cognee: background Cognee memify fallback for vault=${vault.id} because the target rejected background execution: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.fetchCogneeJson<Record<string, unknown>>(
      target,
      "/api/v1/memify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(memifyPayload),
        signal,
      },
      COGNEE_MEMIFY_TIMEOUT_MS,
    );
    return { memified: true };
  }

  private extractCogneeBackgroundRun(
    response: unknown,
  ): { status?: string; pipelineRunId?: string } | undefined {
    if (!response || typeof response !== "object") {
      return undefined;
    }
    const entries = Object.values(response as Record<string, unknown>);
    const candidate = (entries[0] ?? response) as Record<string, unknown>;
    if (!candidate || typeof candidate !== "object") {
      return undefined;
    }
    const status = typeof candidate.status === "string" ? candidate.status : undefined;
    const pipelineRunId =
      typeof candidate.pipeline_run_id === "string"
        ? candidate.pipeline_run_id
        : typeof candidate.pipelineRunId === "string"
          ? candidate.pipelineRunId
          : undefined;
    if (!status && !pipelineRunId) {
      return undefined;
    }
    return { status, pipelineRunId };
  }

  private isCogneeBackgroundMemifyCompatibilityError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /UUID' object is not iterable|HTTP 409 .*\/api\/v1\/memify/i.test(message);
  }

  private isCogneeContextLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /HTTP 409 .*\/api\/v1\/cognify/i.test(message)
      && /Text too long for embedding model|input length exceeds the context length|longer than chunking size\s*8191/i.test(message);
  }

  private getCogneeTimeoutMs(vault: ResolvedVaultConfig, minimumMs: number): number {
    return Math.max(vault.requestTimeoutMs, minimumMs);
  }

  private async buildCogneeHeaders(target: ResolvedVaultConfig["cognee"]): Promise<HeadersInit> {
    const headers: Record<string, string> = {};
    if (target.apiKey) {
      headers["X-API-Key"] = target.apiKey;
      headers.Authorization = `Bearer ${target.apiKey}`;
      return headers;
    }
    if (target.authToken) {
      headers.Authorization = target.authToken.startsWith("Bearer ")
        ? target.authToken
        : `Bearer ${target.authToken}`;
      return headers;
    }
    if (target.username || target.password) {
      const cacheKey = this.buildCogneeAuthCacheKey(target);
      const cached = this.cogneeAuthTokens.get(cacheKey);
      const token = cached ?? (await this.loginToCognee(target));
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async resolveCogneeDataset(
    vault: ResolvedVaultConfig,
    target: ResolvedVaultConfig["cognee"] = vault.cognee,
  ): Promise<{ id: string; name: string } | undefined> {
    if (!target.enabled || !target.baseUrl) {
      return undefined;
    }
    if (target.datasetId) {
      return { id: target.datasetId, name: target.datasetName ?? `vault_${vault.id}` };
    }
    if (!target.datasetName) {
      return undefined;
    }

    const datasets = await this.fetchCogneeJson<Array<{ id: string; name: string }>>(target, "/api/v1/datasets", {}, vault.requestTimeoutMs);
    return datasets.find((dataset) => dataset.name === target.datasetName);
  }

  private resolveEffectiveCogneeTarget(
    vault: ResolvedVaultConfig,
    agentId?: string,
  ): ResolvedVaultConfig["cognee"] {
    const scopedDatasetName = agentId ? vault.cognee.datasetNames?.[agentId] : undefined;
    if (!scopedDatasetName) {
      return vault.cognee;
    }
    return {
      ...vault.cognee,
      datasetName: scopedDatasetName,
      datasetId: vault.cognee.datasetName === scopedDatasetName ? vault.cognee.datasetId : undefined,
    };
  }

  private hasResolvableCogneeDatasetTarget(target: ResolvedVaultConfig["cognee"]): boolean {
    return Boolean(target.datasetId || target.datasetName);
  }

  private isVaultAccessibleToAgent(vault: ResolvedVaultConfig, agentId?: string): boolean {
    if (!vault.enabled) {
      return false;
    }
    if (!agentId) {
      return true;
    }
    return this.hasResolvableCogneeDatasetTarget(this.resolveEffectiveCogneeTarget(vault, agentId));
  }

  private resolveQueryCogneeVaults(vaultId?: string, agentId?: string): ResolvedVaultConfig[] {
    const vaults = vaultId
      ? [this.requireVault(vaultId)]
      : this.config.vaults.filter((vault) => vault.cognee.enabled && vault.cognee.baseUrl);

    return vaults.filter((vault) => this.hasResolvableCogneeDatasetTarget(this.resolveEffectiveCogneeTarget(vault, agentId)));
  }

  private buildCogneeAuthCacheKey(target: ResolvedVaultConfig["cognee"]): string {
    return `${target.baseUrl ?? ""}|${target.username ?? ""}`;
  }

  private async loginToCognee(target: ResolvedVaultConfig["cognee"]): Promise<string> {
    const cacheKey = this.buildCogneeAuthCacheKey(target);
    const existing = this.cogneeLoginInFlight.get(cacheKey);
    if (existing) {
      return existing;
    }
    const login = (async () => {
      const response = await this.fetchAbsoluteJson<{ access_token?: string; token?: string }>(
        `${target.baseUrl?.replace(/\/+$/, "")}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            username: target.username ?? "",
            password: target.password ?? "",
          }),
        },
      );
      const token = response.access_token ?? response.token;
      if (!token) {
        throw new Error("Cognee login succeeded but no token was returned");
      }
      this.cogneeAuthTokens.set(cacheKey, token);
      return token;
    })().finally(() => {
      this.cogneeLoginInFlight.delete(cacheKey);
    });
    this.cogneeLoginInFlight.set(cacheKey, login);
    return login;
  }

  private async fetchCogneeJson<T>(
    target: ResolvedVaultConfig["cognee"],
    pathName: string,
    init: RequestInit,
    timeoutMs = 20_000,
  ): Promise<T> {
    const url = `${target.baseUrl?.replace(/\/+$/, "")}${pathName}`;
    const headers = await this.buildCogneeHeaders(target);
    try {
      return await this.fetchAbsoluteJson<T>(url, {
        ...init,
        headers: { ...headers, ...init.headers },
        timeoutMs,
      } as RequestInit & { timeoutMs?: number });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((target.username || target.password) && message.includes("HTTP 401")) {
        this.cogneeAuthTokens.delete(this.buildCogneeAuthCacheKey(target));
        const retryHeaders = await this.buildCogneeHeaders(target);
        return this.fetchAbsoluteJson<T>(url, {
          ...init,
          headers: { ...retryHeaders, ...init.headers },
          timeoutMs,
        } as RequestInit & { timeoutMs?: number });
      }
      throw error;
    }
  }

  private async fetchLinkedHttpContent(
    vault: ResolvedVaultConfig,
    notePath: string,
    links: Array<{ url: string; kind: "http" | "relative" | "wiki" }>,
  ): Promise<Array<{ url: string; contentType: string; content: string }>> {
    if (!vault.cognee.downloadHttpLinks || vault.cognee.maxLinksPerNote <= 0) {
      return [];
    }
    const results: Array<{ url: string; contentType: string; content: string }> = [];
    for (const link of links) {
      if (link.kind !== "http") {
        continue;
      }
      if (results.length >= vault.cognee.maxLinksPerNote) {
        break;
      }
      try {
        const controller = new AbortController();
        const timeoutMs = Math.min(vault.requestTimeoutMs, EXTERNAL_LINK_FETCH_TIMEOUT_MS);
        const timer = setTimeout(
          () => controller.abort(new Error(`linked HTTP fetch timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        try {
          const response = await fetch(link.url, {
            dispatcher: getExternalFetchDispatcher(),
            redirect: "follow",
            signal: controller.signal,
            headers: {
              "User-Agent": EXTERNAL_HTTP_FETCH_USER_AGENT,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.8",
              "Cache-Control": "max-age=0",
              Pragma: "no-cache",
              "Sec-Fetch-Dest": "document",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Site": "none",
              "Sec-Fetch-User": "?1",
              "Upgrade-Insecure-Requests": "1",
            },
          } as RequestInit & { dispatcher?: EnvHttpProxyAgent });
          const contentType = response.headers.get("content-type") ?? "application/octet-stream";
          if (!response.ok) {
            this.logger.warn(
              `obsidian-livesync-cognee: linked HTTP fetch skipped note=${notePath} url=${link.url} status=${response.status}`,
            );
            await response.body?.cancel?.().catch(() => undefined);
            continue;
          }
          const contentLength = parseContentLength(response.headers.get("content-length"));
          if (contentLength !== undefined && contentLength > vault.cognee.maxLinkBytes) {
            this.logger.warn(
              `obsidian-livesync-cognee: linked HTTP fetch skipped note=${notePath} url=${link.url} because content-length=${contentLength} exceeds maxLinkBytes=${vault.cognee.maxLinkBytes}`,
            );
            await response.body?.cancel?.().catch(() => undefined);
            continue;
          }
          if (!isInlineTextContentType(contentType)) {
            this.logger.warn(
              `obsidian-livesync-cognee: linked HTTP fetch skipped note=${notePath} url=${link.url} because content-type=${contentType} is not inline text content`,
            );
            await response.body?.cancel?.().catch(() => undefined);
            continue;
          }
          const raw = await response.text();
          const limited = raw.slice(0, vault.cognee.maxLinkBytes);
          const content = contentType.includes("html") ? stripHtml(limited) : limited;
          if (!content.trim()) {
            continue;
          }
          results.push({
            url: link.url,
            contentType,
            content: `Source note: ${notePath}\n\n${content}`,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        this.logger.warn(
          `obsidian-livesync-cognee: linked HTTP fetch failed note=${notePath} url=${link.url}: ${String(error)}`,
        );
      }
    }
    return results;
  }

  private async fetchNoteContentByPath(
    vault: ResolvedVaultConfig,
    notePath: string,
    trackedDocId?: string,
  ): Promise<{ doc: CouchNoteDoc; content: string; deleted: boolean }> {
    const docId = trackedDocId ?? pathToDocumentId(vault, notePath);
    const rawDoc = await this.fetchJson<CouchNoteDoc>(vault, `/${encodeURIComponent(docId)}`);
    const doc = await this.decodeNoteDoc(vault, rawDoc);
    if (!this.isNoteDoc(doc)) {
      throw new Error(`document at ${notePath} is not a note`);
    }
    const deleted = Boolean(doc.deleted || doc._deleted);
    if (deleted) {
      return { doc, content: "", deleted: true };
    }
    const content = await this.loadNoteContent(vault, doc);
    if (content === null) {
      throw new Error(`note at ${notePath} uses unsupported encoding`);
    }
    return { doc, content, deleted: false };
  }

  private async loadNoteContent(vault: ResolvedVaultConfig, doc: CouchNoteDoc): Promise<string | null> {
    const readableDoc = await this.decodeNoteDoc(vault, doc);
    if (Array.isArray(readableDoc.data)) {
      return readableDoc.data.join("");
    }
    if (typeof readableDoc.data === "string") {
      return readableDoc.data;
    }
    if (readableDoc.children && readableDoc.children.length > 0) {
      const pieces: string[] = [];
      for (const childId of readableDoc.children) {
        const edenChunk = readableDoc.eden?.[childId]?.data;
        if (typeof edenChunk === "string") {
          pieces.push(edenChunk);
          continue;
        }
        const chunk = await this.fetchJson<CouchLeafDoc>(vault, `/${encodeURIComponent(childId)}`);
        const readableChunk = await this.decodeLeafDoc(vault, chunk);
        if (!readableChunk || readableChunk.type !== "leaf" || typeof readableChunk.data !== "string") {
          return null;
        }
        pieces.push(readableChunk.data);
      }
      return pieces.join("");
    }
    return "";
  }

  private isNoteDoc(doc: CouchNoteDoc | CouchLeafDoc): doc is CouchNoteDoc {
    return (doc.type === "plain" || doc.type === "newnote") && typeof (doc as CouchNoteDoc).path === "string";
  }

  private async fetchChanges(
    vault: ResolvedVaultConfig,
    since: string,
    forceFull: boolean,
    signal?: AbortSignal,
  ): Promise<CouchChangesResponse> {
    const initialSince = forceFull ? "0" : since || "0";
    let cursor: string | number = initialSince;
    let finalLastSeq: string | number | undefined;
    const results: CouchChangesResponse["results"] = [];

    while (true) {
      const params = new URLSearchParams();
      params.set("include_docs", "true");
      params.set("limit", String(CHANGES_PAGE_LIMIT));
      params.set("since", String(cursor));
      const page = await this.fetchJson<CouchChangesResponse>(vault, `/_changes?${params.toString()}`, { signal });
      results.push(...page.results);
      finalLastSeq = page.last_seq;

      if (page.results.length < CHANGES_PAGE_LIMIT) {
        break;
      }

      const lastRowSeq = page.results[page.results.length - 1]?.seq;
      if (lastRowSeq === undefined || String(lastRowSeq) === String(cursor)) {
        break;
      }
      cursor = lastRowSeq;
    }

    return {
      results,
      last_seq: finalLastSeq ?? initialSince,
    };
  }

  private async tryGetDoc(vault: ResolvedVaultConfig, docId: string): Promise<CouchNoteDoc | null> {
    try {
      return await this.fetchJson<CouchNoteDoc>(vault, `/${encodeURIComponent(docId)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  private async fetchConflictProbeByPath(
    vault: ResolvedVaultConfig,
    notePath: string,
    trackedDocId?: string,
  ): Promise<CouchNoteDoc> {
    const docId = trackedDocId ?? pathToDocumentId(vault, notePath);
    return this.fetchJson<CouchNoteDoc>(vault, `/${encodeURIComponent(docId)}?conflicts=true`);
  }

  private async fetchConflictProbeByDocId(vault: ResolvedVaultConfig, docId: string): Promise<CouchNoteDoc> {
    return this.fetchJson<CouchNoteDoc>(vault, `/${encodeURIComponent(docId)}?conflicts=true`);
  }

  private async fetchConflictBundle(vault: ResolvedVaultConfig, currentDoc: CouchNoteDoc): Promise<ConflictBundle | null> {
    const currentRev = currentDoc._rev;
    const conflictRevs = currentDoc._conflicts ?? [];
    if (!currentRev || conflictRevs.length === 0) {
      return null;
    }

    const docs = await this.fetchOpenRevisionBundle(vault, currentDoc._id);
    const loaded = new Map<string, RevisionContent>();
    const addRevision = async (doc: CouchNoteDoc) => {
      if (!doc._rev || loaded.has(doc._rev)) {
        return;
      }
      const readableDoc = await this.decodeNoteDoc(vault, doc);
      loaded.set(doc._rev, {
        doc: readableDoc,
        rev: doc._rev,
        content: doc.deleted || doc._deleted ? "" : await this.loadNoteContent(vault, readableDoc),
        deleted: Boolean(doc.deleted || doc._deleted),
      });
    };

    await addRevision(currentDoc);
    for (const entry of docs) {
      if (entry.ok && this.isNoteDoc(entry.ok)) {
        await addRevision(entry.ok);
      }
    }

    const current = loaded.get(currentRev);
    if (!current) {
      return null;
    }
    const explicitConflicts = conflictRevs
      .map((rev) => loaded.get(rev))
      .filter((entry): entry is RevisionContent => Boolean(entry));
    const conflicts =
      explicitConflicts.length > 0
        ? explicitConflicts
        : Array.from(loaded.values()).filter((entry) => entry.rev !== currentRev);
    return { current, conflicts };
  }

  private async fetchOpenRevisionBundle(
    vault: ResolvedVaultConfig,
    docId: string,
  ): Promise<OpenRevisionEntry[]> {
    const url = `${vault.url}/${encodeURIComponent(vault.database)}/${encodeURIComponent(docId)}?open_revs=all`;
    const response = await this.fetchAbsoluteResponse(url, {
      headers: this.buildVaultHeaders(vault),
      timeoutMs: vault.requestTimeoutMs,
    });
    const text = await response.text();
    if (!text.trim()) {
      return [];
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") || /^[\s]*[[{]/.test(text)) {
      return (JSON.parse(text) as unknown[]).map((entry) => this.normalizeOpenRevisionEntry(entry));
    }
    if (!contentType.includes("multipart/mixed")) {
      throw new Error(`unsupported open_revs response type: ${contentType || "unknown"}`);
    }
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (!boundaryMatch) {
      throw new Error("multipart open_revs response is missing a boundary");
    }
    const boundary = boundaryMatch[1]?.trim().replace(/^"|"$/g, "");
    if (!boundary) {
      throw new Error("multipart open_revs response boundary was empty");
    }
    return this.parseMultipartJsonParts(text, boundary).map((entry) => this.normalizeOpenRevisionEntry(entry));
  }

  private normalizeOpenRevisionEntry(entry: unknown): OpenRevisionEntry {
    if (entry && typeof entry === "object") {
      const objectEntry = entry as Record<string, unknown>;
      if ("ok" in objectEntry || "missing" in objectEntry) {
        return objectEntry as OpenRevisionEntry;
      }
      if (typeof objectEntry._id === "string" && typeof objectEntry._rev === "string") {
        return { ok: objectEntry as CouchNoteDoc };
      }
    }
    return { missing: String(entry) };
  }

  private parseMultipartJsonParts(payload: string, boundary: string): unknown[] {
    const marker = `--${boundary}`;
    return payload
      .split(marker)
      .map((part) => part.trim())
      .filter((part) => part && part !== "--")
      .map((part) => {
        const cleaned = part.endsWith("--") ? part.slice(0, -2).trim() : part;
        const separator = cleaned.search(/\r?\n\r?\n/);
        const body = separator >= 0 ? cleaned.slice(separator).replace(/^\r?\n\r?\n/, "") : cleaned;
        return JSON.parse(body.trim()) as unknown;
      });
  }

  private async inspectConflicts(
    vault: ResolvedVaultConfig,
    notePath: string,
    currentDoc?: CouchNoteDoc,
    trackedDocId?: string,
  ): Promise<{ currentDoc?: CouchNoteDoc; conflictDetected: boolean; autoResolved: boolean }> {
    const probe = currentDoc?._id
      ? await this.fetchConflictProbeByDocId(vault, currentDoc._id)
      : await this.fetchConflictProbeByPath(vault, notePath, trackedDocId);
    const readableProbe = await this.decodeNoteDoc(vault, probe);
    const bundle = await this.fetchConflictBundle(vault, probe);
    if (!bundle || bundle.conflicts.length === 0) {
      return { currentDoc: readableProbe, conflictDetected: false, autoResolved: false };
    }

    if (vault.autoResolveConflicts && this.isVaultWritebackCompatible(vault)) {
      if ([bundle.current, ...bundle.conflicts].some((entry) => !entry.deleted && entry.content === null)) {
        return { currentDoc: bundle.current.doc, conflictDetected: true, autoResolved: false };
      }
      const signatures = [bundle.current, ...bundle.conflicts].map((entry) =>
        normalizeConflictComparableContent(entry.content, entry.deleted),
      );
      if (new Set(signatures).size === 1) {
        const resolvedConflict = this.buildConflictState(probe, bundle);
        await this.deleteConflictRevisions(vault, bundle.current.doc._id, bundle.conflicts.map((entry) => entry.rev));
        const runtime = this.ensureVaultState(vault.id);
        runtime.resolvedConflicts ??= {};
        runtime.resolvedConflicts[notePath] = {
          ...resolvedConflict,
          resolution: "keep_current",
          resolutionReason: "Automatically resolved because every revision normalized to the same content.",
          resolvedAt: new Date().toISOString(),
        };
        delete runtime.conflicts[notePath];
        await this.writeState();
        this.notifyVault(vault, `Vault ${vault.id}: automatically resolved a benign conflict for ${notePath}.`, {
          kind: "conflict",
          contextKey: `vault:${vault.id}:conflict:auto:${notePath}`,
        });
        return { currentDoc: bundle.current.doc, conflictDetected: true, autoResolved: true };
      }
    }

    this.ensureVaultState(vault.id).conflicts[notePath] = this.buildConflictState(probe, bundle);
    await this.writeState();
    this.notifyVault(
      vault,
      `Vault ${vault.id}: conflict detected for ${notePath}. Ask me to inspect conflicts or resolve one explicitly.`,
      {
        kind: "conflict",
        contextKey: `vault:${vault.id}:conflict:${notePath}`,
      },
    );
    return { currentDoc: bundle.current.doc, conflictDetected: true, autoResolved: false };
  }

  private buildConflictState(currentDoc: CouchNoteDoc, bundle: ConflictBundle): StoredConflictState {
    const revisions: ConflictRevisionState[] = [bundle.current, ...bundle.conflicts].map((entry) => ({
      rev: entry.rev,
      deleted: entry.deleted,
      mtime: entry.doc.mtime,
      ctime: entry.doc.ctime,
      summary: summarizeConflictContent(entry.content, entry.deleted),
      diffPreview:
        entry.rev === bundle.current.rev
          ? undefined
          : buildDiffPreview(bundle.current.content, entry.deleted ? null : entry.content),
    }));
    return {
      path: bundle.current.doc.path ?? currentDoc.path ?? currentDoc._id,
      docId: currentDoc._id,
      winnerRev: currentDoc._rev,
      revisions,
      detectedAt: new Date().toISOString(),
    };
  }

  private chooseConflictWinner(
    bundle: ConflictBundle,
    strategy: "keep_current" | "keep_latest_mtime" | "use_revision",
    winnerRev?: string,
  ): RevisionContent {
    if (strategy === "keep_current") {
      return bundle.current;
    }
    if (strategy === "keep_latest_mtime") {
      return [bundle.current, ...bundle.conflicts].reduce((latest, candidate) => {
        const latestMtime = latest.doc.mtime ?? 0;
        const candidateMtime = candidate.doc.mtime ?? 0;
        return candidateMtime > latestMtime ? candidate : latest;
      }, bundle.current);
    }
    if (!winnerRev) {
      throw new Error("winnerRev is required when strategy=use_revision");
    }
    const match = [bundle.current, ...bundle.conflicts].find((entry) => entry.rev === winnerRev);
    if (!match) {
      throw new Error(`winner revision ${winnerRev} is not part of the current conflict set`);
    }
    return match;
  }

  private async deleteConflictRevisions(vault: ResolvedVaultConfig, docId: string, revs: string[]): Promise<void> {
    if (revs.length === 0) {
      return;
    }
    await this.fetchJson<Record<string, unknown>>(vault, "/_bulk_docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docs: revs.map((rev) => ({ _id: docId, _deleted: true, _rev: rev })),
      }),
    });
  }

  private async fetchJson<T>(vault: ResolvedVaultConfig, relativePath: string, init: RequestInit = {}): Promise<T> {
    const url = `${vault.url}/${encodeURIComponent(vault.database)}${relativePath}`;
    return this.fetchAbsoluteJson<T>(url, {
      ...init,
      headers: {
        ...this.buildVaultHeaders(vault),
        ...init.headers,
      },
      timeoutMs: vault.requestTimeoutMs,
    } as RequestInit & { timeoutMs?: number });
  }

  private async decodeNoteDoc(vault: ResolvedVaultConfig, doc: CouchNoteDoc): Promise<CouchNoteDoc> {
    const readableDoc: CouchNoteDoc = {
      ...doc,
      children: doc.children ? [...doc.children] : doc.children,
      eden: doc.eden ? { ...doc.eden } : doc.eden,
    };

    if (typeof readableDoc.path === "string") {
      if (readableDoc.path.startsWith(ENCRYPTED_META_PREFIX)) {
        const metadata = await this.decryptHkdfMetadata(vault, readableDoc.path);
        readableDoc.path = metadata.path;
        readableDoc.mtime = metadata.mtime;
        readableDoc.ctime = metadata.ctime;
        readableDoc.size = metadata.size;
        readableDoc.children = metadata.children ?? readableDoc.children;
      } else if (isPathProbablyObfuscated(readableDoc.path)) {
        readableDoc.path = await this.tryDecryptLegacyString(vault, readableDoc.path);
      }
    }

    if (typeof readableDoc.data === "string" && readableDoc.e_) {
      readableDoc.data = await this.decryptLiveSyncString(vault, readableDoc.data);
      delete readableDoc.e_;
    }

    if (readableDoc.eden && Object.keys(readableDoc.eden).length > 0) {
      let decryptedEden: Record<string, { data?: string; epoch?: number }> | undefined;

      const legacyEden = readableDoc.eden[EDEN_ENCRYPTED_KEY]?.data;
      if (typeof legacyEden === "string") {
        decryptedEden = {
          ...(decryptedEden ?? readableDoc.eden),
          ...JSON.parse(await this.tryDecryptLegacyString(vault, legacyEden)) as Record<string, { data?: string; epoch?: number }>,
        };
      }

      const hkdfEden = readableDoc.eden[EDEN_ENCRYPTED_KEY_HKDF]?.data;
      if (typeof hkdfEden === "string") {
        decryptedEden = {
          ...(decryptedEden ?? readableDoc.eden),
          ...JSON.parse(await this.decryptHkdfString(vault, hkdfEden)) as Record<string, { data?: string; epoch?: number }>,
        };
      }

      if (decryptedEden) {
        delete decryptedEden[EDEN_ENCRYPTED_KEY];
        delete decryptedEden[EDEN_ENCRYPTED_KEY_HKDF];
        readableDoc.eden = decryptedEden;
      }
    }

    return readableDoc;
  }

  private async decodeLeafDoc(vault: ResolvedVaultConfig, doc: CouchLeafDoc): Promise<CouchLeafDoc> {
    if (!(typeof doc.data === "string" && doc.e_)) {
      return doc;
    }
    return {
      ...doc,
      data: await this.decryptLiveSyncString(vault, doc.data),
      e_: undefined,
    };
  }

  private async decryptLiveSyncString(vault: ResolvedVaultConfig, input: string): Promise<string> {
    if (input.startsWith("%$")) {
      return decryptWithEphemeralSalt(input, this.requireVaultPassphrase(vault));
    }
    if (input.startsWith("%=")) {
      return this.decryptHkdfString(vault, input);
    }
    return this.tryDecryptLegacyString(vault, input);
  }

  private async decryptHkdfMetadata(vault: ResolvedVaultConfig, encryptedPath: string): Promise<DecryptedMetaProps> {
    const decrypted = await this.decryptHkdfString(vault, encryptedPath.slice(ENCRYPTED_META_PREFIX.length));
    return JSON.parse(decrypted) as DecryptedMetaProps;
  }

  private async decryptHkdfString(vault: ResolvedVaultConfig, input: string): Promise<string> {
    return decryptHkdf(input, this.requireVaultPassphrase(vault), await this.getReplicationPbkdf2Salt(vault));
  }

  private async tryDecryptLegacyString(vault: ResolvedVaultConfig, input: string): Promise<string> {
    const passphrase = this.requireVaultPassphrase(vault);
    try {
      return await decryptLegacy(input, passphrase, false);
    } catch {
      return decryptLegacy(input, passphrase, true);
    }
  }

  private requireVaultPassphrase(vault: ResolvedVaultConfig): string {
    if (!vault.passphrase) {
      throw new Error(`vault ${vault.id} is missing a LiveSync passphrase`);
    }
    return vault.passphrase;
  }

  private async getReplicationPbkdf2Salt(vault: ResolvedVaultConfig): Promise<Uint8Array<ArrayBuffer>> {
    const cacheKey = `${vault.url}/${vault.database}`;
    const cached = this.replicationSaltCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const fetchSalt = (async () => {
      const syncParams = await this.fetchJson<CouchSyncParametersDoc>(
        vault,
        `/${encodeURIComponent(SYNC_PARAMETERS_DOC_ID)}`,
      );
      if (!syncParams?.pbkdf2salt) {
        throw new Error(`vault ${vault.id} is missing remote PBKDF2 salt`);
      }
      return Uint8Array.from(Buffer.from(syncParams.pbkdf2salt, "base64")) as Uint8Array<ArrayBuffer>;
    })().catch((error) => {
      this.replicationSaltCache.delete(cacheKey);
      throw error;
    });

    this.replicationSaltCache.set(cacheKey, fetchSalt);
    return fetchSalt;
  }

  private async fetchAbsoluteJson<T>(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const response = await this.fetchAbsoluteResponse(url, init);
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private async fetchAbsoluteResponse(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
    const externalSignal = init.signal;
    const abortFromExternal = () => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortFromExternal();
      } else {
        externalSignal.addEventListener("abort", abortFromExternal, { once: true });
      }
    }
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
      }
      return response;
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortFromExternal);
      }
      clearTimeout(timer);
    }
  }

  private buildVaultHeaders(vault: ResolvedVaultConfig): Record<string, string> {
    const headers = { ...vault.headers };
    if (vault.username || vault.password) {
      headers.Authorization = `Basic ${Buffer.from(`${vault.username ?? ""}:${vault.password ?? ""}`).toString("base64")}`;
    }
    return headers;
  }

  private notifyVault(
    vault: ResolvedVaultConfig,
    text: string,
    params: { kind: "error" | "conflict"; contextKey: string },
  ): void {
    const sessionKey = vault.notifications.sessionKey?.trim();
    if (!sessionKey || !this.notifySystemEvent) {
      return;
    }
    if (params.kind === "error" && !vault.notifications.onError) {
      return;
    }
    if (params.kind === "conflict" && !vault.notifications.onConflict) {
      return;
    }

    const runtime = this.ensureVaultState(vault.id);
    const dedupeWindowMs = vault.notifications.dedupeWindowSeconds * 1000;
    const messageHash = sha256(text);
    const previous = runtime.notifications?.[params.contextKey];
    if (dedupeWindowMs > 0 && previous?.lastMessageHash === messageHash) {
      const lastSentAtMs = Date.parse(previous.lastSentAt);
      if (Number.isFinite(lastSentAtMs) && Date.now() - lastSentAtMs < dedupeWindowMs) {
        return;
      }
    }

    runtime.notifications ??= {};
    runtime.notifications[params.contextKey] = {
      lastSentAt: new Date().toISOString(),
      lastMessageHash: messageHash,
    };

    this.notifySystemEvent(text, {
      sessionKey,
      contextKey: params.contextKey,
      wakeAgent: vault.notifications.wakeAgent,
    });
  }

  private notifyMemify(
    vault: ResolvedVaultConfig,
    text: string,
    sessionKeyOverride: string | undefined,
    contextKey: string,
  ): void {
    const sessionKey = sessionKeyOverride?.trim() || vault.notifications.sessionKey?.trim();
    if (!sessionKey || !this.notifySystemEvent) {
      return;
    }
    this.notifySystemEvent(text, {
      sessionKey,
      contextKey,
      wakeAgent: vault.notifications.wakeAgent,
    });
  }

  private async preemptBackgroundTaskForManualRun(
    vaultId: string,
    manualOperation: "sync" | "repair",
    requestedBy?: "tool" | "cli" | "automation" | "service",
  ): Promise<void> {
    if (requestedBy !== "tool" && requestedBy !== "cli") {
      return;
    }

    const activeTask = this.activeTasks.get(vaultId);
    if (!activeTask) {
      return;
    }

    if (activeTask.state.requestedBy !== "service" && activeTask.state.requestedBy !== "automation") {
      return;
    }

    const activePromise =
      activeTask.state.kind === "sync"
        ? this.inFlight.get(vaultId)
        : activeTask.state.kind === "memify"
          ? this.memifyInFlight.get(vaultId)
          : undefined;
    if (!activePromise) {
      return;
    }

    await this.stopVaultTask(
      vaultId,
      `Preempted ${activeTask.state.kind} so manual ${manualOperation} can start immediately.`,
    );
    await activePromise.catch(() => undefined);
  }

  private beginVaultTask(
    vaultId: string,
    kind: VaultTaskKind,
    params: {
      trigger?: StoredVaultTaskState["trigger"];
      requestedBy?: StoredVaultTaskState["requestedBy"];
    } = {},
  ): TaskExecutionContext {
    const runtime = this.ensureVaultState(vaultId);
    const state: StoredVaultTaskState = {
      kind,
      status: "running",
      startedAt: new Date().toISOString(),
      trigger: params.trigger,
      requestedBy: params.requestedBy,
    };
    const activeTask: ActiveVaultTask = {
      state,
      controller: new AbortController(),
    };
    this.activeTasks.set(vaultId, activeTask);
    runtime.currentTask = state;
    return {
      signal: activeTask.controller.signal,
      state,
    };
  }

  private async finishVaultTask(
    vaultId: string,
    state: StoredVaultTaskState,
    outcome: {
      status: StoredVaultTaskState["status"];
      error?: string;
      cancelReason?: string;
    },
  ): Promise<void> {
    const runtime = this.ensureVaultState(vaultId);
    const finishedState: StoredVaultTaskState = {
      ...state,
      status: outcome.status,
      finishedAt: new Date().toISOString(),
      error: outcome.error,
      cancelReason: outcome.cancelReason ?? state.cancelReason,
      cancelRequestedAt: state.cancelRequestedAt,
    };
    runtime.currentTask = undefined;
    runtime.lastTask = finishedState;
    const activeTask = this.activeTasks.get(vaultId);
    if (activeTask?.state.startedAt === state.startedAt && activeTask.state.kind === state.kind) {
      this.activeTasks.delete(vaultId);
    }
    await this.writeState();
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? "Task cancelled"));
    }
  }

  private isCancellationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message === "Task cancelled" || message.includes("abort") || message.includes("cancel");
  }

  private runExclusive<T>(vaultId: string, task: () => Promise<T>): Promise<T> {
    // Serialize all mutating work for a vault so sync, repair, writeback,
    // conflict resolution, and memify cannot interleave state updates.
    const previous = this.vaultOperationTails.get(vaultId) ?? Promise.resolve();
    let releaseTail: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const queuedTail = previous.catch(() => undefined).then(() => tail);
    this.vaultOperationTails.set(vaultId, queuedTail);
    return previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        releaseTail?.();
        if (this.vaultOperationTails.get(vaultId) === queuedTail) {
          this.vaultOperationTails.delete(vaultId);
        }
      });
  }

  private ensureVaultState(vaultId: string): VaultRuntimeState {
    if (!this.state.vaults[vaultId]) {
      const vault = this.config.vaults.find((candidate) => candidate.id === vaultId);
      this.state.vaults[vaultId] = {
        lastSeq: "0",
        notes: {},
        conflicts: {},
        resolvedConflicts: {},
        notifications: {},
        memify: createIdleMemifyState(vault?.automation.memify.allSnapshots ?? false),
      };
    }
    const runtime = this.state.vaults[vaultId] as VaultRuntimeState;
    runtime.notes ??= {};
    runtime.conflicts ??= {};
    runtime.resolvedConflicts ??= {};
    runtime.notifications ??= {};
    const vault = this.config.vaults.find((candidate) => candidate.id === vaultId);
    runtime.memify ??= createIdleMemifyState(vault?.automation.memify.allSnapshots ?? false);
    return runtime;
  }

  private requireVault(vaultId: string): ResolvedVaultConfig {
    const vault = this.config.vaults.find((candidate) => candidate.id === vaultId);
    if (!vault) {
      throw new Error(`unknown vault: ${vaultId}`);
    }
    return vault;
  }

  private isVaultWritebackCompatible(vault: ResolvedVaultConfig): boolean {
    return vault.mode === "read-write" && !(vault.encrypt || vault.passphrase || vault.usePathObfuscation);
  }

  private assertVaultWritebackCompatible(vault: ResolvedVaultConfig, vaultId: string): void {
    if (vault.mode !== "read-write") {
      throw new Error(`vault ${vaultId} is read-only`);
    }
    if (!this.isVaultWritebackCompatible(vault)) {
      const sourceHint = vault.configSource === "setup-uri" ? " from setupUri" : "";
      throw new Error(`vault ${vaultId} uses unsupported LiveSync encryption/obfuscation for writeback${sourceHint}`);
    }
  }

  private async writeState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await fs.writeFile(this.stateFilePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}