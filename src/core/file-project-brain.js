import { randomUUID } from "node:crypto";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLock } from "./lock.js";

const withLock = createLock();

export class FileProjectBrain {
  constructor(path) {
    this.path = path;
    this.legacyPath = path.endsWith(".jsonl") ? path.replace(/\.jsonl$/, ".json") : null;
    this.migrated = false;
  }

  async #readLines() {
    try { return (await readFile(this.path, "utf8")).split("\n"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  // Rebuilds the project map from the append-only log. A truncated final line is the
  // signature of a crash mid-append: drop it rather than failing the whole read.
  async #read() {
    await this.#migrateLegacy();
    const projects = {};
    const lines = await this.#readLines();
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch {
        if (index === lines.length - 1) continue;
        throw new Error(`Corrupt project log at line ${index + 1}`);
      }
      if (record.kind === "project") projects[record.project.id] = { project: record.project, events: [] };
      else if (record.kind === "event") projects[record.event.projectId]?.events.push(record.event);
    }
    return { projects };
  }

  async #append(record) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  // One-time conversion of the pre-JSONL whole-file format. The legacy file is left in
  // place as a backup; the presence of the .jsonl file is what marks the migration done.
  async #migrateLegacy() {
    if (this.migrated || !this.legacyPath) return;
    this.migrated = true;
    const lines = await this.#readLines();
    if (lines.some(line => line.trim())) return;
    let legacy;
    try { legacy = JSON.parse(await readFile(this.legacyPath, "utf8")); }
    catch { return; }
    const records = [];
    for (const entry of Object.values(legacy.projects ?? {})) {
      records.push({ kind: "project", project: entry.project });
      for (const event of entry.events ?? []) records.push({ kind: "event", event });
    }
    if (!records.length) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, records.map(record => `${JSON.stringify(record)}\n`).join(""), "utf8");
  }

  async createProject(input) {
    return withLock(this.path, async () => {
      const project = { id: randomUUID(), name: input.name, purpose: input.purpose, createdAt: new Date().toISOString() };
      await this.#read();
      await this.#append({ kind: "project", project });
      return project;
    });
  }

  // Serialized: read-then-append is one atomic unit, so concurrent callers cannot compute
  // the same sequence number and silently overwrite each other's event.
  async appendEvent(projectId, input) {
    return withLock(this.path, async () => {
      const entry = (await this.#read()).projects[projectId];
      if (!entry) throw new Error("Project not found");
      const event = { id: randomUUID(), projectId, sequence: entry.events.length + 1, type: input.type, actorId: input.actorId, payload: input.payload, createdAt: new Date().toISOString() };
      await this.#append({ kind: "event", event });
      return event;
    });
  }

  async eventsSince(projectId, sequence) {
    const entry = (await this.#read()).projects[projectId];
    if (!entry) throw new Error("Project not found");
    return entry.events.filter(event => event.sequence > sequence);
  }

  async getState(projectId) {
    const entry = (await this.#read()).projects[projectId];
    if (!entry) throw new Error("Project not found");
    const state = { version: entry.events.length, latestMessage: null, decisions: [], tasks: [], contributions: [], document: null };
    for (const event of entry.events) {
      if (event.type === "message.created") state.latestMessage = event.payload.text;
      if (event.type === "decision.created") state.decisions.push(event.payload.statement);
      if (event.type === "task.created") state.tasks.push(event.payload);
      if (event.type === "contribution.created") state.contributions.push(event.payload);
      if (event.type === "document.revised") state.document = event.payload;
    }
    return state;
  }

  async getProject(projectId) {
    const entry = (await this.#read()).projects[projectId];
    if (!entry) throw new Error("Project not found");
    return entry.project;
  }

  async listProjects() { return Object.values((await this.#read()).projects).map(entry => entry.project); }
}
