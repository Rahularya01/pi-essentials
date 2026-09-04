import { lookup } from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "0.0.0.0", "::1", "ip6-localhost", "ip6-loopback"]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

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

/** Strip IPv6 brackets, a trailing FQDN dot, and case. */
export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === "metadata.google.internal" || host === "metadata") return true;
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (!version) return true;
  if (version === 4) return isBlockedIpv4(ip);

  const groups = expandIpv6(ip);
  if (!groups) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses.
  const isZeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return true; // :: and ::1
    return isBlockedIpv4(mapped);
  }

  const [first] = groups;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x0064 && groups[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (first === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true; // 100::/64 discard
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  return false;
}

/** Expand any valid IPv6 textual form into eight 16-bit groups. */
export function expandIpv6(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  let text = ip.toLowerCase().replace(/%.*$/, ""); // drop zone id

  // Trailing dotted-quad form: ::ffff:127.0.0.1
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, dotted.index)}${hi}:${lo}`;
  }

  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return undefined;
  const parse = (part: string): number[] =>
    part
      .split(":")
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => Number.parseInt(chunk, 16));

  const left = parse(head ?? "");
  const right = tail === undefined ? [] : parse(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return undefined;
  const groups = [...left, ...new Array<number>(Math.max(0, fill)).fill(0), ...right];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

export interface PinnedAddress {
  address: string;
  family: number;
}

export interface SafeUrl {
  url: URL;
  /**
   * The exact addresses this URL was validated against. Connecting to these
   * instead of re-resolving the hostname is what closes the DNS-rebinding window
   * between validation and connect.
   */
  addresses: PinnedAddress[];
}

export interface SsrfPolicy {
  /**
   * Hosts explicitly trusted by the user, as `host` or `host:port` (a bare host
   * matches any port). Used for deliberately local services such as a self-hosted
   * SearXNG instance.
   */
  allowedHosts?: ReadonlySet<string>;
}

/** True when the user has explicitly allowed this host (optionally per port). */
export function isAllowedHost(url: URL, policy?: SsrfPolicy): boolean {
  const allowed = policy?.allowedHosts;
  if (!allowed || allowed.size === 0) return false;
  const host = normalizeHostname(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.has(host) || allowed.has(`${host}:${port}`);
}

function explicitPort(entry: string): string | undefined {
  const withoutScheme = entry.includes("://") ? entry.slice(entry.indexOf("://") + 3) : entry;
  const authority = withoutScheme.split(/[/?#]/, 1)[0].split("@").pop() ?? "";
  const match = authority.startsWith("[") ? /^\[[^\]]+\]:(\d+)$/.exec(authority) : /:(\d+)$/.exec(authority);
  return match?.[1];
}

/** Normalize an allowlist entry the same way `isAllowedHost` normalizes a URL. */
export function normalizeAllowedHost(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed) return undefined;
  try {
    // URL.port intentionally erases explicit default ports. Extract the port
    // from the original authority so `host:80` does not become a host-wide grant.
    const port = explicitPort(trimmed);
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    const host = normalizeHostname(parsed.hostname);
    if (!host) return undefined;
    return port ? `${host}:${port}` : host;
  } catch {
    return undefined;
  }
}

/**
 * Validate a URL and return the addresses it resolved to, so the caller can pin
 * the connection to them.
 */
export async function resolveSafeUrl(raw: string, policy?: SsrfPolicy): Promise<SafeUrl> {
  const url = parseHttpUrl(raw);
  const hostname = normalizeHostname(url.hostname);
  const exempt = isAllowedHost(url, policy);

  if (!exempt && isBlockedHostname(url.hostname)) {
    throw new SsrfError(`Blocked host: ${url.hostname}`, "blocked-host");
  }

  const literal = net.isIP(hostname);
  if (literal) {
    if (!exempt && isBlockedIp(hostname)) {
      throw new SsrfError(`Blocked IP address: ${url.hostname}`, "blocked-ip");
    }
    return { url, addresses: [{ address: hostname, family: literal }] };
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`DNS lookup failed for ${url.hostname}`, "dns-failure");
  }
  if (results.length === 0) {
    throw new SsrfError(`DNS lookup returned no addresses for ${url.hostname}`, "dns-failure");
  }
  if (!exempt) {
    for (const result of results) {
      if (isBlockedIp(result.address)) {
        throw new SsrfError(`Host ${url.hostname} resolves to blocked address ${result.address}`, "blocked-ip");
      }
    }
  }
  return {
    url,
    addresses: results.map((result) => ({ address: result.address, family: result.family || net.isIP(result.address) })),
  };
}

export async function assertSafeUrl(raw: string, policy?: SsrfPolicy): Promise<URL> {
  return (await resolveSafeUrl(raw, policy)).url;
}

export function redirectUrl(current: URL, location: string): URL {
  try {
    return new URL(location, current);
  } catch {
    throw new SsrfError(`Invalid redirect location: ${location}`, "invalid-url");
  }
}
