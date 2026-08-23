import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveMesh } from "../cognitive-mesh.js";
import { InMemoryProjectBrain } from "../project-brain.js";
import { RecordingProvider } from "./recording-provider.js";
import { AnthropicProvider } from "./api-providers.js";

// Counts every outbound call, so a test can prove replay costs nothing.
class CountingProvider extends AnthropicProvider {
  constructor() { super({ apiKey: "not-used", model: "test-model" }); this.calls = 0; }
  async complete() { this.calls += 1; return "answer"; }
}

async function projectWithHistory() {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship" });
  const mesh = new CognitiveMesh(brain);
  await mesh.addResident(project.id, { id: "gpt", model: "gpt", provider: new RecordingProvider("openai") });
  await mesh.publish(project.id, { type: "message.created", actorId: "user", payload: { text: "the founding decision" } });
  await mesh.publish(project.id, { type: "collective.started", actorId: "architect", payload: { objective: "bookkeeping" } });
  await mesh.publish(project.id, { type: "contribution.created", actorId: "gpt", payload: { text: "an earlier contribution" } });
  return { brain, project, mesh };
}

test("A resident joining an existing project receives its history", async () => {
  const { project, mesh } = await projectWithHistory();
  const arriving = new RecordingProvider("anthropic");
  await mesh.addResident(project.id, { id: "claude", model: "claude", provider: arriving });

  assert.ok(arriving.hydratedEvents.length > 0, "the newcomer must not start blank");
  assert.deepEqual(
    arriving.hydratedEvents.map(event => event.payload.text ?? event.payload.objective),
    ["the founding decision", "an earlier contribution"],
    "it receives project content and not the bookkeeping events");
});

test("Replacing a provider keeps the resident but re-arms it with the history", async () => {
  const { project, mesh } = await projectWithHistory();
  const replacement = new RecordingProvider("anthropic-live");

  const resident = await mesh.replaceProvider(project.id, "gpt", { provider: replacement, model: "claude-opus-5" });
  assert.equal(resident.id, "gpt", "identity survives the swap");
  assert.equal(resident.model, "claude-opus-5");
  assert.equal(replacement.hydratedEvents.length, 2);
  assert.equal(resident.cursor, 3, "and it is genuinely up to date");
});

test("Replacing the provider of an unknown resident fails loudly", async () => {
  const { project, mesh } = await projectWithHistory();
  await assert.rejects(
    () => mesh.replaceProvider(project.id, "nobody", { provider: new RecordingProvider("x") }),
    /Resident not found/);
});

// Replaying history must never be billable: joining a long project would
// otherwise cost one API call per past event, per resident.
test("Catching up on history costs no provider calls", async () => {
  const { project, mesh } = await projectWithHistory();
  const counting = new CountingProvider();

  await mesh.addResident(project.id, { id: "claude", model: "claude-opus-5", provider: counting });

  assert.equal(counting.calls, 0, "hydration must not call the API");
  assert.equal(counting.projectEvents.length, 2, "yet the context is there");
});

test("A hydrated provider carries the history into the prompt it sends", async () => {
  const { project, mesh } = await projectWithHistory();
  const counting = new CountingProvider();
  await mesh.addResident(project.id, { id: "claude", model: "claude-opus-5", provider: counting });

  let sent = "";
  counting.complete = async prompt => { sent = prompt; return "answer"; };
  await counting.work({ prompt: "Continue the work", projectVersion: 3 });

  assert.match(sent, /the founding decision/, "it can see what came before");
  assert.match(sent, /an earlier contribution/);
  assert.match(sent, /Continue the work/);
});
