import test from "node:test";
import assert from "node:assert/strict";
import { filesInFailure, parseChanges, repairPrompt, importedBy, relatedFiles } from "./failure.js";

const PROJECT = ["src/total.js", "src/cart.js", "src/total.test.js", "index.js"];

test("A stack trace gives up the project files it blames, in order", () => {
  const trace = `
AssertionError [ERR_ASSERTION]: Expected 35 to equal 0
    at TestContext.<anonymous> (file:///C:/work/src/total.test.js:6:10)
    at total (file:///C:/work/src/total.js:2:20)
    at Test.run (node:internal/test_runner/test:1118:25)
`;
  assert.deepEqual(filesInFailure(trace, { known: PROJECT }), ["src/total.test.js", "src/total.js"]);
});

// A stack trace is mostly runtime internals and dependency code. Offering those
// up to be rewritten would be worse than offering nothing.
test("Node internals and dependencies are never offered for repair", () => {
  const trace = [
    "at node:internal/modules/esm/loader:123",
    "at Object.<anonymous> (/work/node_modules/vitest/dist/index.js:44:9)",
    "at run (/work/src/total.js:2:20)"
  ].join("\n");
  assert.deepEqual(filesInFailure(trace, { known: PROJECT }), ["src/total.js"]);
});

test("A file the project does not have is not invented", () => {
  assert.deepEqual(filesInFailure("at /work/somewhere/else.js:1:1", { known: PROJECT }), []);
});

test("Only the first few blamed files are offered", () => {
  const many = PROJECT.map(path => `at (${path}:1:1)`).join("\n");
  assert.equal(filesInFailure(many, { known: PROJECT, limit: 2 }).length, 2);
});

test("A failure that names nothing yields nothing", () => {
  for (const value of ["", "   ", null, "Segmentation fault"]) {
    assert.deepEqual(filesInFailure(value, { known: PROJECT }), []);
  }
});

test("Several labelled files come back as separate changes", () => {
  const reply = [
    "=== FILE: src/total.js ===",
    "export const total = items => items.length;",
    "",
    "=== FILE: src/cart.js ===",
    "export const cart = [];"
  ].join("\n");

  assert.deepEqual(parseChanges(reply, { allowed: PROJECT }), [
    { path: "src/total.js", content: "export const total = items => items.length;\n" },
    { path: "src/cart.js", content: "export const cart = [];\n" }
  ]);
});

// At scale this is how a model rewrites something it was never shown.
test("A change to a file that was not offered is refused", () => {
  const reply = "=== FILE: package.json ===\n{}\n\n=== FILE: src/total.js ===\nexport const a = 1;";
  assert.deepEqual(parseChanges(reply, { allowed: ["src/total.js"] }).map(change => change.path), ["src/total.js"]);
});

test("A change escaping the project is refused", () => {
  const reply = "=== FILE: ../../etc/passwd ===\nowned\n\n=== FILE: /etc/hosts ===\nowned";
  assert.deepEqual(parseChanges(reply), []);
});

test("A fence the model added around a file is stripped", () => {
  const reply = "=== FILE: src/total.js ===\n```js\nexport const a = 1;\n```";
  assert.equal(parseChanges(reply)[0].content, "export const a = 1;\n");
});

test("A file that legitimately contains fences keeps them", () => {
  const reply = "=== FILE: README.md ===\n# Title\n\n```js\nconst a = 1;\n```\n\nDone.";
  const content = parseChanges(reply)[0].content;
  assert.equal((content.match(/```/g) ?? []).length, 2);
  assert.match(content, /Done\./);
});

test("Prose with no labels changes nothing", () => {
  assert.deepEqual(parseChanges("I would change the total function to add instead."), []);
});

test("A labelled file left empty is not written", () => {
  assert.deepEqual(parseChanges("=== FILE: src/total.js ===\n\n   \n"), []);
});

test("The repair prompt carries the project, the files and the failure", () => {
  const prompt = repairPrompt({
    command: "npm test",
    failure: "AssertionError: expected 35",
    files: [{ path: "src/total.js", content: "export const total = () => 0;" }],
    tree: ["src/total.js", "src/cart.js"]
  });
  assert.match(prompt, /=== FILE: src\/total\.js ===/);
  assert.match(prompt, /export const total/);
  assert.match(prompt, /AssertionError: expected 35/);
  assert.match(prompt, /THE PROJECT/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /do not change a file that is not listed above/);
});

// The label the prompt asks for and the label the parser reads have to be the
// same thing, or a repair silently writes nothing.
test("What the prompt asks for is what the parser reads", () => {
  const prompt = repairPrompt({
    command: "npm test", failure: "boom",
    files: [{ path: "src/total.js", content: "old" }], tree: []
  });
  const asShown = prompt.match(/^=== FILE: .+ ===$/m)[0];
  const reply = `${asShown.replace(/FILE: .+ ===/, "FILE: src/total.js ===")}\nnew content`;
  assert.deepEqual(parseChanges(reply, { allowed: ["src/total.js"] }), [
    { path: "src/total.js", content: "new content\n" }
  ]);
});

// A stack trace names the test, not the mistake. Without following imports the
// repair sees only the failing assertion and, quite rightly, refuses to change
// the test to make wrong code pass — so it gets stuck.
test("The files a blamed file imports are found", () => {
  const known = ["src/cart.js", "src/prices.js", "src/util/round.js"];
  const content = `import { withDiscount } from "./prices.js";\nimport { round } from "./util/round.js";\nimport fs from "node:fs";`;
  assert.deepEqual(importedBy(content, "src/cart.js", known), ["src/prices.js", "src/util/round.js"]);
});

test("A package import is not mistaken for a project file", () => {
  const known = ["src/cart.js"];
  assert.deepEqual(importedBy(`import test from "node:test";\nimport x from "vitest";`, "src/cart.js", known), []);
});

test("An import climbing out of a folder resolves", () => {
  const known = ["src/cart.js", "shared/money.js"];
  assert.deepEqual(importedBy(`import { money } from "../shared/money.js";`, "src/cart.js", known), ["shared/money.js"]);
});

test("An import with no extension, or pointing at a folder, still resolves", () => {
  const known = ["src/cart.js", "src/prices.js", "src/util/index.js"];
  const content = `import a from "./prices";\nimport b from "./util";`;
  assert.deepEqual(importedBy(content, "src/cart.js", known), ["src/prices.js", "src/util/index.js"]);
});

test("require and dynamic import are followed too", () => {
  const known = ["a.js", "b.js", "c.js"];
  assert.deepEqual(importedBy(`const b = require("./b.js");\nconst c = await import("./c.js");`, "a.js", known),
    ["b.js", "c.js"]);
});

test("Related files reach past the blamed file to what it calls", async () => {
  const project = {
    "src/cart.test.js": `import { total } from "./cart.js";`,
    "src/cart.js": `import { withDiscount } from "./prices.js";`,
    "src/prices.js": `export const withDiscount = () => 0;`
  };
  const chosen = await relatedFiles(["src/cart.test.js"], {
    read: path => project[path] ?? null,
    known: Object.keys(project)
  });
  assert.deepEqual(chosen.map(file => file.path), ["src/cart.test.js", "src/cart.js", "src/prices.js"]);
});

// A prompt carrying half a project would cost more than the repair.
test("Following imports stops at the budget", async () => {
  const project = Object.fromEntries(
    Array.from({ length: 30 }, (unused, index) => [`f${index}.js`, `import a from "./f${index + 1}.js";`]));
  const chosen = await relatedFiles(["f0.js"], {
    read: path => project[path] ?? null, known: Object.keys(project), limit: 4
  });
  assert.equal(chosen.length, 4);
});

test("A file that cannot be read is skipped rather than breaking the walk", async () => {
  const chosen = await relatedFiles(["gone.js", "here.js"], {
    read: path => (path === "here.js" ? "const a = 1;" : null),
    known: ["gone.js", "here.js"]
  });
  assert.deepEqual(chosen.map(file => file.path), ["here.js"]);
});
