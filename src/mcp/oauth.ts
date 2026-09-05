import http from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { accountId, createFileStore, resolveCredentialStore } from "./credential-store.ts";

interface StoredRecord {
  serverUrl: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationFull | OAuthClientInformation;
  codeVerifier?: string;
}

function storageKey(serverName: string, serverUrl: string): string {
  return `${serverName}|${serverUrl}`;
}

/** Shared across FileOAuthProvider instances for the process lifetime, so a
 *  second instance created for the same server (as the two-step auth-complete
 *  flow does) sees what an earlier instance just persisted. `null` means
 *  "confirmed absent", distinct from "not yet looked up". */
const recordCache = new Map<string, StoredRecord | null>();

function parseRecord(raw: string | undefined, expectedUrl: string): StoredRecord | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredRecord;
    // A record whose URL no longer matches belongs to a server that moved; treat it as absent.
    return parsed && parsed.serverUrl === expectedUrl ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readRecord(serverName: string, serverUrl: string): Promise<StoredRecord | undefined> {
  const rawKey = storageKey(serverName, serverUrl);
  if (recordCache.has(rawKey)) return recordCache.get(rawKey) ?? undefined;

  const { store } = await resolveCredentialStore();
  const account = store.backend === "keyring" ? accountId(rawKey) : rawKey;
  let raw = await store.get(account);

  if (raw === undefined && store.backend === "keyring") {
    // One-way import of a plaintext entry from before the credential store existed.
    const legacy = createFileStore();
    const legacyRaw = await legacy.get(rawKey);
    if (legacyRaw !== undefined) {
      await store.set(account, legacyRaw);
      await legacy.delete(rawKey);
      raw = legacyRaw;
    }
  }

  const record = parseRecord(raw, serverUrl);
  recordCache.set(rawKey, record ?? null);
  return record;
}

async function writeRecord(serverName: string, serverUrl: string, record: StoredRecord): Promise<void> {
  const rawKey = storageKey(serverName, serverUrl);
  const { store } = await resolveCredentialStore();
  const account = store.backend === "keyring" ? accountId(rawKey) : rawKey;
  await store.set(account, JSON.stringify(record));
  recordCache.set(rawKey, record);
}

async function deleteRecord(serverName: string, serverUrl: string): Promise<void> {
  const rawKey = storageKey(serverName, serverUrl);
  const { store } = await resolveCredentialStore();
  const account = store.backend === "keyring" ? accountId(rawKey) : rawKey;
  await store.delete(account);
  // A server not yet migrated to the keyring may still have a legacy plaintext
  // entry; clear that too so logout actually removes every stored credential.
  if (store.backend === "keyring") await createFileStore().delete(rawKey);
  recordCache.set(rawKey, null);
}

/** Test-only: forget cached records so a test can observe a fresh read from the backing store. */
export function resetOAuthCacheForTests(): void {
  recordCache.clear();
}

export class FileOAuthProvider implements OAuthClientProvider {
  private pendingRedirect: URL | undefined;
  private localVerifier: string | undefined;

  constructor(
    readonly serverName: string,
    readonly serverUrl: string,
    readonly redirectUrl: string,
    readonly clientMetadata: OAuthClientMetadata,
    private readonly staticClient?: OAuthClientInformation,
    private readonly onRedirect?: (url: URL) => void,
  ) {}

  private async read(): Promise<StoredRecord> {
    const record = await readRecord(this.serverName, this.serverUrl);
    return record ?? { serverUrl: this.serverUrl };
  }

  private async write(patch: Partial<StoredRecord>): Promise<void> {
    const current = await this.read();
    await writeRecord(this.serverName, this.serverUrl, { ...current, ...patch, serverUrl: this.serverUrl });
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return this.staticClient ?? (await this.read()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.write({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ tokens, codeVerifier: undefined });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingRedirect = authorizationUrl;
    this.onRedirect?.(authorizationUrl);
  }

  takeRedirectUrl(): URL | undefined {
    const url = this.pendingRedirect;
    this.pendingRedirect = undefined;
    return url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.localVerifier = codeVerifier;
    await this.write({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const stored = this.localVerifier ?? (await this.read()).codeVerifier;
    if (!stored) throw new Error("No PKCE code verifier is stored for this OAuth flow.");
    return stored;
  }

  async clearTokens(): Promise<void> {
    await deleteRecord(this.serverName, this.serverUrl);
    this.localVerifier = undefined;
  }
}

export interface LoopbackCallback {
  redirectUri: string;
  waitForCallback: (timeoutMs: number) => Promise<URL>;
  close: () => void;
}

const CALLBACK_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Pi</title>` +
  `<body style="font-family:system-ui;padding:2rem"><p>${message}</p></body>`;

export function startLoopbackCallback(preferredPort = 0): Promise<LoopbackCallback> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const sockets = new Set<import("node:net").Socket>();
    const waiters: Array<(url: URL) => void> = [];
    let received: URL | undefined;

    // Keep-alive sockets would otherwise block server.close().
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    server.on("request", (req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.statusCode = 400;
        res.end("Bad request");
        return;
      }
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const oauthError = url.searchParams.get("error");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        CALLBACK_PAGE(
          oauthError
            ? `Authorization failed: ${escapeHtml(url.searchParams.get("error_description") ?? oauthError)}`
            : "Authentication complete. You can return to Pi.",
        ),
      );
      received = url;
      for (const waiter of waiters.splice(0)) waiter(url);
    });

    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind the OAuth callback server on 127.0.0.1"));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        waitForCallback: (timeoutMs: number) =>
          new Promise<URL>((resWait, rejWait) => {
            if (received) {
              resWait(received);
              return;
            }
            const timer = setTimeout(
              () => rejWait(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the OAuth callback.`)),
              timeoutMs,
            );
            timer.unref?.();
            waiters.push((url) => {
              clearTimeout(timer);
              resWait(url);
            });
          }),
        close: () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close();
        },
      });
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export async function maybeOpenUrl(url: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    if (process.platform === "darwin") {
      await execFileAsync("open", [url]);
      return true;
    }
    if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", url]);
      return true;
    }
    await execFileAsync("xdg-open", [url]);
    return true;
  } catch {
    return false;
  }
}
