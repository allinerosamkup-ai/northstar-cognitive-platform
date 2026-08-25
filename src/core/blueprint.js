// Building one file is not building software. A system is several files that
// have to agree with each other — the names they export, the paths they import,
// the shape of what they pass around — and a file written in isolation agrees
// with nothing.
//
// So a build plans first: what the parts are, what each is responsible for, and
// what command proves the whole thing works. Every file is then written knowing
// the plan and the files already written, and the command at the end is what
// decides whether any of it is true.

const SECTION = /^##\s+(.+?)\s*$/gm;
const FILE_LINE = /^[-*]\s*(?:`)?([\w./-]+\.[\w]{1,8})(?:`)?\s*[—–:-]\s*(.+)$/;

export function planPrompt({ description, tree = [], language = "JavaScript" }) {
  return [
    `Plan the files for this, in ${language}. Do not write any code yet.`,
    tree.length ? `THE PROJECT ALREADY CONTAINS\n\n${tree.slice(0, 60).join("\n")}` : null,
    `WHAT TO BUILD\n\n${description}`,
    [
      "Reply with exactly these three sections and nothing else:",
      "",
      "## Files",
      "- path/to/file.ext — what this file is responsible for",
      "",
      "One line per file, in the order they should be written: something that",
      "others import comes before the files that import it. Include the tests.",
      "",
      "## Verify",
      "A single command that proves the whole thing works, on its own line.",
      "Prefer a test run. Use only: npm, npx, node, python, pytest, go, cargo.",
      "",
      "## Notes",
      "Anything a file needs to know to agree with the others: exact export names,",
      "the shape of data passed between them, where state lives. Be concrete —",
      "this is the only thing keeping the files consistent with each other."
    ].join("\n")
  ].filter(Boolean).join("\n\n");
}

export function parsePlan(reply) {
  const raw = String(reply ?? "").trim();
  const sections = {};
  const matches = [...raw.matchAll(SECTION)];

  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    sections[match[1].trim().toLowerCase()] = raw.slice(start, end).trim();
  }

  const files = (sections.files ?? "")
    .split("\n")
    .map(line => line.trim().match(FILE_LINE))
    .filter(Boolean)
    .map(match => ({ path: match[1].replace(/\\/g, "/"), purpose: match[2].trim() }))
    .filter(file => !file.path.includes("..") && !file.path.startsWith("/"));

  // A plan naming the same file twice would have the later one silently
  // overwrite the earlier, losing whatever the first was responsible for.
  const seen = new Set();
  const unique = files.filter(file => !seen.has(file.path) && seen.add(file.path));

  return {
    files: unique,
    verify: firstCommand(sections.verify),
    notes: (sections.notes ?? "").trim()
  };
}

// The verify section arrives as prose around a command as often as not.
function firstCommand(block) {
  for (const line of String(block ?? "").split("\n")) {
    const clean = line.trim().replace(/^[-*]\s*/, "").replace(/^`+|`+$/g, "").replace(/^\$\s*/, "");
    if (/^(npm|npx|node|python3?|pytest|go|cargo|deno|bun|make)\b/.test(clean)) return clean;
  }
  return null;
}

// Each file is written knowing the whole plan and everything written before it.
// That is what makes the imports resolve and the names line up: not luck, and
// not a model remembering across separate requests it never sees together.
// A model writing a test guesses at the framework, and guesses wrong: asked for
// node --test it reached for `expect`, which node:test does not export, turning
// a working suite into a module that will not load. Naming what the runner
// actually provides costs one line and removes the whole class of mistake.
const RUNNERS = [
  {
    match: /node\s+--test/,
    note: [
      "Tests run with `node --test`. Import what you use from 'node:test' —",
      "`test`, and `describe`/`it` if you prefer them. There is no `expect`:",
      "assertions come from 'node:assert/strict'."
    ].join(" ")
  },
  { match: /vitest/, note: "Tests run with vitest. Import `describe`, `it` and `expect` from 'vitest'." },
  { match: /jest/, note: "Tests run with jest. `describe`, `it` and `expect` are global; do not import them." },
  { match: /pytest/, note: "Tests run with pytest. Use plain `assert` and name test functions `test_*`." },
  { match: /go\s+test/, note: "Tests run with `go test`. Use the standard `testing` package." },
  { match: /cargo\s+test/, note: "Tests run with `cargo test`. Use `#[test]` and the standard assert macros." }
];

export function runnerNote(command) {
  return RUNNERS.find(runner => runner.match.test(String(command ?? "")))?.note ?? null;
}

export function partPrompt({ description, plan, path, purpose, written = [] }) {
  return [
    `You are writing one file of a larger project. Write ${path} and nothing else.`,
    `WHAT THE WHOLE PROJECT IS\n\n${description}`,
    `THE PLAN\n\n${plan.files.map(file => `- ${file.path} — ${file.purpose}`).join("\n")}`,
    plan.notes ? `WHAT EVERY FILE MUST AGREE ON\n\n${plan.notes}` : null,
    written.length
      ? `FILES ALREADY WRITTEN — match these exactly: their export names, their paths, the shape of what they return\n\n${written.map(file => `=== ${file.path} ===\n${file.content}`).join("\n\n")}`
      : null,
    `THIS FILE\n\n${path} — ${purpose}`,
    runnerNote(plan.verify),
    [
      "Output the file and nothing else: no explanation before it, no summary",
      "after it, no markdown fence around it. The first character of your reply is",
      "the first character of the file. It must be complete and ready to run, and",
      "it must work with the files above rather than assuming a different shape."
    ].join(" ")
  ].filter(Boolean).join("\n\n");
}

// What a build will cost before anyone starts one: one call to plan, one per
// file, and whatever the repair spends afterwards.
export function buildCost(fileCount, repairAttempts = 3) {
  return { plan: 1, files: fileCount, repair: repairAttempts, total: 1 + fileCount + repairAttempts };
}
