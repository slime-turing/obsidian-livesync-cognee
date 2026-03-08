export type VaultAccessMode = "read-only" | "read-write";

export type VaultSyncMode = "changes" | "full";

export type VaultNotificationConfig = {
  sessionKey?: string;
  onError: boolean;
  onConflict: boolean;
  wakeAgent: boolean;
  dedupeWindowSeconds: number;
};

export type VaultMemifyTrigger = "heartbeat" | "cron";

export type VaultMemifyAutomationConfig = {
  enabled: boolean;
  triggers: VaultMemifyTrigger[];
  minIntervalSeconds: number;
  allSnapshots: boolean;
  notifyOnStart: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
};

export type ResolvedCogneeTarget = {
  enabled: boolean;
  baseUrl?: string;
  datasetName?: string;
  datasetNames?: Record<string, string>;
  datasetId?: string;
  apiKey?: string;
  authToken?: string;
  username?: string;
  password?: string;
  nodeSet: string[];
  cognify: boolean;
  downloadHttpLinks: boolean;
  maxLinksPerNote: number;
  maxLinkBytes: number;
  searchType: "GRAPH_COMPLETION" | "CHUNKS";
  searchTopK: number;
  inheritedFrom?: "vault" | "memory-slot";
};

export type ResolvedVaultConfig = {
  id: string;
  url: string;
  database: string;
  username?: string;
  password?: string;
  headers: Record<string, string>;
  enabled: boolean;
  mode: VaultAccessMode;
  syncMode: VaultSyncMode;
  pollIntervalSeconds: number;
  requestTimeoutMs: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  mirrorRoot?: string;
  snapshotRoot?: string;
  passphrase?: string;
  usePathObfuscation: boolean;
  handleFilenameCaseSensitive: boolean;
  autoResolveConflicts: boolean;
  notifications: VaultNotificationConfig;
  automation: {
    memify: VaultMemifyAutomationConfig;
  };
  cognee: ResolvedCogneeTarget;
};

export type ResolvedPluginConfig = {
  vaults: ResolvedVaultConfig[];
};

export type StoredNoteState = {
  path: string;
  docId?: string;
  rev?: string;
  ctime?: number;
  mtime?: number;
  deleted?: boolean;
  lastSnapshotPath?: string;
  lastSyncedAt?: string;
  lastCogneeRevision?: string;
  lastCogneeDatasetKey?: string;
};

export type VaultTaskKind = "sync" | "memify" | "repair";

export type StoredVaultTaskState = {
  kind: VaultTaskKind;
  status: "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  trigger?: "timer" | "manual" | "heartbeat" | "cron";
  requestedBy?: "tool" | "cli" | "automation" | "service";
  cancelRequestedAt?: string;
  cancelReason?: string;
  error?: string;
};

export type ConflictRevisionState = {
  rev: string;
  deleted: boolean;
  mtime?: number;
  ctime?: number;
  summary: string;
  diffPreview?: string;
};

export type StoredConflictState = {
  path: string;
  docId: string;
  winnerRev?: string;
  revisions: ConflictRevisionState[];
  detectedAt: string;
  resolution?: string;
  resolutionReason?: string;
  resolvedAt?: string;
};

export type StoredMemifyRunState = {
  status: "idle" | "running" | "succeeded" | "failed";
  trigger?: "manual" | VaultMemifyTrigger;
  agentId?: string;
  sessionKey?: string;
  startedAt?: string;
  finishedAt?: string;
  allSnapshots: boolean;
  snapshotsConsidered: number;
  memified: boolean;
  error?: string;
};

export type VaultRuntimeState = {
  lastSeq: string;
  lastSyncAt?: string;
  lastError?: string;
  notes: Record<string, StoredNoteState>;
  conflicts: Record<string, StoredConflictState>;
  resolvedConflicts?: Record<string, StoredConflictState>;
  notifications?: Record<string, StoredNotificationState>;
  memify?: StoredMemifyRunState;
  currentTask?: StoredVaultTaskState;
  lastTask?: StoredVaultTaskState;
};

export type StoredNotificationState = {
  lastSentAt: string;
  lastMessageHash: string;
};

export type ControllerStateFile = {
  version: 1;
  vaults: Record<string, VaultRuntimeState>;
};

export type VaultStatus = {
  vaultId: string;
  enabled: boolean;
  mode: VaultAccessMode;
  syncMode: VaultSyncMode;
  lastSeq: string;
  lastSyncAt?: string;
  lastError?: string;
  noteCount: number;
  openConflictCount: number;
  mirrorRoot: string;
  snapshotRoot: string;
  cogneeEnabled: boolean;
  notifySessionKey?: string;
  memify: StoredMemifyRunState;
  currentTask?: StoredVaultTaskState;
  lastTask?: StoredVaultTaskState;
};

export type SyncRunStats = {
  vaultId: string;
  changesSeen: number;
  notesUpserted: number;
  notesDeleted: number;
  snapshotsWritten: number;
  cogneeUploads: number;
  cogneeFailures: number;
  unsupportedEntries: number;
  conflictsDetected: number;
  conflictsAutoResolved: number;
  lastSeq: string;
};

export type ConflictRecord = {
  vaultId: string;
  path: string;
  docId: string;
  winnerRev?: string;
  revisions: ConflictRevisionState[];
  detectedAt: string;
  resolution?: string;
  resolutionReason?: string;
  resolvedAt?: string;
};

export type NoteRecord = {
  vaultId: string;
  path: string;
  content: string;
  mirrorPath: string;
  snapshotPath?: string;
  exists: boolean;
  mtime?: number;
  ctime?: number;
  rev?: string;
  filenameHints: {
    dates: string[];
    people: string[];
    tokens: string[];
  };
  links: Array<{ url: string; kind: "http" | "relative" | "wiki" }>;
  relatedContext?: Array<{ datasetName?: string; sourcePath?: string; excerpt: string }>;
};

export type CogneeMemoryResult = {
  vaultId: string;
  datasetName?: string;
  datasetId?: string;
  answer?: string;
  sources: Array<{
    sourcePath?: string;
    excerpt: string;
    datasetName?: string;
    datasetId?: string;
  }>;
  raw: unknown;
};

export type VaultCompactionResult = {
  vaultId: string;
  accepted: boolean;
};

export type VaultMemifyResult = {
  vaultId: string;
  snapshotsConsidered: number;
  memified: boolean;
  datasetId?: string;
  datasetName?: string;
};

export type VaultPurgeOptions = {
  mirror: boolean;
  snapshots: boolean;
  state: boolean;
  cogneeDataset: boolean;
};

export type VaultPurgeResult = {
  vaultId: string;
  removedPaths: string[];
  stateReset: boolean;
  cogneeDatasetDeleted: boolean;
  datasetId?: string;
  datasetName?: string;
};

export type VaultRepairResult = {
  vaultId: string;
  mirrorRoot: string;
  snapshotRoot: string;
  rebuildSnapshots: boolean;
  sync: SyncRunStats;
};

export type VaultTaskStopResult = {
  vaultId: string;
  stopped: boolean;
  task?: StoredVaultTaskState;
};

export type CouchLeafDoc = {
  _id: string;
  _rev?: string;
  type: "leaf";
  data?: string;
  _deleted?: boolean;
};

export type CouchNoteDoc = {
  _id: string;
  _rev?: string;
  path?: string;
  type?: string;
  datatype?: string;
  data?: string | string[];
  children?: string[];
  ctime?: number;
  mtime?: number;
  size?: number;
  deleted?: boolean;
  _deleted?: boolean;
  _conflicts?: string[];
  eden?: Record<string, { data?: string; epoch?: number }>;
};

export type CouchChangeRow = {
  seq: string | number;
  id: string;
  deleted?: boolean;
  doc?: CouchNoteDoc | CouchLeafDoc;
};

export type CouchChangesResponse = {
  results: CouchChangeRow[];
  last_seq: string | number;
  pending?: number;
};