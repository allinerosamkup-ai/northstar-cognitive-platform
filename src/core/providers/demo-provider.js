// Stands in for a real model so the whole app can be tried without a key or a
// bill. It must never be mistaken for intelligence — but it does have to answer
// in the *shape* the caller expects, or the demo misrepresents what the product
// does. Echoing an engineered build prompt back as the document would be worse
// than saying nothing.
// Cutting a title mid-word looks like a bug even when it is only a limit.
function trimToWords(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]$/, "")}…`;
}

export class DemoProvider {
  constructor(name, perspective) {
    this.name = name;
    this.perspective = perspective;
  }
  hydrate() {}
  async observe() { return { intervention: null }; }

  async work(request) {
    if (request.kind === "build") return { text: this.#document(request) };
    if (request.kind === "propose") return { text: this.#propose(request) };
    if (request.kind === "critique") return { text: this.#critique(request) };
    if (request.kind === "synthesis") return { text: this.#synthesis(request) };
    if (request.kind === "claim") return { text: this.#claim(request) };
    if (request.kind === "divide") return { text: this.#divide(request) };
    return { text: `${this.perspective}: ${request.prompt}. This contribution remains grounded in project version ${request.projectVersion}.` };
  }

  #demoNote(what) {
    return `_Demo response — no language model wrote this ${what}. Add an API key in Settings._`;
  }

  #propose({ question = "" }) {
    return [
      `Looking at "${trimToWords(String(question), 90)}" through ${this.perspective.toLowerCase()}:`,
      "",
      "I would commit to the option that keeps the project reversible. Decide what",
      "\"done\" means first, then pick whichever choice is cheapest to undo if it is wrong.",
      "",
      this.#demoNote("proposal")
    ].join("\n");
  }

  #critique({ others = [] }) {
    const named = others.map(item => item.model ?? item.residentId).join(" and ");
    return [
      named ? `I read ${named}.` : "I read the other proposals.",
      "",
      "Where a real model would agree, disagree, or change its mind, this stand-in",
      "cannot: it has no view to revise.",
      "",
      this.#demoNote("response")
    ].join("\n");
  }

  #synthesis({ question = "" }) {
    return [
      "## Conclusion",
      "",
      `No conclusion can be drawn about "${trimToWords(String(question), 80)}" from demo responses.`,
      "Add an API key in Settings and run the session again.",
      "",
      "## Agreed",
      "",
      "- none",
      "",
      "## Unresolved",
      "",
      "- none"
    ].join("\n");
  }

  #claim({ phases = [] }) {
    return [
      `A stand-in cannot judge what it is good at, so it claims nothing.`,
      phases.length ? `Parts on the table: ${phases.join(", ")}.` : "",
      "",
      this.#demoNote("claim")
    ].filter(Boolean).join("\n");
  }

  #divide({ phases = [], residentIds = [] }) {
    if (!phases.length || !residentIds.length) return this.#demoNote("division");
    return phases
      .map((phase, index) => `- ${phase}: ${residentIds[index % residentIds.length]} — round-robin stand-in, not a judgement`)
      .join("\n");
  }

  #document({ instruction = "the project", document, attachments = [] }) {
    const asked = String(instruction).replace(/\s+/g, " ").trim();
    const title = document?.title ?? `Plan: ${trimToWords(asked, 52)}`;
    const carried = document?.markdown
      ? `\n## Carried over\n\nRevision ${document.version} is kept and extended rather than replaced.\n`
      : "";
    const sources = attachments.length
      ? `\n## Sources in the project\n\n${attachments.map(file => `- ${file.path}`).join("\n")}\n`
      : "";

    return `# ${title}

## This is demo output

No language model wrote this. Every resident is answering with canned text
because no API key is configured. Add one in Settings to see what the real
intelligences build here.

## The instruction

> ${asked}

## How ${this.perspective.toLowerCase()} would approach it

- Establish what "done" means before writing anything
- Name the smallest version that is genuinely useful
- Decide what is deliberately out of scope for now
${carried}${sources}`;
  }
}
