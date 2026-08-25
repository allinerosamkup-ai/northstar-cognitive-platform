// A build that stops because a command exited zero has proved one thing: that
// command passed. It has not proved that what was asked for exists. Those are
// different, and the gap between them is where "it looks done" lives.
//
// So a request is broken into requirements a person could check, and each one is
// checked against what was actually built. A requirement nobody built is a
// finding, not a silence.

const SECTION = /^##\s+(.+?)\s*$/gm;
const BULLET = /^[-*]\s*(?:\[.\]\s*)?(.+)$/;

export function requirementsPrompt({ description }) {
  return [
    "Break this request into the things someone would check to say it was done.",
    `THE REQUEST\n\n${description}`,
    [
      "Reply with one section and nothing else:",
      "",
      "## Requirements",
      "- one checkable statement per line",
      "",
      "Each must be something you could look at the finished code and say yes or",
      "no to. Write what the software must do, not how to build it. Split a",
      "sentence that hides two demands into two lines. Include what the request",
      "says it must refuse or prevent — those are the ones that get forgotten.",
      "Between three and ten lines."
    ].join("\n")
  ].join("\n\n");
}

export function parseRequirements(reply) {
  const raw = String(reply ?? "").trim();
  const sections = {};
  const matches = [...raw.matchAll(SECTION)];
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    sections[match[1].trim().toLowerCase()] = raw.slice(start, end).trim();
  }

  // A reply that ignored the heading is still worth reading: bullets are bullets.
  const block = sections.requirements ?? (matches.length ? "" : raw);
  const seen = new Set();
  return block
    .split("\n")
    .map(line => line.trim().match(BULLET))
    .filter(Boolean)
    .map(match => match[1].trim().replace(/^\*\*|\*\*$/g, ""))
    .filter(text => text.length > 3 && !/^\(none/i.test(text))
    .filter(text => !seen.has(text.toLowerCase()) && seen.add(text.toLowerCase()));
}

export function reviewPrompt({ requirements, files }) {
  return [
    "Check whether this code does each of these things. Judge only what is here.",
    `REQUIREMENTS\n\n${requirements.map((text, index) => `${index + 1}. ${text}`).join("\n")}`,
    `THE CODE\n\n${files.map(file => `=== ${file.path} ===\n${file.content}`).join("\n\n")}`,
    [
      "Reply with one line per requirement, numbered, in this exact form:",
      "",
      "1. MET — the function that does it, named",
      "2. MISSING — what is absent",
      "3. PARTIAL — what is there and what is not",
      "",
      "Nothing else. MET means you can point at the code that does it. If you",
      "cannot point at it, it is not MET — a requirement marked met that is not",
      "is worse than one marked missing, because nobody will look at it again."
    ].join("\n")
  ].join("\n\n");
}

const VERDICT = /^\s*(\d+)[.)]\s*(MET|MISSING|PARTIAL)\b\s*[—–:-]?\s*(.*)$/i;

export function parseReview(reply, requirements = []) {
  const found = new Map();
  for (const line of String(reply ?? "").split("\n")) {
    const match = line.match(VERDICT);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (index < 0 || (requirements.length && index >= requirements.length)) continue;
    if (found.has(index)) continue;
    found.set(index, { verdict: match[2].toUpperCase(), detail: match[3].trim() });
  }

  // A requirement the review skipped is unproven, and unproven is not met. The
  // whole point is that silence stops counting as success.
  return requirements.map((requirement, index) => ({
    requirement,
    ...(found.get(index) ?? { verdict: "UNCHECKED", detail: "the review did not report on this" })
  }));
}

export const isSatisfied = review => review.every(item => item.verdict === "MET");

export function unmet(review) {
  return review.filter(item => item.verdict !== "MET");
}

// What another pass has to fix, phrased as work rather than as a complaint.
export function gapInstruction(review) {
  const missing = unmet(review);
  if (!missing.length) return null;
  return [
    "The code does not yet do everything that was asked. Add what is missing,",
    "keeping everything that already works:",
    "",
    ...missing.map(item => `- ${item.requirement}${item.detail ? ` — currently: ${item.detail}` : ""}`)
  ].join("\n");
}
