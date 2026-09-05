import crypto from "node:crypto";
import fs from "node:fs";
import { ensureDir, writePrivateFile } from "../config.ts";
import { getOAuthStorePath, getPiEssentialsDir } from "../paths.ts";

const KEYRING_SERVICE = "pi-essentials-mcp-oauth";
const PROBE_TIMEOUT_MS = 3_000;

export interface CredentialStore {
  readonly backend: "keyring" | "file";
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export function accountId(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

interface FileRecords {
  records: Record<string, unknown>;
}

function loadFileRecords(): FileRecords {
  const filePath = getOAuthStorePath();
  if (!fs.existsSync(filePath)) return { records: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as FileRecords;
    if (!parsed.records || typeof parsed.records !== "object") return { records: {} };
    return parsed;
  } catch {
    return { records: {} };
  }
}

function saveFileRecords(data: FileRecords): void {
  ensureDir(getPiEssentialsDir());
  writePrivateFile(getOAuthStorePath(), `${JSON.stringify(data, null, 2)}\n`);
}

/** Plaintext file (mode 0600), keyed by the raw un-hashed storage key -- unchanged on-disk shape. */
export function createFileStore(): CredentialStore {
  return {
    backend: "file",
    async get(account) {
      const raw = loadFileRecords().records[account];
      if (raw === undefined) return undefined;
      // A record written by the previous (pre credential-store) version of this
      // file stored the object directly rather than a JSON string; tolerate it.
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    },
    async set(account, value) {
      const data = loadFileRecords();
      data.records[account] = value;
      saveFileRecords(data);
    },
    async delete(account) {
      const data = loadFileRecords();
      if (!(account in data.records)) return;
      delete data.records[account];
      saveFileRecords(data);
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
export function createKeyringStore(): CredentialStore {
  return {
    backend: "keyring",
    async get(account) {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      try {
        return (await new AsyncEntry(KEYRING_SERVICE, account).getPassword()) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async set(account, value) {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      await new AsyncEntry(KEYRING_SERVICE, account).setPassword(value);
    },
    async delete(account) {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      try {
        await new AsyncEntry(KEYRING_SERVICE, account).deletePassword();
      } catch {
        // Already absent, or the store rejected the delete; there is nothing more to do.
      }
    },
  };
}

/** Round-trips a canary value; any failure (missing binary, locked/absent daemon) means "unavailable". */
async function probeKeyring(): Promise<boolean> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const probe = new AsyncEntry(KEYRING_SERVICE, "__pi_essentials_probe__");
    await withTimeout(probe.setPassword("ok"), PROBE_TIMEOUT_MS);
    await withTimeout(probe.deletePassword(), PROBE_TIMEOUT_MS).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedCredentialStore {
  store: CredentialStore;
  /** Set only when falling back to the plaintext file because no OS credential store is available. */
  warning?: string;
}

let resolved: Promise<ResolvedCredentialStore> | undefined;

/**
 * Prefer the OS credential store; fall back to the existing 0600 plaintext file
 * when none is available (no daemon, headless Linux without Secret Service,
 * platform without a supported backend). Unlike a hard fail-closed policy, this
 * keeps OAuth working everywhere pi-essentials already worked, while upgrading
 * to the more secure backend wherever one exists. Resolved once per process.
 */
export function resolveCredentialStore(): Promise<ResolvedCredentialStore> {
  if (!resolved) {
    resolved = probeKeyring().then((available) =>
      available
        ? { store: createKeyringStore() }
        : {
            store: createFileStore(),
            warning:
              "No OS credential store is available (keychain/Credential Manager/Secret Service); " +
              "MCP OAuth tokens are stored in a local file instead (mode 0600).",
          },
    );
  }
  return resolved;
}

/** Test-only: forget the resolved backend so the next call re-probes. */
export function resetCredentialStoreForTests(): void {
  resolved = undefined;
}
