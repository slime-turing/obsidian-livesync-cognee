import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";

const SETUP_URI_PREFIX = "obsidian://setuplivesync?settings=";
const ENCRYPT_V2_PREFIX = "%";
const ENCRYPT_V3_PREFIX = "%~";
const LEGACY_V1_PREFIX = "[";

export type DecodedSetupUriConfig = {
  url: string;
  database: string;
  username?: string;
  password?: string;
  headers: Record<string, string>;
  encrypt: boolean;
  passphrase?: string;
  usePathObfuscation: boolean;
  handleFilenameCaseSensitive: boolean;
  e2eeAlgorithm?: string | number;
  settingVersion?: number;
};

type SetupUriPayload = {
  couchDB_URI?: unknown;
  couchDB_DBNAME?: unknown;
  couchDB_USER?: unknown;
  couchDB_PASSWORD?: unknown;
  couchDB_CustomHeaders?: unknown;
  encrypt?: unknown;
  passphrase?: unknown;
  usePathObfuscation?: unknown;
  handleFilenameCaseSensitive?: unknown;
  E2EEAlgorithm?: unknown;
  settingVersion?: unknown;
};

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string, required = false): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (required) {
    throw new Error(`${label} is required`);
  }
  return undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseCustomHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) {
          return undefined;
        }
        const key = line.slice(0, separatorIndex).trim();
        const headerValue = line.slice(separatorIndex + 1).trim();
        if (!key || !headerValue) {
          return undefined;
        }
        return [key, headerValue] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== undefined),
  );
}

function decodeSetupUriPayloadV2(encodedValue: string, passphrase: string): string {
  if (!encodedValue.startsWith(ENCRYPT_V2_PREFIX)) {
    throw new Error("setupUri payload must use LiveSync V2 encryption");
  }
  if (encodedValue.startsWith(ENCRYPT_V3_PREFIX)) {
    throw new Error("setupUri payload uses an unsupported LiveSync encryption version");
  }

  const ivHex = encodedValue.slice(1, 33);
  const saltHex = encodedValue.slice(33, 65);
  const ciphertextBase64 = encodedValue.slice(65);
  if (ivHex.length !== 32 || saltHex.length !== 32 || ciphertextBase64.length === 0) {
    throw new Error("setupUri payload is malformed");
  }

  const passphraseDigest = createHash("sha256").update(passphrase, "utf8").digest();
  const key = pbkdf2Sync(passphraseDigest, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
  const encryptedBuffer = Buffer.from(ciphertextBase64, "base64");
  if (encryptedBuffer.length <= 16) {
    throw new Error("setupUri ciphertext is truncated");
  }
  const authTag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
  const ciphertext = encryptedBuffer.subarray(0, encryptedBuffer.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

function normalizeSetupUriPayload(rawValue: string): string {
  if (/%25|%2b|%2f|%3d/i.test(rawValue)) {
    return decodeURIComponent(rawValue);
  }
  return rawValue;
}

export function decodeSetupUri(setupUri: string, setupUriPassphrase: string): DecodedSetupUriConfig {
  if (!setupUri.startsWith(SETUP_URI_PREFIX)) {
    throw new Error("setupUri must start with obsidian://setuplivesync?settings=");
  }
  if (!setupUriPassphrase.trim()) {
    throw new Error("setupUriPassphrase is required");
  }

  const encodedPayload = normalizeSetupUriPayload(setupUri.slice(SETUP_URI_PREFIX.length));
  if (encodedPayload.startsWith(LEGACY_V1_PREFIX)) {
    throw new Error("legacy setupUri payloads are not supported by this plugin yet");
  }

  let payload: SetupUriPayload;
  try {
    payload = JSON.parse(decodeSetupUriPayloadV2(encodedPayload, setupUriPassphrase)) as SetupUriPayload;
  } catch (error) {
    throw new Error(
      `failed to decode setupUri: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const objectValue = asObject(payload, "decoded setupUri payload");
  const url = readString(objectValue.couchDB_URI, "decoded setupUri payload.couchDB_URI", true) as string;
  const database = readString(objectValue.couchDB_DBNAME, "decoded setupUri payload.couchDB_DBNAME", true) as string;
  const encrypt = readBoolean(objectValue.encrypt, false);
  const passphrase = readString(objectValue.passphrase, "decoded setupUri payload.passphrase");
  const usePathObfuscation = readBoolean(objectValue.usePathObfuscation, false);
  const handleFilenameCaseSensitive = readBoolean(objectValue.handleFilenameCaseSensitive, false);

  if (encrypt && !passphrase) {
    throw new Error("decoded setupUri payload.passphrase is required when encryption is enabled");
  }
  if (usePathObfuscation && !passphrase) {
    throw new Error("decoded setupUri payload.passphrase is required when path obfuscation is enabled");
  }

  return {
    url: url.replace(/\/+$/, ""),
    database,
    username: readString(objectValue.couchDB_USER, "decoded setupUri payload.couchDB_USER"),
    password: readString(objectValue.couchDB_PASSWORD, "decoded setupUri payload.couchDB_PASSWORD"),
    headers: parseCustomHeaders(objectValue.couchDB_CustomHeaders),
    encrypt,
    passphrase,
    usePathObfuscation,
    handleFilenameCaseSensitive,
    e2eeAlgorithm: objectValue.E2EEAlgorithm as string | number | undefined,
    settingVersion: readOptionalNumber(objectValue.settingVersion),
  };
}

export function isSetupUriFieldPresent(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}