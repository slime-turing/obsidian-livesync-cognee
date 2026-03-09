import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolvePluginConfig } from "./config.js";

const SETUP_URI_PREFIX = "obsidian://setuplivesync?settings=";

function createSetupUriPayloadV2(input: string, passphrase: string): string {
  const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const salt = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
  const passphraseDigest = createHash("sha256").update(passphrase, "utf8").digest();
  const key = pbkdf2Sync(passphraseDigest, salt, 100000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(input, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `%${iv.toString("hex")}${salt.toString("hex")}${Buffer.concat([ciphertext, authTag]).toString("base64")}`;
}

function createSetupUri(payload: Record<string, unknown>, passphrase: string): string {
  return `${SETUP_URI_PREFIX}${encodeURIComponent(
    createSetupUriPayloadV2(JSON.stringify(payload), passphrase),
  )}`;
}

describe("obsidian-livesync-cognee config", () => {
  it("parses a minimal vault config", () => {
    const config = resolvePluginConfig({
      vaults: [
        {
          id: "vault-a",
          url: "https://couchdb.example.invalid",
          database: "vault-a-db",
        },
      ],
    });

    expect(config.vaults).toHaveLength(1);
    expect(config.vaults[0]?.mode).toBe("read-only");
    expect(config.vaults[0]?.syncMode).toBe("changes");
    expect(config.vaults[0]?.pollIntervalSeconds).toBe(300);
    expect(config.vaults[0]?.autoResolveConflicts).toBe(true);
    expect(config.vaults[0]?.notifications.onError).toBe(true);
    expect(config.vaults[0]?.notifications.dedupeWindowSeconds).toBe(300);
    expect(config.vaults[0]?.automation.memify.enabled).toBe(false);
    expect(config.vaults[0]?.automation.memify.minIntervalSeconds).toBe(3600);
    expect(config.vaults[0]?.cognee.searchType).toBe("CHUNKS");
  });

  it("resolves env placeholders inside secret fields", () => {
    process.env.OBS_TEST_PASSWORD = "test-password";
    process.env.OBS_TEST_COGNEE = "test-auth-value";

    const config = resolvePluginConfig({
      vaults: [
        {
          id: "vault-a",
          url: "https://couchdb.example.invalid",
          database: "vault-a-db",
          password: "${OBS_TEST_PASSWORD}",
          cognee: {
            enabled: true,
            baseUrl: "https://cognee.example.invalid",
            authToken: "${OBS_TEST_COGNEE}",
          },
        },
      ],
    });

    expect(config.vaults[0]?.password).toBe("test-password");
    expect(config.vaults[0]?.cognee.authToken).toBe("test-auth-value");
  });

  it("rejects duplicate vault ids", () => {
    expect(() =>
      resolvePluginConfig({
        vaults: [
          { id: "same", url: "http://a", database: "one" },
          { id: "same", url: "http://b", database: "two" },
        ],
      }),
    ).toThrow("duplicate vault id: same");
  });

  it("rejects manual CouchDB and E2EE fields when setupUri is used", () => {
    const setupUriPassphrase = "patient-haze";
    const setupUri = createSetupUri(
      {
        couchDB_URI: "https://couchdb.example.invalid",
        couchDB_DBNAME: "vault-a-db",
        couchDB_USER: "user-a",
        couchDB_PASSWORD: "password-a",
        encrypt: true,
        passphrase: "vault-passphrase",
        usePathObfuscation: true,
      },
      setupUriPassphrase,
    );

    expect(() =>
      resolvePluginConfig({
        vaults: [
          {
            id: "vault-a",
            setupUri,
            setupUriPassphrase,
            database: "conflicting-db",
            username: "conflicting-user",
            password: "conflicting-password",
          },
        ],
      }),
    ).toThrow("vaults[0] cannot set database, username, password when setupUri is used");
  });

  it("accepts setupUri payloads that are already URI-decoded once", () => {
    const setupUriPassphrase = "patient-haze";
    const decodedPayload = createSetupUriPayloadV2(
      JSON.stringify({
        couchDB_URI: "https://couchdb.example.invalid",
        couchDB_DBNAME: "vault-a-db",
        couchDB_USER: "user-a",
        couchDB_PASSWORD: "password-a",
        encrypt: true,
        passphrase: "vault-passphrase",
        usePathObfuscation: true,
        handleFilenameCaseSensitive: false,
      }),
      setupUriPassphrase,
    );

    const config = resolvePluginConfig({
      vaults: [
        {
          id: "vault-a",
          setupUri: `${SETUP_URI_PREFIX}${decodedPayload}`,
          setupUriPassphrase,
        },
      ],
    });

    expect(config.vaults[0]).toMatchObject({
      id: "vault-a",
      url: "https://couchdb.example.invalid",
      database: "vault-a-db",
      username: "user-a",
      password: "password-a",
      encrypt: true,
      passphrase: "vault-passphrase",
      usePathObfuscation: true,
    });
  });

  it("parses notifications and search settings", () => {
    const config = resolvePluginConfig({
      vaults: [
        {
          id: "vault-a",
          url: "https://couchdb.example.invalid",
          database: "vault-a-db",
          autoResolveConflicts: false,
          notifications: {
            sessionKey: "main:test",
            onError: true,
            onConflict: true,
            wakeAgent: true,
            dedupeWindowSeconds: 45,
          },
          cognee: {
            enabled: true,
            baseUrl: "https://cognee.example.invalid",
            searchType: "GRAPH_COMPLETION",
            searchTopK: 6,
          },
        },
      ],
    });

    expect(config.vaults[0]?.autoResolveConflicts).toBe(false);
    expect(config.vaults[0]?.notifications.sessionKey).toBe("main:test");
    expect(config.vaults[0]?.notifications.wakeAgent).toBe(true);
    expect(config.vaults[0]?.notifications.dedupeWindowSeconds).toBe(45);
    expect(config.vaults[0]?.cognee.searchType).toBe("GRAPH_COMPLETION");
    expect(config.vaults[0]?.cognee.searchTopK).toBe(6);
  });

  it("parses memify automation settings", () => {
    const config = resolvePluginConfig({
      vaults: [
        {
          id: "vault-a",
          url: "https://couchdb.example.invalid",
          database: "vault-a-db",
          automation: {
            memify: {
              enabled: true,
              triggers: ["heartbeat", "cron"],
              minIntervalSeconds: 120,
              allSnapshots: true,
              notifyOnStart: true,
              notifyOnSuccess: false,
              notifyOnFailure: true,
            },
          },
        },
      ],
    });

    expect(config.vaults[0]?.automation.memify.enabled).toBe(true);
    expect(config.vaults[0]?.automation.memify.triggers).toEqual(["heartbeat", "cron"]);
    expect(config.vaults[0]?.automation.memify.minIntervalSeconds).toBe(120);
    expect(config.vaults[0]?.automation.memify.allSnapshots).toBe(true);
    expect(config.vaults[0]?.automation.memify.notifyOnStart).toBe(true);
    expect(config.vaults[0]?.automation.memify.notifyOnSuccess).toBe(false);
  });

  it("inherits Cognee endpoint and dataset mapping from the configured memory slot", () => {
    const config = resolvePluginConfig(
      {
        vaults: [
          {
            id: "vault-a",
            url: "https://couchdb.example.invalid",
            database: "vault-a-db",
          },
        ],
      },
      {
        openclawConfig: {
          plugins: {
            slots: { memory: "cognee-openclaw" },
            entries: {
              "cognee-openclaw": {
                enabled: true,
                config: {
                  baseUrl: "https://cognee.example.invalid",
                  datasetName: "default-dataset",
                  datasetNames: {
                    asst: "asst-dataset",
                  },
                  maxResults: 9,
                  autoCognify: false,
                },
              },
            },
          },
        },
      },
    );

    expect(config.vaults[0]?.cognee.enabled).toBe(true);
    expect(config.vaults[0]?.cognee.baseUrl).toBe("https://cognee.example.invalid");
    expect(config.vaults[0]?.cognee.datasetName).toBe("default-dataset");
    expect(config.vaults[0]?.cognee.datasetNames).toEqual({ asst: "asst-dataset" });
    expect(config.vaults[0]?.cognee.searchTopK).toBe(9);
    expect(config.vaults[0]?.cognee.cognify).toBe(false);
    expect(config.vaults[0]?.cognee.inheritedFrom).toBe("memory-slot");
  });
});