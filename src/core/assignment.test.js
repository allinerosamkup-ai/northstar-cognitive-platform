import test from "node:test";
import assert from "node:assert/strict";
import { claimPrompt, dividePrompt, parseAssignments, assignmentCost } from "./assignment.js";

const PHASES = ["Architecture", "User research", "Launch plan"];
const RESIDENTS = ["gpt", "claude", "gemini"];

test("A resident is asked to argue from capability, not willingness", () => {
  const prompt = claimPrompt({ phases: PHASES, self: "claude", model: "Claude", document: null });
  assert.match(prompt, /Architecture/);
  assert.match(prompt, /Launch plan/);
  assert.match(prompt, /actually good at rather than willingness/);
  assert.match(prompt, /poor fit/, "declining a part has to be a valid move");
});

test("The dividing prompt shows every claim and asks for identifiers", () => {
  const prompt = dividePrompt({
    phases: PHASES,
    claims: [{ residentId: "gpt", model: "GPT", text: "I should take the launch plan." }]
  });
  assert.match(prompt, /gpt \(GPT\)/);
  assert.match(prompt, /I should take the launch plan\./);
  assert.match(prompt, /identifiers in parentheses/);
  assert.match(prompt, /spread the work/);
});

test("A well-formed division is read back with its reasoning", () => {
  const { assignments, unassigned } = parseAssignments(`
- Architecture: claude — strongest at structural tradeoffs
- User research: gemini — best at gathering evidence
- Launch plan: gpt — best at sequencing and framing
`, { phases: PHASES, residentIds: RESIDENTS });

  assert.deepEqual(assignments.map(item => [item.phase, item.residentId]), [
    ["Architecture", "claude"], ["User research", "gemini"], ["Launch plan", "gpt"]
  ]);
  assert.match(assignments[0].reason, /structural tradeoffs/);
  assert.deepEqual(unassigned, []);
});

test("Numbered and loosely worded parts still match the real phases", () => {
  const { assignments } = parseAssignments(
    "- 1. architecture: claude — fit\n- user research: gemini — fit",
    { phases: PHASES, residentIds: RESIDENTS });
  assert.deepEqual(assignments.map(item => item.phase), ["Architecture", "User research"]);
});

// A phase quietly missing from the split is how work disappears. It has to be
// reported, not dropped.
test("A part nobody was given is reported as unassigned", () => {
  const { assignments, unassigned } = parseAssignments(
    "- Architecture: claude — fit", { phases: PHASES, residentIds: RESIDENTS });
  assert.equal(assignments.length, 1);
  assert.deepEqual(unassigned, ["User research", "Launch plan"]);
});

test("A part given to someone who is not in the room is refused", () => {
  const { assignments, unassigned } = parseAssignments(
    "- Architecture: llama — fit\n- User research: gemini — fit",
    { phases: PHASES, residentIds: RESIDENTS });
  assert.deepEqual(assignments.map(item => item.residentId), ["gemini"]);
  assert.ok(unassigned.includes("Architecture"));
});

test("The same part claimed twice is only assigned once", () => {
  const { assignments } = parseAssignments(
    "- Architecture: claude — first\n- Architecture: gpt — second",
    { phases: PHASES, residentIds: RESIDENTS });
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].residentId, "claude");
});

test("Prose around the list does not become an assignment", () => {
  const { assignments } = parseAssignments(
    "Here is how I would divide it:\n\n- Architecture: claude — fit\n\nThat seems balanced.",
    { phases: PHASES, residentIds: RESIDENTS });
  assert.equal(assignments.length, 1);
});

test("An unparseable division assigns nothing rather than guessing", () => {
  const { assignments, unassigned } = parseAssignments(
    "I think everyone should collaborate on everything.",
    { phases: PHASES, residentIds: RESIDENTS });
  assert.deepEqual(assignments, []);
  assert.deepEqual(unassigned, PHASES);
});

test("Dividing costs one call per participant plus the division itself", () => {
  assert.equal(assignmentCost(3), 4);
});
