import { proposePrompt, critiquePrompt, synthesisPrompt, parseSynthesis } from "./deliberation.js";
import { claimPrompt, dividePrompt, parseAssignments } from "./assignment.js";

// Runs the multi-round sessions: a deliberation where residents read and answer
// each other, and a division of work they argue for themselves. Both end in a
// proposal, never a decision — confirming one is a person's job.
export class WorkingSession {
  constructor(mesh, brain) { this.mesh = mesh; this.brain = brain; }

  #participants(projectId, residentIds) {
    const chosen = (residentIds?.length ? residentIds : this.mesh.residents(projectId).map(item => item.id))
      .map(id => this.mesh.resident(projectId, id))
      .filter(Boolean);
    if (!chosen.length) {
      const available = this.mesh.residents(projectId).map(resident => resident.id);
      throw new Error(available.length
        ? `No such resident. This project has: ${available.join(", ")}`
        : "This project has no resident intelligences");
    }
    return chosen;
  }

  // One resident failing must not end the session — the others still met.
  async #round(participants, build, taskId, projectVersion, context = {}) {
    const spoke = [];
    const silent = [];
    await Promise.all(participants.map(async resident => {
      try {
        const output = await resident.provider.work({
          taskId, projectVersion, prompt: build(resident),
          // Carried so a provider can answer in the right shape; a live adapter
          // ignores these and works from the prompt alone.
          ...context, ...(context.per ? context.per(resident) : {})
        });
        resident.status = "present";
        spoke.push({ residentId: resident.id, model: resident.model, text: output.text });
      } catch (error) {
        resident.status = "paused";
        silent.push({ residentId: resident.id, model: resident.model, error: error.message });
      }
    }));
    // Promise.all resolves out of order; a session reads better in the order the
    // residents were chosen.
    const order = new Map(participants.map((resident, index) => [resident.id, index]));
    spoke.sort((a, b) => order.get(a.residentId) - order.get(b.residentId));
    return { spoke, silent };
  }

  async deliberate(projectId, { question, synthesisBy, residentIds }) {
    const participants = this.#participants(projectId, residentIds);
    const { version } = await this.brain.getState(projectId);
    const document = (await this.brain.getState(projectId)).document;

    await this.mesh.publish(projectId, {
      type: "session.started",
      actorId: "cognitive-architect",
      payload: { kind: "deliberation", question, residentIds: participants.map(item => item.id) }
    });

    const proposed = await this.#round(participants,
      () => proposePrompt({ question, document }), "deliberate:propose", version,
      { kind: "propose", question });
    if (!proposed.spoke.length) throw sessionFailure(proposed.silent);

    const answered = participants.filter(resident => proposed.spoke.some(item => item.residentId === resident.id));
    const critiqued = answered.length > 1
      ? await this.#round(answered,
          resident => critiquePrompt({ question, proposals: proposed.spoke, self: resident.id }),
          "deliberate:critique", version,
          { kind: "critique", question, per: resident => ({ others: proposed.spoke.filter(item => item.residentId !== resident.id) }) })
      : { spoke: [], silent: [] };

    // The conclusion is the output that matters most, so a live model writes it
    // whenever one took part — a stand-in scribe would waste the whole session.
    const scribe = this.mesh.resident(projectId, synthesisBy)
      ?? answered.find(resident => resident.provider.apiKey)
      ?? answered.find(resident => resident.id === proposed.spoke[0].residentId);
    let synthesis = { conclusion: "", agreed: [], unresolved: [] };
    let synthesisBy_ = null;
    try {
      const output = await scribe.provider.work({
        taskId: "deliberate:synthesis",
        prompt: synthesisPrompt({ question, proposals: proposed.spoke, critiques: critiqued.spoke }),
        projectVersion: version,
        kind: "synthesis", question
      });
      synthesis = parseSynthesis(output.text);
      synthesisBy_ = scribe.id;
    } catch (error) {
      // Without a conclusion the rounds are still worth keeping — a person can
      // read them and decide. Losing the whole session to the last call would be
      // the expensive failure.
      synthesis.conclusion = `No conclusion was written: ${scribe.model} failed (${error.message}). The proposals and responses above are still recorded.`;
    }

    const session = {
      kind: "deliberation",
      question,
      proposals: proposed.spoke,
      critiques: critiqued.spoke,
      synthesis,
      synthesisBy: synthesisBy_,
      unavailable: [...proposed.silent, ...critiqued.silent],
      status: "proposed"
    };
    const event = await this.mesh.publish(projectId, {
      type: "session.concluded", actorId: "cognitive-architect", payload: session
    });
    return { ...session, sequence: event.sequence };
  }

  async divide(projectId, { phases, residentIds, dividedBy }) {
    const participants = this.#participants(projectId, residentIds);
    const { version, document } = await this.brain.getState(projectId);

    await this.mesh.publish(projectId, {
      type: "session.started",
      actorId: "cognitive-architect",
      payload: { kind: "assignment", phases, residentIds: participants.map(item => item.id) }
    });

    const claimed = await this.#round(participants,
      resident => claimPrompt({ phases, self: resident.id, model: resident.model, document }),
      "assign:claim", version, { kind: "claim", phases });
    if (!claimed.spoke.length) throw sessionFailure(claimed.silent);

    // Only a resident that actually spoke can write the split: handing it to one
    // that just failed would throw away the round that succeeded.
    const spokeUp = participants.filter(resident => claimed.spoke.some(item => item.residentId === resident.id));
    const divider = spokeUp.find(resident => resident.id === dividedBy)
      ?? spokeUp.find(resident => resident.provider.apiKey)
      ?? spokeUp[0];

    let assignments = [];
    let unassigned = phases;
    let dividerFailure = null;
    try {
      const output = await divider.provider.work({
        taskId: "assign:divide",
        prompt: dividePrompt({ phases, claims: claimed.spoke }),
        projectVersion: version,
        kind: "divide", phases, residentIds: claimed.spoke.map(item => item.residentId)
      });
      ({ assignments, unassigned } = parseAssignments(output.text, {
        phases, residentIds: participants.map(item => item.id)
      }));
    } catch (error) {
      // The arguments each resident made are still worth having; a person can
      // divide the work from them by hand.
      divider.status = "paused";
      dividerFailure = { residentId: divider.id, model: divider.model, error: error.message };
    }

    const proposal = {
      kind: "assignment",
      phases,
      claims: claimed.spoke,
      assignments,
      unassigned,
      dividedBy: dividerFailure ? null : divider.id,
      unavailable: [...claimed.silent, ...(dividerFailure ? [dividerFailure] : [])],
      status: "proposed"
    };
    const event = await this.mesh.publish(projectId, {
      type: "assignment.proposed", actorId: "cognitive-architect", payload: proposal
    });
    return { ...proposal, sequence: event.sequence };
  }
}

function sessionFailure(silent) {
  return new Error(silent.length
    ? `No intelligence could take part. ${silent.map(item => `${item.model}: ${item.error}`).join(" · ")}`
    : "No intelligence took part in the session");
}
