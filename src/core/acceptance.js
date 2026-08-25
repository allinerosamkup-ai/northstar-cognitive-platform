// A suite written alongside the code passes for reasons the code does not
// deserve. Building a room booking system, the generated tests called an
// internal `addRoom()` in their setup; without that call every reservation was
// silently dropped, so nothing was ever stored and no overlap was ever detected.
// The tests passed. The software did not work.
//
// So "done" is not decided by the code's own tests. It is decided by a separate
// script that uses the software the way a caller would — public interface only,
// no test framework, no private setup — and reports one line per requirement.
// Reading code cannot catch this. Running it can.

export function acceptancePrompt({ description, requirements, files, entryHint }) {
  return [
    "Write a script that checks whether this software actually does what was asked.",
    `WHAT WAS ASKED FOR\n\n${description}`,
    `WHAT IT MUST DO\n\n${requirements.map((text, index) => `${index + 1}. ${text}`).join("\n")}`,
    `THE CODE\n\n${files.map(file => `=== ${file.path} ===\n${file.content}`).join("\n\n")}`,
    [
      `Write it as ${entryHint}. Rules that decide whether this check is worth anything:`,
      "",
      "- Use only what an ordinary caller would use: the public interface these",
      "  modules export for real work. Do not call setup or bootstrap functions",
      "  that a real caller would not have to call, and do not import internals to",
      "  arrange state. If the software only works when primed that way, that is",
      "  the finding.",
      "- No test framework. Plain code that runs from top to bottom.",
      "- Check each requirement in order, and print exactly one line for each:",
      "",
      "    PASS 1 — a short note",
      "    FAIL 2 — what happened instead",
      "",
      "- Check behaviour, not the presence of a function. Call it, then look at",
      "  what the software says afterwards through its own public interface.",
      "- Wrap each check so one failure does not stop the rest.",
      "- End with process.exit(failures > 0 ? 1 : 0), or the equivalent.",
      "",
      "Output the script and nothing else: no explanation, no markdown fence."
    ].join("\n")
  ].join("\n\n");
}

const LINE = /^\s*(PASS|FAIL)\s+(\d+)\s*[—–:-]?\s*(.*)$/i;

export function parseAcceptance(output, requirements = []) {
  const found = new Map();
  for (const line of String(output ?? "").split("\n")) {
    const match = line.match(LINE);
    if (!match) continue;
    const index = Number(match[2]) - 1;
    if (index < 0 || (requirements.length && index >= requirements.length)) continue;
    if (found.has(index)) continue;
    found.set(index, { passed: match[1].toUpperCase() === "PASS", note: match[3].trim() });
  }

  // A requirement the script never reported on was never checked, and unchecked
  // is not passing. Silence is exactly how this failure mode survives.
  return requirements.map((requirement, index) => ({
    requirement,
    ...(found.get(index) ?? { passed: false, note: "the check never reported on this" })
  }));
}

export const accepted = results => results.length > 0 && results.every(item => item.passed);

export function rejectedInstruction(results) {
  const failed = results.filter(item => !item.passed);
  if (!failed.length) return null;
  return [
    "The code passes its own tests but does not behave correctly when used the way",
    "a caller would. Fix the software — not the checks — so these hold:",
    "",
    ...failed.map(item => `- ${item.requirement}${item.note ? ` — observed: ${item.note}` : ""}`)
  ].join("\n");
}

// Where the check is written, and what runs it. It lives beside the project
// rather than inside its source tree, so it never becomes something the project
// ships or something its own test run picks up.
export function acceptancePath(language = "javascript") {
  return language === "python" ? "northstar-acceptance.py" : "northstar-acceptance.mjs";
}

export function acceptanceCommand(path) {
  return path.endsWith(".py") ? `python ${path}` : `node ${path}`;
}
