import test from "node:test";
import assert from "node:assert/strict";
import { parseRevision, proposedFiles, nextRevision, buildPrompt, filePrompt, fileFromReply } from "./document.js";

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

// Found by the app analysing its own interface: the reply was 7000 characters
// of real document containing four code fences, and the parser kept only the
// first fence's contents. A document about code always contains code.
test("A document that contains code fences is not mistaken for a wrapped one", () => {
  const reply = `# Northstar Visual Workspace

**Scope:** the interface.

## 1. Split view

\`\`\`html
<div class="split"></div>
\`\`\`

## 2. Live document

\`\`\`css
.editor { display: grid; }
\`\`\`

That is the plan.`;

  const revision = parseRevision(reply);
  assert.equal(revision.title, "Northstar Visual Workspace");
  assert.match(revision.markdown, /Split view/);
  assert.match(revision.markdown, /Live document/);
  assert.match(revision.markdown, /That is the plan\./, "nothing after the fences is lost");
  assert.equal(revision.markdown, reply, "the whole reply is the document");
});

test("A reply genuinely wrapped in one fence is still unwrapped", () => {
  const revision = parseRevision("Sure, here it is:\n\n```markdown\n# The plan\n\nShip it.\n```");
  assert.equal(revision.markdown, "# The plan\n\nShip it.");
});

test("A wrapped reply containing an inner fence keeps the inner one", () => {
  const revision = parseRevision("```markdown\n# The plan\n\n    indented code\n\nDone.\n```");
  assert.match(revision.markdown, /# The plan/);
  assert.match(revision.markdown, /Done\./);
});

test("A long preamble means the fence is content, not a wrapper", () => {
  const reply = `${"x".repeat(200)}\n\n\`\`\`js\nconst a = 1;\n\`\`\``;
  const revision = parseRevision(reply);
  assert.match(revision.markdown, /^x{200}/, "the preamble is part of the document");
});

// Found by asking the app to build a working app: the model put the filename in
// one fence and the code in another. Unwrapping from the first fence to the last
// spliced them together and destroyed the file it had just written.
test("A reply with several fences keeps every one of them intact", () => {
  const reply = [
    "# Shopping List App",
    "",
    "```html",
    "app/lista.html",
    "```",
    "",
    "```html",
    "<!DOCTYPE html>",
    "<h1>Lista</h1>",
    "```"
  ].join("\n");

  const revision = parseRevision(reply);
  assert.equal((revision.markdown.match(/```/g) ?? []).length, 4,
    "all four fence markers survive");

  const files = proposedFiles(revision.markdown);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "app/lista.html");
  assert.match(files[0].content, /<!DOCTYPE html>/, "the code is recoverable, not spliced away");
});

// The format a model chooses varies run to run: the same request produced the
// path inside a fence, then beside one, then no fence at all. When one file is
// the point, the reply is the file and the decoration is stripped.
test("A file reply is recovered whatever decoration the model adds", () => {
  const html = '<!DOCTYPE html>\n<h1>Lista</h1>';
  for (const [shape, reply] of [
    ["bare", html],
    ["named line first", `app/lista.html\n${html}`],
    ["named in backticks", `\`app/lista.html\`\n${html}`],
    ["fenced", "```html\n" + html + "\n```"],
    ["named then fenced", "app/lista.html\n```html\n" + html + "\n```"]
  ]) {
    assert.equal(fileFromReply(reply, "app/lista.html"), `${html}\n`, shape);
  }
});

test("A file that legitimately contains fences keeps them", () => {
  const markdown = "# Readme\n\n```js\nconst a = 1;\n```\n\nDone.";
  assert.equal(fileFromReply(markdown, "README.md"), `${markdown}\n`);
});

test("A leading line that is not this file's name is kept as content", () => {
  assert.match(fileFromReply("other.txt\nreal content", "app/lista.html"), /^other\.txt/);
});

test("The file prompt demands the file and nothing around it", () => {
  const prompt = filePrompt({ path: "app/lista.html", instruction: "A shopping list", existing: null, attachments: [] });
  assert.match(prompt, /complete contents of the file `app\/lista\.html`/);
  assert.match(prompt, /no markdown fence around it/);
  assert.match(prompt, /A shopping list/);
});

test("The file prompt shows the file as it is when rewriting one", () => {
  const prompt = filePrompt({ path: "a.js", instruction: "add logging", existing: "const a = 1;" });
  assert.match(prompt, /THE FILE AS IT IS NOW/);
  assert.match(prompt, /const a = 1;/);
});
