import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveMesh } from "./cognitive-mesh.js";
import { ContinuityManager } from "./continuity.js";
import { InMemoryProjectBrain } from "./project-brain.js";
import { RecordingProvider } from "./providers/recording-provider.js";

test("Continuity uses another already-aware resident after credit exhaustion", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship" });
  const mesh = new CognitiveMesh(brain);
  const exhausted = new RecordingProvider("openai", { failWorkWith: "credits_exhausted" });
  const ready = new RecordingProvider("anthropic");
  await mesh.addResident(project.id, { id: "gpt", model: "gpt-5", provider: exhausted });
  await mesh.addResident(project.id, { id: "claude", model: "claude", provider: ready });
  await mesh.publish(project.id, { type: "task.created", actorId: "user", payload: { taskId: "task-1", objective: "Build launch plan" } });
  const result = await new ContinuityManager(mesh, brain).execute(project.id, { taskId: "task-1", preferredResidentId: "gpt", prompt: "Continue the approved launch plan" });
  assert.equal(result.residentId, "claude");
  assert.equal(result.takeover, true);
  assert.deepEqual(ready.workRequests[0], { taskId: "task-1", prompt: "Continue the approved launch plan", projectVersion: 2 });
  assert.ok((await brain.getState(project.id)).version > 1);
});
