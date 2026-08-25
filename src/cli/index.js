#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { CognitiveClient } from "./client.js";

const HELP = `
Northstar Cognitive Project CLI

  The CLI and the visual application operate on the same project. Anything you
  do here is visible there immediately, and the other way round.

CONVERSATION
  status                          Who is present, what they have heard, what is configured
  ask <text>                      Ask the project; the residents answer
  say <text>                      Record a message without asking anyone to answer
  decide <statement>              Record a canonical decision

WORKING SESSIONS
  meet <question>                 The residents answer, read each other, and conclude
  conclude [decision]             Accept the conclusion, or write your own
  divide <part> | <part> | ...    They argue for parts of the work and propose a split
  confirm-division                Approve the proposed split
  cost                            What a session costs in provider calls

REPOSITORY
  git                             Branch, what changed, recent commits
  branch <what you are doing>     Start work on its own branch
  diff                            What changed, ready to review
  commit <message>                Record the work
  discard [files]                 Throw the changes away

RUNNING
  run <command>                   Run a command in the workspace
  fix -- <command>                Run it; while it fails, the files it blames are rewritten
  fix <files> -- <command>        The same, but you say which files may change

BUILDING SOFTWARE
  create <what to build>          Plan the parts, write them all, run it, fix it until it passes

BUILDING
  build <instruction>             Produce the next revision of the project document
  document                        Print the current document
  make <path> <instruction>       Write one working file, straight to disk
  save [path]                     Write the document to disk (default: documents/<title>.md)
  work <objective>                Run one task with provider failover

DEDICATED AGENTS
  agents                          Who is in the room, and what the project has learned
  hire <id> <role> [| scope]      Add an agent that owns part of the project
  fire <id>                       Dismiss a dedicated agent

FILES
  ls [folder]                     Browse the workspace
  open <file>                     Print a file from the workspace
  attach <file>                   Put a file's content into the shared project
  put <file> <source>             Write a local file into the workspace

PROVIDERS
  providers                       Which intelligences are live and which are demo
  set-key <provider> <key> [model]  Configure a provider (gpt | claude | gemini)
  test <provider>                 Make one real call and report what happened
  forget <provider>               Remove a key and return that resident to demo

OPTIONS
  --topology <name>               solo | distributed | joint | composite (default: composite)
  --with <ids>                    Comma-separated residents, e.g. --with gpt,claude
  --by <id>                       Which resident writes the conclusion, split or fix
  --attempts <n>                  How many times a fix may retry (default 3, max 6)
  --verify <command>              What proves a created project works, if the plan names none
  --json                          Machine-readable output for scripts

  Set COGNITIVE_API_URL to reach a server on another port or host.
`;

/* --------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
const options = { topology: "composite", json: false, with: undefined };
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--json") options.json = true;
  else if (argument === "--topology") options.topology = argv[++index];
  else if (argument === "--with") options.with = argv[++index]?.split(",").map(item => item.trim()).filter(Boolean);
  else if (argument === "--verify") options.verify = argv[++index];
  else if (argument === "--name") options.name = argv[++index];
  else if (argument === "--staged") options.staged = true;
  else if (argument === "--yes") options.yes = true;
  else if (argument === "--attempts") options.attempts = Number(argv[++index]);
  else if (argument === "--by") options.by = options.synthesisBy = options.dividedBy = argv[++index];
  else positional.push(argument);
}
const [command = "status", ...rest] = positional;
const joined = rest.join(" ").trim();
const client = new CognitiveClient(process.env.COGNITIVE_API_URL);

/* ----------------------------------------------------------------- output */

const out = value => console.log(options.json ? JSON.stringify(value, null, 2) : value);
function requireText(value, what) {
  if (!value) throw new Error(`${what} is required. Run "npm run cli -- help" to see the usage.`);
  return value;
}
function printAnswer(result) {
  if (options.json) return out(result);
  for (const contribution of result.contributions ?? []) {
    console.log(`\n[${contribution.model ?? contribution.residentId}]\n${contribution.text}`);
  }
  for (const missing of result.unavailable ?? []) {
    console.log(`\n[${missing.model ?? missing.residentId}] could not answer — ${missing.error}`);
  }
  const answered = result.contributions?.length ?? 0;
  console.log(`\n${answered} ${answered === 1 ? "intelligence" : "intelligences"} contributed through ${result.topology} cognition.`);
}

const COMMANDS = {
  async status() {
    const value = await client.status();
    if (options.json) return out(value);
    console.log(`${value.project.name} · project version ${value.state.version}`);
    for (const resident of value.residents) {
      const mode = resident.live ? "live" : "demo";
      const state = resident.status === "paused" ? "not answering" : resident.status;
      console.log(`  ${resident.id.padEnd(8)} ${mode.padEnd(5)} ${state.padEnd(14)} heard through #${resident.cursor}`);
    }
    if (value.state.document) console.log(`\nDocument: ${value.state.document.title} (revision ${value.state.document.version})`);
    if (value.residents.every(resident => !resident.live)) {
      console.log(`\nEvery resident is on demo responses. Add a key with: npm run cli -- set-key claude <your-key>`);
    }
  },

  async ask() {
    const result = await client.chat(requireText(joined, "A question"), options.topology, options.with);
    printAnswer(result.result);
  },

  async say() {
    const value = await client.message(requireText(joined, "A message"));
    out(options.json ? value : `Recorded as canonical event #${value.event.sequence}`);
  },

  async decide() {
    const value = await client.decision(requireText(joined, "A statement"));
    out(options.json ? value : `Decision recorded as event #${value.event.sequence}`);
  },

  async meet() {
    const question = requireText(joined, "A question");
    const cost = await client.sessionCost();
    if (!options.json && cost.liveParticipants > 0) {
      console.log(`Running a session with ${cost.liveParticipants} live ${cost.liveParticipants === 1 ? "intelligence" : "intelligences"} \u00b7 about ${cost.deliberationCalls} provider calls\n`);
    }
    const { session } = await client.deliberate(question, options.with, options.synthesisBy);
    if (options.json) return out(session);

    console.log("PROPOSALS");
    for (const item of session.proposals) console.log(`\n[${item.model ?? item.residentId}]\n${item.text}`);

    if (session.critiques.length) {
      console.log("\n\nRESPONSES TO EACH OTHER");
      for (const item of session.critiques) console.log(`\n[${item.model ?? item.residentId}]\n${item.text}`);
    }
    for (const missing of session.unavailable) {
      console.log(`\n[${missing.model ?? missing.residentId}] could not take part \u2014 ${missing.error}`);
    }

    console.log(`\n\nCONCLUSION${session.synthesisBy ? ` (written by ${session.synthesisBy})` : ""}\n`);
    console.log(session.synthesis.conclusion || "(none)");
    if (session.synthesis.agreed.length) {
      console.log("\nAgreed:");
      for (const point of session.synthesis.agreed) console.log(`  \u00b7 ${point}`);
    }
    if (session.synthesis.unresolved.length) {
      console.log("\nStill unresolved \u2014 this is yours to settle:");
      for (const point of session.synthesis.unresolved) console.log(`  \u00b7 ${point.topic}${point.detail ? `: ${point.detail}` : ""}`);
    }
    console.log(`\nNothing is decided yet. Accept it with "conclude", or write your own with "conclude <your decision>".`);
  },

  async conclude() {
    const value = await client.resolve(joined || undefined);
    out(options.json ? value : `Decided: ${value.snapshot.state.decisions.at(-1)}`);
  },

  async divide() {
    const phases = joined.split("|").map(part => part.trim()).filter(Boolean);
    if (phases.length < 2) {
      throw new Error(`At least two parts are needed, separated by "|". Example: divide Architecture | Research | Launch`);
    }
    const { assignment } = await client.assign(phases, options.with, options.dividedBy);
    if (options.json) return out(assignment);

    console.log("WHAT EACH ONE ARGUED");
    for (const claim of assignment.claims) console.log(`\n[${claim.model ?? claim.residentId}]\n${claim.text}`);

    console.log(`\n\nPROPOSED DIVISION (by ${assignment.dividedBy})\n`);
    for (const item of assignment.assignments) {
      console.log(`  ${item.phase} -> ${item.residentId}${item.reason ? ` (${item.reason})` : ""}`);
    }
    if (assignment.unassigned.length) console.log(`\n  Nobody was given: ${assignment.unassigned.join(", ")}`);
    console.log(`\nApprove it with "confirm-division", or run divide again.`);
  },

  async "confirm-division"() {
    const value = await client.confirmAssignment();
    if (options.json) return out(value);
    for (const item of value.snapshot.state.assignment.assignments) {
      console.log(`  ${item.phase} -> ${item.residentId}`);
    }
    console.log("\nDivision confirmed. Every resident can see it.");
  },

  async cost() {
    const value = await client.sessionCost();
    if (options.json) return out(value);
    console.log(`Live intelligences: ${value.liveParticipants}`);
    console.log(`  meet    ${value.deliberationCalls} provider calls`);
    console.log(`  divide  ${value.assignmentCalls} provider calls`);
    if (!value.liveParticipants) console.log(`\nAll demo \u2014 a session costs nothing right now.`);
  },

  async build() {
    const value = await client.build(requireText(joined, "An instruction"), options.topology, options.with);
    if (options.json) return out(value);
    console.log(`\n${value.revision.markdown}\n`);
    console.log(`Revision ${value.revision.version} · built by ${value.revision.contributors.join(", ")}`);
    if (value.files.length) console.log(`Proposed files: ${value.files.map(file => file.path).join(", ")}`);
  },

  async git() {
    const value = await client.git();
    if (options.json) return out(value);
    if (!value.repository) {
      console.log(`${value.workspacePath} is not a git repository.`);
      console.log(`Run "git init" there to work in branches and commits.`);
      return;
    }
    console.log(`on ${value.branch}${value.clean ? " \u00b7 clean" : ""}`);
    for (const file of value.changed) console.log(`  ${file.status.padEnd(3)} ${file.path}`);
    if (value.branches.length > 1) console.log(`\nbranches: ${value.branches.join(", ")}`);
    if (value.recent.length) {
      console.log("\nrecent:");
      for (const entry of value.recent) console.log(`  ${entry.hash}  ${entry.subject}`);
    }
  },

  async branch() {
    const value = await client.branch(joined || undefined, options.name);
    out(options.json ? value : `${value.created ? "started" : "back on"} ${value.branch}`);
  },

  async diff() {
    const value = await client.diff(options.staged);
    if (options.json) return out(value);
    if (!value.summary) return console.log("nothing changed");
    console.log(value.patch || value.summary);
  },

  async commit() {
    const value = await client.commit(requireText(joined, "A commit message"));
    if (options.json) return out(value);
    console.log(value.committed ? `${value.hash}  ${value.subject}` : value.reason);
  },

  async discard() {
    const paths = rest.length ? rest : undefined;
    if (!options.yes && process.stdin.isTTY) {
      process.stdout.write(paths ? `Throw away changes to ${paths.join(", ")}? [y/N] ` : "Throw away every change? [y/N] ");
      const answer = await new Promise(resolve => {
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", value => resolve(value.trim().toLowerCase()));
      });
      process.stdin.pause();
      if (answer !== "y" && answer !== "yes") return console.log("Left them alone.");
    }
    const value = await client.discard(paths);
    out(options.json ? value : `put back: ${value.discarded.join(", ") || "nothing"}`);
  },

  async run() {
    const { result } = await client.runCommand(requireText(joined, "A command"));
    if (options.json) return out(result);
    if (result.stdout.trim()) console.log(result.stdout.trimEnd());
    if (result.stderr.trim()) console.error(result.stderr.trimEnd());
    if (result.failure) console.error(result.failure);
    console.log(result.ok
      ? `\npassed in ${Math.round(result.durationMs / 100) / 10}s`
      : `\nfailed: ${result.timedOut ? "it was still running at the time limit" : `exit code ${result.exitCode}`}`);
    if (!result.ok) process.exitCode = 1;
  },

  async fix() {
    const separator = rest.indexOf("--");
    const command = separator >= 0 ? rest.slice(separator + 1).join(" ") : joined;
    const paths = separator > 0 ? rest.slice(0, separator).filter(part => part !== "--") : [];
    requireText(command, "A command to run");

    const value = await client.fix(paths, command, options.attempts, options.by);
    if (options.json) return out(value);

    for (const attempt of value.attempts) {
      if (attempt.refused) console.log(`  attempt ${attempt.attempt}: the edit did not match the file — ${attempt.refused}`);
      else if (attempt.noEdits) console.log(`  attempt ${attempt.attempt}: ${value.by} proposed no edits, so it stopped`);
      else if (attempt.truncated) console.log(`  attempt ${attempt.attempt}: ${value.by} sent back only part of ${attempt.truncated.join(", ")}, so it was refused`);
      else if (attempt.unchanged) console.log(`  attempt ${attempt.attempt}: ${value.by} returned the files unchanged, so it stopped`);
      else if (attempt.noFilesFound) console.log(`  attempt ${attempt.attempt}: the failure named no file in this project — say which to change`);
      else if (attempt.failed) console.log(`  attempt ${attempt.attempt}: ${value.by} could not answer \u2014 ${attempt.failed}`);
      else console.log(`  attempt ${attempt.attempt}: changed ${attempt.changed.join(", ")} \u2014 ${attempt.ok ? "passed" : `still failing (exit ${attempt.exitCode})`}`);
    }

    if (value.fixed) {
      const touched = [...new Set(value.attempts.flatMap(attempt => attempt.changed ?? []))];
      console.log(`\n"${command}" passes now${touched.length ? `, after changing ${touched.join(", ")}` : ""}.`);
    } else {
      console.log(`\nStill failing after ${value.attempts.length} ${value.attempts.length === 1 ? "attempt" : "attempts"}.`);
      if (value.reverted.length) console.log(`Put back as they were: ${value.reverted.join(", ")}`);
      console.log(`\n${(value.result.stderr || value.result.stdout || value.result.failure || "").trim().slice(-1200)}`);
      process.exitCode = 1;
    }
  },

  // The whole point: not a file, a working system. Plan, write every part so
  // they agree with each other, run the command that proves it, and repair until
  // it passes — because a build nobody ran is not a build that works.
  async create() {
    const description = requireText(joined, "A description of what to build");

    console.log("Planning the parts…");
    const value = await client.project(description, options.by);
    if (options.json) return out(value);

    console.log(`\n${value.plan.files.length} files planned:`);
    for (const file of value.plan.files) console.log(`  ${file.path.padEnd(34)} ${file.purpose}`);
    if (value.plan.notes) console.log(`\nWhat they must agree on:\n${value.plan.notes.split("\n").map(line => `  ${line}`).join("\n")}`);

    console.log(`\nWritten:`);
    for (const file of value.written) console.log(`  ${file.path.padEnd(34)} ${file.size} bytes`);
    for (const failure of value.failed) console.log(`  ${failure.path.padEnd(34)} failed — ${failure.error}`);

    const command = options.verify ?? value.plan.verify;
    if (!command) {
      console.log(`\nNothing to run: the plan named no command that proves it works.`);
      console.log(`Give one with --verify "<command>" to have it checked and repaired.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\nRunning "${command}"…`);
    const repaired = await client.fix([], command, options.attempts, options.by);
    for (const attempt of repaired.attempts) {
      if (attempt.refused) console.log(`  attempt ${attempt.attempt}: the edit did not match — ${attempt.refused}`);
      else if (attempt.noEdits) console.log(`  attempt ${attempt.attempt}: no edits proposed, so it stopped`);
      else if (attempt.noFilesFound) console.log(`  attempt ${attempt.attempt}: the failure named no file in this project`);
      else if (attempt.unchanged) console.log(`  attempt ${attempt.attempt}: nothing changed, so it stopped`);
      else console.log(`  attempt ${attempt.attempt}: changed ${(attempt.changed ?? []).join(", ")} \u2014 ${attempt.ok ? "passed" : "still failing"}`);
    }

    if (repaired.fixed) {
      console.log(`\nIt works. "${command}" passes.`);
    } else {
      console.log(`\nIt does not work yet. "${command}" still fails:\n`);
      console.log((repaired.result.stderr || repaired.result.stdout || repaired.result.failure || "").trim().slice(-1200));
      console.log(`\nThe files are on disk to look at. Run "fix -- ${command}" to try again.`);
      process.exitCode = 1;
    }
  },

  async make() {
    const [path, ...instruction] = rest;
    requireText(path, "A file path");
    requireText(instruction.join(" "), "An instruction");
    const value = await client.generate(path, instruction.join(" "), options.by);
    out(options.json ? value : `${value.file.path} written by ${value.by} (${value.file.size} bytes)${value.file.replaced ? " — replaced the previous version" : ""}`);
  },

  async document() {
    const { state } = await client.status();
    if (!state.document) throw new Error(`No document yet. Create one with: npm run cli -- build "<instruction>"`);
    out(options.json ? state.document : state.document.markdown);
  },

  async save() {
    const { state } = await client.status();
    if (!state.document) throw new Error(`No document to save yet. Create one with: npm run cli -- build "<instruction>"`);
    const slug = state.document.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-");
    const path = joined || `documents/${slug || "project-document"}.md`;
    const value = await saveWithConfirmation(path, state.document.markdown);
    if (value) out(options.json ? value : `Saved ${value.file.path} (${value.file.size} bytes)`);
  },

  async work() {
    const value = await client.work(requireText(joined, "An objective"));
    if (options.json) return out(value);
    console.log(`\n${value.result.output.text}\n`);
    console.log(`Answered by ${value.result.residentId}${value.result.takeover ? " after taking over from an unavailable resident" : ""}.`);
  },

  async ls() {
    const listing = await client.files(joined || ".");
    if (options.json) return out(listing);
    console.log(listing.path && listing.path !== "." ? `workspace/${listing.path}` : "workspace");
    if (!listing.items.length) console.log("  (empty)");
    for (const item of listing.items) {
      console.log(`  ${item.directory ? "/" : " "} ${item.name}${item.directory ? "" : `  ${item.size} bytes`}`);
    }
  },

  async agents() {
    const value = await client.agents();
    if (options.json) return out(value);
    console.log("DEDICATED AGENTS");
    if (!value.agents.length) console.log("  (none — hire one with: hire reviewer \"Code reviewer\" | src/core)");
    for (const agent of value.agents) {
      console.log(`  ${agent.id.padEnd(14)} ${agent.role}${agent.scope ? ` \u00b7 owns ${agent.scope}` : ""} \u00b7 on ${agent.backedBy}`);
    }
    console.log("\nWHAT THIS PROJECT HAS LEARNED");
    if (!value.skills.length) console.log("  (nothing yet — it learns from decisions you confirm)");
    for (const skill of value.skills.slice(0, 10)) console.log(`  \u00b7 ${skill.name}\n      ${skill.approach}`);
  },

  async hire() {
    const [id, ...restOfIt] = rest;
    requireText(id, "An agent id");
    const [role, scope] = restOfIt.join(" ").split("|").map(part => part.trim());
    requireText(role, "A role");
    const { agent } = await client.hire({ id, role, scope, backedBy: options.by });
    out(options.json ? agent : `${agent.id} joined the project as ${agent.role}${agent.scope ? `, owning ${agent.scope}` : ""}.`);
  },

  async fire() {
    const id = requireText(rest[0], "An agent id");
    await client.dismiss(id);
    out(options.json ? { id } : `${id} left the project. Everything it contributed stays in the log.`);
  },

  async open() {
    const file = await client.open(requireText(joined, "A file path"));
    out(options.json ? file : file.content);
  },

  async attach() {
    const value = await client.attach(requireText(joined, "A file path"));
    out(options.json ? value : `${value.file.path} added to the project as event #${value.event.sequence}. Every resident can see it.`);
  },

  async put() {
    const [target, source] = rest;
    requireText(target, "A destination path");
    requireText(source, "A source file");
    const value = await saveWithConfirmation(target, await readFile(source, "utf8"));
    if (value) out(options.json ? value : `Wrote ${value.file.path} (${value.file.size} bytes)`);
  },

  async providers() {
    const settings = await client.settings();
    if (options.json) return out(settings);
    console.log(`Configuration file: ${settings.envPath}`);
    for (const provider of settings.providers) {
      console.log(`  ${provider.id.padEnd(8)} ${(provider.configured ? "live" : "demo").padEnd(5)} ${provider.model.padEnd(22)} ${provider.configured ? provider.keyHint : provider.keysUrl}`);
    }
  },

  async "set-key"() {
    const [provider, apiKey, model] = rest;
    requireText(provider, "A provider (gpt, claude or gemini)");
    requireText(apiKey, "An API key");
    await client.configure(provider, { apiKey, model });
    console.log(`${provider} configured. Confirming it works…`);
    await COMMANDS.test.call(null, provider);
  },

  async test(explicitProvider) {
    const provider = explicitProvider ?? requireText(rest[0], "A provider (gpt, claude or gemini)");
    const result = await client.testProvider(provider);
    if (options.json) return out(result);
    if (result.ok) console.log(`${provider} is working. ${result.model} replied: ${result.reply}`);
    else {
      console.log(`${provider} is not working: ${result.error}`);
      process.exitCode = 1;
    }
  },

  async forget() {
    const provider = requireText(rest[0], "A provider (gpt, claude or gemini)");
    await client.forget(provider);
    out(options.json ? { provider, configured: false } : `${provider} returned to demo mode. Its key was removed from the configuration file.`);
  },

  help() { console.log(HELP); }
};

// Overwriting is the only irreversible thing the CLI does, so it asks unless
// the answer is already unambiguous.
async function saveWithConfirmation(path, content) {
  try {
    return await client.write(path, content);
  } catch (error) {
    if (error.status !== 409) throw error;
    if (!process.stdin.isTTY) {
      throw new Error(`${path} already exists. Re-run with a different path, or delete it first.`);
    }
    process.stdout.write(`${path} already exists. Replace it? [y/N] `);
    const answer = await new Promise(resolve => {
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", value => resolve(value.trim().toLowerCase()));
    });
    process.stdin.pause();
    if (answer !== "y" && answer !== "yes") {
      console.log("Left the existing file alone.");
      return null;
    }
    return client.write(path, content, true);
  }
}

try {
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Northstar CLI: unknown command "${command}".`);
    console.log(HELP);
    process.exitCode = 1;
  } else {
    await run();
  }
} catch (error) {
  console.error(`Northstar CLI: ${error.message}`);
  process.exitCode = 1;
}
