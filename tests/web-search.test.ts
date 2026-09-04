import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { registerWeb, resolveSearchCount } from "../src/web/index.ts";
import { normalizeResultUrl, toHits } from "../src/web/providers/types.ts";
import { formatSearch, runSearch } from "../src/web/search.ts";

describe("web search compatibility", () => {
  it("advertises integer schemas for all result-count spellings", () => {
    let schema: { properties?: Record<string, { type?: string }> } | undefined;
    const pi = {
      registerTool: (tool: { name: string; parameters: typeof schema }) => {
        if (tool.name === "web_search") schema = tool.parameters;
      },
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      on: () => undefined,
    };
    registerWeb(pi as never, resolveConfig({}));
    expect(schema?.properties?.numResults?.type).toBe("integer");
    expect(schema?.properties?.limit?.type).toBe("integer");
    expect(schema?.properties?.num_search_results?.type).toBe("integer");
  });

  it("accepts count aliases with documented precedence", () => {
    expect(resolveSearchCount({ numResults: 3, limit: 4, num_search_results: 5 }, 6)).toBe(3);
    expect(resolveSearchCount({ limit: 4, num_search_results: 5 }, 6)).toBe(4);
    expect(resolveSearchCount({ num_search_results: 5 }, 6)).toBe(5);
    expect(resolveSearchCount({}, 6)).toBe(6);
  });

  it("rejects non-integer and out-of-range result counts at runtime", () => {
    expect(() => resolveSearchCount({ limit: 2.5 }, 5)).toThrow(/must be an integer/);
    expect(() => resolveSearchCount({ numResults: 0 }, 5)).toThrow(/must be an integer/);
  });

  it("normalizes, validates, and deduplicates http(s) result URLs", () => {
    expect(normalizeResultUrl("HTTPS://Example.COM:443/a#first")).toBe("https://example.com/a");
    expect(normalizeResultUrl("javascript:alert(1)")).toBeUndefined();
    const hits = toHits(
      [
        { title: "First", url: "HTTPS://Example.COM:443/a#first", snippet: "one" },
        { title: "Duplicate", url: "https://example.com/a#second", snippet: "two" },
        { title: "Unsafe", url: "file:///etc/passwd", snippet: "three" },
        { title: "Broken", url: "not a url", snippet: "four" },
      ],
      10,
      "test",
    );
    expect(hits).toEqual([
      { title: "First", url: "https://example.com/a", snippet: "one", source: "test" },
    ]);
  });

  it("caps snippets rendered into tool output at about 240 characters", () => {
    const output = formatSearch({
      provider: "test",
      query: "q",
      hits: [{ title: "A", url: "https://example.com/", snippet: "x".repeat(500), source: "test" }],
    });
    const snippet = output.split("\n").find((line) => line.trimStart().startsWith("x"));
    expect(snippet?.trim().length).toBe(240);
    expect(snippet).toMatch(/…$/);
  });

  it("does not enter the provider fallback chain after cancellation", async () => {
    const config = resolveConfig({}).web.search;
    const controller = new AbortController();
    controller.abort();
    await expect(runSearch("q", config, "auto", 1, controller.signal)).rejects.toMatchObject({
      code: "WEB_SEARCH_CANCELLED",
    });
  });
});
