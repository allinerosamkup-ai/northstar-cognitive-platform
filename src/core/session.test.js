import test from "node:test";
import assert from "node:assert/strict";
import { WorkingSession } from "./session.js";
import { CognitiveMesh } from "./cognitive-mesh.js";
import { InMemoryProjectBrain } from "./project-brain.js";
import { RecordingProvider } from "./providers/recording-provider.js";

async function room(residents) {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Northstar", purpose: "Build" });
  const mesh = new CognitiveMesh(brain);
  for (const [id, provider] of Object.entries(residents)) {
    await mesh.addResident(project.id, { id, model: id, provider });
  }
  return { brain, project, mesh, session: new WorkingSession(mesh, brain) };
}

const working = response => new RecordingProvider("demo", { response });
const broken = reason => new RecordingProvider("demo", { failWorkWith: reason });

test("A deliberation runs both rounds and ends in a proposal", async () => {
  const { project, session } = await room({ gpt: working("SQLite"), claude: working("JSON files") });
  const result = await session.deliberate(project.id, { question: "Which store?" });

  assert.equal(result.proposals.length, 2);
  assert.equal(result.critiques.length, 2, "each one answers the other");
  assert.equal(result.status, "proposed", "a session proposes; it never decides");
});

// A session is expensive. Losing it because one participant was down would be
// the worst possible failure mode.
test("A resident that fails is named, and the session still happens", async () => {
  const { project, session } = await room({ gpt: working("SQLite"), claude: broken("invalid api key") });
  const result = await session.deliberate(project.id, { question: "Which store?" });

  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.unavailable.map(item => item.residentId), ["claude"]);
  assert.match(result.unavailable[0].error, /invalid api key/);
});

test("With nobody able to speak, the reason reaches the person", async () => {
  const { project, session } = await room({ gpt: broken("quota exhausted") });
  await assert.rejects(() => session.deliberate(project.id, { question: "q" }), /quota exhausted/);
});

test("A single resident is not asked to answer itself", async () => {
  const { project, session } = await room({ gpt: working("SQLite") });
  const result = await session.deliberate(project.id, { question: "q" });
  assert.deepEqual(result.critiques, []);
});

test("A failed conclusion still preserves the rounds that worked", async () => {
  const scribe = working("fine");
  const { project, session } = await room({ gpt: working("a real proposal"), claude: scribe });
  scribe.options.response = "ok";

  // Only the synthesis call fails, after both rounds have already succeeded.
  let calls = 0;
  const original = scribe.work.bind(scribe);
  scribe.work = async request => {
    calls += 1;
    if (request.taskId === "deliberate:synthesis") throw new Error("rate limited");
    return original(request);
  };
  const result = await session.deliberate(project.id, { question: "q", synthesisBy: "claude" });

  assert.equal(result.proposals.length, 2, "the proposals survive");
  assert.match(result.synthesis.conclusion, /rate limited/, "and the failure is explained");
  assert.ok(calls > 0);
});

test("Dividing the work returns a proposal each resident argued for", async () => {
  const { project, session } = await room({
    gpt: working("- Architecture: gpt — fit\n- Research: claude — fit"),
    claude: working("I want research")
  });
  const result = await session.divide(project.id, { phases: ["Architecture", "Research"] });

  assert.equal(result.claims.length, 2);
  assert.equal(result.status, "proposed");
  assert.deepEqual(result.assignments.map(item => item.residentId), ["gpt", "claude"]);
});

// The bug this test exists for: choosing the divider from every participant
// handed the work to a resident that had just failed, and lost the whole round.
test("The split is written by a resident that actually spoke", async () => {
  const { project, session } = await room({
    gpt: broken("quota exhausted"),
    claude: working("- Architecture: claude — fit\n- Research: claude — fit")
  });
  const result = await session.divide(project.id, { phases: ["Architecture", "Research"] });

  assert.equal(result.dividedBy, "claude", "the resident that failed cannot write the split");
  assert.equal(result.assignments.length, 2);
  assert.deepEqual(result.unavailable.map(item => item.residentId), ["gpt"]);
});

test("A failed split keeps the arguments so a person can divide by hand", async () => {
  const divider = working("ok");
  const { project, session } = await room({ claude: divider });
  const original = divider.work.bind(divider);
  divider.work = async request => {
    if (request.taskId === "assign:divide") throw new Error("rate limited");
    return original(request);
  };
  const result = await session.divide(project.id, { phases: ["Architecture", "Research"] });

  assert.equal(result.claims.length, 1, "what the resident argued is kept");
  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.unassigned, ["Architecture", "Research"]);
  assert.equal(result.dividedBy, null);
  assert.match(result.unavailable.at(-1).error, /rate limited/);
});

test("Asking for a resident the project does not have names the ones it has", async () => {
  const { project, session } = await room({ gpt: working("x") });
  await assert.rejects(
    () => session.deliberate(project.id, { question: "q", residentIds: ["llama"] }),
    /This project has: gpt/);
});
