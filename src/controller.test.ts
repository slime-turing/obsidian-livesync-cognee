import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObsidianLivesyncCogneeController } from "./controller.js";
import type { ResolvedPluginConfig } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached in time");
}

function createConfig(overrides: Partial<ResolvedPluginConfig["vaults"][number]> = {}): ResolvedPluginConfig {
  return {
    vaults: [
      {
        id: "vault-a",
        url: "https://couchdb.example.invalid",
        database: "vault-a-db",
        headers: {},
        enabled: true,
        mode: "read-only",
        syncMode: "changes",
        pollIntervalSeconds: 3600,
        requestTimeoutMs: 5000,
        includeGlobs: [],
        excludeGlobs: [],
        usePathObfuscation: false,
        handleFilenameCaseSensitive: false,
        autoResolveConflicts: true,
        notifications: {
          onError: true,
          onConflict: true,
          wakeAgent: true,
          sessionKey: "session:main",
          dedupeWindowSeconds: 300,
        },
        automation: {
          memify: {
            enabled: false,
            triggers: [],
            minIntervalSeconds: 3600,
            allSnapshots: false,
            notifyOnStart: false,
            notifyOnSuccess: true,
            notifyOnFailure: true,
          },
        },
        cognee: {
          enabled: false,
          nodeSet: [],
          cognify: true,
          downloadHttpLinks: true,
          maxLinksPerNote: 3,
          maxLinkBytes: 1024,
          searchType: "CHUNKS",
          searchTopK: 5,
        },
        ...overrides,
      },
    ],
  };
}

describe("obsidian-livesync-cognee controller", () => {
  let tempDir: string;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-sync-"));
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("syncs a plain note into the local mirror", async () => {
    const config = createConfig();

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const stats = await controller.syncVault("vault-a");
    expect(stats.notesUpserted).toBe(1);
    expect(stats.conflictsDetected).toBe(0);

    const statuses = controller.getStatuses();
    const mirrorFile = path.join(statuses[0]!.mirrorRoot, "daily", "note.md");
    await expect(fs.readFile(mirrorFile, "utf8")).resolves.toContain("hello from vault");
  });

  it("writes a plain note back to a read-write vault", async () => {
    const putCalls: Array<{ url: string; body: string }> = [];
    const config = createConfig({ mode: "read-write" });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        putCalls.push({ url, body: String(init.body ?? "") });
        return new Response(JSON.stringify({ ok: true, rev: "2-b" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const result = await controller.writeNote("vault-a", "drafts/test.md", "body");
    expect(result.rev).toBe("2-b");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.body).toContain('"type":"plain"');
    expect(putCalls[0]?.body).toContain('"path":"drafts/test.md"');
  });

  it("uses the documented CouchDB protocol surface across sync, read, write, conflict, and compact operations", async () => {
    const requests: string[] = [];
    const config = createConfig({ mode: "read-write" });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);

      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("chunked%2Fnote.md")) {
        return new Response(
          JSON.stringify({
            _id: "chunked/note.md",
            _rev: "3-a",
            path: "chunked/note.md",
            type: "plain",
            datatype: "plain",
            children: ["leaf-1"],
            ctime: 3,
            mtime: 4,
            size: 11,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/leaf-1")) {
        return new Response(JSON.stringify({ _id: "leaf-1", type: "leaf", data: "chunk body\n" }), { status: 200 });
      }
      if (url.endsWith("drafts%2Ftest.md") && method === "GET") {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("drafts%2Ftest.md") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true, rev: "2-b" }), { status: 200 });
      }
      if (url.endsWith("conflicted%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "conflicted/note.md",
            _rev: "2-current",
            _conflicts: ["2-other"],
            path: "conflicted/note.md",
            type: "plain",
            datatype: "plain",
            data: ["current body\n"],
            children: [],
            ctime: 10,
            mtime: 20,
            size: 13,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("conflicted%2Fnote.md?open_revs=all")) {
        return new Response(
          JSON.stringify([
            {
              ok: {
                _id: "conflicted/note.md",
                _rev: "2-current",
                path: "conflicted/note.md",
                type: "plain",
                datatype: "plain",
                data: ["current body\n"],
                children: [],
                ctime: 10,
                mtime: 20,
                size: 13,
                eden: {},
              },
            },
            {
              ok: {
                _id: "conflicted/note.md",
                _rev: "2-other",
                path: "conflicted/note.md",
                type: "plain",
                datatype: "plain",
                data: ["other body\n"],
                children: [],
                ctime: 10,
                mtime: 30,
                size: 11,
                eden: {},
              },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("conflicted%2Fnote.md") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true, rev: "3-resolved" }), { status: 200 });
      }
      if (url.includes("_bulk_docs") && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      if (url.endsWith("/_compact") && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }

      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");
    await controller.readNote("vault-a", "chunked/note.md");
    await controller.writeNote("vault-a", "drafts/test.md", "body");
    await controller.resolveConflict("vault-a", "conflicted/note.md", "keep_latest_mtime");
    await controller.compactVault("vault-a");

    const paths = Array.from(
      new Set(
        requests.map((entry) =>
          entry.replace("https://couchdb.example.invalid/vault-a-db", "").replace(/since=[^& ]+/, "since=<seq>"),
        ),
      ),
    );

    expect(paths).toMatchInlineSnapshot(`
      [
        "GET /_changes?include_docs=true&limit=200&since=<seq>",
        "GET /daily%2Fnote.md?conflicts=true",
        "GET /chunked%2Fnote.md",
        "GET /leaf-1",
        "GET /drafts%2Ftest.md",
        "PUT /drafts%2Ftest.md",
        "GET /conflicted%2Fnote.md?conflicts=true",
        "GET /conflicted%2Fnote.md?open_revs=all",
        "PUT /conflicted%2Fnote.md",
        "POST /_bulk_docs",
        "POST /_compact",
      ]
    `);
  });

  it("uses the agent-scoped dataset name during sync uploads", async () => {
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "default-dataset",
        datasetNames: {
          asst: "asst-dataset",
        },
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        const form = init?.body as FormData;
        expect(form.get("datasetName")).toBe("asst-dataset");
        expect(form.get("datasetId")).toBeNull();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/cognify") {
        expect(String(init?.body ?? "")).toContain("asst-dataset");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const stats = await controller.syncVault("vault-a", { agentId: "asst" });
    expect(stats.cogneeUploads).toBe(1);
  });

  it("uses the documented Cognee protocol surface across search, add, cognify, memify, and dataset purge", async () => {
    const requests: string[] = [];
    const config = createConfig({
      mode: "read-write",
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "asst-dataset",
        datasetNames: { asst: "asst-dataset" },
        nodeSet: ["Note"],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "GRAPH_COMPLETION",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);

      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/cognify") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/datasets") {
        return new Response(JSON.stringify([{ id: "ds1", name: "asst-dataset" }]), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/search") {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "result-1",
                dataset_id: "ds1",
                dataset_name: "asst-dataset",
                search_result: "source_path: daily/note.md\n\nhello from cognee",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/memify") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/datasets/ds1" && method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a", { agentId: "asst" });
    await controller.queryCogneeMemory({ query: "what happened", agentId: "asst", includeAnswer: true });
    await controller.memifyVault("vault-a", { agentId: "asst" });
    await controller.purgeVaultData("vault-a", { mirror: false, snapshots: false, state: false, cogneeDataset: true });

    const paths = Array.from(
      new Set(
        requests
          .map((entry) => entry.replace("https://couchdb.example.invalid/vault-a-db", ""))
          .filter((entry) => entry.includes("https://cognee.example.invalid") || entry.startsWith("GET /_changes") || entry.endsWith("?conflicts=true")),
      ),
    );

    expect(paths).toMatchInlineSnapshot(`
      [
        "GET /_changes?include_docs=true&limit=200&since=0",
        "GET /daily%2Fnote.md?conflicts=true",
        "POST https://cognee.example.invalid/api/v1/add",
        "POST https://cognee.example.invalid/api/v1/cognify",
        "GET https://cognee.example.invalid/api/v1/datasets",
        "POST https://cognee.example.invalid/api/v1/search",
        "POST https://cognee.example.invalid/api/v1/memify",
        "DELETE https://cognee.example.invalid/api/v1/datasets/ds1",
      ]
    `);
  });

  it("auto-resolves benign conflicts and notifies the configured session", async () => {
    const notifySystemEvent = vi.fn();
    const config = createConfig();

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "2-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["same text\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 10,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "2-a",
            _conflicts: ["1-b"],
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["same text\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 10,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?open_revs=all")) {
        return new Response(
          [
            "--open-revs-boundary",
            "Content-Type: application/json",
            "",
            JSON.stringify({
              ok: {
                _id: "daily/note.md",
                _rev: "2-a",
                path: "daily/note.md",
                type: "plain",
                datatype: "plain",
                data: ["same text\n"],
                children: [],
                ctime: 1,
                mtime: 2,
                size: 10,
                eden: {},
              },
            }),
            "--open-revs-boundary",
            "Content-Type: application/json",
            "",
            JSON.stringify({
              ok: {
                _id: "daily/note.md",
                _rev: "1-b",
                path: "daily/note.md",
                type: "plain",
                datatype: "plain",
                data: ["same text\n"],
                children: [],
                ctime: 1,
                mtime: 1,
                size: 10,
                eden: {},
              },
            }),
            "--open-revs-boundary--",
            "",
          ].join("\r\n"),
          {
            status: 200,
            headers: { "Content-Type": 'multipart/mixed; boundary="open-revs-boundary"' },
          },
        );
      }
      if (url.includes("_bulk_docs") && init?.method === "POST") {
        return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
      notifySystemEvent,
    });

    const stats = await controller.syncVault("vault-a");
    expect(stats.conflictsDetected).toBe(1);
    expect(stats.conflictsAutoResolved).toBe(1);
    expect(controller.getConflicts("vault-a")).toEqual([]);
    expect(notifySystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("automatically resolved a benign conflict"),
      expect.objectContaining({ sessionKey: "session:main", wakeAgent: true }),
    );
  });

  it("queries Cognee memory and exposes source-aware context", async () => {
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "default-dataset",
        datasetNames: {
          "agent-main": "vault_a",
        },
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://cognee.example.invalid/api/v1/search") {
        return new Response(
          JSON.stringify([
            {
              dataset_name: "vault_a",
              dataset_id: "dataset-1",
              search_result:
                'source_path: "daily/note.md"\nsource_revision: "2-a"\n\nImportant paragraph from the synced snapshot.',
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const results = await controller.queryCogneeMemory({ query: "important paragraph" });
    expect(results).toHaveLength(1);
    expect(results[0]?.sources[0]?.sourcePath).toBe("daily/note.md");
    expect(results[0]?.sources[0]?.excerpt).toContain("Important paragraph");
  });

  it("can override Cognee search type for explicit graph exploration", async () => {
    const requestBodies: string[] = [];
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "https://cognee.example.invalid/api/v1/search") {
        requestBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify([
            {
              dataset_name: "vault_a",
              dataset_id: "dataset-1",
              search_result: 'source_path: "projects/graph.md"\n\nAlice depends on Bob via project graph.',
            },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const results = await controller.queryCogneeMemory({
      query: "how is Alice connected to Bob?",
      searchTypeOverride: "GRAPH_COMPLETION",
      includeAnswer: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.sources[0]?.sourcePath).toBe("projects/graph.md");
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toContain('"search_type":"GRAPH_COMPLETION"');
  });

  it("skips explicit graph search when the current agent does not resolve to a vault dataset", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("search should not be attempted without a mapped dataset");
    });
    global.fetch = fetchSpy as typeof fetch;

    const warn = vi.fn();
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: undefined,
        datasetId: undefined,
        datasetNames: {},
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "GRAPH_COMPLETION",
        searchTopK: 4,
      },
    });

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const results = await controller.queryCogneeMemory({
      query: "who approved Cedar?",
      agentId: "asst",
      searchTypeOverride: "GRAPH_COMPLETION",
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("queryCogneeMemory skipped because no Cognee-mapped vault matched"),
    );
  });

  it("falls back to legacy Cognee search payloads when the modern schema is rejected", async () => {
    const requestBodies: string[] = [];
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "https://cognee.example.invalid/api/v1/datasets") {
        return new Response(JSON.stringify([{ id: "dataset-1", name: "vault_a" }]), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/search") {
        requestBodies.push(String(init?.body ?? ""));
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.query !== undefined) {
          return new Response(JSON.stringify({ error: "maximum recursion depth exceeded" }), { status: 409 });
        }
        return new Response(
          JSON.stringify([
            '{"path":"daily/note.md","content":"Important paragraph from the synced snapshot."}',
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const results = await controller.queryCogneeMemory({ query: "important paragraph" });

    expect(results).toHaveLength(1);
    expect(results[0]?.sources[0]?.excerpt).toContain("Important paragraph from the synced snapshot");
    expect(results[0]?.datasetId).toBe("dataset-1");
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toContain('"query":"important paragraph"');
    expect(requestBodies[1]).toContain('"queryText":"important paragraph"');
    expect(requestBodies[1]).toContain('"datasetIds":["dataset-1"]');
  });

  it("deduplicates repeated notifications for the same problem within the configured window", async () => {
    const notifySystemEvent = vi.fn();
    const config = createConfig({
      notifications: {
        onError: true,
        onConflict: true,
        wakeAgent: true,
        sessionKey: "session:main",
        dedupeWindowSeconds: 300,
      },
    });

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  children: ["leaf-1"],
                  ctime: 1,
                  mtime: 2,
                  size: 0,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            children: ["leaf-1"],
            ctime: 1,
            mtime: 2,
            size: 0,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/leaf-1")) {
        return new Response(JSON.stringify({ _id: "leaf-1", type: "leaf", data: 42 }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
      notifySystemEvent,
    });

    await controller.syncVault("vault-a");
    await controller.syncVault("vault-a");

    expect(notifySystemEvent).toHaveBeenCalledTimes(1);
    expect(notifySystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("unsupported note encoding"),
      expect.objectContaining({ sessionKey: "session:main" }),
    );
  });

  it("supports manual compact, memify, and purge operations", async () => {
    const addCalls: string[] = [];
    const memifyCalls: string[] = [];
    const deleteCalls: string[] = [];
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        addCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/memify") {
        memifyCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/cognify") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/_compact") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/datasets") {
        return new Response(JSON.stringify([{ id: "dataset-1", name: "vault_a" }]), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/datasets/dataset-1" && init?.method === "DELETE") {
        deleteCalls.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");
    addCalls.length = 0;

    const compactResult = await controller.compactVault("vault-a");
    expect(compactResult).toEqual({ vaultId: "vault-a", accepted: true });

    const memifyResult = await controller.memifyVault("vault-a");
    expect(memifyResult.memified).toBe(true);
    expect(addCalls).toHaveLength(0);
    expect(memifyCalls).toHaveLength(1);

    const statuses = controller.getStatuses();
    const purgeResult = await controller.purgeVaultData("vault-a", {
      mirror: true,
      snapshots: true,
      state: true,
      cogneeDataset: true,
    });

    expect(purgeResult.cogneeDatasetDeleted).toBe(true);
    expect(deleteCalls).toEqual(["https://cognee.example.invalid/api/v1/datasets/dataset-1"]);
    await expect(fs.access(statuses[0]!.mirrorRoot)).rejects.toBeDefined();
    await expect(fs.access(statuses[0]!.snapshotRoot)).rejects.toBeDefined();
    expect(controller.getConflicts("vault-a")).toEqual([]);
  });

  it("retains the considered snapshot count when memify fails", async () => {
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/cognify") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/memify") {
        throw new Error("AbortError: This operation was aborted");
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");
    await expect(controller.memifyVault("vault-a")).rejects.toThrow(/aborted/i);

    const status = controller.getStatuses()[0];
    expect(status?.memify.snapshotsConsidered).toBe(1);
    expect(status?.memify.status).toBe("idle");
  });

  it("persists manual conflict resolution reason and resolved history", async () => {
    const config = createConfig({ mode: "read-write" });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "2-a",
            _conflicts: ["1-b"],
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["line one\nline two\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 18,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?open_revs=all")) {
        return new Response(
          JSON.stringify([
            {
              ok: {
                _id: "daily/note.md",
                _rev: "2-a",
                path: "daily/note.md",
                type: "plain",
                datatype: "plain",
                data: ["line one\nline two\n"],
                children: [],
                ctime: 1,
                mtime: 2,
                size: 18,
                eden: {},
              },
            },
            {
              ok: {
                _id: "daily/note.md",
                _rev: "1-b",
                path: "daily/note.md",
                type: "plain",
                datatype: "plain",
                data: ["line one\nline changed\n"],
                children: [],
                ctime: 1,
                mtime: 1,
                size: 22,
                eden: {},
              },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/daily%2Fnote.md") && init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, rev: "3-c" }), { status: 200 });
      }
      if (url.includes("_bulk_docs") && init?.method === "POST") {
        return new Response(JSON.stringify([{ ok: true }]), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const result = await controller.resolveConflict(
      "vault-a",
      "daily/note.md",
      "use_revision",
      "1-b",
      "User confirmed the older branch contained the intended edit.",
    );

    expect(result.resolutionReason).toContain("intended edit");
    expect(controller.getConflicts("vault-a")).toEqual([]);
    const resolved = controller.getConflicts("vault-a", { includeResolved: true });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.resolutionReason).toContain("intended edit");
    expect(resolved[0]?.revisions.some((revision) => Boolean(revision.diffPreview))).toBe(true);
  });

  it("runs automated memify on configured heartbeat triggers and rate-limits repeats", async () => {
    const notifySystemEvent = vi.fn();
    const addCalls: string[] = [];
    const memifyCalls: string[] = [];
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
      automation: {
        memify: {
          enabled: true,
          triggers: ["heartbeat"],
          minIntervalSeconds: 3600,
          allSnapshots: false,
          notifyOnStart: false,
          notifyOnSuccess: true,
          notifyOnFailure: true,
        },
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        addCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/memify") {
        memifyCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
      notifySystemEvent,
    });

    await controller.syncVault("vault-a");
    addCalls.length = 0;

    await controller.handleAutomationTrigger({
      trigger: "heartbeat",
      agentId: "agent-main",
      sessionKey: "session:heartbeat",
    });

    expect(addCalls).toHaveLength(0);
    expect(memifyCalls).toHaveLength(1);
    expect(controller.getStatuses()[0]?.memify.status).toBe("succeeded");
    expect(controller.getStatuses()[0]?.memify.trigger).toBe("heartbeat");
    expect(notifySystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat memify run finished"),
      expect.objectContaining({ sessionKey: "session:heartbeat" }),
    );

    await controller.handleAutomationTrigger({
      trigger: "heartbeat",
      agentId: "agent-main",
      sessionKey: "session:heartbeat",
    });

    expect(memifyCalls).toHaveLength(1);
  });

  it("skips automated memify when the triggering agent is not mapped to the vault dataset", async () => {
    const warn = vi.fn();
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: undefined,
        datasetNames: {
          asst: "asst-dataset",
        },
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
      automation: {
        memify: {
          enabled: true,
          triggers: ["heartbeat"],
          minIntervalSeconds: 0,
          allSnapshots: false,
          notifyOnStart: false,
          notifyOnSuccess: true,
          notifyOnFailure: true,
        },
      },
    });

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");
    await controller.handleAutomationTrigger({
      trigger: "heartbeat",
      agentId: "lawyer",
      sessionKey: "session:heartbeat",
    });

    expect(controller.getStatuses()[0]?.memify.status).toBe("idle");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped heartbeat automation for vault=vault-a because agentId=lawyer is not mapped"),
    );
  });

  it("skips automated memify when the trigger does not provide an agent id", async () => {
    const warn = vi.fn();
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "default-dataset",
        datasetNames: {
          asst: "asst-dataset",
        },
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
      automation: {
        memify: {
          enabled: true,
          triggers: ["cron"],
          minIntervalSeconds: 0,
          allSnapshots: false,
          notifyOnStart: false,
          notifyOnSuccess: true,
          notifyOnFailure: true,
        },
      },
    });

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.handleAutomationTrigger({
      trigger: "cron",
      sessionKey: "session:cron",
    });

    expect(controller.getStatuses()[0]?.memify.status).toBe("idle");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped cron automation because the trigger did not include an agentId"),
    );
  });

  it("repairs deleted local mirror and snapshots with a forced full resync", async () => {
    const config = createConfig();

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");
    const status = controller.getStatuses()[0]!;
    await fs.rm(status.mirrorRoot, { recursive: true, force: true });
    await fs.rm(status.snapshotRoot, { recursive: true, force: true });

    const result = await controller.repairLocalVault("vault-a", { rebuildSnapshots: true });

    expect(result.sync.notesUpserted).toBe(1);
    await expect(fs.readFile(path.join(status.mirrorRoot, "daily", "note.md"), "utf8")).resolves.toContain(
      "hello from vault",
    );
    const repairedSnapshots = await fs.readdir(status.snapshotRoot);
    expect(repairedSnapshots.length).toBeGreaterThan(0);
  });

  it("serializes a manual write behind an in-flight sync for the same vault", async () => {
    const changeResponse = deferred<Response>();
    const putCalls: string[] = [];
    const config = createConfig({ mode: "read-write" });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return changeResponse.promise;
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("drafts%2Fqueued.md") && init?.method === "PUT") {
        putCalls.push(String(init.body ?? ""));
        return new Response(JSON.stringify({ ok: true, rev: "2-b" }), { status: 200 });
      }
      if (url.endsWith("drafts%2Fqueued.md")) {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const syncPromise = controller.syncVault("vault-a");
    const writePromise = controller.writeNote("vault-a", "drafts/queued.md", "queued body");

    await Promise.resolve();
    expect(putCalls).toHaveLength(0);

    changeResponse.resolve(
      new Response(
        JSON.stringify({
          results: [
            {
              seq: "1-g1",
              id: "daily/note.md",
              doc: {
                _id: "daily/note.md",
                _rev: "1-a",
                path: "daily/note.md",
                type: "plain",
                datatype: "plain",
                data: ["hello from vault\n"],
                children: [],
                ctime: 1,
                mtime: 2,
                size: 17,
                eden: {},
              },
            },
          ],
          last_seq: "1-g1",
        }),
        { status: 200 },
      ),
    );

    await syncPromise;
    const writeResult = await writePromise;
    expect(writeResult.rev).toBe("2-b");
    expect(putCalls).toHaveLength(1);
  });

  it("cancels an active sync task when stop is requested", async () => {
    const config = createConfig();

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("Task cancelled"));
          });
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const syncPromise = controller.syncVault("vault-a", { trigger: "manual", requestedBy: "tool" });
    await waitFor(() => Boolean(controller.getStatuses()[0]?.currentTask));

    const stopResult = await controller.stopVaultTask("vault-a", "user requested repair instead");
    expect(stopResult.stopped).toBe(true);

    await expect(syncPromise).rejects.toThrow();

    const status = controller.getStatuses()[0];
    expect(status?.currentTask).toBeUndefined();
    expect(status?.lastTask?.status).toBe("cancelled");
    expect(status?.lastTask?.cancelReason).toContain("user requested repair instead");
  });

  it("preempts an in-flight service sync when a manual sync is requested", async () => {
    const firstChangesGate = deferred<Response>();
    let changesCalls = 0;
    const config = createConfig();

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        changesCalls += 1;
        if (changesCalls === 1) {
          const pending = new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(new Error("Task cancelled"));
              return;
            }
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("Task cancelled"));
            });
          });
          void pending.catch(() => undefined);
          return pending;
        }
        return firstChangesGate.promise;
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const backgroundSync = controller.syncVault("vault-a", { trigger: "timer", requestedBy: "service" });
    const backgroundSyncOutcome = backgroundSync.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );
    await waitFor(() => controller.getStatuses()[0]?.currentTask?.requestedBy === "service");

    const manualSync = controller.syncVault("vault-a", { trigger: "manual", requestedBy: "tool" });

    firstChangesGate.resolve(
      new Response(
        JSON.stringify({
          results: [
            {
              seq: "1-g1",
              id: "daily/note.md",
              doc: {
                _id: "daily/note.md",
                _rev: "1-a",
                path: "daily/note.md",
                type: "plain",
                datatype: "plain",
                data: ["hello from vault\n"],
                children: [],
                ctime: 1,
                mtime: 2,
                size: 17,
                eden: {},
              },
            },
          ],
          last_seq: "1-g1",
        }),
        { status: 200 },
      ),
    );

    const backgroundResult = await backgroundSyncOutcome;
    expect(backgroundResult.ok).toBe(false);
    expect(backgroundResult.ok ? undefined : backgroundResult.error).toBeInstanceOf(Error);
    const stats = await manualSync;

    expect(stats.notesUpserted).toBe(1);
    expect(changesCalls).toBe(2);
  }, 10000);

  it("does not re-upload the same note revision to Cognee during a forced full resync", async () => {
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });
    let addCalls = 0;

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        addCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://cognee.example.invalid/api/v1/cognify") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const firstSync = await controller.syncVault("vault-a", { trigger: "manual", requestedBy: "tool" });
    const secondSync = await controller.syncVault("vault-a", {
      forceFull: true,
      trigger: "manual",
      requestedBy: "tool",
    });

    expect(firstSync.cogneeUploads).toBe(1);
    expect(secondSync.cogneeUploads).toBe(0);
    expect(addCalls).toBe(1);
  });

  it("writes full snapshots locally and uploads full version documents for later revisions", async () => {
    const uploadedDocuments: string[] = [];
    let syncRound = 0;
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: false,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        syncRound += 1;
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: `${syncRound}-g1`,
                id: "projects/roadmap.md",
                doc: {
                  _id: "projects/roadmap.md",
                  _rev: syncRound === 1 ? "1-a" : "2-b",
                  path: "projects/roadmap.md",
                  type: "plain",
                  datatype: "plain",
                  data: [
                    syncRound === 1
                      ? "# Roadmap\nKeep this line.\nOriginal status.\n"
                      : "# Roadmap\nKeep this line.\nUpdated status.\n",
                  ],
                  children: [],
                  ctime: 1,
                  mtime: syncRound,
                  size: 48,
                  eden: {},
                },
              },
            ],
            last_seq: `${syncRound}-g1`,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("projects%2Froadmap.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "projects/roadmap.md",
            _rev: syncRound === 1 ? "1-a" : "2-b",
            path: "projects/roadmap.md",
            type: "plain",
            datatype: "plain",
            data: [
              syncRound === 1
                ? "# Roadmap\nKeep this line.\nOriginal status.\n"
                : "# Roadmap\nKeep this line.\nUpdated status.\n",
            ],
            children: [],
            ctime: 1,
            mtime: syncRound,
            size: 48,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        const form = init?.body as FormData;
        const uploaded = form.get("data");
        uploadedDocuments.push(await (uploaded as Blob).text());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const firstSync = await controller.syncVault("vault-a");
    const secondSync = await controller.syncVault("vault-a");

    expect(firstSync.cogneeUploads).toBe(1);
    expect(secondSync.cogneeUploads).toBe(1);
    expect(uploadedDocuments).toHaveLength(2);
    expect(uploadedDocuments[0]).toContain("Original status.");
    expect(uploadedDocuments[1]).toContain("Updated status.");
    expect(uploadedDocuments[1]).toContain('previous_revision: "1-a"');
    expect(uploadedDocuments[1]).toContain('change_type: "modified"');
    expect(uploadedDocuments[1]).toContain('source_mtime: "1970-01-01T00:00:00.002Z"');

    const snapshotRoot = controller.getStatuses()[0]!.snapshotRoot;
    const snapshots = (await fs.readdir(snapshotRoot)).sort();
    expect(snapshots).toHaveLength(2);

    const firstSnapshot = await fs.readFile(path.join(snapshotRoot, snapshots[0]!), "utf8");
    const secondSnapshot = await fs.readFile(path.join(snapshotRoot, snapshots[1]!), "utf8");
    expect(firstSnapshot).toContain('source_mtime: "1970-01-01T00:00:00.001Z"');
    expect(firstSnapshot).toContain("source_mtime_unix_ms: 1");
    expect(secondSnapshot).toContain("Updated status.");
    expect(secondSnapshot).toContain('source_mtime: "1970-01-01T00:00:00.002Z"');
  });

  it("writes filename hint frontmatter for date, mention, and tokenized note names", async () => {
    const config = createConfig();

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/2026-03-08 @kevin Launch-Plan.md",
                doc: {
                  _id: "daily/2026-03-08 @kevin Launch-Plan.md",
                  _rev: "1-a",
                  path: "daily/2026-03-08 @kevin Launch-Plan.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hint coverage\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 14,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2F2026-03-08%20%40kevin%20launch-plan.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/2026-03-08 @kevin Launch-Plan.md",
            _rev: "1-a",
            path: "daily/2026-03-08 @kevin Launch-Plan.md",
            type: "plain",
            datatype: "plain",
            data: ["hint coverage\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 14,
            eden: {},
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");

    const snapshotRoot = controller.getStatuses()[0]!.snapshotRoot;
    const snapshots = await fs.readdir(snapshotRoot);
    expect(snapshots).toHaveLength(1);
    const snapshot = await fs.readFile(path.join(snapshotRoot, snapshots[0]!), "utf8");

    expect(snapshot).toContain('filename_dates: "[\\"2026-03-08\\"]"');
    expect(snapshot).toContain('filename_people: "[\\"kevin\\"]"');
    expect(snapshot).toContain('filename_tokens: "[\\"2026-03-08\\",\\"@kevin\\",\\"Launch-Plan\\"]"');
  });

  it("writes capitalized person-style filename hints into frontmatter", async () => {
    const config = createConfig();

    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "people/Alice.md",
                doc: {
                  _id: "people/alice.md",
                  _rev: "1-a",
                  path: "people/Alice.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["person hint\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 12,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("people%2Falice.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "people/alice.md",
            _rev: "1-a",
            path: "people/Alice.md",
            type: "plain",
            datatype: "plain",
            data: ["person hint\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 12,
            eden: {},
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");

    const snapshotRoot = controller.getStatuses()[0]!.snapshotRoot;
    const snapshots = await fs.readdir(snapshotRoot);
    expect(snapshots).toHaveLength(1);
    const snapshot = await fs.readFile(path.join(snapshotRoot, snapshots[0]!), "utf8");

    expect(snapshot).toContain('filename_people: "[\\"Alice\\"]"');
    expect(snapshot).toContain('filename_tokens: "[\\"Alice\\"]"');
  });

  it("removes mirrored content and writes a deletion snapshot for tombstone change rows", async () => {
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "vault_a",
        nodeSet: [],
        cognify: false,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
      },
    });
    let syncRound = 0;
    const uploadedDocuments: string[] = [];

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        syncRound += 1;
        if (syncRound === 1) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  seq: "1-g1",
                  id: "projects/delete-me.md",
                  doc: {
                    _id: "projects/delete-me.md",
                    _rev: "1-a",
                    path: "projects/delete-me.md",
                    type: "plain",
                    datatype: "plain",
                    data: ["hello\n"],
                    children: [],
                    ctime: 10,
                    mtime: 20,
                    size: 6,
                    eden: {},
                  },
                },
              ],
              last_seq: "1-g1",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "2-g1",
                id: "projects/delete-me.md",
                deleted: true,
                doc: {
                  _id: "projects/delete-me.md",
                  _rev: "2-b",
                  _deleted: true,
                },
              },
            ],
            last_seq: "2-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("projects%2Fdelete-me.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "projects/delete-me.md",
            _rev: "1-a",
            path: "projects/delete-me.md",
            type: "plain",
            datatype: "plain",
            data: ["hello\n"],
            children: [],
            ctime: 10,
            mtime: 20,
            size: 6,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        const form = init?.body as FormData;
        const uploaded = form.get("data");
        uploadedDocuments.push(await (uploaded as Blob).text());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    const firstSync = await controller.syncVault("vault-a");
    const secondSync = await controller.syncVault("vault-a");

    expect(firstSync.notesUpserted).toBe(1);
    expect(secondSync.notesDeleted).toBe(1);
    expect(secondSync.snapshotsWritten).toBe(1);
    expect(secondSync.cogneeUploads).toBe(1);

    const status = controller.getStatuses()[0]!;
    expect(status.noteCount).toBe(0);
    await expect(fs.access(path.join(status.mirrorRoot, "projects", "delete-me.md"))).rejects.toBeDefined();

    const snapshots = (await fs.readdir(status.snapshotRoot)).sort();
    expect(snapshots).toHaveLength(2);
    const deletionSnapshot = await fs.readFile(path.join(status.snapshotRoot, snapshots[1]!), "utf8");
    expect(deletionSnapshot).toContain("source_deleted: true");
    expect(deletionSnapshot).toContain("This note was deleted in the remote vault.");

    expect(uploadedDocuments).toHaveLength(2);
    expect(uploadedDocuments[1]).toContain('change_type: "deleted"');
    expect(uploadedDocuments[1]).toContain('previous_revision: "1-a"');
  });

  it("coalesces overlapping heartbeat and cron memify triggers into one run", async () => {
    const addGate = deferred<Response>();
    const config = createConfig({
      cognee: {
        enabled: true,
        baseUrl: "https://cognee.example.invalid",
        datasetName: "default-dataset",
        datasetNames: {
          asst: "asst-dataset",
        },
        nodeSet: [],
        cognify: true,
        downloadHttpLinks: false,
        maxLinksPerNote: 0,
        maxLinkBytes: 1024,
        searchType: "CHUNKS",
        searchTopK: 4,
        inheritedFrom: "memory-slot",
      },
      automation: {
        memify: {
          enabled: true,
          triggers: ["heartbeat", "cron"],
          minIntervalSeconds: 0,
          allSnapshots: false,
          notifyOnStart: false,
          notifyOnSuccess: false,
          notifyOnFailure: true,
        },
      },
    });
    let addCount = 0;

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("_changes")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                seq: "1-g1",
                id: "daily/note.md",
                doc: {
                  _id: "daily/note.md",
                  _rev: "1-a",
                  path: "daily/note.md",
                  type: "plain",
                  datatype: "plain",
                  data: ["hello from vault\n"],
                  children: [],
                  ctime: 1,
                  mtime: 2,
                  size: 17,
                  eden: {},
                },
              },
            ],
            last_seq: "1-g1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("daily%2Fnote.md?conflicts=true")) {
        return new Response(
          JSON.stringify({
            _id: "daily/note.md",
            _rev: "1-a",
            path: "daily/note.md",
            type: "plain",
            datatype: "plain",
            data: ["hello from vault\n"],
            children: [],
            ctime: 1,
            mtime: 2,
            size: 17,
            eden: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://cognee.example.invalid/api/v1/add") {
        addCount += 1;
        const form = init?.body as FormData;
        expect(form.get("datasetName")).toBe("asst-dataset");
        return addGate.promise;
      }
      if (url === "https://cognee.example.invalid/api/v1/memify") {
        addCount += 1;
        expect(String(init?.body ?? "")).toContain("asst-dataset");
        return addGate.promise;
      }
      if (url === "https://cognee.example.invalid/api/v1/cognify") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    const controller = new ObsidianLivesyncCogneeController({
      config,
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      stateDir: tempDir,
    });

    await controller.syncVault("vault-a");
    addCount = 0;

    const heartbeat = controller.handleAutomationTrigger({ trigger: "heartbeat", agentId: "asst" });
    const cron = controller.handleAutomationTrigger({ trigger: "cron", agentId: "asst" });

    addGate.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await Promise.all([heartbeat, cron]);
    expect(addCount).toBe(1);
  });
});