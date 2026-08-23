export class CognitiveArchitect {
  constructor(mesh, brain) { this.mesh = mesh; this.brain = brain; }
  async run(projectId, request) {
    const selected = request.residentIds.map(id => this.mesh.resident(projectId, id)).filter(Boolean);
    if (!selected.length) throw new Error("No resident LLM selected");
    await this.mesh.publish(projectId, { type: "collective.started", actorId: "cognitive-architect", payload: { objective: request.objective, topology: request.topology, residentIds: request.residentIds } });

    const contributors = request.topology === "solo" ? selected.slice(0, 1) : selected;
    const contributions = [];
    const unavailable = [];

    // One provider failing — an expired key, a wrong model id, a rate limit —
    // must not end the whole turn. The project does not stop when a single
    // intelligence becomes unavailable, so a failure is recorded and the rest
    // of the room carries on.
    const ask = async (resident, state, index) => {
      const rolePrompt = request.topology === "distributed"
        ? `Own workstream ${index + 1} while preserving awareness of the complete objective: ${request.objective}`
        : request.objective;
      try {
        const output = await resident.provider.work({
          taskId: `${request.topology}:${request.objective}`,
          prompt: rolePrompt,
          projectVersion: state.version,
          // Carried through so a provider can answer in the right shape; a live
          // adapter ignores these and works from the prompt alone.
          kind: request.kind,
          instruction: request.instruction,
          document: request.document,
          attachments: request.attachments
        });
        resident.status = "present";
        return { kind: "llm-contribution", residentId: resident.id, model: resident.model, text: output.text };
      } catch (error) {
        resident.status = "paused";
        return { kind: "llm-unavailable", residentId: resident.id, model: resident.model, error: error.message };
      }
    };

    const record = async outcome => {
      if (outcome.kind === "llm-unavailable") {
        unavailable.push(outcome);
        await this.mesh.publish(projectId, { type: "resident.paused", actorId: "cognitive-architect", payload: { residentId: outcome.residentId, reason: outcome.error } });
        return;
      }
      contributions.push(outcome);
      await this.mesh.contribute(projectId, outcome.residentId, outcome);
    };

    if (request.topology === "parallel" || request.topology === "distributed") {
      // Everyone answers from the same shared version, then the answers land.
      const state = await this.brain.getState(projectId);
      const outcomes = await Promise.all(contributors.map((resident, index) => ask(resident, state, index)));
      for (const outcome of outcomes) await record(outcome);
    } else {
      // Each intelligence speaks into a project the previous one has already
      // changed — this ordering is what "continues where the last one stopped"
      // actually means, so recording must stay inside the loop.
      for (const [index, resident] of contributors.entries()) {
        const state = await this.brain.getState(projectId);
        await record(await ask(resident, state, index));
      }
    }

    if (!contributions.length) {
      throw new Error(unavailable.length
        ? `No intelligence could answer. ${unavailable.map(item => `${item.model}: ${item.error}`).join(" · ")}`
        : "No intelligence produced a contribution");
    }

    const synthesis = contributions.map(item => item.text).join("\n\n");
    await this.mesh.publish(projectId, { type: "contribution.created", actorId: "cognitive-architect", payload: { kind: "collective-result", topology: request.topology, text: synthesis, residentIds: contributions.map(item => item.residentId) } });
    const finalState = await this.brain.getState(projectId);
    return { topology: request.topology, contributions, unavailable, synthesis, projectVersion: finalState.version };
  }
}
