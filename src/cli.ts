import type { Command } from "commander";
import type { ObsidianLivesyncCogneeController } from "./controller.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function isMemifyCheckLaterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /aborterror|aborted|timed out|timeout/i.test(message);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._:@/=-]+$/.test(value) ? value : JSON.stringify(value);
}

function buildMemifyRetryCommand(options: { datasetName?: string; agent?: string; vault?: string; allSnapshots?: boolean }): string {
  const parts = ["openclaw", "obsidian-vault", "memify"];
  if (options.datasetName) {
    parts.push("--dataset-name", shellQuote(options.datasetName));
  }
  if (options.vault) {
    parts.push("--vault", shellQuote(options.vault));
  }
  if (options.agent) {
    parts.push("--agent", shellQuote(options.agent));
  }
  if (options.allSnapshots) {
    parts.push("--all-snapshots");
  }
  return parts.join(" ");
}

function buildMemifyCheckLaterResult(options: {
  datasetName?: string;
  matchingVaultIds?: string[];
  vaultId: string;
  agent?: string;
  allSnapshots?: boolean;
  error: unknown;
}) {
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  return {
    requestedDatasetName: options.datasetName,
    matchingVaultIds: options.matchingVaultIds,
    vaultId: options.vaultId,
    memified: false,
    pending: true,
    status: "check-later",
    reason: "Cognee memify did not return before the CLI stopped waiting.",
    error: message,
    checkHint:
      "Cognee memify is blocking by default, so the server may still be processing this dataset. Retry the memify command later or inspect the Cognee service logs.",
    retryCommand: buildMemifyRetryCommand({
      datasetName: options.datasetName,
      agent: options.agent,
      vault: options.datasetName ? undefined : options.vaultId,
      allSnapshots: options.allSnapshots,
    }),
  };
}

export function registerObsidianLivesyncCogneeCli(params: {
  program: Command;
  controller: ObsidianLivesyncCogneeController;
}) {
  const { program, controller } = params;
  const root = program.command("obsidian-vault").description("Operate the Obsidian LiveSync Cognee bridge");

  root
    .command("status")
    .description("Show configured vault status and local state")
    .option("--vault <id>", "Limit output to one vault")
    .action(async (options: { vault?: string }) => {
      await controller.ensureReady();
      const statuses = controller.getStatuses();
      printJson(options.vault ? statuses.filter((status) => status.vaultId === options.vault) : statuses);
    });

  root
    .command("sync")
    .description("Run an on-demand sync for one vault or all vaults")
    .option("--vault <id>", "Sync only one vault")
    .action(async (options: { vault?: string }) => {
      const result = options.vault
        ? [await controller.syncVault(options.vault, { trigger: "manual", requestedBy: "cli" })]
        : await controller.syncAll({ trigger: "manual", requestedBy: "cli" });
      printJson(result);
    });

  root
    .command("conflicts")
    .description("List unresolved CouchDB conflicts")
    .option("--vault <id>", "Limit output to one vault")
    .option("--include-resolved", "Also show resolved conflicts preserved in local state")
    .action(async (options: { vault?: string; includeResolved?: boolean }) => {
      await controller.ensureReady();
      printJson(controller.getConflicts(options.vault, { includeResolved: options.includeResolved }));
    });

  root
    .command("resolve-conflict")
    .description("Resolve one tracked conflict")
    .requiredOption("--vault <id>", "Vault id")
    .requiredOption("--path <notePath>", "Vault-relative note path")
    .requiredOption("--strategy <strategy>", "keep_current, keep_latest_mtime, or use_revision")
    .option("--winner-rev <rev>", "Revision to keep when strategy=use_revision")
    .option("--reason <text>", "Optional operator note describing why this resolution was chosen")
    .action(
      async (options: {
        vault: string;
        path: string;
        strategy: "keep_current" | "keep_latest_mtime" | "use_revision";
        winnerRev?: string;
        reason?: string;
      }) => {
        const result = await controller.resolveConflict(
          options.vault,
          options.path,
          options.strategy,
          options.winnerRev,
          options.reason,
        );
        printJson(result);
      },
    );

  root
    .command("compact")
    .description("Request CouchDB compaction for a vault database")
    .requiredOption("--vault <id>", "Vault id")
    .action(async (options: { vault: string }) => {
      printJson(await controller.compactVault(options.vault));
    });

  root
    .command("memify")
    .description("Run Cognee memify against a resolved dataset name or a legacy vault selection")
    .option("--dataset-name <name>", "Cognee dataset name")
    .option("--agent <id>", "Agent id used to resolve per-agent dataset mappings")
    .option("--vault <id>", "Legacy vault id selector")
    .option("--all-snapshots", "Inspect every snapshot on disk when reporting local memify scope")
    .action(async (options: { datasetName?: string; agent?: string; vault?: string; allSnapshots?: boolean }) => {
      if (options.datasetName && options.vault) {
        throw new Error("choose either --dataset-name or --vault");
      }
      if (!options.datasetName && !options.vault) {
        throw new Error("dataset name or vault required");
      }

      if (options.datasetName) {
        const matchingVaultIds = controller.findCogneeVaultIdsByDatasetName(options.datasetName, options.agent);
        if (matchingVaultIds.length === 0) {
          throw new Error(`unknown Cognee dataset for current selection: ${options.datasetName}`);
        }
        const selectedVaultId = matchingVaultIds[0] as string;
        try {
          const result = await controller.memifyVault(selectedVaultId, {
            allSnapshots: options.allSnapshots,
            trigger: "manual",
            requestedBy: "cli",
            agentId: options.agent,
          });
          printJson({
            requestedDatasetName: options.datasetName,
            matchingVaultIds,
            ...result,
          });
          return;
        } catch (error) {
          if (!isMemifyCheckLaterError(error)) {
            throw error;
          }
          printJson(
            buildMemifyCheckLaterResult({
              datasetName: options.datasetName,
              matchingVaultIds,
              vaultId: selectedVaultId,
              agent: options.agent,
              allSnapshots: options.allSnapshots,
              error,
            }),
          );
          return;
        }
      }

      try {
        printJson(
          await controller.memifyVault(options.vault as string, {
            allSnapshots: options.allSnapshots,
            trigger: "manual",
            requestedBy: "cli",
            agentId: options.agent,
          }),
        );
      } catch (error) {
        if (!isMemifyCheckLaterError(error)) {
          throw error;
        }
        printJson(
          buildMemifyCheckLaterResult({
            vaultId: options.vault as string,
            agent: options.agent,
            allSnapshots: options.allSnapshots,
            error,
          }),
        );
      }
    });

  root
    .command("repair")
    .description("Rebuild deleted local mirror and optional snapshot files by forcing a full vault resync")
    .requiredOption("--vault <id>", "Vault id")
    .option("--rebuild-snapshots", "Delete and regenerate snapshot files as part of the repair")
    .action(async (options: { vault: string; rebuildSnapshots?: boolean }) => {
      printJson(
        await controller.repairLocalVault(options.vault, {
          rebuildSnapshots: options.rebuildSnapshots,
          requestedBy: "cli",
        }),
      );
    });

  root
    .command("stop")
    .description("Cancel the active sync, memify, or repair task for a vault")
    .requiredOption("--vault <id>", "Vault id")
    .option("--reason <text>", "Optional reason recorded with the cancellation")
    .action(async (options: { vault: string; reason?: string }) => {
      printJson(await controller.stopVaultTask(options.vault, options.reason));
    });

  root
    .command("purge")
    .description("Remove local mirror/snapshots/state and optionally delete the corresponding Cognee dataset")
    .requiredOption("--vault <id>", "Vault id")
    .option("--mirror", "Delete the local mirror directory")
    .option("--snapshots", "Delete stored snapshot files")
    .option("--state", "Reset tracked sequence, notes, conflicts, and notification history")
    .option("--cognee-dataset", "Delete the configured Cognee dataset for this vault")
    .option("--all", "Remove mirror, snapshots, state, and Cognee dataset together")
    .action(
      async (options: {
        vault: string;
        mirror?: boolean;
        snapshots?: boolean;
        state?: boolean;
        cogneeDataset?: boolean;
        all?: boolean;
      }) => {
        const purgeOptions = options.all
          ? { mirror: true, snapshots: true, state: true, cogneeDataset: true }
          : {
              mirror: Boolean(options.mirror),
              snapshots: Boolean(options.snapshots),
              state: Boolean(options.state),
              cogneeDataset: Boolean(options.cogneeDataset),
            };
        if (!purgeOptions.mirror && !purgeOptions.snapshots && !purgeOptions.state && !purgeOptions.cogneeDataset) {
          throw new Error("select at least one purge target or use --all");
        }
        printJson(await controller.purgeVaultData(options.vault, purgeOptions));
      },
    );
}