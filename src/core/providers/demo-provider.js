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
    return { text: `${this.perspective}: ${request.prompt}. This contribution remains grounded in project version ${request.projectVersion}.` };
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
