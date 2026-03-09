import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerObsidianLivesyncCogneeCli } from "./cli.js";

describe("obsidian-livesync-cognee cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints filtered status output", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(() => [
        { vaultId: "vault-a", enabled: true },
        { vaultId: "vault-b", enabled: false },
      ]),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(),
      memifyVault: vi.fn(),
      repairLocalVault: vi.fn(),
      stopVaultTask: vi.fn(),
      purgeVaultData: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await program.parseAsync(["obsidian-vault", "status", "--vault", "vault-b"], {
      from: "user",
    });

    expect(controller.ensureReady).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify([{ vaultId: "vault-b", enabled: false }], null, 2),
    );
  });

  it("rejects purge without a selected target", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(),
      memifyVault: vi.fn(),
      repairLocalVault: vi.fn(),
      stopVaultTask: vi.fn(),
      purgeVaultData: vi.fn(),
    };

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await expect(
      program.parseAsync(["obsidian-vault", "purge", "--vault", "vault-a"], {
        from: "user",
      }),
    ).rejects.toThrow("select at least one purge target or use --all");
  });

  it("passes resolution reason through the conflict command", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(async () => ({ path: "daily/note.md" })),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(),
      memifyVault: vi.fn(),
      repairLocalVault: vi.fn(),
      stopVaultTask: vi.fn(),
      purgeVaultData: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await program.parseAsync(
      [
        "obsidian-vault",
        "resolve-conflict",
        "--vault",
        "vault-a",
        "--path",
        "daily/note.md",
        "--strategy",
        "keep_current",
        "--reason",
        "operator verified the freshest note in Obsidian",
      ],
      {
        from: "user",
      },
    );

    expect(controller.resolveConflict).toHaveBeenCalledWith(
      "vault-a",
      "daily/note.md",
      "keep_current",
      undefined,
      "operator verified the freshest note in Obsidian",
    );
    expect(logSpy).toHaveBeenCalled();
  });

  it("calls local repair from the CLI", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(),
      memifyVault: vi.fn(),
      repairLocalVault: vi.fn(async () => ({ vaultId: "vault-a" })),
      stopVaultTask: vi.fn(),
      purgeVaultData: vi.fn(),
    };

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await program.parseAsync(["obsidian-vault", "repair", "--vault", "vault-a", "--rebuild-snapshots"], {
      from: "user",
    });

    expect(controller.repairLocalVault).toHaveBeenCalledWith("vault-a", {
      rebuildSnapshots: true,
      requestedBy: "cli",
    });
  });

  it("stops an active vault task from the CLI", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(),
      memifyVault: vi.fn(),
      repairLocalVault: vi.fn(),
      stopVaultTask: vi.fn(async () => ({ vaultId: "vault-a", stopped: true })),
      purgeVaultData: vi.fn(),
    };

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await program.parseAsync(["obsidian-vault", "stop", "--vault", "vault-a", "--reason", "user request"], {
      from: "user",
    });

    expect(controller.stopVaultTask).toHaveBeenCalledWith("vault-a", "user request");
  });

  it("resolves memify from a dataset name", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(() => ["vault-a", "vault-b"]),
      memifyVault: vi.fn(async () => ({ vaultId: "vault-a", memified: true, datasetName: "asst-dataset" })),
      repairLocalVault: vi.fn(),
      stopVaultTask: vi.fn(),
      purgeVaultData: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await program.parseAsync(
      ["obsidian-vault", "memify", "--dataset-name", "asst-dataset", "--agent", "asst", "--all-snapshots"],
      { from: "user" },
    );

    expect(controller.findCogneeVaultIdsByDatasetName).toHaveBeenCalledWith("asst-dataset", "asst");
    expect(controller.memifyVault).toHaveBeenCalledWith("vault-a", {
      allSnapshots: true,
      trigger: "manual",
      requestedBy: "cli",
      agentId: "asst",
    });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          requestedDatasetName: "asst-dataset",
          matchingVaultIds: ["vault-a", "vault-b"],
          vaultId: "vault-a",
          memified: true,
          datasetName: "asst-dataset",
        },
        null,
        2,
      ),
    );
  });

  it("prints a check-later hint when memify times out", async () => {
    const program = new Command();
    program.exitOverride();
    const controller = {
      ensureReady: vi.fn(async () => {}),
      getStatuses: vi.fn(),
      syncVault: vi.fn(),
      syncAll: vi.fn(),
      getConflicts: vi.fn(),
      resolveConflict: vi.fn(),
      compactVault: vi.fn(),
      findCogneeVaultIdsByDatasetName: vi.fn(),
      memifyVault: vi.fn(async () => {
        throw new Error("AbortError: This operation was aborted");
      }),
      repairLocalVault: vi.fn(),
      stopVaultTask: vi.fn(),
      purgeVaultData: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    registerObsidianLivesyncCogneeCli({
      program,
      controller: controller as never,
    });

    await program.parseAsync(
      ["obsidian-vault", "memify", "--vault", "vault-a", "--agent", "asst", "--all-snapshots"],
      { from: "user" },
    );

    expect(controller.memifyVault).toHaveBeenCalledWith("vault-a", {
      allSnapshots: true,
      trigger: "manual",
      requestedBy: "cli",
      agentId: "asst",
    });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          requestedDatasetName: undefined,
          matchingVaultIds: undefined,
          vaultId: "vault-a",
          memified: false,
          pending: true,
          status: "check-later",
          reason: "Cognee memify did not return before the CLI stopped waiting.",
          error: "AbortError: This operation was aborted",
          checkHint:
            "Cognee memify is blocking by default, so the server may still be processing this dataset. Retry the memify command later or inspect the Cognee service logs.",
          retryCommand: "openclaw obsidian-vault memify --vault vault-a --agent asst --all-snapshots",
        },
        null,
        2,
      ),
    );
  });
});