// What the project learned works. A skill is not code and not a prompt template:
// it is a named approach that produced a result someone kept, recorded so the
// next attempt starts from it instead of rediscovering it.
//
// Only outcomes a person confirmed become skills. Learning from unreviewed
// output would teach the project its own mistakes.

const MAX_SKILLS_IN_BRIEFING = 6;

export function learnFrom(event) {
  if (event.type === "decision.created" && event.payload.question) {
    return {
      name: shorten(event.payload.question),
      approach: `The project settled this as: ${shorten(event.payload.statement, 220)}`,
      source: "decision",
      sequence: event.sequence
    };
  }
  if (event.type === "assignment.confirmed") {
    return {
      name: "How this project divides work",
      approach: event.payload.assignments.map(item => `${item.phase} belongs to ${item.residentId}`).join("; "),
      source: "assignment",
      sequence: event.sequence
    };
  }
  if (event.type === "file.written" && event.payload.path) {
    return {
      name: `Where ${kindOf(event.payload.path)} goes`,
      approach: `Files of this kind are written to ${event.payload.path}`,
      source: "file",
      sequence: event.sequence
    };
  }
  return null;
}

// The newest lesson on a topic wins: an approach that was superseded should not
// keep being offered alongside the one that replaced it.
export function skillsFrom(events) {
  const learned = new Map();
  for (const event of events) {
    const skill = learnFrom(event);
    if (skill) learned.set(skill.name, skill);
  }
  return [...learned.values()].sort((a, b) => b.sequence - a.sequence);
}

export function briefingSkills(events) {
  return skillsFrom(events).slice(0, MAX_SKILLS_IN_BRIEFING);
}

function shorten(text, limit = 70) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit / 2 ? cut.slice(0, space) : cut}…`;
}

function kindOf(path) {
  const name = path.split("/").pop() ?? path;
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return extension ? `.${extension} files` : "files";
}
