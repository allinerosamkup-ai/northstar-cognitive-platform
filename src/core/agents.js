// A dedicated agent is a resident with a job: a name, the part of the project it
// owns, and a provider behind it. It sits in the same mesh as everyone else, so
// it reads the same log and is subject to the same staleness rule — the point is
// specialisation, not a private channel.

const ID = /^[a-z][a-z0-9-]{1,30}$/;

export class AgentRejectedError extends Error {
  constructor(reason) { super(reason); this.name = "AgentRejectedError"; }
}

export function validateAgent({ id, role, scope }, existingIds = []) {
  if (!ID.test(String(id ?? ""))) {
    throw new AgentRejectedError("An agent id must be lowercase letters, digits or dashes, 2 to 31 characters");
  }
  if (existingIds.includes(id)) throw new AgentRejectedError(`There is already a resident called ${id}`);
  if (!String(role ?? "").trim()) throw new AgentRejectedError("An agent needs a role");
  return {
    id,
    role: String(role).trim(),
    scope: String(scope ?? "").trim()
  };
}

// Prepended to everything this agent is asked, so its speciality survives every
// round without the caller having to remember it.
export function agentBriefing({ role, scope, skills = [] }) {
  const parts = [`You are the project's ${role}.`];
  if (scope) parts.push(`You own this part of the project: ${scope}. Answer from that responsibility, and say so when something falls outside it.`);
  if (skills.length) {
    parts.push([
      "Approaches this project has already found to work — reuse them rather than starting over:",
      ...skills.map(skill => `- ${skill.name}: ${skill.approach}`)
    ].join("\n"));
  }
  return parts.join("\n\n");
}

// Wraps any provider so every prompt carries the briefing. The underlying
// provider keeps its own hydration and history: an agent is a lens on a
// resident, not a replacement for one.
export function specialise(provider, briefing) {
  return {
    get name() { return provider.name; },
    get model() { return provider.model; },
    get apiKey() { return provider.apiKey; },
    get projectEvents() { return provider.projectEvents; },
    hydrate: events => provider.hydrate?.(events),
    observe: input => provider.observe(input),
    work: request => provider.work({ ...request, prompt: `${briefing}\n\n${request.prompt}` }),
    complete: provider.complete ? prompt => provider.complete(prompt) : undefined
  };
}
