/** Elements whose content is never useful as prose. */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "IFRAME",
  "CANVAS",
  "OBJECT",
  "EMBED",
  "HEAD",
  "META",
  "LINK",
  "AUDIO",
  "VIDEO",
]);

/** Elements rendered inside the current line rather than as their own block. */
const INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BIG",
  "BR",
  "CITE",
  "CODE",
  "DATA",
  "DEL",
  "DFN",
  "EM",
  "I",
  "IMG",
  "INS",
  "KBD",
  "LABEL",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRIKE",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "TT",
  "U",
  "VAR",
  "WBR",
]);

const MAX_DEPTH = 64;

interface Context {
  out: string[];
  pending: string[];
  listDepth: number;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ");
}

function textOf(node: { textContent?: string | null }): string {
  return collapse(node.textContent ?? "").trim();
}

export function htmlToMarkdown(root: ParentNode | null | undefined): string {
  if (!root) return "";
  const ctx: Context = { out: [], pending: [], listDepth: 0 };
  walk(pickRoot(root), ctx, 0);
  flush(ctx);
  return ctx.out
    .join("\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickRoot(root: ParentNode): ParentNode {
  const body = (root as ParentNode & { body?: ParentNode | null }).body;
  if (body && (body.childNodes?.length ?? 0) > 0) return body;
  if ((root.childNodes?.length ?? 0) > 0) return root;
  return body ?? root;
}

function flush(ctx: Context): void {
  const text = collapse(ctx.pending.join("")).trim();
  ctx.pending.length = 0;
  if (text) ctx.out.push(text);
}

function pushBlock(ctx: Context, block: string): void {
  flush(ctx);
  const trimmed = block.replace(/\s+$/, "");
  if (trimmed.trim()) ctx.out.push(trimmed);
}

function walk(node: ParentNode, ctx: Context, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const child of Array.from(node.childNodes ?? [])) {
    handle(child as ChildNode, ctx, depth);
  }
}

function handle(node: ChildNode, ctx: Context, depth: number): void {
  if (node.nodeType === 3) {
    const text = collapse(node.textContent ?? "");
    if (text.trim()) ctx.pending.push(text);
    return;
  }
  if (node.nodeType !== 1) return;

  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return;

  if (INLINE_TAGS.has(tag)) {
    ctx.pending.push(inline(el, depth + 1));
    return;
  }

  if (/^H[1-6]$/.test(tag)) {
    const heading = textOf(el);
    if (heading) pushBlock(ctx, `${"#".repeat(Number(tag[1]))} ${heading}`);
    return;
  }
  if (tag === "HR") {
    pushBlock(ctx, "---");
    return;
  }
  if (tag === "PRE") {
    pushBlock(ctx, codeBlock(el));
    return;
  }
  if (tag === "UL" || tag === "OL") {
    pushBlock(ctx, list(el, tag === "OL", ctx.listDepth, depth + 1));
    return;
  }
  if (tag === "LI") {
    // A stray <li> outside a list still reads better as a bullet.
    pushBlock(ctx, `- ${inline(el, depth + 1)}`);
    return;
  }
  if (tag === "TABLE") {
    pushBlock(ctx, table(el, depth + 1));
    return;
  }
  if (tag === "BLOCKQUOTE") {
    const inner = htmlToMarkdown(el);
    if (inner.trim()) {
      pushBlock(
        ctx,
        inner
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
    }
    return;
  }
  if (tag === "DT") {
    pushBlock(ctx, `**${inline(el, depth + 1)}**`);
    return;
  }
  if (tag === "DD") {
    pushBlock(ctx, `  ${inline(el, depth + 1)}`);
    return;
  }

  // Any other block-level container: keep its children in separate blocks.
  flush(ctx);
  walk(el, ctx, depth + 1);
  flush(ctx);
}

function codeBlock(el: Element): string {
  const code = el.querySelector?.("code") ?? null;
  const className = code?.getAttribute("class") ?? el.getAttribute("class") ?? "";
  const language = /(?:language|lang)-([\w+#-]+)/i.exec(className)?.[1] ?? "";
  const body = (el.textContent ?? "").replace(/\n+$/, "");
  if (!body.trim()) return "";
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

function list(el: Element, ordered: boolean, listDepth: number, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const indent = "  ".repeat(listDepth);
  const start = Number.parseInt(el.getAttribute("start") ?? "1", 10);
  const lines: string[] = [];
  let index = Number.isFinite(start) ? start : 1;

  for (const child of Array.from(el.children ?? [])) {
    const item = child as Element;
    if (item.tagName.toUpperCase() !== "LI") continue;
    const marker = ordered ? `${index++}.` : "-";
    const nested: string[] = [];
    const own: string[] = [];

    for (const part of Array.from(item.childNodes ?? [])) {
      const partTag = part.nodeType === 1 ? (part as Element).tagName.toUpperCase() : "";
      if (partTag === "UL" || partTag === "OL") {
        nested.push(list(part as Element, partTag === "OL", listDepth + 1, depth + 1));
      } else if (part.nodeType === 3) {
        own.push(collapse(part.textContent ?? ""));
      } else if (part.nodeType === 1) {
        own.push(INLINE_TAGS.has(partTag) ? inline(part as Element, depth + 1) : `${inline(part as Element, depth + 1)} `);
      }
    }

    const text = collapse(own.join("")).trim();
    lines.push(`${indent}${marker} ${text}`.replace(/\s+$/, ""));
    for (const block of nested) {
      if (block.trim()) lines.push(block);
    }
  }
  return lines.join("\n");
}

function table(el: Element, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const rows = Array.from(el.querySelectorAll?.("tr") ?? []) as Element[];
  if (rows.length === 0) return "";

  const grid = rows.map((row) =>
    (Array.from(row.children ?? []) as Element[])
      .filter((cell) => ["TD", "TH"].includes(cell.tagName.toUpperCase()))
      .map((cell) => inline(cell, depth + 1).replace(/\|/g, "\\|") || " "),
  );
  const width = Math.max(...grid.map((row) => row.length));
  if (width === 0) return "";

  const padded = grid.map((row) => [...row, ...new Array<string>(width - row.length).fill(" ")]);
  const headerIsLabels = rows[0].querySelector?.("th") !== null;
  const header = headerIsLabels ? padded[0] : new Array<string>(width).fill(" ");
  const body = headerIsLabels ? padded.slice(1) : padded;

  const lines = [`| ${header.join(" | ")} |`, `| ${new Array<string>(width).fill("---").join(" | ")} |`];
  for (const row of body) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function inline(el: Element, depth: number): string {
  if (depth > MAX_DEPTH) return textOf(el);
  const tag = el.tagName.toUpperCase();

  if (tag === "BR" || tag === "WBR") return " ";
  if (tag === "IMG") {
    const src = el.getAttribute("src") ?? "";
    const alt = collapse(el.getAttribute("alt") ?? "").trim();
    return src ? `![${alt}](${src})` : alt;
  }
  if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
    const code = textOf(el);
    return code ? `\`${code}\`` : "";
  }

  const parts: string[] = [];
  for (const child of Array.from(el.childNodes ?? [])) {
    if (child.nodeType === 3) {
      parts.push(collapse(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const nested = child as Element;
    if (SKIP_TAGS.has(nested.tagName.toUpperCase())) continue;
    parts.push(inline(nested, depth + 1));
  }
  const content = collapse(parts.join("")).trim();

  if (tag === "A") {
    const href = el.getAttribute("href") ?? "";
    if (!href || href.startsWith("javascript:")) return content;
    return content ? `[${content}](${href})` : href;
  }
  if (tag === "STRONG" || tag === "B") return content ? `**${content}**` : "";
  if (tag === "EM" || tag === "I") return content ? `_${content}_` : "";
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") return content ? `~~${content}~~` : "";
  return content;
}
