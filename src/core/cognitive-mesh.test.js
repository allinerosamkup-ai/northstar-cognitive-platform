import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveMesh } from "./cognitive-mesh.js";
import { InMemoryProjectBrain } from "./project-brain.js";
import { RecordingProvider } from "./providers/recording-provider.js";

test("Cognitive Mesh keeps every resident LLM co-present", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship" });
  const mesh = new CognitiveMesh(brain);
  const providers = [new RecordingProvider("openai"), new RecordingProvider("anthropic"), new RecordingProvider("google")];
  await mesh.addResident(project.id, { id: "gpt", model: "gpt-5", provider: providers[0] });
  await mesh.addResident(project.id, { id: "claude", model: "claude", provider: providers[1] });
  await mesh.addResident(project.id, { id: "gemini", model: "gemini", provider: providers[2] });
  const event = await mesh.publish(project.id, { type: "message.created", actorId: "user", payload: { text: "Keep the whole in view" } });
  assert.deepEqual(providers.map(provider => provider.processedSequences), [[event.sequence], [event.sequence], [event.sequence]]);
  assert.deepEqual(mesh.residents(project.id).map(resident => resident.cursor), [1, 1, 1]);
});

test("Cognitive Mesh prevents stale contributions", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship" });
  const mesh = new CognitiveMesh(brain);
  await mesh.addResident(project.id, { id: "gpt", model: "gpt-5", provider: new RecordingProvider("openai") });
  await brain.appendEvent(project.id, { type: "decision.created", actorId: "user", payload: { statement: "Use English" } });
  await assert.rejects(() => mesh.contribute(project.id, "gpt", { text: "Old-state contribution" }), /Resident is stale/);
});

test("Concurrent contributions are serialized instead of interleaving", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship" });
  const mesh = new CognitiveMesh(brain);
  const ids = ["gpt", "claude", "gemini"];
  for (const id of ids) await mesh.addResident(project.id, { id, model: id, provider: new RecordingProvider(id) });

  const events = await Promise.all(ids.map(id => mesh.contribute(project.id, id, { text: `from ${id}` })));
  assert.deepEqual(events.map(event => event.sequence).sort((a, b) => a - b), [1, 2, 3]);
  assert.equal((await brain.getState(project.id)).contributions.length, 3);
  assert.ok(mesh.residents(project.id).every(resident => resident.cursor === 3));
});

test("A resident left behind by an external write cannot slip a contribution through", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship" });
  const mesh = new CognitiveMesh(brain);
  await mesh.addResident(project.id, { id: "gpt", model: "gpt-5", provider: new RecordingProvider("openai") });
  await brain.appendEvent(project.id, { type: "decision.created", actorId: "user", payload: { statement: "Written outside the mesh" } });

  const outcomes = await Promise.allSettled(ids());
  assert.ok(outcomes.every(outcome => outcome.status === "rejected"), "every stale contribution must be refused");
  assert.equal((await brain.getState(project.id)).contributions.length, 0);

  function ids() {
    return [1, 2, 3].map(attempt => mesh.contribute(project.id, "gpt", { text: `attempt ${attempt}` }));
  }
});
