import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProjectBrain } from "./file-project-brain.js";

async function workspace(run) {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-project-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Project Brain survives process restarts without losing context", async () => {
  await workspace(async directory => {
    const path = join(directory, "brain.jsonl");
    const first = new FileProjectBrain(path);
    const project = await first.createProject({ name: "Northstar", purpose: "Create the future" });
    await first.appendEvent(project.id, { type: "decision.created", actorId: "user", payload: { statement: "Context belongs to the project" } });
    const restarted = new FileProjectBrain(path);
    assert.deepEqual(await restarted.getState(project.id), { version: 1, latestMessage: null, decisions: ["Context belongs to the project"], tasks: [], contributions: [], document: null });
  });
});

test("Appending an event never rewrites the events already on disk", async () => {
  await workspace(async directory => {
    const path = join(directory, "brain.jsonl");
    const brain = new FileProjectBrain(path);
    const project = await brain.createProject({ name: "Northstar", purpose: "Create the future" });
    await brain.appendEvent(project.id, { type: "message.created", actorId: "user", payload: { text: "first" } });
    const before = await readFile(path, "utf8");
    await brain.appendEvent(project.id, { type: "message.created", actorId: "user", payload: { text: "second" } });
    const after = await readFile(path, "utf8");
    assert.ok(after.startsWith(before), "existing log lines must be left untouched");
  });
});

test("Concurrent appends each claim their own sequence number", async () => {
  await workspace(async directory => {
    const brain = new FileProjectBrain(join(directory, "brain.jsonl"));
    const project = await brain.createProject({ name: "Northstar", purpose: "Create the future" });
    const events = await Promise.all(Array.from({ length: 20 }, (unused, index) =>
      brain.appendEvent(project.id, { type: "message.created", actorId: "user", payload: { text: `message ${index}` } })
    ));
    assert.deepEqual(events.map(event => event.sequence).sort((a, b) => a - b), Array.from({ length: 20 }, (unused, index) => index + 1));
    assert.equal((await brain.getState(project.id)).version, 20);
  });
});

test("A legacy whole-file brain is migrated into the append-only log", async () => {
  await workspace(async directory => {
    const legacyPath = join(directory, "brain.json");
    const project = { id: "11111111-1111-4111-8111-111111111111", name: "Northstar", purpose: "Create the future", createdAt: new Date().toISOString() };
    const event = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, sequence: 1, type: "decision.created", actorId: "user", payload: { statement: "Context belongs to the project" }, createdAt: new Date().toISOString() };
    await writeFile(legacyPath, JSON.stringify({ projects: { [project.id]: { project, events: [event] } } }), "utf8");

    const brain = new FileProjectBrain(join(directory, "brain.jsonl"));
    assert.deepEqual((await brain.listProjects()).map(item => item.id), [project.id]);
    assert.deepEqual((await brain.getState(project.id)).decisions, ["Context belongs to the project"]);

    const appended = await brain.appendEvent(project.id, { type: "message.created", actorId: "user", payload: { text: "after migration" } });
    assert.equal(appended.sequence, 2);
    assert.ok(await readFile(legacyPath, "utf8"), "the legacy file is kept as a backup");
  });
});

test("A half-written final line from a crash does not destroy the log", async () => {
  await workspace(async directory => {
    const path = join(directory, "brain.jsonl");
    const brain = new FileProjectBrain(path);
    const project = await brain.createProject({ name: "Northstar", purpose: "Create the future" });
    await brain.appendEvent(project.id, { type: "message.created", actorId: "user", payload: { text: "survivor" } });
    await writeFile(path, `${await readFile(path, "utf8")}{"kind":"event","eve`, "utf8");

    const recovered = new FileProjectBrain(path);
    const state = await recovered.getState(project.id);
    assert.equal(state.version, 1);
    assert.equal(state.latestMessage, "survivor");
  });
});
