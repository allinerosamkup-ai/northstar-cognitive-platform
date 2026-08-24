import test from "node:test";
import assert from "node:assert/strict";
import { learnFrom, skillsFrom, briefingSkills } from "./skills.js";

const decision = (statement, question, sequence = 1) =>
  ({ type: "decision.created", sequence, payload: { statement, question } });

test("A decision that settled a question becomes a lesson", () => {
  const skill = learnFrom(decision("Store in the cloud, cache on device.", "Local or cloud storage?", 7));
  assert.match(skill.name, /Local or cloud storage\?/);
  assert.match(skill.approach, /Store in the cloud/);
  assert.equal(skill.source, "decision");
  assert.equal(skill.sequence, 7);
});

// A decision recorded on its own settled no question, so it teaches nothing
// about how to approach one.
test("A bare decision with no question behind it is not a lesson", () => {
  assert.equal(learnFrom({ type: "decision.created", sequence: 1, payload: { statement: "x" } }), null);
});

test("A confirmed division teaches who owns what", () => {
  const skill = learnFrom({
    type: "assignment.confirmed", sequence: 4,
    payload: { assignments: [{ phase: "Architecture", residentId: "claude" }, { phase: "Launch", residentId: "gpt" }] }
  });
  assert.match(skill.approach, /Architecture belongs to claude/);
  assert.match(skill.approach, /Launch belongs to gpt/);
});

test("A saved file teaches where that kind of file goes", () => {
  const skill = learnFrom({ type: "file.written", sequence: 9, payload: { path: "documents/plan.md" } });
  assert.match(skill.name, /\.md files/);
  assert.match(skill.approach, /documents\/plan\.md/);
});

test("Events with nothing to teach are ignored", () => {
  for (const type of ["message.created", "contribution.created", "session.started", "resident.paused"]) {
    assert.equal(learnFrom({ type, sequence: 1, payload: {} }), null, type);
  }
});

// Offering a superseded approach beside the one that replaced it would teach
// the project to contradict itself.
test("A later lesson on the same topic replaces the earlier one", () => {
  const skills = skillsFrom([
    decision("Use local storage.", "Where do we store data?", 2),
    decision("Use the cloud instead.", "Where do we store data?", 8)
  ]);
  assert.equal(skills.length, 1);
  assert.match(skills[0].approach, /cloud instead/);
});

test("Lessons come back newest first", () => {
  const skills = skillsFrom([
    decision("a", "First question", 1),
    decision("b", "Second question", 5)
  ]);
  assert.deepEqual(skills.map(skill => skill.sequence), [5, 1]);
});

// A briefing that grows without limit would eventually cost more than the work.
test("A briefing carries only the most recent handful", () => {
  const many = Array.from({ length: 20 }, (unused, index) =>
    decision(`answer ${index}`, `question ${index}`, index + 1));
  assert.equal(briefingSkills(many).length, 6);
  assert.equal(briefingSkills(many)[0].sequence, 20, "and the newest come first");
});

test("A project that has learned nothing yields no lessons", () => {
  assert.deepEqual(skillsFrom([]), []);
});
