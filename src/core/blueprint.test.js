import test from "node:test";
import assert from "node:assert/strict";
import { planPrompt, parsePlan, partPrompt, buildCost, runnerNote } from "./blueprint.js";

const PLAN_REPLY = `## Files

- src/store.js — reads and writes the list to disk
- src/list.js — add, remove and complete items, using the store
- src/list.test.js — covers adding, removing and completing

## Verify

npm test

## Notes

store.js exports read() and write(items). An item is { id, text, done }.
list.js exports add(text), remove(id) and complete(id), each returning the new array.`;

test("A plan comes back as files in order, a command, and what they must agree on", () => {
  const plan = parsePlan(PLAN_REPLY);

  assert.deepEqual(plan.files.map(file => file.path),
    ["src/store.js", "src/list.js", "src/list.test.js"]);
  assert.match(plan.files[0].purpose, /reads and writes/);
  assert.equal(plan.verify, "npm test");
  assert.match(plan.notes, /\{ id, text, done \}/);
});

// A file written in isolation agrees with nothing. The notes are the only thing
// keeping separate requests consistent, so losing them silently would produce a
// project whose files each work and which together do not.
test("A plan without notes is still usable, and says so by being empty", () => {
  const plan = parsePlan("## Files\n\n- a.js — does a thing\n\n## Verify\n\nnode a.js");
  assert.equal(plan.files.length, 1);
  assert.equal(plan.notes, "");
});

test("A command wrapped in prose or backticks is still found", () => {
  for (const block of ["`npm test`", "$ npm test", "- npm test", "Run this:\nnpm test"]) {
    assert.equal(parsePlan(`## Verify\n\n${block}`).verify, "npm test");
  }
});

test("A verify section with no runnable command yields none rather than a guess", () => {
  assert.equal(parsePlan("## Verify\n\nOpen it in a browser and look at it.").verify, null);
});

test("A file listed twice is planned once", () => {
  const plan = parsePlan("## Files\n\n- a.js — first\n- a.js — second\n- b.js — other");
  assert.deepEqual(plan.files.map(file => file.path), ["a.js", "b.js"]);
  assert.match(plan.files[0].purpose, /first/, "the first responsibility is the one kept");
});

test("A planned file escaping the project is refused", () => {
  const plan = parsePlan("## Files\n\n- ../../etc/passwd — no\n- /etc/hosts — no\n- ok.js — yes");
  assert.deepEqual(plan.files.map(file => file.path), ["ok.js"]);
});

test("A reply with no plan in it yields nothing rather than nonsense", () => {
  for (const value of ["", "   ", null, "I would start by thinking about the data model."]) {
    const plan = parsePlan(value);
    assert.deepEqual(plan.files, []);
    assert.equal(plan.verify, null);
  }
});

test("The planning prompt asks for order, tests, and a runnable command", () => {
  const prompt = planPrompt({ description: "a shopping list", tree: ["package.json"] });
  assert.match(prompt, /a shopping list/);
  assert.match(prompt, /package\.json/);
  assert.match(prompt, /Do not write any code yet/);
  assert.match(prompt, /Include the tests/);
  assert.match(prompt, /comes before the files that import it/);
});

// This is the whole mechanism for coherence: a file is written seeing the plan
// and everything written before it, so the imports resolve and the names line up.
test("Writing a part shows the plan and every file already written", () => {
  const plan = parsePlan(PLAN_REPLY);
  const prompt = partPrompt({
    description: "a shopping list",
    plan,
    path: "src/list.js",
    purpose: plan.files[1].purpose,
    written: [{ path: "src/store.js", content: "export const read = () => [];" }]
  });

  assert.match(prompt, /Write src\/list\.js and nothing else/);
  assert.match(prompt, /=== src\/store\.js ===/);
  assert.match(prompt, /export const read/);
  assert.match(prompt, /WHAT EVERY FILE MUST AGREE ON/);
  assert.match(prompt, /\{ id, text, done \}/);
  assert.match(prompt, /match these exactly/);
});

test("The first file is written with nothing before it and says so by omission", () => {
  const prompt = partPrompt({
    description: "x", plan: parsePlan(PLAN_REPLY),
    path: "src/store.js", purpose: "the store", written: []
  });
  assert.doesNotMatch(prompt, /FILES ALREADY WRITTEN/);
  assert.match(prompt, /THE PLAN/);
});

// Cost is a design constraint here: a build is the most expensive thing the
// product can do, and nobody should discover that from an invoice.
test("The cost of a build is one call to plan, one per file, plus the repair", () => {
  assert.deepEqual(buildCost(4), { plan: 1, files: 4, repair: 3, total: 8 });
  assert.equal(buildCost(10, 0).total, 11);
});

// Found building a real project: asked for `node --test`, the model wrote a
// suite importing `expect` from 'node:test', which does not export it — so the
// module would not even load. It was guessing at the framework, because nothing
// told it which one.
test("The prompt names what the test runner actually provides", () => {
  const plan = parsePlan("## Files\n\n- a.test.js — tests\n\n## Verify\n\nnode --test a.test.js");
  const prompt = partPrompt({ description: "x", plan, path: "a.test.js", purpose: "tests", written: [] });

  assert.match(prompt, /node --test/);
  assert.match(prompt, /There is no `expect`/);
  assert.match(prompt, /node:assert\/strict/);
});

test("Each runner is described in its own terms", () => {
  assert.match(runnerNote("npx vitest run"), /from 'vitest'/);
  assert.match(runnerNote("npx jest"), /are global; do not import them/);
  assert.match(runnerNote("pytest -q"), /test_\*/);
  assert.match(runnerNote("go test ./..."), /testing/);
});

test("An unfamiliar command adds nothing rather than guessing", () => {
  assert.equal(runnerNote("./build.sh"), null);
  assert.equal(runnerNote(null), null);
});
