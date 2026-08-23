import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryProjectBrain } from "./project-brain.js";

test("Project Brain records one canonical ordered event stream", async () => {
  const brain = new InMemoryProjectBrain();
  const project = await brain.createProject({ name: "Atlas", purpose: "Ship a new product" });
  const first = await brain.appendEvent(project.id, { type: "message.created", actorId: "user-1", payload: { text: "Define the market" } });
  const second = await brain.appendEvent(project.id, { type: "decision.created", actorId: "llm-1", payload: { statement: "English-first" } });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(await brain.eventsSince(project.id, 0), [first, second]);
  assert.deepEqual(await brain.getState(project.id), { version: 2, latestMessage: "Define the market", decisions: ["English-first"], tasks: [], contributions: [], document: null, session: null, assignment: null });
});
