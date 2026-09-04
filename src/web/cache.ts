import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, writePrivateFile } from "../config.ts";
import { getWebCacheDir } from "../paths.ts";
import { WEB_CACHE_MAX_BYTES, WEB_CACHE_MAX_ENTRIES, WEB_CACHE_TTL_MS } from "../security/limits.ts";

export interface CacheEntry {
  id: string;
  url: string;
  title: string;
  markdown: string;
  createdAt: number;
}

interface IndexEntry {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  bytes: number;
}

interface IndexFile {
  entries: IndexEntry[];
}

const ID_PATTERN = /^[0-9a-f]{16}$/;

function indexPath(): string {
  return path.join(getWebCacheDir(), "index.json");
}

function entryPath(id: string): string {
  return path.join(getWebCacheDir(), `${id}.md`);
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<IndexEntry>;
  return (
    typeof row.id === "string" &&
    ID_PATTERN.test(row.id) &&
    typeof row.url === "string" &&
    typeof row.createdAt === "number" &&
    typeof row.bytes === "number"
  );
}

function loadIndex(): IndexFile {
  const file = indexPath();
  if (!fs.existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<IndexFile>;
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return {
      entries: parsed.entries.filter(isIndexEntry).map((row) => ({ ...row, title: String(row.title ?? row.url) })),
    };
  } catch {
    return { entries: [] };
  }
}

function saveIndex(index: IndexFile): void {
  ensureDir(getWebCacheDir());
  writePrivateFile(indexPath(), `${JSON.stringify(index)}\n`);
}

export function cacheId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function putCache(url: string, title: string, markdown: string): string {
  const id = cacheId(url);
  try {
    ensureDir(getWebCacheDir());
    writePrivateFile(entryPath(id), markdown);
    const index = loadIndex();
    const entries = index.entries.filter((e) => e.id !== id);
    entries.unshift({ id, url, title, createdAt: Date.now(), bytes: Buffer.byteLength(markdown, "utf8") });
    prune(entries);
    saveIndex({ entries });
  } catch {
    // A failing cache must never fail the fetch; the caller still gets the page.
  }
  return id;
}

export function getCache(idOrUrl: string): CacheEntry | undefined {
  const index = loadIndex();
  const meta = index.entries.find((e) => e.id === idOrUrl || e.url === idOrUrl);
  if (!meta) return undefined;
  if (Date.now() - meta.createdAt > WEB_CACHE_TTL_MS) return undefined;
  try {
    const markdown = fs.readFileSync(entryPath(meta.id), "utf8");
    return { id: meta.id, url: meta.url, title: meta.title, markdown, createdAt: meta.createdAt };
  } catch {
    return undefined;
  }
}

export function sliceMarkdown(markdown: string, offset = 0, limit?: number): { text: string; total: number; start: number } {
  const total = markdown.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), total);
  const end = limit !== undefined && Number.isFinite(limit) ? start + Math.max(0, Math.floor(limit)) : total;
  return { text: markdown.slice(start, end), total, start };
}

function prune(entries: IndexEntry[]): void {
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (now - entries[i].createdAt > WEB_CACHE_TTL_MS) {
      unlink(entries[i].id);
      entries.splice(i, 1);
    }
  }
  while (entries.length > WEB_CACHE_MAX_ENTRIES) {
    const removed = entries.pop();
    if (removed) unlink(removed.id);
  }
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  while (total > WEB_CACHE_MAX_BYTES && entries.length > 1) {
    const removed = entries.pop();
    if (!removed) break;
    total -= removed.bytes;
    unlink(removed.id);
  }
  removeOrphans(new Set(entries.map((entry) => entry.id)));
}

/** Drop `.md` files the index no longer references (crash or lost-update leftovers). */
function removeOrphans(live: Set<string>): void {
  let files: string[];
  try {
    files = fs.readdirSync(getWebCacheDir());
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const id = file.slice(0, -3);
    if (!ID_PATTERN.test(id) || live.has(id)) continue;
    unlink(id);
  }
}

function unlink(id: string): void {
  try {
    fs.rmSync(entryPath(id), { force: true });
  } catch {
    // ignore
  }
}
