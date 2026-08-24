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

// Models fence code even when told not to. One fence around the whole block is
// decoration; more than one belongs to the file itself.
function stripFence(text) {
  const body = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if ((body.match(/```/g) ?? []).length !== 2) return body;
  const unwrapped = body.match(/^```[\w+-]*[^\n]*\n([\s\S]*)```$/);
  return unwrapped ? unwrapped[1] : body;
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
      `and do not change a file that is not listed above. The command was: ${command}`
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
