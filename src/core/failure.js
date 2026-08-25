// Reading a failure well is what makes repair possible at scale. One file can be
// rewritten from the error alone; a project cannot, because the error names files
// the person never mentioned and the fix often belongs in one of those.

const PATH_IN_TEXT = /(?:^|[\s('"[]|file:\/\/\/)([A-Za-z]:[\\/][^\s:'")\]]+|[\\/]?(?:\.{1,2}[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z]{1,5})(?=[\s:'")\]]|$)/g;

// Paths a failure blames, in the order they appear, so the first is usually the
// one to look at. Only files inside the project survive: a stack trace is mostly
// node internals and dependency code, and offering those to be rewritten would be
// worse than offering nothing.
export function filesInFailure(text, { known = [], limit = 6 } = {}) {
  const inProject = new Set(known);
  const found = [];

  for (const match of String(text ?? "").matchAll(PATH_IN_TEXT)) {
    const raw = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
    if (/node_modules|node:internal|^node:/.test(raw)) continue;

    const candidate = inProject.has(raw)
      ? raw
      : [...inProject].find(path => raw.endsWith(`/${path}`) || path.endsWith(`/${raw}`));
    if (candidate && !found.includes(candidate)) found.push(candidate);
    if (found.length >= limit) break;
  }
  return found;
}

// One file is asked for as a whole file. Several have to be labelled, and the
// label has to be unmistakable — a model improvising here would write code into
// the wrong file.
const CHANGE = /^===\s*FILE:\s*(\S+)\s*===\s*$/;

export function parseChanges(reply, { allowed = [] } = {}) {
  const changes = [];
  let current = null;

  for (const line of String(reply ?? "").split(/\r?\n/)) {
    const header = line.match(CHANGE);
    if (header) {
      if (current) changes.push(current);
      current = { path: header[1].replace(/\\/g, "/"), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) changes.push(current);

  // A change to a file nobody offered is refused rather than applied: at scale
  // that is how a model rewrites something it was never shown.
  const permitted = new Set(allowed);
  return changes
    .filter(change => permitted.size === 0 || permitted.has(change.path))
    .filter(change => !change.path.includes("..") && !change.path.startsWith("/"))
    .map(change => ({
      path: change.path,
      content: `${stripFence(change.lines.join("\n")).replace(/\s+$/, "")}\n`
    }))
    .filter(change => change.content.trim().length > 0);
}

// Models fence code even when told not to. A fence opening the block and a fence
// closing it is decoration; fences in between belong to the file.
function stripFence(text) {
  const body = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!body.startsWith("```")) return body;
  const opened = body.replace(/^```[\w+-]*[^\n]*\n?/, "");
  return opened.replace(/\n?```\s*$/, "");
}

// A model asked for a complete file sometimes answers with only the part it
// changed. Written as the whole file that is not an edit — it is a truncation
// that destroys everything else, and the next attempt then debugs the damage
// instead of the bug. A change that loses most of a file is refused.
const SHRINK_FLOOR = 0.5;
const SMALL_ENOUGH_TO_REWRITE = 400;

export function looksTruncated(before, after) {
  const previous = String(before ?? "").trim();
  const next = String(after ?? "").trim();
  if (!previous || previous.length <= SMALL_ENOUGH_TO_REWRITE) return false;
  return next.length < previous.length * SHRINK_FLOOR;
}

export function repairPrompt({ command, failure, files, tree }) {
  return [
    "A command in this project failed. Change whatever files are needed to make it pass.",
    tree?.length ? `THE PROJECT\n\n${tree.join("\n")}` : null,
    files.map(file => `=== FILE: ${file.path} ===\n${file.content}`).join("\n\n"),
    `WHAT HAPPENED WHEN IT RAN\n\n${failure}`,
    [
      "Reply with the complete new contents of every file you are changing, and",
      "nothing else. Mark each one with a line of exactly this form before its",
      "contents:",
      "",
      "=== FILE: path/to/file.js ===",
      "",
      "Leave out any file you are not changing. Do not explain, do not summarise,",
      "and do not change a file that is not listed above.",
      "",
      "Change as little as possible. Keep every comment, every blank line and",
      "every piece of formatting that is not part of the fix — a repair that",
      "quietly strips a file's documentation is not one a person will accept.",
      `The command was: ${command}`
    ].join("\n")
  ].filter(Boolean).join("\n\n");
}

// A stack trace names where an assertion blew up, which is the test — almost
// never where the mistake lives. Following what those files import is how a
// person would look: read the failing test, then read what it calls.
const IMPORT = /(?:import[\s\S]*?from\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;

export function importedBy(content, fromPath, known = []) {
  const base = fromPath.split("/").slice(0, -1);
  const inProject = new Set(known);
  const found = [];

  for (const match of String(content ?? "").matchAll(IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;   // a package, not this project

    const segments = [...base];
    for (const part of specifier.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") segments.pop();
      else segments.push(part);
    }
    const resolved = segments.join("/");

    // An import may leave off the extension, or point at a folder's index file.
    const candidate = [resolved, `${resolved}.js`, `${resolved}.mjs`, `${resolved}.ts`, `${resolved}/index.js`]
      .find(path => inProject.has(path));
    if (candidate && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

// Everything worth showing: the files the failure blamed, plus what they import,
// a level at a time, until the budget runs out. Breadth first, so the closest
// neighbours arrive before distant ones.
// The file count is the real budget; depth is only a guard against a cycle of
// imports walking forever.
export async function relatedFiles(blamed, { read, known = [], depth = 6, limit = 8 }) {
  const chosen = [];
  let frontier = [...blamed];

  for (let level = 0; level <= depth && frontier.length && chosen.length < limit; level += 1) {
    const next = [];
    for (const path of frontier) {
      if (chosen.some(file => file.path === path) || chosen.length >= limit) continue;
      const content = await read(path);
      if (content === null || content === undefined) continue;
      chosen.push({ path, content });
      next.push(...importedBy(content, path, known));
    }
    frontier = next.filter(path => !chosen.some(file => file.path === path));
  }
  return chosen;
}

// Asking a model to reproduce a whole file does not hold: on anything past a
// few dozen lines it answers with the part it changed, which written as the
// whole file destroys the rest. Asking for the exact text to replace is a much
// smaller thing to get right, and it preserves everything else by construction —
// comments and formatting included, with nothing to instruct and nothing to trust.

const EDIT = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE$/gm;

export function parseEdits(reply, { allowed = [] } = {}) {
  const permitted = new Set(allowed);
  const edits = [];
  let path = null;

  // The lookahead starts with \s* deliberately: "(?===" reads as "(?=" followed
  // by "==", which then fails to match a three-equals header and silently never
  // splits, so every edit lands on the first file named.
  for (const block of String(reply ?? "").split(/^(?=\s*===\s*FILE:)/m)) {
    const header = block.match(/^===\s*FILE:\s*(\S+)\s*===/);
    if (header) path = header[1].replace(/\\/g, "/");
    if (!path) continue;
    if (permitted.size && !permitted.has(path)) continue;

    for (const match of block.matchAll(EDIT)) {
      const [, search, replace] = match;
      if (!search.trim()) continue;    // an empty search would match anywhere
      edits.push({ path, search, replace });
    }
  }
  return edits;
}

export class EditNotApplicableError extends Error {
  constructor(reason, path) {
    super(reason);
    this.name = "EditNotApplicableError";
    this.path = path;
  }
}

// Applied by exact match, and only when the text appears exactly once. Twice is
// ambiguous and zero means the model is editing a file it misremembered — both
// are refused rather than guessed at.
export function applyEdits(content, edits) {
  let next = String(content ?? "");
  for (const edit of edits) {
    const occurrences = next.split(edit.search).length - 1;
    if (occurrences === 0) {
      throw new EditNotApplicableError(`the text to replace was not found in ${edit.path}`, edit.path);
    }
    if (occurrences > 1) {
      throw new EditNotApplicableError(`the text to replace appears ${occurrences} times in ${edit.path}`, edit.path);
    }
    next = next.replace(edit.search, () => edit.replace);
  }
  return next;
}

export function editPrompt({ command, failure, files, tree, alreadyTried = [] }) {
  return [
    "A command in this project failed. Change whatever it takes to make it pass.",
    tree?.length ? `THE PROJECT\n\n${tree.join("\n")}` : null,
    // Files go back to how they were between attempts, but what was learned does
    // not. Without this the same wrong edit gets proposed again, word for word,
    // until the attempts run out.
    alreadyTried.length
      ? `EDITS ALREADY TRIED, WHICH DID NOT WORK — do not repeat them\n\n${alreadyTried
          .map((tried, index) => `${index + 1}. In ${tried.path}, replacing with:\n${tried.replace}\n\nThat produced:\n${tried.outcome}`)
          .join("\n\n")}`
      : null,
    files.map(file => `=== FILE: ${file.path} ===\n${file.content}`).join("\n\n"),
    `WHAT HAPPENED WHEN IT RAN\n\n${failure}`,
    [
      "Reply only with the edits you are making. Do not repeat a whole file and do",
      "not explain anything. For each edit, name the file and give the exact text",
      "to find and what to put in its place:",
      "",
      "=== FILE: path/to/file.js ===",
      "<<<<<<< SEARCH",
      "the exact text as it appears now, copied character for character",
      "=======",
      "what it should say instead",
      ">>>>>>> REPLACE",
      "",
      "Include enough surrounding lines that the text you are finding appears",
      "exactly once in the file. Give several edits if you need them, and only for",
      `the files listed above. The command was: ${command}`
    ].join("\n")
  ].filter(Boolean).join("\n\n");
}

// A model repairing a file cannot tell what it is allowed to import. Left to
// guess it invents a plausible library — "your-testing-library" — and turns a
// missing import into a missing package. The manifest is what says which
// dependencies exist, so it travels with every repair.
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "deno.json"];

export function manifestPaths(tree = []) {
  return MANIFESTS.filter(name => tree.includes(name));
}
