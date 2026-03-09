import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { encrypt as encryptHkdf, createPBKDF2Salt } from "octagonal-wheels/encryption/hkdf";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { resolvePluginConfig } from "./config.js";
import { ObsidianLivesyncCogneeController } from "./controller.js";
import type { ResolvedPluginConfig } from "./types.js";

const SETUP_URI_PREFIX = "obsidian://setuplivesync?settings=";
const ENCRYPTED_META_PREFIX = "/\\:";
const EDEN_ENCRYPTED_KEY_HKDF = "h:++encrypted-hkdf";
const SYNC_PARAMETERS_DOC_ID = "_local/obsidian_livesync_sync_parameters";
const couchUser = "obsidian_user";
const couchPassword = "obsidian_password";
const setupUriPassphrase = "patient-haze";
const vaultPassphrase = "vault-passphrase";

type SetupUriFixture = {
  config: ResolvedPluginConfig;
  vault: ResolvedPluginConfig["vaults"][number];
};

function createSetupUriPayloadV2(input: string, passphrase: string): string {
  const iv = randomBytes(16);
  const salt = randomBytes(16);
  const passphraseDigest = createHash("sha256").update(passphrase, "utf8").digest();
  const key = pbkdf2Sync(passphraseDigest, salt, 100000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(input, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `%${iv.toString("hex")}${salt.toString("hex")}${Buffer.concat([ciphertext, authTag]).toString("base64")}`;
}

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

function pathToDocumentId(filePath: string, passphrase: string, caseSensitive: boolean): string {
  const normalized = normalizePathForId(filePath, caseSensitive);
  const prefixSplit = normalized.split(":", 2);
  let prefix = "";
  let body = normalized;
  if (prefixSplit[1]) {
    prefix = `${prefixSplit[0]}:`;
    body = prefixSplit[1];
  }
  const hashedPassphrase = createHash("sha256").update(passphrase).digest("hex");
  return `${prefix}f:${createHash("sha256").update(`${hashedPassphrase}:${body}`).digest("hex")}`;
}

async function putCouchDoc(baseUrl: string, database: string, docId: string, body: unknown, authHeader: string): Promise<void> {
  const response = await fetch(`${baseUrl}/${database}/${encodeURIComponent(docId)}`, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
}

async function postCouchJson(baseUrl: string, database: string, endpoint: string, body: unknown, authHeader: string): Promise<void> {
  const response = await fetch(`${baseUrl}/${database}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
}

function createSetupUriFixture(baseUrl: string, database: string, mode: "read-only" | "read-write" = "read-only"): SetupUriFixture {
  const setupUriPayload = {
    couchDB_URI: baseUrl,
    couchDB_USER: couchUser,
    couchDB_PASSWORD: couchPassword,
    couchDB_DBNAME: database,
    encrypt: true,
    passphrase: vaultPassphrase,
    usePathObfuscation: true,
    handleFilenameCaseSensitive: false,
    settingVersion: 10,
  };
  const setupUri = `${SETUP_URI_PREFIX}${encodeURIComponent(
    createSetupUriPayloadV2(JSON.stringify(setupUriPayload), setupUriPassphrase),
  )}`;
  const config = resolvePluginConfig({
    vaults: [
      {
        id: "vault-a",
        setupUri,
        setupUriPassphrase,
        mode,
      },
    ],
  });
  return { config, vault: config.vaults[0]! };
}

async function putSyncParameters(baseUrl: string, database: string, authHeader: string, salt: Uint8Array<ArrayBuffer>): Promise<void> {
  await putCouchDoc(
    baseUrl,
    database,
    SYNC_PARAMETERS_DOC_ID,
    {
      _id: SYNC_PARAMETERS_DOC_ID,
      type: "sync-parameters",
      protocolVersion: 2,
      pbkdf2salt: Buffer.from(salt).toString("base64"),
    },
    authHeader,
  );
}

async function writeEncryptedSetupUriNote(params: {
  baseUrl: string;
  database: string;
  authHeader: string;
  vault: ResolvedPluginConfig["vaults"][number];
  notePath: string;
  content: string;
  ctime: number;
  mtime: number;
  salt?: Uint8Array<ArrayBuffer>;
}): Promise<{ noteId: string; salt: Uint8Array<ArrayBuffer> }> {
  const salt = params.salt ?? createPBKDF2Salt();
  await putSyncParameters(params.baseUrl, params.database, params.authHeader, salt);
  const noteId = pathToDocumentId(
    params.notePath,
    params.vault.passphrase ?? "",
    params.vault.handleFilenameCaseSensitive,
  );
  const encryptedMeta = `${ENCRYPTED_META_PREFIX}${await encryptHkdf(
    JSON.stringify({
      path: params.notePath,
      ctime: params.ctime,
      mtime: params.mtime,
      size: Buffer.byteLength(params.content, "utf8"),
      children: [],
    }),
    params.vault.passphrase ?? "",
    salt,
  )}`;
  await putCouchDoc(
    params.baseUrl,
    params.database,
    noteId,
    {
      _id: noteId,
      path: encryptedMeta,
      type: "plain",
      datatype: "plain",
      data: await encryptHkdf(params.content, params.vault.passphrase ?? "", salt),
      e_: true,
      children: [],
      ctime: 0,
      mtime: 0,
      size: 0,
      eden: {},
    },
    params.authHeader,
  );
  return { noteId, salt };
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath);
      }
      return [fullPath];
    }),
  );
  return nested.flat();
}

async function waitForCouch(baseUrl: string, authHeader: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/_up`, {
        headers: { Authorization: authHeader },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the container is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("couchdb container did not become ready in time");
}

describe("setup URI integration", () => {
  let container: StartedTestContainer;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    container = await new GenericContainer("couchdb:3.4")
      .withEnvironment({
        COUCHDB_USER: couchUser,
        COUCHDB_PASSWORD: couchPassword,
      })
      .withExposedPorts(5984)
      .start();
    baseUrl = `http://${container.getHost()}:${container.getMappedPort(5984)}`;
    const authHeader = `Basic ${Buffer.from(`${couchUser}:${couchPassword}`).toString("base64")}`;
    await waitForCouch(baseUrl, authHeader);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("decodes setupUri config and keeps encrypted writeback fail-closed", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-setup-uri-"));
    const database = `setupuri-${Date.now()}`;
    const authHeader = `Basic ${Buffer.from(`${couchUser}:${couchPassword}`).toString("base64")}`;

    const createDbResponse = await fetch(`${baseUrl}/${database}`, {
      method: "PUT",
      headers: { Authorization: authHeader },
    });
    expect(createDbResponse.ok).toBe(true);

    const { config } = createSetupUriFixture(baseUrl, database, "read-write");

    expect(config.vaults[0]?.configSource).toBe("setup-uri");
    expect(config.vaults[0]?.url).toBe(baseUrl);
    expect(config.vaults[0]?.database).toBe(database);
    expect(config.vaults[0]?.username).toBe(couchUser);
    expect(config.vaults[0]?.password).toBe(couchPassword);
    expect(config.vaults[0]?.passphrase).toBe(vaultPassphrase);
    expect(config.vaults[0]?.usePathObfuscation).toBe(true);

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const syncStats = await controller.syncVault("vault-a");
    expect(syncStats.vaultId).toBe("vault-a");
    expect(syncStats.notesUpserted).toBe(0);

    await expect(controller.writeNote("vault-a", "drafts/test.md", "hello")).rejects.toThrow(
      "unsupported LiveSync encryption/obfuscation for writeback",
    );

    const allDocsResponse = await fetch(`${baseUrl}/${database}/_all_docs`, {
      headers: { Authorization: authHeader },
    });
    const allDocs = (await allDocsResponse.json()) as { total_rows: number };
    expect(allDocs.total_rows).toBe(0);
  }, 120_000);

  it("rejects a wrong setupUri passphrase before controller start", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-setup-uri-"));
    const setupUriPayload = {
      couchDB_URI: baseUrl,
      couchDB_USER: couchUser,
      couchDB_PASSWORD: couchPassword,
      couchDB_DBNAME: "ignored-db",
      encrypt: true,
      passphrase: vaultPassphrase,
      usePathObfuscation: true,
      handleFilenameCaseSensitive: false,
      settingVersion: 10,
    };
    const setupUri = `${SETUP_URI_PREFIX}${encodeURIComponent(
      createSetupUriPayloadV2(JSON.stringify(setupUriPayload), setupUriPassphrase),
    )}`;

    expect(() =>
      resolvePluginConfig({
        vaults: [
          {
            id: "vault-a",
            setupUri,
            setupUriPassphrase: "wrong-passphrase",
          },
        ],
      }),
    ).toThrow("failed to decode setupUri");
  });

  it("reads HKDF-encrypted and obfuscated LiveSync notes in read-only mode", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-setup-uri-"));
    const database = `setupuri-encrypted-${Date.now()}`;
    const authHeader = `Basic ${Buffer.from(`${couchUser}:${couchPassword}`).toString("base64")}`;

    const createDbResponse = await fetch(`${baseUrl}/${database}`, {
      method: "PUT",
      headers: { Authorization: authHeader },
    });
    expect(createDbResponse.ok).toBe(true);

    const { config } = createSetupUriFixture(baseUrl, database);

    const notePath = "Encrypted/Note.md";
    const noteId = pathToDocumentId(notePath, vaultPassphrase, false);
    const chunkId = "h:chunk-remote";
    const edenChunkId = "h:chunk-eden";
    const salt = createPBKDF2Salt();
    const meta = {
      path: notePath,
      ctime: 1_725_000_000_000,
      mtime: 1_725_000_100_000,
      size: 11,
      children: [chunkId, edenChunkId],
    };
    const encryptedMeta = `${ENCRYPTED_META_PREFIX}${await encryptHkdf(JSON.stringify(meta), vaultPassphrase, salt)}`;
    const encryptedChunk = await encryptHkdf("hello ", vaultPassphrase, salt);
    const encryptedEden = await encryptHkdf(
      JSON.stringify({
        [edenChunkId]: {
          data: "world",
          epoch: 1,
        },
      }),
      vaultPassphrase,
      salt,
    );

    await putCouchDoc(
      baseUrl,
      database,
      SYNC_PARAMETERS_DOC_ID,
      {
        _id: SYNC_PARAMETERS_DOC_ID,
        type: "sync-parameters",
        protocolVersion: 2,
        pbkdf2salt: Buffer.from(salt).toString("base64"),
      },
      authHeader,
    );
    await putCouchDoc(
      baseUrl,
      database,
      chunkId,
      {
        _id: chunkId,
        type: "leaf",
        data: encryptedChunk,
        e_: true,
      },
      authHeader,
    );
    await putCouchDoc(
      baseUrl,
      database,
      noteId,
      {
        _id: noteId,
        path: encryptedMeta,
        type: "plain",
        datatype: "plain",
        children: [],
        ctime: 0,
        mtime: 0,
        size: 0,
        eden: {
          [EDEN_ENCRYPTED_KEY_HKDF]: {
            data: encryptedEden,
            epoch: 999999,
          },
        },
      },
      authHeader,
    );

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const syncStats = await controller.syncVault("vault-a");
    expect(syncStats.notesUpserted).toBe(1);
    expect(syncStats.unsupportedEntries).toBe(0);

    const status = controller.getStatuses()[0];
    expect(status).toBeDefined();
    const mirroredFiles = await collectFiles(status!.mirrorRoot);
    expect(mirroredFiles).toHaveLength(1);
    await expect(fs.readFile(mirroredFiles[0]!, "utf8")).resolves.toBe("hello world");
  }, 120_000);

  it("detects encrypted conflicts without remote cleanup in read-only mode", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-setup-uri-"));
    const database = `setupuri-encrypted-conflict-${Date.now()}`;
    const authHeader = `Basic ${Buffer.from(`${couchUser}:${couchPassword}`).toString("base64")}`;

    const createDbResponse = await fetch(`${baseUrl}/${database}`, {
      method: "PUT",
      headers: { Authorization: authHeader },
    });
    expect(createDbResponse.ok).toBe(true);

    const { config, vault } = createSetupUriFixture(baseUrl, database);

    const notePath = "Encrypted/Conflict.md";
    const noteId = pathToDocumentId(notePath, vault.passphrase ?? "", vault.handleFilenameCaseSensitive);
    const salt = createPBKDF2Salt();
    const currentBody = "current text";
    const conflictBody = "other text";
    const makeEncryptedMeta = async (mtime: number, size: number) =>
      `${ENCRYPTED_META_PREFIX}${await encryptHkdf(
        JSON.stringify({
          path: notePath,
          ctime: 1_725_100_000_000,
          mtime,
          size,
          children: [],
        }),
        vaultPassphrase,
        salt,
      )}`;

    await putSyncParameters(baseUrl, database, authHeader, salt);
    await postCouchJson(
      baseUrl,
      database,
      "_bulk_docs",
      {
        new_edits: false,
        docs: [
          {
            _id: noteId,
            _rev: "1-root",
            _revisions: { start: 1, ids: ["root"] },
            path: await makeEncryptedMeta(1_725_100_000_000, currentBody.length),
            type: "plain",
            datatype: "plain",
            data: await encryptHkdf("root text", vaultPassphrase, salt),
            e_: true,
            children: [],
            ctime: 0,
            mtime: 0,
            size: 0,
            eden: {},
          },
          {
            _id: noteId,
            _rev: "2-current",
            _revisions: { start: 2, ids: ["current", "root"] },
            path: await makeEncryptedMeta(1_725_100_200_000, currentBody.length),
            type: "plain",
            datatype: "plain",
            data: await encryptHkdf(currentBody, vaultPassphrase, salt),
            e_: true,
            children: [],
            ctime: 0,
            mtime: 0,
            size: 0,
            eden: {},
          },
          {
            _id: noteId,
            _rev: "2-conflict",
            _revisions: { start: 2, ids: ["conflict", "root"] },
            path: await makeEncryptedMeta(1_725_100_100_000, conflictBody.length),
            type: "plain",
            datatype: "plain",
            data: await encryptHkdf(conflictBody, vaultPassphrase, salt),
            e_: true,
            children: [],
            ctime: 0,
            mtime: 0,
            size: 0,
            eden: {},
          },
        ],
      },
      authHeader,
    );

    const preSyncConflictProbeResponse = await fetch(`${baseUrl}/${database}/${encodeURIComponent(noteId)}?conflicts=true`, {
      headers: { Authorization: authHeader },
    });
    expect(preSyncConflictProbeResponse.ok).toBe(true);
    const preSyncConflictProbe = (await preSyncConflictProbeResponse.json()) as { _conflicts?: string[] };
    expect(preSyncConflictProbe._conflicts).toHaveLength(1);

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const syncStats = await controller.syncVault("vault-a");

    expect(syncStats.notesUpserted).toBe(1);
    expect(syncStats.conflictsDetected).toBe(1);
    expect(syncStats.conflictsAutoResolved).toBe(0);

    const conflicts = controller.getConflicts("vault-a");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.path).toBe(notePath);
    expect(conflicts[0]?.revisions.map((entry) => entry.summary).sort()).toEqual([currentBody, conflictBody].sort());

    const conflictProbeResponse = await fetch(`${baseUrl}/${database}/${encodeURIComponent(noteId)}?conflicts=true`, {
      headers: { Authorization: authHeader },
    });
    expect(conflictProbeResponse.ok).toBe(true);
    const conflictProbe = (await conflictProbeResponse.json()) as { _conflicts?: string[] };
    expect(conflictProbe._conflicts).toHaveLength(1);
  }, 120_000);

  it("round-trips setup-uri-derived encrypted deep paths into the mirror tree", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-setup-uri-"));
    const database = `setupuri-encrypted-deep-${Date.now()}`;
    const authHeader = `Basic ${Buffer.from(`${couchUser}:${couchPassword}`).toString("base64")}`;

    const createDbResponse = await fetch(`${baseUrl}/${database}`, {
      method: "PUT",
      headers: { Authorization: authHeader },
    });
    expect(createDbResponse.ok).toBe(true);

    const { config, vault } = createSetupUriFixture(baseUrl, database);
    const notePath = "areas/2026/q1/launch/brief.md";
    const noteContent = "nested encrypted setup-uri note\n";

    await writeEncryptedSetupUriNote({
      baseUrl,
      database,
      authHeader,
      vault,
      notePath,
      content: noteContent,
      ctime: 1_725_200_000_000,
      mtime: 1_725_200_100_000,
    });

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const syncStats = await controller.syncVault("vault-a");
    expect(syncStats.notesUpserted).toBe(1);
    expect(syncStats.unsupportedEntries).toBe(0);

    const status = controller.getStatuses()[0];
    expect(status).toBeDefined();
    const mirroredPath = path.join(status!.mirrorRoot, "areas", "2026", "q1", "launch", "brief.md");
    await expect(fs.readFile(mirroredPath, "utf8")).resolves.toBe(noteContent);
  }, 120_000);
});