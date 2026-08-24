import test from "node:test";
import assert from "node:assert/strict";
import { validateAgent, agentBriefing, specialise, AgentRejectedError } from "./agents.js";
import { RecordingProvider } from "./providers/recording-provider.js";

test("An agent needs a usable id and a role", () => {
  assert.deepEqual(validateAgent({ id: "frontend", role: "Frontend engineer", scope: "src/web" }), {
    id: "frontend", role: "Frontend engineer", scope: "src/web"
  });
  for (const bad of ["", "A", "Frontend", "has space", "x".repeat(40), "1st"]) {
    assert.throws(() => validateAgent({ id: bad, role: "r" }), AgentRejectedError, `id: ${bad}`);
  }
  assert.throws(() => validateAgent({ id: "ok", role: "  " }), AgentRejectedError);
});

test("An id already in the room is refused", () => {
  assert.throws(() => validateAgent({ id: "gpt", role: "r" }, ["gpt", "claude"]),
    /already a resident called gpt/);
});

test("A briefing states the role, the territory, and what is already known", () => {
  const briefing = agentBriefing({
    role: "Frontend engineer",
    scope: "src/web",
    skills: [{ name: "Where .md files go", approach: "Files of this kind are written to documents/" }]
  });
  assert.match(briefing, /You are the project's Frontend engineer\./);
  assert.match(briefing, /You own this part of the project: src\/web/);
  assert.match(briefing, /falls outside it/, "an agent must be able to decline what is not its job");
  assert.match(briefing, /Where \.md files go/);
  assert.match(briefing, /reuse them rather than starting over/);
});

test("An agent with no scope and nothing learned still gets a role", () => {
  const briefing = agentBriefing({ role: "Reviewer" });
  assert.equal(briefing, "You are the project's Reviewer.");
});

// The speciality has to survive every round without the caller remembering it.
test("A specialised provider carries its briefing into every request", async () => {
  const underlying = new RecordingProvider("openai", { response: "done" });
  const agent = specialise(underlying, "You are the project's Reviewer.");

  await agent.work({ taskId: "t", prompt: "Check the plan", projectVersion: 3 });
  assert.match(underlying.workRequests[0].prompt, /^You are the project's Reviewer\./);
  assert.match(underlying.workRequests[0].prompt, /Check the plan/);
  assert.equal(underlying.workRequests[0].projectVersion, 3, "the rest of the request is untouched");
});

// An agent is a lens on a resident, so it must not break the shared brain.
test("A specialised provider still hydrates and observes like any resident", async () => {
  const underlying = new RecordingProvider("openai");
  const agent = specialise(underlying, "briefing");

  agent.hydrate([{ sequence: 1, type: "message.created", payload: { text: "history" } }]);
  await agent.observe({ event: { sequence: 2, type: "message.created", payload: {} } });

  assert.equal(underlying.hydratedEvents.length, 1);
  assert.deepEqual(underlying.processedSequences, [2]);
  assert.equal(agent.name, "openai", "and it reports the provider behind it honestly");
});
