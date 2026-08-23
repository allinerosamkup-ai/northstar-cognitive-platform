import { randomUUID } from "node:crypto";

export class InMemoryProjectBrain {
  #projects = new Map();
  async createProject(input) {
    const project = { id: randomUUID(), name: input.name, purpose: input.purpose, createdAt: new Date().toISOString() };
    this.#projects.set(project.id, { project, events: [] });
    return project;
  }
  #entry(projectId) {
    const entry = this.#projects.get(projectId);
    if (!entry) throw new Error("Project not found");
    return entry;
  }
  async appendEvent(projectId, input) {
    const entry = this.#entry(projectId);
    const event = { id: randomUUID(), projectId, sequence: entry.events.length + 1, type: input.type, actorId: input.actorId, payload: input.payload, createdAt: new Date().toISOString() };
    entry.events.push(event);
    return event;
  }
  async eventsSince(projectId, sequence) {
    return this.#entry(projectId).events.filter(event => event.sequence > sequence);
  }
  async getState(projectId) {
    const events = this.#entry(projectId).events;
    const state = { version: events.length, latestMessage: null, decisions: [], tasks: [], contributions: [], document: null };
    for (const event of events) {
      if (event.type === "message.created") state.latestMessage = event.payload.text;
      if (event.type === "decision.created") state.decisions.push(event.payload.statement);
      if (event.type === "task.created") state.tasks.push(event.payload);
      if (event.type === "contribution.created") state.contributions.push(event.payload);
      if (event.type === "document.revised") state.document = event.payload;
    }
    return state;
  }
  async getProject(projectId) { return this.#entry(projectId).project; }
}
