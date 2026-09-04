import fs from "node:fs";
import http from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { ensureDir, writePrivateFile } from "../config.ts";
import { getOAuthStorePath, getPiEssentialsDir } from "../paths.ts";

interface StoredRecord {
  serverUrl: string;
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationFull | OAuthClientInformation;
  codeVerifier?: string;
}

interface StoreFile {
  records: Record<string, StoredRecord>;
}

function storageKey(serverName: string, serverUrl: string): string {
  return `${serverName}|${serverUrl}`;
}

function loadStore(): StoreFile {
  const filePath = getOAuthStorePath();
  if (!fs.existsSync(filePath)) return { records: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoreFile;
    if (!parsed.records || typeof parsed.records !== "object") return { records: {} };
    return parsed;
  } catch {
    return { records: {} };
  }
}

function saveStore(store: StoreFile): void {
  ensureDir(getPiEssentialsDir());
  writePrivateFile(getOAuthStorePath(), `${JSON.stringify(store, null, 2)}\n`);
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

  private read(): StoredRecord {
    const store = loadStore();
    const record = store.records[storageKey(this.serverName, this.serverUrl)];
    if (record && record.serverUrl !== this.serverUrl) {
      return { serverUrl: this.serverUrl };
    }
    return record ?? { serverUrl: this.serverUrl };
  }

  private write(patch: Partial<StoredRecord>): void {
    const store = loadStore();
    const key = storageKey(this.serverName, this.serverUrl);
    const current = store.records[key] ?? { serverUrl: this.serverUrl };
    if (current.serverUrl !== this.serverUrl) {
      store.records[key] = { serverUrl: this.serverUrl, ...patch };
    } else {
      store.records[key] = { ...current, ...patch, serverUrl: this.serverUrl };
    }
    saveStore(store);
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.staticClient ?? this.read().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.write({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    const tokens = this.read().tokens;
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens, codeVerifier: undefined });
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

  saveCodeVerifier(codeVerifier: string): void {
    this.localVerifier = codeVerifier;
    this.write({ codeVerifier });
  }

  codeVerifier(): string {
    const stored = this.localVerifier ?? this.read().codeVerifier;
    if (!stored) throw new Error("No PKCE code verifier is stored for this OAuth flow.");
    return stored;
  }

  clearTokens(): void {
    const store = loadStore();
    delete store.records[storageKey(this.serverName, this.serverUrl)];
    saveStore(store);
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
