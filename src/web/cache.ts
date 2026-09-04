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

interface IndexFile {
  entries: Array<{ id: string; url: string; title: string; createdAt: number; bytes: number }>;
}

function indexPath(): string {
  return path.join(getWebCacheDir(), "index.json");
}

function entryPath(id: string): string {
  return path.join(getWebCacheDir(), `${id}.md`);
}

function loadIndex(): IndexFile {
  const file = indexPath();
  if (!fs.existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as IndexFile;
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
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
  ensureDir(getWebCacheDir());
  writePrivateFile(entryPath(id), markdown);
  const index = loadIndex();
  const bytes = Buffer.byteLength(markdown, "utf8");
  const next = index.entries.filter((e) => e.id !== id);
  next.unshift({ id, url, title, createdAt: Date.now(), bytes });
  prune(next);
  saveIndex({ entries: next });
  return id;
}

export function getCache(idOrUrl: string): CacheEntry | undefined {
  const index = loadIndex();
  const now = Date.now();
  const meta = index.entries.find((e) => e.id === idOrUrl || e.url === idOrUrl);
  if (!meta) return undefined;
  if (now - meta.createdAt > WEB_CACHE_TTL_MS) return undefined;
  const file = entryPath(meta.id);
  if (!fs.existsSync(file)) return undefined;
  try {
    const markdown = fs.readFileSync(file, "utf8");
    return { id: meta.id, url: meta.url, title: meta.title, markdown, createdAt: meta.createdAt };
  } catch {
    return undefined;
  }
}

export function sliceMarkdown(markdown: string, offset = 0, limit?: number): { text: string; total: number } {
  const start = Math.max(0, offset);
  const end = limit !== undefined ? start + Math.max(0, limit) : markdown.length;
  return { text: markdown.slice(start, end), total: markdown.length };
}

function prune(entries: IndexFile["entries"]): void {
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
  while (total > WEB_CACHE_MAX_BYTES && entries.length > 0) {
    const removed = entries.pop();
    if (!removed) break;
    total -= removed.bytes;
    unlink(removed.id);
  }
}

function unlink(id: string): void {
  try {
    fs.unlinkSync(entryPath(id));
  } catch {
    // ignore
  }
}
