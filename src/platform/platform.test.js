import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformServer } from "./server.js";

async function serving(run) {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-api-"));
  const workspacePath = join(directory, "workspace");
  await mkdir(join(workspacePath, "notes"), { recursive: true });
  await writeFile(join(workspacePath, "notes", "brief.md"), "# The brief\n\nShip it in English first.", "utf8");
  await writeFile(join(directory, "outside-secret.txt"), "must never be readable", "utf8");

  // Hermetic: an API key in the developer's shell must never turn a resident
  // live mid-test and start making real network calls.
  const app = await createPlatformServer({
    dataPath: join(directory, "brain.jsonl"), port: 0, workspacePath,
    envPath: join(directory, ".env"), processEnv: {}
  });
  await app.start();
  try {
    await run(`http://127.0.0.1:${app.port}`, { app, directory, workspacePath });
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

const postJson = (url, data) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data)
});

test("API, mesh, and project brain expose one shared project state", async () => {
  await serving(async base => {
    const interfaceHtml = await fetch(base).then(response => response.text());
    assert.match(interfaceHtml, /Resident intelligences/);
    assert.match(interfaceHtml, /data-view="artifacts"/);

    const initial = await fetch(`${base}/api/snapshot`).then(response => response.json());
    assert.equal(initial.residents.length, 3);
    assert.ok(initial.residents.every(resident => resident.cursor === initial.state.version));

    const message = await postJson(`${base}/api/messages`, { text: "Keep every intelligence aware of this decision." });
    assert.equal(message.status, 201);
    const updated = await fetch(`${base}/api/snapshot`).then(response => response.json());
    assert.equal(updated.state.latestMessage, "Keep every intelligence aware of this decision.");
    assert.ok(updated.residents.every(resident => resident.cursor === updated.state.version));

    const collective = await postJson(`${base}/api/collaborate`, {
      topology: "composite", objective: "Create a launch thesis", residentIds: ["gpt", "claude", "gemini"]
    }).then(response => response.json());
    assert.equal(collective.contributions.length, 3);
    assert.match(collective.synthesis, /launch thesis/i);
  });
});

test("The snapshot reports the environment the Settings view shows", async () => {
  await serving(async (base, { workspacePath }) => {
    const snapshot = await fetch(`${base}/api/snapshot`).then(response => response.json());
    assert.equal(snapshot.environment.workspacePath, workspacePath);
    assert.ok(snapshot.residents.every(resident => resident.live === false), "demo mode by default");
    assert.ok(snapshot.settings.providers.every(provider => provider.configured === false));
    assert.equal(snapshot.settings.liveResidency, false, "live residency must never default on");
  });
});

test("One chat turn records the question and answers it", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/chat`, { text: "What should we build first?", topology: "composite" });
    assert.equal(response.status, 201);
    const { result, snapshot } = await response.json();

    assert.equal(result.contributions.length, 3);
    assert.match(result.synthesis, /What should we build first\?/);
    assert.equal(snapshot.state.latestMessage, "What should we build first?");
    assert.ok(snapshot.residents.every(resident => resident.cursor === snapshot.state.version),
      "every resident heard the whole turn");
  });
});

test("A solo chat turn is answered by one intelligence", async () => {
  await serving(async base => {
    const { result } = await postJson(`${base}/api/chat`, { text: "Answer alone", topology: "solo" })
      .then(response => response.json());
    assert.equal(result.contributions.length, 1);
  });
});

test("An empty chat message is refused", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/chat`, { text: "   " });
    assert.equal(response.status, 400);
  });
});

test("Work routed through continuity produces a traceable contribution", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/work`, { objective: "Draft the opening section" });
    assert.equal(response.status, 201);
    const { result, snapshot } = await response.json();
    assert.equal(result.takeover, false, "no provider failed, so nobody had to take over");
    assert.ok(result.residentId, "the contribution names which intelligence produced it");
    const recorded = snapshot.state.contributions.at(-1);
    assert.match(recorded.text, /Draft the opening section/);
    assert.equal(recorded.takeover, false);
  });
});

test("Browsing the workspace lists folders and files", async () => {
  await serving(async base => {
    const root = await fetch(`${base}/api/files`).then(response => response.json());
    assert.deepEqual(root.items.map(item => item.name), ["notes"]);

    const notes = await fetch(`${base}/api/files?path=notes`).then(response => response.json());
    assert.deepEqual(notes.items.map(item => item.path), ["notes/brief.md"]);
    assert.equal(notes.items[0].directory, false);
  });
});

test("Attaching a file puts its content into the shared project brain", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/files/attach`, { path: "notes/brief.md" });
    assert.equal(response.status, 201);
    const { event, file, snapshot } = await response.json();

    assert.equal(event.type, "file.attached");
    assert.equal(file.path, "notes/brief.md");
    assert.match(event.payload.content, /Ship it in English first\./);
    assert.ok(snapshot.residents.every(resident => resident.cursor === snapshot.state.version),
      "every resident saw the attachment");
  });
});

test("The workspace refuses to serve anything outside its root", async () => {
  await serving(async base => {
    for (const attempt of ["../outside-secret.txt", "notes/../../outside-secret.txt"]) {
      const listing = await fetch(`${base}/api/files?path=${encodeURIComponent(attempt)}`);
      assert.equal(listing.status, 403, `listing ${attempt}`);

      const attach = await postJson(`${base}/api/files/attach`, { path: attempt });
      assert.equal(attach.status, 403, `attaching ${attempt}`);
      const body = await attach.json();
      assert.doesNotMatch(JSON.stringify(body), /must never be readable/, "content must never leak");
    }
  });
});

test("Attaching a file that does not exist reports it clearly", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/files/attach`, { path: "notes/nope.md" });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /No such file/);
  });
});

test("Settings never expose a stored API key", async () => {
  await serving(async base => {
    const secret = "sk-test-SUPERSECRETVALUE-9999";
    await postJson(`${base}/api/settings/providers`, { provider: "claude", apiKey: secret, model: "claude-opus-5" });

    for (const url of [`${base}/api/settings`, `${base}/api/snapshot`]) {
      const raw = await fetch(url).then(response => response.text());
      assert.doesNotMatch(raw, /SUPERSECRETVALUE/, `${url} must never carry the key`);
    }

    const described = await fetch(`${base}/api/settings`).then(response => response.json());
    const claude = described.providers.find(provider => provider.id === "claude");
    assert.equal(claude.configured, true);
    assert.equal(claude.model, "claude-opus-5");
    assert.match(claude.keyHint, /^sk-…9999$/, "only a recognisable hint is shown");
  });
});

test("Saving a key puts that resident on its real provider and persists to .env", async () => {
  await serving(async (base, { directory }) => {
    const { snapshot } = await postJson(`${base}/api/settings/providers`, { provider: "gpt", apiKey: "sk-live", model: "gpt-4o" })
      .then(response => response.json());

    const gpt = snapshot.residents.find(resident => resident.id === "gpt");
    assert.equal(gpt.live, true, "the resident switched to its real provider");
    assert.equal(gpt.model, "gpt-4o");
    assert.ok(snapshot.residents.filter(resident => resident.id !== "gpt").every(resident => resident.live === false));

    const envText = await readFile(join(directory, "workspace", "..", ".env"), "utf8").catch(() => "");
    assert.match(envText, /OPENAI_API_KEY=sk-live/, "the key is written to .env so it survives a restart");
  });
});

test("Removing a key returns that resident to demo mode", async () => {
  await serving(async base => {
    await postJson(`${base}/api/settings/providers`, { provider: "gemini", apiKey: "key" });
    const removal = await fetch(`${base}/api/settings/providers`, {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "gemini" })
    }).then(response => response.json());

    assert.equal(removal.settings.providers.find(provider => provider.id === "gemini").configured, false);
    assert.equal(removal.snapshot.residents.find(resident => resident.id === "gemini").live, false);
  });
});

test("Testing a provider with no key reports that instead of pretending", async () => {
  await serving(async base => {
    const result = await postJson(`${base}/api/settings/test`, { provider: "claude" }).then(response => response.json());
    assert.equal(result.ok, false);
    assert.match(result.error, /No API key/);
  });
});

test("A build produces a document revision that lands in the project state", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/build`, { instruction: "Draft the launch plan" });
    assert.equal(response.status, 201);
    const { revision, snapshot } = await response.json();

    assert.equal(revision.version, 1);
    assert.ok(revision.markdown.length > 0, "a build must produce something");
    assert.deepEqual(revision.contributors, ["gpt", "claude", "gemini"]);
    assert.equal(snapshot.state.document.version, 1, "the document is part of the shared brain");
  });
});

test("Building again revises the same document rather than starting over", async () => {
  await serving(async base => {
    await postJson(`${base}/api/build`, { instruction: "Draft the launch plan" });
    const { revision } = await postJson(`${base}/api/build`, { instruction: "Add a risks section" })
      .then(response => response.json());
    assert.equal(revision.version, 2);
  });
});

test("An empty build instruction is refused", async () => {
  await serving(async base => {
    assert.equal((await postJson(`${base}/api/build`, { instruction: "  " })).status, 400);
  });
});

test("Writing a file puts it on disk and records it in the project", async () => {
  await serving(async (base, { workspacePath }) => {
    const response = await postJson(`${base}/api/files/write`, { path: "build/plan.md", content: "# The plan\n" });
    assert.equal(response.status, 201);

    const onDisk = await readFile(join(workspacePath, "build", "plan.md"), "utf8");
    assert.equal(onDisk, "# The plan\n", "the file really exists outside the app");

    const { snapshot } = await response.json();
    assert.ok(snapshot.events.some(event => event.type === "file.written"));
  });
});

test("Writing over an existing file asks first", async () => {
  await serving(async base => {
    await postJson(`${base}/api/files/write`, { path: "notes/plan.md", content: "original" });
    const conflict = await postJson(`${base}/api/files/write`, { path: "notes/plan.md", content: "replacement" });
    assert.equal(conflict.status, 409, "silent overwrite would destroy someone's work");

    const forced = await postJson(`${base}/api/files/write`, { path: "notes/plan.md", content: "replacement", overwrite: true });
    assert.equal(forced.status, 201);
  });
});

test("Writing outside the workspace is refused over HTTP too", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/files/write`, { path: "../escaped.txt", content: "nope" });
    assert.equal(response.status, 403);
  });
});

// The demo path is the one every first-time visitor takes. If a build there
// returns the engineered prompt instead of a document, the product looks broken
// to exactly the audience it is trying to win.
test("A build in demo mode produces a readable document, not the internal prompt", async () => {
  await serving(async base => {
    const { revision } = await postJson(`${base}/api/build`, { instruction: "Plan a shopping list app" })
      .then(response => response.json());

    assert.doesNotMatch(revision.markdown, /You are a resident intelligence/,
      "the engineered prompt must never surface as the document");
    assert.doesNotMatch(revision.markdown, /INSTRUCTION\n/,
      "nor its section markers");
    assert.match(revision.markdown, /^# /, "it is a real markdown document");
    assert.match(revision.markdown, /demo output/i, "and it says plainly that no model wrote it");
    assert.match(revision.markdown, /Plan a shopping list app/, "while reflecting what was asked");
  });
});

test("A demo build on top of an existing document keeps building on it", async () => {
  await serving(async base => {
    await postJson(`${base}/api/build`, { instruction: "Plan a shopping list app" });
    const { revision } = await postJson(`${base}/api/build`, { instruction: "Add offline support" })
      .then(response => response.json());
    assert.equal(revision.version, 2);
    assert.match(revision.markdown, /Carried over/);
  });
});

test("A deliberation runs its rounds and comes back as a proposal, not a decision", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/deliberate`, { question: "Local or cloud storage?" });
    assert.equal(response.status, 201);
    const { session, snapshot } = await response.json();

    assert.equal(session.proposals.length, 3, "everyone proposes");
    assert.equal(session.critiques.length, 3, "and everyone answers the others");
    assert.equal(session.status, "proposed");
    assert.ok(session.synthesisBy, "someone wrote the conclusion");
    assert.deepEqual(snapshot.state.decisions, [],
      "a session must never decide anything on its own");
    assert.equal(snapshot.state.session.question, "Local or cloud storage?");
  });
});

test("A deliberation with one resident skips the round of answering itself", async () => {
  await serving(async base => {
    const { session } = await postJson(`${base}/api/deliberate`, { question: "q", residentIds: ["gpt"] })
      .then(response => response.json());
    assert.equal(session.proposals.length, 1);
    assert.deepEqual(session.critiques, [], "there is nobody to respond to");
  });
});

test("Accepting the conclusion turns it into the project's decision", async () => {
  await serving(async base => {
    await postJson(`${base}/api/deliberate`, { question: "Local or cloud?" });
    const { snapshot } = await postJson(`${base}/api/deliberate/resolve`, {}).then(response => response.json());

    assert.equal(snapshot.state.decisions.length, 1);
    assert.equal(snapshot.state.session, null, "the session closes once it is settled");
  });
});

// The point of the design: the residents advise, the person rules.
test("A person can overrule the conclusion and record their own decision", async () => {
  await serving(async base => {
    await postJson(`${base}/api/deliberate`, { question: "Subscription or one-off?" });
    const { snapshot } = await postJson(`${base}/api/deliberate/resolve`, { decision: "One-off. No recurring billing." })
      .then(response => response.json());

    assert.deepEqual(snapshot.state.decisions, ["One-off. No recurring billing."]);
    const recorded = snapshot.events.find(event => event.type === "decision.created");
    assert.equal(recorded.payload.question, "Subscription or one-off?", "the decision remembers what it settled");
  });
});

test("Resolving with no open session is refused", async () => {
  await serving(async base => {
    assert.equal((await postJson(`${base}/api/deliberate/resolve`, { decision: "x" })).status, 400);
  });
});

test("An empty deliberation question is refused", async () => {
  await serving(async base => {
    assert.equal((await postJson(`${base}/api/deliberate`, { question: "  " })).status, 400);
  });
});

test("The residents argue for parts of the work and a split is proposed", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/assign`, { phases: ["Architecture", "Research", "Launch"] });
    assert.equal(response.status, 201);
    const { assignment, snapshot } = await response.json();

    assert.equal(assignment.claims.length, 3, "each resident makes its case");
    assert.equal(assignment.status, "proposed");
    assert.equal(snapshot.state.assignment.status, "proposed",
      "a proposed split is not yet what the project believes");
  });
});

test("Dividing fewer than two parts is refused", async () => {
  await serving(async base => {
    assert.equal((await postJson(`${base}/api/assign`, { phases: ["Only one"] })).status, 400);
  });
});

test("Confirming a division is what makes it the project's", async () => {
  await serving(async base => {
    await postJson(`${base}/api/assign`, { phases: ["Architecture", "Research"] });
    const { snapshot } = await postJson(`${base}/api/assign/confirm`, {}).then(response => response.json());
    assert.equal(snapshot.state.assignment.status, "confirmed");
    assert.ok(snapshot.state.assignment.assignments.length > 0);
  });
});

test("A person can edit the split before confirming it", async () => {
  await serving(async base => {
    await postJson(`${base}/api/assign`, { phases: ["Architecture", "Research"] });
    const { snapshot } = await postJson(`${base}/api/assign/confirm`, {
      assignments: [{ phase: "Architecture", residentId: "claude" }, { phase: "Research", residentId: "gemini" }]
    }).then(response => response.json());

    assert.deepEqual(snapshot.state.assignment.assignments.map(item => item.residentId), ["claude", "gemini"]);
  });
});

test("A division naming an unknown resident is refused", async () => {
  await serving(async base => {
    await postJson(`${base}/api/assign`, { phases: ["Architecture", "Research"] });
    const response = await postJson(`${base}/api/assign/confirm`, {
      assignments: [{ phase: "Architecture", residentId: "llama" }]
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /No such resident: llama/);
  });
});

// Cost is visible before anyone spends it.
test("The cost of a session is reported before running one", async () => {
  await serving(async base => {
    const cost = await fetch(`${base}/api/session/cost`).then(response => response.json());
    assert.equal(cost.liveParticipants, 0, "nothing is live in a hermetic test");
    assert.equal(cost.deliberationCalls, 1);
  });
});

test("A dedicated agent joins the room and answers from its speciality", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/agents`, {
      id: "reviewer", role: "Code reviewer", scope: "src/core", backedBy: "claude"
    });
    assert.equal(response.status, 201);
    const { snapshot } = await response.json();

    const agent = snapshot.residents.find(resident => resident.id === "reviewer");
    assert.ok(agent, "it is a resident like any other");
    assert.match(agent.model, /Code reviewer/);
    assert.equal(agent.cursor, snapshot.state.version, "and it arrives caught up");
  });
});

test("An agent id that is taken or malformed is refused", async () => {
  await serving(async base => {
    assert.equal((await postJson(`${base}/api/agents`, { id: "gpt", role: "r" })).status, 400);
    assert.equal((await postJson(`${base}/api/agents`, { id: "Has Space", role: "r" })).status, 400);
    assert.equal((await postJson(`${base}/api/agents`, { id: "ok", role: "" })).status, 400);
  });
});

// Agents a person created must not evaporate with the process.
test("Dedicated agents come back after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-agents-"));
  const config = {
    dataPath: join(directory, "brain.jsonl"), port: 0, workspacePath: directory,
    envPath: join(directory, ".env"), processEnv: {}
  };
  try {
    const first = await createPlatformServer(config);
    await first.start();
    await postJson(`http://127.0.0.1:${first.port}/api/agents`, { id: "frontend", role: "Frontend engineer", scope: "src/web" });
    await first.stop();

    const second = await createPlatformServer(config);
    await second.start();
    const snapshot = await fetch(`http://127.0.0.1:${second.port}/api/snapshot`).then(response => response.json());
    await second.stop();

    assert.ok(snapshot.residents.some(resident => resident.id === "frontend"));
    assert.deepEqual(snapshot.agents.map(agent => agent.id), ["frontend"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("A dismissed agent leaves, and what it contributed stays", async () => {
  await serving(async base => {
    await postJson(`${base}/api/agents`, { id: "reviewer", role: "Code reviewer" });
    await postJson(`${base}/api/chat`, { text: "hello", topology: "solo", residentIds: ["reviewer"] });

    const removal = await fetch(`${base}/api/agents`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "reviewer" })
    });
    assert.equal(removal.status, 200);
    const { snapshot } = await removal.json();

    assert.ok(!snapshot.residents.some(resident => resident.id === "reviewer"));
    assert.ok(snapshot.events.some(event => event.actorId === "reviewer"),
      "the history it took part in is not erased");
  });
});

test("Dismissing an agent that is not there says so", async () => {
  await serving(async base => {
    const response = await fetch(`${base}/api/agents`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nobody" })
    });
    assert.equal(response.status, 404);
  });
});

// The project learns from what a person confirmed, never from raw output.
test("A confirmed decision becomes something the project knows", async () => {
  await serving(async base => {
    let { skills } = await fetch(`${base}/api/agents`).then(response => response.json());
    assert.deepEqual(skills, [], "nothing is known before anything is settled");

    await postJson(`${base}/api/deliberate`, { question: "Where do we store data?" });
    await postJson(`${base}/api/deliberate/resolve`, { decision: "On the device, exported to JSON." });

    ({ skills } = await fetch(`${base}/api/agents`).then(response => response.json()));
    assert.equal(skills.length, 1);
    assert.match(skills[0].name, /Where do we store data\?/);
    assert.match(skills[0].approach, /On the device/);
  });
});

test("Opening a file returns its content and when it last changed", async () => {
  await serving(async base => {
    const file = await fetch(`${base}/api/files/content?path=notes/brief.md`).then(response => response.json());
    assert.match(file.content, /Ship it in English first\./);
    assert.ok(file.modifiedAt > 0, "an editor needs to know this to detect a clash");
  });
});

test("Opening a file outside the workspace is refused", async () => {
  await serving(async base => {
    const response = await fetch(`${base}/api/files/content?path=${encodeURIComponent("../outside-secret.txt")}`);
    assert.equal(response.status, 403);
  });
});

// Two editors on one file: the second save must not erase the first silently.
test("Saving an edit over someone else's change is stopped", async () => {
  await serving(async base => {
    const opened = await fetch(`${base}/api/files/content?path=notes/brief.md`).then(response => response.json());
    await postJson(`${base}/api/files/write`, { path: "notes/brief.md", content: "changed elsewhere", overwrite: true });
    await new Promise(resolve => setTimeout(resolve, 20));

    const stale = await postJson(`${base}/api/files/write`, {
      path: "notes/brief.md", content: "my edit", overwrite: true, expectedModifiedAt: opened.modifiedAt
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).staleEdit, true);

    const current = await fetch(`${base}/api/files/content?path=notes/brief.md`).then(response => response.json());
    assert.equal(current.content, "changed elsewhere", "the other edit survives");
  });
});

test("Saving an edit nobody touched goes through", async () => {
  await serving(async base => {
    const opened = await fetch(`${base}/api/files/content?path=notes/brief.md`).then(response => response.json());
    const saved = await postJson(`${base}/api/files/write`, {
      path: "notes/brief.md", content: "my edit", overwrite: true, expectedModifiedAt: opened.modifiedAt
    });
    assert.equal(saved.status, 201);
  });
});

test("A command runs in the workspace and its result is recorded", async () => {
  await serving(async base => {
    const { result, snapshot } = await postJson(`${base}/api/run`, { command: 'node -e "console.log(7)"' })
      .then(response => response.json());
    assert.equal(result.ok, true);
    assert.match(result.stdout, /7/);
    assert.ok(snapshot.events.some(event => event.type === "command.run"));
  });
});

test("A failing command reports its exit code rather than an error", async () => {
  await serving(async base => {
    const response = await postJson(`${base}/api/run`, { command: 'node -e "process.exit(4)"' });
    assert.equal(response.status, 200, "a failed command is an answer, not a server error");
    assert.equal((await response.json()).result.exitCode, 4);
  });
});

// The allowlist is the boundary. A model can rewrite a file and read an error;
// it can never choose what executes.
test("A command outside the allowed list is refused", async () => {
  await serving(async base => {
    for (const command of ["curl https://example.com", "./npm test", "/bin/sh"]) {
      const response = await postJson(`${base}/api/run`, { command });
      assert.equal(response.status, 400, command);
    }
  });
});

test("Nothing after a semicolon runs", async () => {
  await serving(async base => {
    const { result } = await postJson(`${base}/api/run`, {
      command: 'node -e "0" ; node -e "console.log(\'ESCAPED\')"'
    }).then(response => response.json());
    assert.doesNotMatch(result.stdout, /ESCAPED/);
  });
});

test("A fix needs a command to run", async () => {
  await serving(async base => {
    assert.equal((await postJson(`${base}/api/fix`, { paths: ["a.js"] })).status, 400);
    assert.equal((await postJson(`${base}/api/fix`, { command: "  " })).status, 400);
  });
});

// At scale the person does not know which file is at fault — the failure does.
test("A fix works out which files to change from the failure itself", async () => {
  await serving(async (base, { workspacePath }) => {
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "src", "total.js"), "throw new Error('boom');\n", "utf8");

    const value = await postJson(`${base}/api/fix`, { command: "node src/total.js", attempts: 1 })
      .then(response => response.json());

    assert.ok(value.attempts.length > 0, "it found something to work on without being told");
    assert.ok(!value.attempts[0].noFilesFound, "the stack trace named the file");
  });
});

test("A failure naming no project file says so instead of guessing", async () => {
  await serving(async base => {
    const value = await postJson(`${base}/api/fix`, { command: 'node -e "process.exit(1)"', attempts: 2 })
      .then(response => response.json());
    assert.equal(value.fixed, false);
    assert.equal(value.attempts[0].noFilesFound, true);
  });
});

// The property that makes repair safe on a real project: a run that ends still
// failing must leave every file exactly as it was found.
test("Files are put back when the fix does not work", async () => {
  await serving(async (base, { workspacePath }) => {
    const before = "throw new Error('boom');\n";
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "src", "broken.js"), before, "utf8");

    const value = await postJson(`${base}/api/fix`, {
      paths: ["src/broken.js"], command: "node src/broken.js", attempts: 2
    }).then(response => response.json());

    assert.equal(value.fixed, false);
    assert.equal(await readFile(join(workspacePath, "src", "broken.js"), "utf8"), before,
      "a failed repair leaves nothing half-rewritten");
  });
});

test("A fix that already passes changes nothing", async () => {
  await serving(async (base, { workspacePath }) => {
    await writeFile(join(workspacePath, "fine.js"), "process.exit(0);\n", "utf8");
    const value = await postJson(`${base}/api/fix`, { paths: ["fine.js"], command: "node fine.js" })
      .then(response => response.json());

    assert.equal(value.fixed, true);
    assert.deepEqual(value.attempts, [], "nothing was rewritten");
    assert.equal(await readFile(join(workspacePath, "fine.js"), "utf8"), "process.exit(0);\n");
  });
});

// Found by repairing this project's own code: one rewrite introduced a syntax
// error, and the next attempt debugged that instead of the real bug. Attempts
// are independent tries at the same problem, never a chain.
test("A rewrite that makes things worse does not poison the next attempt", async () => {
  await serving(async (base, { workspacePath }) => {
    const original = "process.exit(1);\n";
    await writeFile(join(workspacePath, "target.js"), original, "utf8");

    const value = await postJson(`${base}/api/fix`, {
      paths: ["target.js"], command: "node target.js", attempts: 3
    }).then(response => response.json());

    assert.equal(value.fixed, false);
    assert.equal(await readFile(join(workspacePath, "target.js"), "utf8"), original,
      "the file it started from is the file it ends with");
  });
});
