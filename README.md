# Northstar Cognitive Project Platform

[![Test](https://github.com/allinerosamkup-ai/northstar-cognitive-platform/actions/workflows/test.yml/badge.svg)](https://github.com/allinerosamkup-ai/northstar-cognitive-platform/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![How the shared project log works](docs/mesh.svg)

**Northstar is a local development environment where several AI models work on
one codebase together.** You install it, add your own API keys, and they build,
run and repair real software — sharing a single project memory rather than each
holding a private conversation you have to reconcile by hand.

The problem it exists to solve: **two models writing into the same project
overwrite each other's work.** Give GPT and Claude a shared task and you get
lost edits, contradictory decisions, and a model confidently building on a state
that changed three turns ago. The usual workaround is you — copy-pasting context
between tabs, being the integration layer.

Underneath is one canonical, append-only event log that every model reads from
and writes to, with **cursor-based staleness protection**: each resident tracks
how far into the log it has actually seen, and the mesh refuses any contribution
from a resident whose cursor is behind. A model cannot write over something it
never read.

```js
// src/core/cognitive-mesh.js — the guarantee, in full
async contribute(projectId, residentId, payload) {
  return this.#withLock(projectId, async () => {          // serialized per project
    const resident = this.resident(projectId, residentId);
    const state = await this.brain.getState(projectId);
    if (resident.cursor !== state.version) throw new Error("Resident is stale");
    return this.publish(projectId, { type: "contribution.created", actorId: residentId, payload });
  });
}
```

That log is the whole design. Everything else — work sessions, provider
failover, the document the residents build, the repair loop — is a consequence
of it.

## What it does

| | |
|---|---|
| **Talk to the project** | Ask a question; one model or all of them answer, and every model hears the reply whether it spoke or not |
| **Hold a session** | They propose, read each other, respond, and one writes the conclusion — you accept it or overrule it |
| **Divide the work** | Each argues for the part it is best placed to own; you approve the split |
| **Build files** | `make path/to/file "what it should do"` writes a real file to disk |
| **Run and repair** | `fix -- npm test` runs it, reads the failure, follows the imports to the file actually at fault, rewrites it, and runs it again |
| **Edit alongside them** | A file tree and editor in the browser, saving to the same workspace |
| **Dedicated agents** | Give an agent a role and a part of the project it owns |
| **Remember what worked** | Decisions you confirmed become context every agent carries |

## What it is not, yet

Read this before deciding whether it fits your work.

- **It is a prototype.** One project per instance, no authentication, no
  multi-tenancy, no secret management beyond a local `.env`.
- **Repair is bounded.** It follows imports from the failing file, up to eight
  files, and retries three times by default. A failure spread across a large
  codebase will exhaust that.
- **It does not plan work over time.** There is no backlog, no branch, no
  awareness of git. It changes files in place and puts them back if the repair
  fails.
- **Cost is real.** A working session spends two provider calls per participant
  plus one; a repair spends one per attempt. Both are shown before you start.

## Install

Requires **Node.js 22 or newer**. There are no third-party dependencies — not
in the core, not in the server, not in the tests.

```sh
git clone https://github.com/allinerosamkup-ai/northstar-cognitive-platform.git
cd northstar-cognitive-platform
npm start
```

That is the whole installation. Open `http://127.0.0.1:4310`.

Add your keys from the terminal, which saves them to a local `.env` and tests
each one immediately:

```sh
npm run cli -- set-key gpt sk-...
npm run cli -- set-key claude sk-ant-...
npm run cli -- set-key gemini AIza...
```

Or paste them into the **Settings** screen. Either way they stay on your
machine, are never returned by any route, and go only to the provider they
belong to. A wrong or retired model id shows up in the connection test rather
than partway through a session.

## Try it first — no API key needed

Demo mode is not a screenshot: the whole app runs, the mesh works, and every
canned answer says plainly that no model wrote it. Nothing to configure, nothing
to spend.

```sh
npm start
```

Open `http://127.0.0.1:4310`, type a question and press **Enter**. The six views
in the left rail — conversation, project brain, working session, document,
workspace editor, settings — are all live against the same project.

What demo mode cannot show you is the part that matters: a stand-in cannot write
code, reconcile a disagreement, or repair a failing test. It returns files
unchanged and says so, which is honest and ends a repair loop immediately. Add a
key to see the real thing.

## CLI

Everything the interface does, the CLI does — the two share one project, so a
decision recorded in either appears in the other immediately.

```sh
npm run cli -- help          # every command

# talking
npm run cli -- status        # who is present, what they have heard, what is live
npm run cli -- ask "..."     # ask the project
npm run cli -- meet "..."    # a session: propose, respond, conclude
npm run cli -- conclude      # accept the conclusion, or write your own
npm run cli -- divide "A|B"  # they argue for parts of the work

# building
npm run cli -- make src/x.js "what it should do"
npm run cli -- run "npm test"
npm run cli -- fix -- npm test

# the project
npm run cli -- ls / open / attach / put
npm run cli -- agents / hire / fire
npm run cli -- providers / set-key / test
npm run cli -- cost          # what a session will spend before you start one
```

`--json` on any command for scripting, `--topology solo|composite` to choose who
answers, `--with gpt,claude` to pick residents, `--by <id>` to choose who writes
a conclusion or a repair, `--attempts <n>` to bound a repair. Set
`COGNITIVE_API_URL` to reach a server on another port or host.

## Test

```sh
npm test
```

Node's built-in test runner (`node --test`), no test framework dependency.

## Working sessions

The residents do not only answer in parallel — they can hold a session:

1. **Propose.** Each one answers the question in its own voice.
2. **Respond.** Each one reads what the others said and answers them, and may
   change its position.
3. **Conclude.** One of them (a live model whenever there is one) reconciles
   the positions, listing what was agreed and what was not.

The conclusion is a **proposal**. Nothing becomes a decision until you accept
it or write your own — disagreement is surfaced rather than averaged away.

```sh
npm run cli -- cost                       # what a session will spend, first
npm run cli -- meet "Local or cloud?"     # the three rounds
npm run cli -- conclude                   # accept their conclusion
npm run cli -- conclude "your decision"   # or overrule it
```

Work can be divided the same way: each resident argues for the parts it is
best placed to take, one of them proposes the split, and you approve or change
it before it becomes the project's.

```sh
npm run cli -- divide "Architecture | Research | Launch"
npm run cli -- confirm-division
```

A session is the most expensive thing the app does — two provider calls per
participant plus one for the conclusion — so the cost is shown before you
start one, in the interface and in the CLI.

## Running and repairing

Writing a file is half of it. The other half is running something and reading
what broke.

```sh
npm run cli -- run "npm test"          # just run it
npm run cli -- fix -- npm test         # run it, and repair until it passes
npm run cli -- fix src/total.js -- npm test    # the same, but only this file may change
```

`fix` runs the command, and while it fails:

1. It reads the failure for files **in this project** — skipping node internals
   and dependency code, which are not yours to rewrite.
2. A stack trace names where an assertion blew up, which is the test, almost
   never where the mistake lives. So it follows what those files import, a level
   at a time, up to eight files.
3. It sends the failure and those files to a resident, applies whatever comes
   back, and runs the command again.

It stops early when the files come back unchanged, because the same answer will
not pass a second time either. And **if it ends still failing, every file it
touched is put back exactly as it was** — a repair that did not work leaves
nothing half-rewritten across files you have not looked at.

Given a failing assertion in a test whose maths was wrong two imports away, it
found the file the trace never named, corrected the formula, and left the file
that was already right alone.

**The command is always yours.** A resident can read a failure and rewrite a
file; it can never choose what executes. Only programs on an allowlist start
(`npm`, `node`, `python`, `go`, `cargo`, … — narrow it with
`COGNITIVE_ALLOWED_COMMANDS`), they are matched by name so a path cannot
substitute one, nothing runs through a shell so a semicolon is an argument and
not a second command, and a run that will not end is stopped after two minutes.

## Building something

The **Document** view is where the intelligences produce work rather than talk
about it. Give an instruction and they return a full revision of the project
document; give another and they revise it. Every revision is an event in the
project brain, so the history is the document's history.

Attached files feed into a build, and any file the document proposes can be
written to the workspace folder with one click. An existing file is never
overwritten without asking.

## Provider configuration

Northstar starts on deterministic demo providers, so it runs with no key and
costs nothing. Add a key to replace a demo resident with the real intelligence.

**The easy way:** open **Settings** in the app, paste a key, pick a model, and
press **Test connection** — it makes one minimal real call and reports exactly
what the provider said. A wrong or retired model id shows up there in seconds
instead of failing partway through a conversation. Keys are written to your
local `.env`, are never displayed back to you, and are never sent anywhere
except the provider they belong to.

**The manual way:** copy `.env.example` to `.env` and fill it in. Northstar
reads that file at startup; a real environment variable takes precedence over
it.

Supplying a key is the whole switch — there is no second flag to remember.
`LIVE_RESIDENCY` is a separate, off-by-default setting that makes residents call
their provider on every event just to acknowledge it; it multiplies cost without
adding capability, because each request already carries the full context.

Each person runs Northstar on their own machine with their own keys — there
is no shared hosted instance and no account system, so your usage and your
API costs are entirely your own.

## Attaching local files

The **Files** view browses a folder on your machine and attaches a text file
into the project brain, so every resident sees its content.

The browsable root is `COGNITIVE_WORKSPACE_PATH` (default: the folder you
started the server from). Nothing outside that root is readable — the server
resolves every requested path, follows symlinks, and refuses anything that
lands outside. Attachments are capped at 256 KB and must be text.

In demo mode the residents receive the attachment event but ignore its
content, because the demo provider answers with fixed text. File content only
influences an answer once live providers are enabled.

## Architecture

```text
Visual App ─┐
CLI ────────┼── Context API ── Cognitive Mesh ── Resident LLMs
SDK ────────┘                       │
                              Project Brain
                         events · state · provenance
```

The application owns the project context. Providers supply participating
intelligences. Execution agents remain an optional, separately authorized
layer.

## Project Brain storage

The Project Brain is an append-only JSONL log at `data/project-brain.jsonl`:
one line per record, appended and never rewritten, so write cost stays
constant as the project grows and a crash cannot rewrite existing history. A
truncated final line — the signature of a crash mid-append — is dropped on
read instead of failing the whole log.

Writes are serialized per log file, so concurrent callers cannot claim the
same event sequence and overwrite each other. Contributions are serialized
per project, keeping the staleness check and the write atomic.

An older whole-file `data/project-brain.json` is migrated automatically on
first read and kept in place as a backup.

## Event surfaces

`src/core/event-catalog.js` classifies every event type:

- **surface** — project content a model must read back: `message.created`,
  `decision.created`, `task.created`, `contribution.created`, `file.attached`,
  `document.revised`, `session.concluded`, `assignment.confirmed`
- **log-only** — bookkeeping: `collective.started`, `resident.paused`,
  `file.written`, `settings.changed`, `session.started`, `assignment.proposed`,
  `agent.created`, `agent.dismissed`, `command.run`

Prompts are built from surface events only. Note which side the proposals fall
on: a session's conclusion and a proposed division stay out of what the
residents read back until a person confirms them, because a proposal is not yet
what the project believes. An unclassified type defaults to surface, so new
content is never hidden from a model by accident.

## Repository layout

```
src/core/       the mesh, the log, sessions, agents, documents, failure reading
src/platform/   the HTTP server, the workspace, the runner, settings
src/web/        the interface — plain modules, no build step
src/cli/        the terminal client over the same Context API
```

`src/core` holds no I/O and no HTTP; everything it does is against an interface
the platform layer supplies. That is what makes the mesh testable without a
server and the server testable without a model.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to run the project, run the tests, and what a good PR looks like.
Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
