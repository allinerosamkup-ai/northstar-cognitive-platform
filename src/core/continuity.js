import { ProviderUnavailableError } from "./providers/recording-provider.js";

export class ContinuityManager {
  constructor(mesh, brain) { this.mesh = mesh; this.brain = brain; }
  async execute(projectId, request) {
    const preferred = this.mesh.resident(projectId, request.preferredResidentId);
    if (!preferred) throw new Error("Preferred resident not found");
    const candidates = [preferred, ...this.mesh.residents(projectId).filter(item => item.id !== preferred.id && item.status === "present")];
    let takeover = false;
    for (const resident of candidates) {
      const state = await this.brain.getState(projectId);
      if (resident.cursor !== state.version) continue;
      try {
        const output = await resident.provider.work({ taskId: request.taskId, prompt: request.prompt, projectVersion: state.version });
        await this.mesh.contribute(projectId, resident.id, { taskId: request.taskId, text: output.text, takeover });
        return { residentId: resident.id, takeover, output };
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) throw error;
        resident.status = "paused";
        takeover = true;
        await this.mesh.publish(projectId, { type: "resident.paused", actorId: "cognitive-architect", payload: { residentId: resident.id, reason: error.reason } });
      }
    }
    throw new Error("No aware resident available");
  }
}
