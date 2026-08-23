import test from "node:test";
import assert from "node:assert/strict";
import { isSurfaceEvent, surfaceEvents } from "./event-catalog.js";

test("Surface events reach the model and log-only events do not", () => {
  for (const type of ["message.created", "decision.created", "task.created", "contribution.created"]) {
    assert.equal(isSurfaceEvent(type), true, type);
  }
  for (const type of ["collective.started", "resident.paused"]) {
    assert.equal(isSurfaceEvent(type), false, type);
  }
});

test("An unclassified event type stays visible rather than being silently hidden", () => {
  assert.equal(isSurfaceEvent("something.new"), true);
});

test("surfaceEvents keeps project content and drops bookkeeping", () => {
  const events = [
    { sequence: 1, type: "message.created" },
    { sequence: 2, type: "collective.started" },
    { sequence: 3, type: "contribution.created" },
    { sequence: 4, type: "resident.paused" }
  ];
  assert.deepEqual(surfaceEvents(events).map(event => event.sequence), [1, 3]);
});

test("An attached file is surface content so the residents actually read it", () => {
  assert.equal(isSurfaceEvent("file.attached"), true);
  assert.deepEqual(
    surfaceEvents([{ type: "file.attached" }, { type: "resident.paused" }]).map(event => event.type),
    ["file.attached"]);
});
