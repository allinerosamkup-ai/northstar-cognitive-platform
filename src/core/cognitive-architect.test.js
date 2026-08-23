import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveArchitect } from "./cognitive-architect.js";
import { CognitiveMesh } from "./cognitive-mesh.js";
import { InMemoryProjectBrain } from "./project-brain.js";
import { RecordingProvider } from "./providers/recording-provider.js";

test("Composite topology creates one traceable collective work", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Northstar", purpose: "Build" });
  const mesh = new CognitiveMesh(brain);
  const gpt = new RecordingProvider("openai", { response: "Market structure" });
  const claude = new RecordingProvider("anthropic", { response: "Risk correction" });
  const gemini = new RecordingProvider("google", { response: "Evidence check" });
  await mesh.addResident(project.id, { id: "gpt", model: "gpt-5", provider: gpt });
  await mesh.addResident(project.id, { id: "claude", model: "claude", provider: claude });
  await mesh.addResident(project.id, { id: "gemini", model: "gemini", provider: gemini });
  const architect = new CognitiveArchitect(mesh, brain);
  const result = await architect.run(project.id, { topology: "composite", objective: "Define the launch", residentIds: ["gpt", "claude", "gemini"] });
  assert.equal(result.topology, "composite");
  assert.deepEqual(result.contributions.map(item => item.text), ["Market structure", "Risk correction", "Evidence check"]);
  assert.match(result.synthesis, /Market structure/);
  assert.match(result.synthesis, /Risk correction/);
  assert.match(result.synthesis, /Evidence check/);
  const state = await brain.getState(project.id);
  assert.equal(state.contributions.length, 4);
  assert.equal(state.contributions.at(-1).kind, "collective-result");
});

test("Work topologies change coordination without breaking cohabitation", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Northstar", purpose: "Build" });
  const mesh = new CognitiveMesh(brain);
  const providers = [
    new RecordingProvider("openai", { response: "one" }),
    new RecordingProvider("anthropic", { response: "two" }),
    new RecordingProvider("google", { response: "three" })
  ];
  for (const [index, id] of ["gpt", "claude", "gemini"].entries()) await mesh.addResident(project.id, { id, model: id, provider: providers[index] });
  const architect = new CognitiveArchitect(mesh, brain);

  const solo = await architect.run(project.id, { topology: "solo", objective: "Own one task", residentIds: ["gpt", "claude", "gemini"] });
  assert.equal(solo.contributions.length, 1);
  assert.deepEqual(providers.map(provider => provider.workRequests.length), [1, 0, 0]);

  const parallel = await architect.run(project.id, { topology: "parallel", objective: "Explore independently", residentIds: ["gpt", "claude", "gemini"] });
  assert.equal(parallel.contributions.length, 3);
  assert.equal(new Set(providers.map(provider => provider.workRequests.at(-1).projectVersion)).size, 1);

  const joint = await architect.run(project.id, { topology: "joint", objective: "Refine together", residentIds: ["gpt", "claude", "gemini"] });
  assert.equal(joint.contributions.length, 3);
  assert.equal(new Set(providers.map(provider => provider.workRequests.at(-1).projectVersion)).size, 3);
  assert.ok(mesh.residents(project.id).every(resident => resident.cursor === joint.projectVersion));
});

// A resident that fails must be visible. Silently dropping it from the answer
// is how a person ends up trusting output from fewer minds than they think.
test("A failing intelligence is announced, and the others still answer", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Northstar", purpose: "Build" });
  const mesh = new CognitiveMesh(brain);
  const working = new RecordingProvider("openai", { response: "usable answer" });
  const broken = new RecordingProvider("google", { failWorkWith: "invalid api key" });
  await mesh.addResident(project.id, { id: "gpt", model: "gpt", provider: working });
  await mesh.addResident(project.id, { id: "gemini", model: "gemini", provider: broken });

  const result = await new CognitiveArchitect(mesh, brain).run(project.id, {
    topology: "composite", objective: "Draft it", residentIds: ["gpt", "gemini"]
  });

  assert.equal(result.contributions.length, 1, "the working intelligence still answers");
  assert.equal(result.unavailable.length, 1, "and the failure is reported, not swallowed");
  assert.match(result.unavailable[0].error, /invalid api key/);

  const events = await brain.eventsSince(project.id, 0);
  assert.ok(events.some(event => event.type === "resident.paused" && event.payload.residentId === "gemini"),
    "the project records which intelligence dropped out");
  assert.equal(mesh.resident(project.id, "gemini").status, "paused",
    "and the card must not claim it is fine");
  assert.equal(mesh.resident(project.id, "gpt").status, "present");
});

test("A paused intelligence recovers once it can work again", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Northstar", purpose: "Build" });
  const mesh = new CognitiveMesh(brain);
  const flaky = new RecordingProvider("google", { failWorkWith: "rate limited" });
  await mesh.addResident(project.id, { id: "gemini", model: "gemini", provider: flaky });
  const architect = new CognitiveArchitect(mesh, brain);

  await assert.rejects(() => architect.run(project.id, { topology: "solo", objective: "try", residentIds: ["gemini"] }),
    /No intelligence could answer/);
  assert.equal(mesh.resident(project.id, "gemini").status, "paused");

  flaky.options.failWorkWith = null;
  await architect.run(project.id, { topology: "solo", objective: "try again", residentIds: ["gemini"] });
  assert.equal(mesh.resident(project.id, "gemini").status, "present", "a successful turn clears the pause");
});

test("When every intelligence fails, the reason reaches the person", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Northstar", purpose: "Build" });
  const mesh = new CognitiveMesh(brain);
  await mesh.addResident(project.id, { id: "gpt", model: "gpt-4o", provider: new RecordingProvider("openai", { failWorkWith: "quota exhausted" }) });

  await assert.rejects(
    () => new CognitiveArchitect(mesh, brain).run(project.id, { topology: "solo", objective: "x", residentIds: ["gpt"] }),
    /quota exhausted/, "a blank failure would leave the person guessing");
});
