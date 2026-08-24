// A model sometimes wraps its whole answer in a fence. But a document *about*
// code legitimately contains fences of its own, and treating the first one as a
// wrapper would throw the document away and keep a snippet. So a fence only
// counts as a wrapper when it opens the reply and nothing follows it.
const WRAPPER = /^(?:[^\n]{0,120}\n{1,2})?```(?:markdown|md)?[^\n]*\n([\s\S]*?)```\s*$/;

// Models are asked for plain markdown, and mostly comply — but "mostly" is not a
// contract. Anything unparseable still has to become a usable document rather
// than an error, so the whole reply is the body when no structure is found.
export function parseRevision(text, fallbackTitle = "Project document") {
  const raw = String(text ?? "").trim();
  if (!raw) return { title: fallbackTitle, markdown: "" };

  const fenced = raw.match(WRAPPER);
  const body = (fenced ? fenced[1] : raw).trim();

  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading ? heading[1].trim() : fallbackTitle;
  return { title, markdown: body };
}

// Files the model proposes, as ```lang path=... fences or a "path:" line above a
// fence. Offering these to save is the point; guessing wrong must be harmless,
// so a block without a plausible path is simply not offered.
const FILE_BLOCK = /(?:^|\n)(?:(?:\*\*)?([\w./-]+\.[\w]{1,8})(?:\*\*)?\s*:?\s*\n+)?```[\w+-]*(?:\s+path=("?)([^\s"`]+)\2)?\s*\n([\s\S]*?)```/g;

export function proposedFiles(markdown) {
  const files = [];
  const seen = new Set();
  for (const match of String(markdown ?? "").matchAll(FILE_BLOCK)) {
    const [, labelPath, , attributePath, content] = match;
    const path = attributePath ?? labelPath;
    if (!path || !/\.[\w]{1,8}$/.test(path) || path.startsWith("/") || path.includes("..")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, content: content.replace(/\s+$/, "") });
  }
  return files;
}

export function nextRevision(current, { title, markdown, contributors }) {
  return {
    title: title || current?.title || "Project document",
    markdown,
    version: (current?.version ?? 0) + 1,
    contributors: contributors ?? []
  };
}

export function buildPrompt({ instruction, document, attachments }) {
  const sections = [
    "You are a resident intelligence in one shared project. Produce the project document itself, not commentary about it."
  ];

  if (document?.markdown) {
    sections.push(`CURRENT DOCUMENT (revision ${document.version})\n\n${document.markdown}`);
    sections.push("Revise the document above. Keep what still holds, change what the instruction asks for, and return the COMPLETE document — not a diff and not a summary of your edits.");
  } else {
    sections.push("There is no document yet. Create the first revision.");
  }

  if (attachments?.length) {
    sections.push(`ATTACHED FILES\n\n${attachments.map(file => `--- ${file.path} ---\n${file.content}`).join("\n\n")}`);
  }

  sections.push(`INSTRUCTION\n\n${instruction}`);
  sections.push("Reply with markdown only. Start with a single '# ' title line. To propose a file, use a fenced code block preceded by its path on its own line.");
  return sections.join("\n\n");
}
