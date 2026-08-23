// A meeting, in three rounds: everyone proposes, everyone reads the others and
// responds, then one voice reconciles what was said. The reconciliation is a
// *proposal*, never a decision — the person running the project decides, and
// unresolved disagreement is surfaced rather than averaged away.

export function proposePrompt({ question, document }) {
  return [
    "You are one of several resident intelligences in a shared project. Answer the question below in your own voice.",
    document?.markdown ? `CURRENT PROJECT DOCUMENT (revision ${document.version})\n\n${document.markdown}` : null,
    `QUESTION\n\n${question}`,
    "Be specific and commit to a position. Keep it under 250 words. Do not hedge across every option — say what you would actually do."
  ].filter(Boolean).join("\n\n");
}

export function critiquePrompt({ question, proposals, self }) {
  const others = proposals.filter(proposal => proposal.residentId !== self);
  return [
    "You are in a working session with other resident intelligences. Everyone has now answered the same question, and you are reading what they said.",
    `QUESTION\n\n${question}`,
    `YOUR OWN ANSWER\n\n${proposals.find(proposal => proposal.residentId === self)?.text ?? "(you did not answer)"}`,
    `WHAT THE OTHERS SAID\n\n${others.map(proposal => `--- ${proposal.model ?? proposal.residentId} ---\n${proposal.text}`).join("\n\n")}`,
    [
      "Respond to them directly. Say plainly where you agree, where you disagree and why,",
      "and change your own position if they convinced you — changing your mind is a valid",
      "outcome here. Under 200 words. Do not restate your original answer."
    ].join(" ")
  ].join("\n\n");
}

export function synthesisPrompt({ question, proposals, critiques }) {
  return [
    "You are closing a working session between several resident intelligences. Below is the question, what each one proposed, and how each responded to the others.",
    `QUESTION\n\n${question}`,
    `PROPOSALS\n\n${proposals.map(item => `--- ${item.model ?? item.residentId} ---\n${item.text}`).join("\n\n")}`,
    `RESPONSES TO EACH OTHER\n\n${critiques.map(item => `--- ${item.model ?? item.residentId} ---\n${item.text}`).join("\n\n")}`,
    [
      "Write the conclusion of this session. Reconcile the positions honestly: do not",
      "average them, and do not pretend to an agreement that was not reached.",
      "",
      "Use exactly these headings:",
      "",
      "## Conclusion",
      "What the session concluded, as something the project can act on.",
      "",
      "## Agreed",
      "- one line per point everyone accepted",
      "",
      "## Unresolved",
      "- **the question at stake**: who wants what, and why they differ",
      "",
      "If everything was settled, write \"- none\" under Unresolved. Never invent",
      "agreement to fill a section."
    ].join("\n")
  ].join("\n\n");
}

const SECTION = /^##\s+(.+?)\s*$/gm;

// Reads the synthesiser's own structure back out. A model that ignores the
// headings still produces a usable conclusion — the whole reply becomes it —
// because losing the work to a formatting slip would be the worse failure.
export function parseSynthesis(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { conclusion: "", agreed: [], unresolved: [] };

  const sections = {};
  const matches = [...raw.matchAll(SECTION)];
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    sections[match[1].trim().toLowerCase()] = raw.slice(start, end).trim();
  }

  const bullets = block => (block ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+/, "").trim())
    .filter(line => line && !/^none\.?$/i.test(line));

  return {
    conclusion: sections.conclusion || (matches.length ? "" : raw),
    agreed: bullets(sections.agreed),
    unresolved: bullets(sections.unresolved).map(entry => {
      const named = entry.match(/^\*\*(.+?)\*\*\s*:?\s*(.*)$/);
      return named ? { topic: named[1].trim(), detail: named[2].trim() } : { topic: entry, detail: "" };
    })
  };
}

// What one deliberation costs, so nobody discovers it from an invoice: every
// participant proposes and critiques, and one of them writes the conclusion.
export function callCount(participants) {
  return participants * 2 + 1;
}
