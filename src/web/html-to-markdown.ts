const BLOCK_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME"]);

function textOf(node: { textContent?: string | null }): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function htmlToMarkdown(root: ParentNode | null | undefined): string {
  if (!root) return "";
  const start = pickRoot(root);
  const lines: string[] = [];
  walk(start, lines, { listDepth: 0 });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickRoot(root: ParentNode): ParentNode {
  const asDoc = root as ParentNode & { body?: ParentNode | null };
  const body = asDoc.body;
  if (body && childCount(body) > 0) return body;
  if (childCount(root) > 0) return root;
  return body ?? root;
}

function childCount(node: ParentNode): number {
  return node.childNodes?.length ?? 0;
}

interface WalkState {
  listDepth: number;
}

function walk(node: ParentNode, lines: string[], state: WalkState): void {
  for (const child of Array.from(node.childNodes)) {
    handle(child as ChildNode, lines, state);
  }
}

function handle(node: ChildNode, lines: string[], state: WalkState): void {
  if (node.nodeType === 3) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ");
    if (text.trim()) append(lines, text);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (BLOCK_TAGS.has(tag)) return;

  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const heading = textOf(el);
    if (heading) lines.push("", `${"#".repeat(level)} ${heading}`, "");
    return;
  }
  if (tag === "P") {
    const inner = inline(el);
    if (inner) lines.push("", inner, "");
    return;
  }
  if (tag === "BR") {
    lines.push("");
    return;
  }
  if (tag === "HR") {
    lines.push("", "---", "");
    return;
  }
  if (tag === "PRE") {
    lines.push("", "```", el.textContent?.trimEnd() ?? "", "```", "");
    return;
  }
  if (tag === "CODE" && el.parentElement?.tagName !== "PRE") {
    append(lines, `\`${textOf(el)}\``);
    return;
  }
  if (tag === "A") {
    const href = el.getAttribute("href") ?? "";
    const label = inline(el) || href;
    append(lines, href ? `[${label}](${href})` : label);
    return;
  }
  if (tag === "IMG") {
    const src = el.getAttribute("src") ?? "";
    const alt = el.getAttribute("alt") ?? "";
    if (src) append(lines, `![${alt}](${src})`);
    return;
  }
  if (tag === "LI") {
    const prefix = `${"  ".repeat(state.listDepth)}- `;
    lines.push(`${prefix}${inline(el)}`);
    return;
  }
  if (tag === "UL" || tag === "OL") {
    lines.push("");
    walk(el, lines, { listDepth: state.listDepth + 1 });
    lines.push("");
    return;
  }
  if (tag === "BLOCKQUOTE") {
    const inner = htmlToMarkdown(el)
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    if (inner.trim()) lines.push("", inner, "");
    return;
  }
  walk(el, lines, state);
}

function inline(el: Element): string {
  const parts: string[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      parts.push((child.textContent ?? "").replace(/\s+/g, " "));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const nested = child as Element;
    const tag = nested.tagName.toUpperCase();
    if (tag === "A") {
      const href = nested.getAttribute("href") ?? "";
      const label = inline(nested) || href;
      parts.push(href ? `[${label}](${href})` : label);
    } else if (tag === "CODE") {
      parts.push(`\`${textOf(nested)}\``);
    } else if (tag === "STRONG" || tag === "B") {
      parts.push(`**${inline(nested)}**`);
    } else if (tag === "EM" || tag === "I") {
      parts.push(`_${inline(nested)}_`);
    } else if (tag === "BR") {
      parts.push("\n");
    } else {
      parts.push(inline(nested));
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function append(lines: string[], text: string): void {
  if (lines.length === 0) {
    lines.push(text);
    return;
  }
  const last = lines.length - 1;
  if (lines[last] === "") lines[last] = text;
  else lines[last] += text;
}
