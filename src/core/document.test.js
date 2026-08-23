import test from "node:test";
import assert from "node:assert/strict";
import { parseRevision, proposedFiles, nextRevision, buildPrompt } from "./document.js";

test("Clean markdown yields its title and body", () => {
  const revision = parseRevision("# Launch plan\n\nShip the prototype first.");
  assert.equal(revision.title, "Launch plan");
  assert.match(revision.markdown, /Ship the prototype first\./);
});

test("A model that wraps its answer in a markdown fence is unwrapped", () => {
  const revision = parseRevision("Here you go:\n\n```markdown\n# Launch plan\n\nShip it.\n```\n");
  assert.equal(revision.title, "Launch plan");
  assert.equal(revision.markdown, "# Launch plan\n\nShip it.");
});

// The parser is the boundary between a model's goodwill and our data. Anything
// it cannot understand still has to produce a usable document.
test("A reply with no heading still becomes a document", () => {
  const revision = parseRevision("just some prose with no structure at all");
  assert.equal(revision.title, "Project document");
  assert.equal(revision.markdown, "just some prose with no structure at all");
});

test("An empty or missing reply does not throw", () => {
  for (const value of ["", "   ", null, undefined]) {
    const revision = parseRevision(value);
    assert.equal(revision.markdown, "");
    assert.equal(revision.title, "Project document");
  }
});

test("A fence carrying a path attribute is offered as a file", () => {
  const files = proposedFiles("```js path=src/index.js\nconsole.log(1);\n```");
  assert.deepEqual(files, [{ path: "src/index.js", content: "console.log(1);" }]);
});

test("A path written on the line above a fence is offered as a file", () => {
  const files = proposedFiles("**src/app.js**\n\n```js\nexport const a = 1;\n```");
  assert.deepEqual(files, [{ path: "src/app.js", content: "export const a = 1;" }]);
});

test("A fence with no path is not offered as a file", () => {
  assert.deepEqual(proposedFiles("```\nplain example\n```"), []);
});

// Path handling here feeds a write, so a traversal attempt must never survive
// far enough to reach the workspace guard.
test("A file path that escapes or is absolute is refused outright", () => {
  assert.deepEqual(proposedFiles("```js path=../../etc/passwd.js\nx\n```"), []);
  assert.deepEqual(proposedFiles("```js path=/etc/hosts.conf\nx\n```"), []);
});

test("The same path proposed twice is offered once", () => {
  const files = proposedFiles("a.js\n```js\nfirst\n```\na.js\n```js\nsecond\n```");
  assert.equal(files.length, 1);
  assert.equal(files[0].content, "first");
});

test("Each revision increments the version and remembers who wrote it", () => {
  const first = nextRevision(null, { title: "Plan", markdown: "# Plan", contributors: ["gpt"] });
  assert.equal(first.version, 1);

  const second = nextRevision(first, { title: "Plan", markdown: "# Plan v2", contributors: ["gpt", "claude"] });
  assert.equal(second.version, 2);
  assert.deepEqual(second.contributors, ["gpt", "claude"]);
});

test("A revision with no title keeps the previous one", () => {
  const first = nextRevision(null, { title: "Launch plan", markdown: "# Launch plan" });
  assert.equal(nextRevision(first, { markdown: "no heading now" }).title, "Launch plan");
});

test("The build prompt carries the current document, the files, and the instruction", () => {
  const prompt = buildPrompt({
    instruction: "Add a risks section",
    document: { markdown: "# Launch plan\n\nShip it.", version: 3 },
    attachments: [{ path: "notes/brief.md", content: "English first." }]
  });
  assert.match(prompt, /revision 3/);
  assert.match(prompt, /Ship it\./);
  assert.match(prompt, /notes\/brief\.md/);
  assert.match(prompt, /English first\./);
  assert.match(prompt, /Add a risks section/);
  assert.match(prompt, /COMPLETE document/, "the model must be told to return the whole thing");
});

test("With no document yet the prompt asks for a first revision", () => {
  const prompt = buildPrompt({ instruction: "Start the plan", document: null, attachments: [] });
  assert.match(prompt, /no document yet/i);
});
