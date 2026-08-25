import test from "node:test";
import assert from "node:assert/strict";
import {
  requirementsPrompt, parseRequirements, reviewPrompt, parseReview,
  isSatisfied, unmet, gapInstruction
} from "./requirements.js";

const REQUIREMENTS = [
  "A book can be added to the library",
  "A book can be lent to a person",
  "A book already out cannot be lent again"
];

test("Requirements come back as checkable lines", () => {
  const reply = `## Requirements

- A book can be added to the library
- A book can be lent to a person
- A book already out cannot be lent again`;
  assert.deepEqual(parseRequirements(reply), REQUIREMENTS);
});

test("A reply that skipped the heading is still read", () => {
  assert.deepEqual(parseRequirements("- one thing\n- another thing"), ["one thing", "another thing"]);
});

test("Checkboxes, bold and repetition are cleaned up", () => {
  const reply = "## Requirements\n- [ ] **A book can be added**\n- A book can be added\n- Something else";
  assert.deepEqual(parseRequirements(reply), ["A book can be added", "Something else"]);
});

test("A reply with no requirements in it yields none", () => {
  for (const value of ["", "   ", null, "I would start with the data model."]) {
    assert.deepEqual(parseRequirements(value), []);
  }
});

test("The prompt asks for what gets forgotten", () => {
  const prompt = requirementsPrompt({ description: "a lending system" });
  assert.match(prompt, /a lending system/);
  assert.match(prompt, /must refuse or prevent/);
  assert.match(prompt, /not how to build it/);
});

test("A review reports a verdict per requirement", () => {
  const reply = `1. MET — addBook in library.js
2. MET — borrowBook in library.js
3. MISSING — nothing checks whether it is already out`;

  assert.deepEqual(parseReview(reply, REQUIREMENTS), [
    { requirement: REQUIREMENTS[0], verdict: "MET", detail: "addBook in library.js" },
    { requirement: REQUIREMENTS[1], verdict: "MET", detail: "borrowBook in library.js" },
    { requirement: REQUIREMENTS[2], verdict: "MISSING", detail: "nothing checks whether it is already out" }
  ]);
});

// The whole point of reviewing: silence must stop counting as success.
test("A requirement the review ignored is unchecked, never met", () => {
  const review = parseReview("1. MET — done", REQUIREMENTS);
  assert.equal(review[1].verdict, "UNCHECKED");
  assert.equal(review[2].verdict, "UNCHECKED");
  assert.equal(isSatisfied(review), false);
});

test("Partial counts as unmet", () => {
  const review = parseReview("1. MET — yes\n2. MET — yes\n3. PARTIAL — only for one copy", REQUIREMENTS);
  assert.equal(isSatisfied(review), false);
  assert.deepEqual(unmet(review).map(item => item.verdict), ["PARTIAL"]);
});

test("Everything met is satisfied", () => {
  const review = parseReview("1. MET — a\n2. MET — b\n3. MET — c", REQUIREMENTS);
  assert.equal(isSatisfied(review), true);
  assert.deepEqual(unmet(review), []);
  assert.equal(gapInstruction(review), null);
});

test("A verdict for a requirement that does not exist is ignored", () => {
  const review = parseReview("1. MET — a\n9. MET — invented", REQUIREMENTS);
  assert.equal(review.length, 3);
  assert.equal(review[0].verdict, "MET");
});

test("A repeated verdict for one requirement keeps the first", () => {
  const review = parseReview("1. MISSING — no\n1. MET — yes", REQUIREMENTS);
  assert.equal(review[0].verdict, "MISSING");
});

test("Prose around the verdicts does not confuse them", () => {
  const review = parseReview("Here is my review:\n\n1. MET — addBook\n\nThat is all.", REQUIREMENTS);
  assert.equal(review[0].verdict, "MET");
});

// What a further pass has to do, phrased as work rather than as a complaint.
test("The gap becomes an instruction naming only what is missing", () => {
  const review = parseReview("1. MET — yes\n2. MISSING — no lending\n3. PARTIAL — no check", REQUIREMENTS);
  const instruction = gapInstruction(review);

  assert.doesNotMatch(instruction, /A book can be added/, "what already works is not asked for again");
  assert.match(instruction, /A book can be lent to a person/);
  assert.match(instruction, /already out cannot be lent again/);
  assert.match(instruction, /keeping everything that already works/);
});

test("The review prompt refuses a verdict nobody can point at", () => {
  const prompt = reviewPrompt({ requirements: REQUIREMENTS, files: [{ path: "a.js", content: "x" }] });
  assert.match(prompt, /=== a\.js ===/);
  assert.match(prompt, /If you\s*\n?\s*cannot point at it, it is not MET/);
  assert.match(prompt, /A book already out cannot be lent again/);
});
