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

BUILDING
  build <instruction>             Produce the next revision of the project document
  document                        Print the current document
  save [path]                     Write the document to disk (default: documents/<title>.md)
  work <objective>                Run one task with provider failover

FILES
  ls [folder]                     Browse the workspace
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
  --by <id>                       Which resident writes the conclusion or the split
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
  else if (argument === "--by") options.synthesisBy = options.dividedBy = argv[++index];
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
