// A model sometimes wraps its whole answer in one fence. But a document *about*
// code contains fences of its own, and unwrapping then would splice the
// document's own blocks together and destroy the code inside them. A reply is
// only wrapped when there is exactly one fence: an opening and its close.
const WRAPPER = /^(?:[^\n]{0,120}\n{1,2})?```(?:markdown|md)?[^\n]*\n([\s\S]*)```\s*$/;
const fenceCount = text => (text.match(/```/g) ?? []).length;

// Models are asked for plain markdown, and mostly comply — but "mostly" is not a
// contract. Anything unparseable still has to become a usable document rather
// than an error, so the whole reply is the body when no structure is found.
export function parseRevision(text, fallbackTitle = "Project document") {
  const raw = String(text ?? "").trim();
  if (!raw) return { title: fallbackTitle, markdown: "" };

  const fenced = fenceCount(raw) === 2 ? raw.match(WRAPPER) : null;
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
  const offer = (path, content) => {
    if (!usablePath(path) || seen.has(path)) return;
    seen.add(path);
    files.push({ path, content: String(content).replace(/\s+$/, "") });
  };

  // Models name a file in whatever way they feel like. Rejecting a working file
  // because its label arrived in an unexpected shape wastes the work, so every
  // shape seen in practice is accepted.
  for (const match of String(markdown ?? "").matchAll(FILE_BLOCK)) {
    const [, labelPath, , attributePath, content] = match;
    offer(attributePath ?? labelPath, content);
  }

  // A fence containing nothing but a path, naming the fence that follows it.
  const blocks = [...String(markdown ?? "").matchAll(/```[\w+-]*[^\n]*\n([\s\S]*?)```/g)];
  for (const [index, block] of blocks.entries()) {
    const alone = block[1].trim();
    const next = blocks[index + 1];
    if (next && !alone.includes("\n") && usablePath(alone)) offer(alone, next[1]);
  }

  return files;
}

function usablePath(path) {
  return Boolean(path)
    && /\.[\w]{1,8}$/.test(path)
    && !path.startsWith("/")
    && !path.includes("..")
    && !/\s/.test(path);
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

// Asking for a document and hoping a file falls out of it does not hold: the
// same model answers with the path inside a fence, or beside one, or with no
// fence at all, run to run. When the point is to produce one file, the contract
// says so — the whole reply is the file — and this strips the decoration a model
// adds anyway.
export function filePrompt({ path, instruction, existing, attachments }) {
  const sections = [
    `Write the complete contents of the file \`${path}\`.`,
    existing ? `THE FILE AS IT IS NOW\n\n${existing}` : null,
    attachments?.length
      ? `FILES IN THE PROJECT FOR REFERENCE\n\n${attachments.map(file => `--- ${file.path} ---\n${file.content}`).join("\n\n")}`
      : null,
    `WHAT IT MUST DO\n\n${instruction}`,
    [
      "Output the file and nothing else: no explanation before it, no summary",
      "after it, no markdown fence around it. The first character of your reply",
      "is the first character of the file. It must be complete and ready to run."
    ].join(" ")
  ].filter(Boolean);
  return sections.join("\n\n");
}

export function fileFromReply(reply, path) {
  let text = String(reply ?? "").trim();

  // A leading line naming the file, which models add despite being asked not to.
  const named = text.match(/^[`*\s]*([\w./-]+\.[\w]{1,8})[`*\s]*\n/);
  if (named && path && named[1].endsWith(path.split("/").pop())) text = text.slice(named[0].length).trim();

  // A fence around the whole thing, opening and closing exactly once.
  if ((text.match(/```/g) ?? []).length === 2) {
    const unwrapped = text.match(/^```[\w+-]*[^\n]*\n([\s\S]*)```\s*$/);
    if (unwrapped) text = unwrapped[1];
  }
  return text.replace(/\s+$/, "") + "\n";
}
