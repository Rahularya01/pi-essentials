import http from "node:http";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedLookup } from "../src/web/http.ts";
import { normalizeAllowedHost, resolveSafeUrl } from "../src/security/ssrf.ts";

describe("pinnedLookup", () => {
  const addresses = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];

  it("answers with the validated address regardless of the hostname asked for", () => {
    const lookup = pinnedLookup(addresses) as unknown as (
      hostname: string,
      options: { all?: boolean },
      cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
    ) => void;

    let single: [string | LookupAddress[], number | undefined] | undefined;
    lookup("rebind.attacker.test", {}, (err, address, family) => {
      expect(err).toBeNull();
      single = [address, family];
    });
    expect(single?.[0]).toBe("93.184.216.34");
    expect(single?.[1]).toBe(4);

    let all: string | LookupAddress[] | undefined;
    lookup("rebind.attacker.test", { all: true }, (_err, result) => {
      all = result;
    });
    expect(all).toEqual(addresses);
  });

  it("fails closed when there is nothing validated to connect to", () => {
    const lookup = pinnedLookup([]) as unknown as (
      hostname: string,
      options: Record<string, unknown>,
      cb: (err: NodeJS.ErrnoException | null) => void,
    ) => void;
    let error: NodeJS.ErrnoException | null = null;
    lookup("anything", {}, (err) => {
      error = err;
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("DNS rebinding", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("private data");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to the address that was validated, not one resolved later", async () => {
    // Stand in for a hostile resolver: validation saw a public address, and a
    // second lookup at connect time would have returned loopback. The pinned
    // lookup means the socket can only go where the check already approved.
    const validated = await resolveSafeUrl(`http://127.0.0.1:${port}/`, {
      allowedHosts: new Set([`127.0.0.1:${port}`]),
    });
    expect(validated.addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);

    const reached = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        validated.url,
        { lookup: pinnedLookup(validated.addresses) },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(reached).toBe("private data");
  });

  it("rejects a host whose DNS answer includes a private address", async () => {
    // localhost resolves to loopback, which stands in for a rebinding answer.
    await expect(resolveSafeUrl("http://localhost/")).rejects.toThrow(/Blocked host/);
  });
});

describe("allowed host entries", () => {
  it("normalizes bare hosts, host:port, and full urls", () => {
    expect(normalizeAllowedHost("localhost")).toBe("localhost");
    expect(normalizeAllowedHost("LOCALHOST:8888")).toBe("localhost:8888");
    expect(normalizeAllowedHost("http://127.0.0.1:8888/search")).toBe("127.0.0.1:8888");
    expect(normalizeAllowedHost("127.0.0.1:80")).toBe("127.0.0.1:80");
    expect(normalizeAllowedHost("https://searx.example.com:443/search")).toBe("searx.example.com:443");
    expect(normalizeAllowedHost("https://searx.example.com")).toBe("searx.example.com");
    expect(normalizeAllowedHost("  ")).toBeUndefined();
    expect(normalizeAllowedHost("::::")).toBeUndefined();
  });
});
