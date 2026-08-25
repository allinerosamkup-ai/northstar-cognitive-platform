import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptancePrompt, parseAcceptance, accepted, rejectedInstruction,
  acceptancePath, acceptanceCommand
} from "./acceptance.js";

const REQUIREMENTS = [
  "A room can be booked for a period",
  "An overlapping booking is refused",
  "A booking can be cancelled"
];

test("A check reports one verdict per requirement", () => {
  const output = `PASS 1 — booked room1 from 10 to 11
FAIL 2 — the overlapping booking was accepted
PASS 3 — cancelling removed it`;

  assert.deepEqual(parseAcceptance(output, REQUIREMENTS), [
    { requirement: REQUIREMENTS[0], passed: true, note: "booked room1 from 10 to 11" },
    { requirement: REQUIREMENTS[1], passed: false, note: "the overlapping booking was accepted" },
    { requirement: REQUIREMENTS[2], passed: true, note: "cancelling removed it" }
  ]);
});

// Silence is exactly how a broken requirement survives a build: nobody reported
// on it, and nobody noticed nobody had.
test("A requirement the check never reported on has not passed", () => {
  const results = parseAcceptance("PASS 1 — fine", REQUIREMENTS);
  assert.equal(results[1].passed, false);
  assert.match(results[1].note, /never reported/);
  assert.equal(accepted(results), false);
});

test("Everything passing is accepted", () => {
  const results = parseAcceptance("PASS 1 — a\nPASS 2 — b\nPASS 3 — c", REQUIREMENTS);
  assert.equal(accepted(results), true);
  assert.equal(rejectedInstruction(results), null);
});

test("An empty check is never acceptance", () => {
  assert.equal(accepted([]), false);
  assert.equal(accepted(parseAcceptance("", REQUIREMENTS)), false);
});

test("Output around the verdicts does not confuse them", () => {
  const output = "Running checks…\n\nPASS 1 — ok\nsome stray log line\nFAIL 2 — nope\n\nDone.";
  const results = parseAcceptance(output, REQUIREMENTS);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, false);
});

test("A verdict for a requirement that does not exist is ignored", () => {
  const results = parseAcceptance("PASS 1 — ok\nPASS 99 — invented", REQUIREMENTS);
  assert.equal(results.length, 3);
});

test("A repeated verdict keeps the first", () => {
  const results = parseAcceptance("FAIL 1 — no\nPASS 1 — yes", REQUIREMENTS);
  assert.equal(results[0].passed, false);
});

// What a further pass must fix, and — just as important — what it must not.
test("A rejection says to fix the software, not the checks", () => {
  const results = parseAcceptance("PASS 1 — a\nFAIL 2 — overlap accepted", REQUIREMENTS);
  const instruction = rejectedInstruction(results);

  assert.match(instruction, /Fix the software — not the checks/);
  assert.match(instruction, /An overlapping booking is refused/);
  assert.match(instruction, /overlap accepted/);
  assert.doesNotMatch(instruction, /A room can be booked/, "what already works is not reopened");
});

// The rule that made this catch the real bug: the generated tests called an
// internal setup function, and without it nothing was ever stored.
test("The prompt forbids the private setup that makes a broken system look fine", () => {
  const prompt = acceptancePrompt({
    description: "a booking system",
    requirements: REQUIREMENTS,
    files: [{ path: "src/rooms.js", content: "export const book = () => {};" }],
    entryHint: "an ES module"
  });

  assert.match(prompt, /public interface/);
  assert.match(prompt, /Do not call setup or bootstrap functions/);
  assert.match(prompt, /that is\s*\n?\s*the finding/);
  assert.match(prompt, /No test framework/);
  assert.match(prompt, /Check behaviour, not the presence of a function/);
  assert.match(prompt, /An overlapping booking is refused/);
});

// It lives beside the project, never inside its source tree, so it is not
// something the project ships or something its own test run picks up.
test("The check has a name and a command of its own", () => {
  assert.equal(acceptancePath(), "northstar-acceptance.mjs");
  assert.equal(acceptanceCommand(acceptancePath()), "node northstar-acceptance.mjs");
  assert.equal(acceptanceCommand(acceptancePath("python")), "python northstar-acceptance.py");
});
