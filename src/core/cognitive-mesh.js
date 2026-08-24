import { createLock } from "./lock.js";
import { surfaceEvents } from "./event-catalog.js";

export class CognitiveMesh {
  #projects = new Map();
  #withLock = createLock();
  constructor(brain) { this.brain = brain; }
  async addResident(projectId, input) {
    if (!this.#projects.has(projectId)) this.#projects.set(projectId, new Map());
    const state = await this.brain.getState(projectId);
    await this.#catchUp(projectId, input.provider);
    const resident = { id: input.id, model: input.model, provider: input.provider, cursor: state.version, status: "present" };
    this.#projects.get(projectId).set(input.id, resident);
    return resident;
  }

  // A provider object is new on every boot and on every key change, but the
  // project it joins is not. Without replaying the history first, a resident
  // would be marked current while holding no context at all — the shared brain
  // would quietly stop being shared.
  async #catchUp(projectId, provider) {
    if (typeof provider?.hydrate !== "function") return;
    provider.hydrate(surfaceEvents(await this.brain.eventsSince(projectId, 0)));
  }

  // Swapping a provider keeps the resident's identity and place in the project;
  // only the intelligence behind it changes.
  async replaceProvider(projectId, residentId, { provider, model }) {
    const resident = this.resident(projectId, residentId);
    if (!resident) throw new Error("Resident not found");
    await this.#catchUp(projectId, provider);
    resident.provider = provider;
    if (model) resident.model = model;
    resident.status = "present";
    resident.cursor = (await this.brain.getState(projectId)).version;
    return resident;
  }
  // Dedicated agents can be dismissed; the events they contributed stay in the
  // log, because the project's history is not theirs to take away.
  dismiss(projectId, residentId) { return Boolean(this.#projects.get(projectId)?.delete(residentId)); }
  residents(projectId) { return [...(this.#projects.get(projectId)?.values() ?? [])]; }
  resident(projectId, residentId) { return this.#projects.get(projectId)?.get(residentId); }
  async publish(projectId, input) {
    const event = await this.brain.appendEvent(projectId, input);
    await Promise.all(this.residents(projectId).map(async resident => {
      try {
        await resident.provider.observe({ projectId, event });
        resident.cursor = event.sequence;
        // Receiving an event does not prove the provider can do work, so a
        // resident paused by a failed request stays paused until one succeeds.
        // Otherwise the very event announcing the failure would clear it.
      } catch {
        resident.status = "paused";
      }
    }));
    return event;
  }
  // Serialized per project: the staleness check and the write are one atomic unit, so two
  // concurrent contributions cannot both pass the check against the same project version.
  async contribute(projectId, residentId, payload) {
    return this.#withLock(projectId, async () => {
      const resident = this.resident(projectId, residentId);
      if (!resident) throw new Error("Resident not found");
      const state = await this.brain.getState(projectId);
      if (resident.cursor !== state.version) throw new Error("Resident is stale");
      return this.publish(projectId, { type: "contribution.created", actorId: residentId, payload });
    });
  }
}
