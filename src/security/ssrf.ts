import { lookup } from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "0.0.0.0", "::1", "ip6-localhost"]);

export type SsrfIssue =
  | "unsupported-protocol"
  | "invalid-url"
  | "blocked-host"
  | "blocked-ip"
  | "dns-failure";

export class SsrfError extends Error {
  readonly issue: SsrfIssue;
  constructor(message: string, issue: SsrfIssue) {
    super(message);
    this.name = "SsrfError";
    this.issue = issue;
  }
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Invalid URL: ${raw}`, "invalid-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Only http and https URLs are allowed (got ${url.protocol})`, "unsupported-protocol");
  }
  if (url.username || url.password) {
    throw new SsrfError("URLs with embedded credentials are not allowed", "invalid-url");
  }
  return url;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal") return true;
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const ipVersion = net.isIP(ip);
  if (!ipVersion) return true;

  if (ipVersion === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  const normalized = normalizeIpv6(ip);
  if (normalized === "::1") return true; // loopback
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
  if (normalized.startsWith("ff")) return true; // multicast
  if (normalized.startsWith("::ffff:")) {
    const mapped = ipv4FromMapped(normalized);
    if (mapped) return isBlockedIp(mapped);
  }
  if (normalized.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix; treat as untrusted mapping
  return false;
}

function normalizeIpv6(ip: string): string {
  const dummy = net.isIPv6(ip) ? ip : ip;
  return dummy.toLowerCase();
}

function ipv4FromMapped(normalized: string): string | undefined {
  const idx = normalized.lastIndexOf(":");
  const last = normalized.slice(idx + 1);
  if (net.isIPv4(last)) return last;
  return undefined;
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  const url = parseHttpUrl(raw);
  if (isBlockedHostname(url.hostname)) {
    throw new SsrfError(`Blocked host: ${url.hostname}`, "blocked-host");
  }
  if (net.isIP(url.hostname)) {
    if (isBlockedIp(url.hostname)) {
      throw new SsrfError(`Blocked IP address: ${url.hostname}`, "blocked-ip");
    }
    return url;
  }
  try {
    const results = await lookup(url.hostname, { all: true, verbatim: true });
    if (results.length === 0) {
      throw new SsrfError(`DNS lookup returned no addresses for ${url.hostname}`, "dns-failure");
    }
    for (const result of results) {
      if (isBlockedIp(result.address)) {
        throw new SsrfError(`Host ${url.hostname} resolves to blocked address ${result.address}`, "blocked-ip");
      }
    }
  } catch (error) {
    if (error instanceof SsrfError) throw error;
    throw new SsrfError(`DNS lookup failed for ${url.hostname}`, "dns-failure");
  }
  return url;
}

export function redirectUrl(current: URL, location: string): URL {
  try {
    return new URL(location, current);
  } catch {
    throw new SsrfError(`Invalid redirect location: ${location}`, "invalid-url");
  }
}
