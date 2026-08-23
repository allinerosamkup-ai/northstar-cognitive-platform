import test from "node:test";
import assert from "node:assert/strict";
import { proposePrompt, critiquePrompt, synthesisPrompt, parseSynthesis, callCount } from "./deliberation.js";

const PROPOSALS = [
  { residentId: "gpt", model: "GPT", text: "Use SQLite." },
  { residentId: "claude", model: "Claude", text: "Use plain JSON files." },
  { residentId: "gemini", model: "Gemini", text: "Use SQLite, with a JSON export." }
];

test("A proposal prompt carries the document and asks for a real position", () => {
  const prompt = proposePrompt({ question: "Which store?", document: { markdown: "# Plan", version: 3 } });
  assert.match(prompt, /revision 3/);
  assert.match(prompt, /Which store\?/);
  assert.match(prompt, /commit to a position/);
});

// The whole point of round two: a resident must see what the others said. If
// its own answer were all it received, this would just be round one again.
test("A critique prompt shows the others' answers and the resident's own", () => {
  const prompt = critiquePrompt({ question: "Which store?", proposals: PROPOSALS, self: "claude" });
  assert.match(prompt, /YOUR OWN ANSWER\n\nUse plain JSON files\./);
  assert.match(prompt, /Use SQLite\./);
  assert.match(prompt, /Gemini/);
  assert.doesNotMatch(prompt.split("WHAT THE OTHERS SAID")[1], /--- Claude ---/,
    "a resident is not listed among the others");
});

test("A critique prompt permits changing your mind", () => {
  assert.match(critiquePrompt({ question: "q", proposals: PROPOSALS, self: "gpt" }), /change your own position/);
});

test("The synthesis prompt receives both rounds and forbids invented agreement", () => {
  const prompt = synthesisPrompt({
    question: "Which store?",
    proposals: PROPOSALS,
    critiques: [{ residentId: "gpt", model: "GPT", text: "Claude has a point about simplicity." }]
  });
  assert.match(prompt, /PROPOSALS/);
  assert.match(prompt, /RESPONSES TO EACH OTHER/);
  assert.match(prompt, /Claude has a point about simplicity\./);
  assert.match(prompt, /Never invent\s*\n?\s*agreement/);
});

test("A well-formed synthesis is read back into its parts", () => {
  const parsed = parseSynthesis(`## Conclusion

Store in SQLite and offer a JSON export.

## Agreed

- The data must survive an app restart
- Export matters for trust

## Unresolved

- **Migrations**: gpt wants them from day one; claude wants them deferred`);

  assert.match(parsed.conclusion, /SQLite and offer a JSON export/);
  assert.deepEqual(parsed.agreed, ["The data must survive an app restart", "Export matters for trust"]);
  assert.equal(parsed.unresolved.length, 1);
  assert.equal(parsed.unresolved[0].topic, "Migrations");
  assert.match(parsed.unresolved[0].detail, /gpt wants them from day one/);
});

test("A session that settled everything reports no disagreement", () => {
  const parsed = parseSynthesis("## Conclusion\n\nUse SQLite.\n\n## Agreed\n\n- Everyone agrees\n\n## Unresolved\n\n- none");
  assert.deepEqual(parsed.unresolved, []);
  assert.equal(parsed.agreed.length, 1);
});

// Losing a real conclusion because a model skipped the headings would be a worse
// failure than losing the structure around it.
test("A synthesis that ignores the headings still yields its conclusion", () => {
  const parsed = parseSynthesis("We settled on SQLite because durability mattered more than simplicity.");
  assert.match(parsed.conclusion, /We settled on SQLite/);
  assert.deepEqual(parsed.agreed, []);
  assert.deepEqual(parsed.unresolved, []);
});

test("An empty synthesis does not throw", () => {
  for (const value of ["", "   ", null, undefined]) {
    assert.deepEqual(parseSynthesis(value), { conclusion: "", agreed: [], unresolved: [] });
  }
});

test("An unresolved point without a bold topic still records the disagreement", () => {
  const parsed = parseSynthesis("## Unresolved\n\n- whether to support offline editing at all");
  assert.equal(parsed.unresolved[0].topic, "whether to support offline editing at all");
  assert.equal(parsed.unresolved[0].detail, "");
});

// Cost is a design constraint here, not a footnote: a deliberation is the most
// expensive thing the product can do.
test("The cost of a deliberation is two calls per participant plus the synthesis", () => {
  assert.equal(callCount(1), 3);
  assert.equal(callCount(3), 7);
});
