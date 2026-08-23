// Who takes which part of the work. The residents argue their own case, one of
// them writes the split, and it stays a *proposal* until a person confirms it —
// an assignment nobody agreed to would just be a rename of arbitrary division.

export function claimPrompt({ phases, self, model, document }) {
  return [
    `You are ${model ?? self}, one of several resident intelligences in a shared project. The work is being divided and you are saying which parts you should take.`,
    document?.markdown ? `PROJECT DOCUMENT (revision ${document.version})\n\n${document.markdown}` : null,
    `THE PARTS TO DIVIDE\n\n${phases.map((phase, index) => `${index + 1}. ${phase}`).join("\n")}`,
    [
      "Say which parts you are best placed to take and why, in terms of what you",
      "are actually good at rather than willingness. Name any part you would be a",
      "poor fit for — saying so is more useful than claiming everything.",
      "Under 150 words."
    ].join(" ")
  ].filter(Boolean).join("\n\n");
}

export function dividePrompt({ phases, claims }) {
  return [
    "You are dividing the work of a shared project between resident intelligences. Each has argued for the parts it should take.",
    `THE PARTS TO DIVIDE\n\n${phases.map((phase, index) => `${index + 1}. ${phase}`).join("\n")}`,
    `WHAT EACH ONE SAID\n\n${claims.map(claim => `--- ${claim.residentId} (${claim.model ?? claim.residentId}) ---\n${claim.text}`).join("\n\n")}`,
    [
      "Assign every part to exactly one resident. Use the identifiers in parentheses",
      "above, not the display names. Give each part to the resident with the",
      "strongest case for it, and spread the work rather than giving one resident",
      "everything.",
      "",
      "Write one line per part, in exactly this form and nothing else:",
      "",
      "- <part>: <residentId> — <the reason, in one sentence>"
    ].join("\n")
  ].join("\n\n");
}

const LINE = /^[-*]\s*(.+?)\s*:\s*([a-z0-9_-]+)\s*(?:[—–-]\s*(.*))?$/i;

// Reads the split back, and refuses to invent one. An assignment naming a
// resident that is not in the room would send the work nowhere.
export function parseAssignments(text, { phases, residentIds }) {
  const assignments = [];
  const claimed = new Set();

  for (const line of String(text ?? "").split("\n")) {
    const match = line.trim().match(LINE);
    if (!match) continue;
    const [, rawPhase, rawResident, reason = ""] = match;

    const residentId = residentIds.find(id => id.toLowerCase() === rawResident.toLowerCase());
    if (!residentId) continue;

    const phase = matchPhase(rawPhase, phases) ?? rawPhase.trim();
    if (claimed.has(phase)) continue;
    claimed.add(phase);
    assignments.push({ phase, residentId, reason: reason.trim() });
  }

  // Anything the model skipped is reported as unassigned rather than quietly
  // dropped, so a person sees the gap instead of discovering it later.
  const unassigned = phases.filter(phase => !claimed.has(phase));
  return { assignments, unassigned };
}

function matchPhase(candidate, phases) {
  const normalise = value => value.toLowerCase().replace(/^\d+[.)]\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = normalise(candidate);
  return phases.find(phase => normalise(phase) === wanted)
    ?? phases.find(phase => normalise(phase).startsWith(wanted) || wanted.startsWith(normalise(phase)));
}

export function assignmentCost(participants) {
  return participants + 1;
}
