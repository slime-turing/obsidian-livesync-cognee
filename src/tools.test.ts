import { describe, expect, it, vi } from "vitest";
import { createObsidianLivesyncCogneeTools, INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM } from "./tools.js";

describe("deep graph search tool", () => {
  it("does not expose vault selection in the model-visible schema", () => {
    const controller = {
      logger: { info() {} },
      queryCogneeMemory: vi.fn(),
    } as never;

    const tools = createObsidianLivesyncCogneeTools({
      controller,
      updateConfig: vi.fn() as never,
    });

    const tool = tools.find((candidate) => candidate.name === "obsidian_vault_deep_graph_search");
    expect(tool).toBeDefined();
    expect(tool?.parameters).toEqual(
      expect.objectContaining({
        properties: expect.not.objectContaining({
          vaultId: expect.anything(),
        }),
      }),
    );
  });

  it("uses the internally injected agent id for dataset scoping", async () => {
    const queryCogneeMemory = vi.fn(async () => [
      {
        vaultId: "vault-a",
        datasetName: "asst-dataset",
        datasetId: "dataset-1",
        answer: undefined,
        sources: [
          {
            sourcePath: "notes/graph.md",
            excerpt: "Alice depends on Bob via project graph.",
            datasetName: "asst-dataset",
            datasetId: "dataset-1",
          },
        ],
        raw: [],
      },
    ]);

    const controller = {
      logger: { info() {} },
      queryCogneeMemory,
    } as never;

    const tools = createObsidianLivesyncCogneeTools({
      controller,
      updateConfig: vi.fn() as never,
    });

    const tool = tools.find((candidate) => candidate.name === "obsidian_vault_deep_graph_search");
    expect(tool).toBeDefined();

    await tool!.execute("tool-call-1", {
      query: "How is Alice connected to Bob?",
      searchType: "GRAPH_COMPLETION",
      [INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM]: "asst",
    });

    expect(queryCogneeMemory).toHaveBeenCalledWith({
      query: "How is Alice connected to Bob?",
      agentId: "asst",
      includeAnswer: undefined,
      topK: undefined,
      searchTypeOverride: "GRAPH_COMPLETION",
    });
  });

  it("exposes datasetName rather than vaultId for memify", async () => {
    const memifyVault = vi.fn(async () => ({
      vaultId: "vault-a",
      snapshotsConsidered: 3,
      memified: true,
      datasetName: "asst-dataset",
    }));
    const findCogneeVaultIdsByDatasetName = vi.fn(() => ["vault-a", "vault-b"]);
    const controller = {
      logger: { info() {} },
      queryCogneeMemory: vi.fn(),
      memifyVault,
      findCogneeVaultIdsByDatasetName,
    } as never;

    const tools = createObsidianLivesyncCogneeTools({
      controller,
      updateConfig: vi.fn() as never,
    });

    const tool = tools.find((candidate) => candidate.name === "obsidian_vault_memify");
    expect(tool).toBeDefined();
    expect(tool?.parameters).toEqual(
      expect.objectContaining({
        required: ["datasetName"],
        properties: expect.objectContaining({
          datasetName: expect.any(Object),
        }),
      }),
    );
    expect(tool?.parameters).toEqual(
      expect.objectContaining({
        properties: expect.not.objectContaining({
          vaultId: expect.anything(),
        }),
      }),
    );

    const result = await tool!.execute("tool-call-2", {
      datasetName: "asst-dataset",
      [INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM]: "asst",
    });

    expect(findCogneeVaultIdsByDatasetName).toHaveBeenCalledWith("asst-dataset", "asst");
    expect(memifyVault).toHaveBeenCalledWith("vault-a", {
      allSnapshots: undefined,
      trigger: "manual",
      requestedBy: "tool",
      agentId: "asst",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        requestedDatasetName: "asst-dataset",
        matchingVaultIds: ["vault-a", "vault-b"],
      }),
    );
  });

  it("syncs only vaults mapped to the current agent when vaultId is omitted", async () => {
    const syncVault = vi.fn(async (vaultId: string) => ({ vaultId }));
    const syncAll = vi.fn();
    const getAccessibleVaultIds = vi.fn(() => ["vault-a"]);
    const controller = {
      logger: { info() {}, warn() {} },
      syncVault,
      syncAll,
      getAccessibleVaultIds,
      canAgentAccessVault: vi.fn(() => true),
      queryCogneeMemory: vi.fn(),
    } as never;

    const tools = createObsidianLivesyncCogneeTools({
      controller,
      updateConfig: vi.fn() as never,
    });

    const tool = tools.find((candidate) => candidate.name === "obsidian_vault_sync");
    const result = await tool!.execute("tool-call-3", {
      [INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM]: "asst",
    });

    expect(getAccessibleVaultIds).toHaveBeenCalledWith("asst");
    expect(syncVault).toHaveBeenCalledWith("vault-a", {
      trigger: "manual",
      requestedBy: "tool",
      agentId: "asst",
    });
    expect(syncAll).not.toHaveBeenCalled();
    expect(result.details).toEqual([{ vaultId: "vault-a" }]);
  });

  it("rejects vault reads outside the current agent mapping", async () => {
    const readNote = vi.fn();
    const canAgentAccessVault = vi.fn(() => false);
    const controller = {
      logger: { info() {}, warn() {} },
      canAgentAccessVault,
      readNote,
      queryCogneeMemory: vi.fn(),
    } as never;

    const tools = createObsidianLivesyncCogneeTools({
      controller,
      updateConfig: vi.fn() as never,
    });

    const tool = tools.find((candidate) => candidate.name === "obsidian_vault_read");

    await expect(
      tool!.execute("tool-call-4", {
        vaultId: "vault-b",
        path: "daily/note.md",
        [INTERNAL_DEEP_GRAPH_SEARCH_AGENT_ID_PARAM]: "asst",
      }),
    ).rejects.toThrow("vault vault-b is not mapped to the current agent context");

    expect(canAgentAccessVault).toHaveBeenCalledWith("vault-b", "asst");
    expect(readNote).not.toHaveBeenCalled();
  });
});