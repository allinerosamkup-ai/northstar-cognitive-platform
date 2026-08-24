# Contributing to Northstar

Thanks for considering a contribution. Northstar is a small, dependency-free
prototype, and it stays that way on purpose — keep changes simple and
readable over clever.

## Run it locally

Requires **Node.js 22 or newer** (the test runner uses glob patterns added in Node 21). No third-party packages are required for the core app.

```sh
npm start
```

Open `http://127.0.0.1:4310`. In another terminal:

```sh
npm run cli -- status
npm run cli -- say "Hello from a contributor"
npm run cli -- collaborate composite "Draft a release plan"
```

By default the app runs in **demo mode**: the three resident LLMs return
deterministic canned text, so you can develop and test without any API key
or cost. To use real providers, open Settings in the app and add a key, or
copy `.env.example` to `.env` — Northstar reads it at startup.

Tests must never depend on a key: pass `processEnv: {}` to
`createPlatformServer` so a key in your shell cannot turn a resident live and
start making real network calls mid-test. The demo provider answers every kind
of request in the shape the caller expects — a document for a build, a file
unchanged for a repair — so a test can exercise a whole flow without a model,
and a person running demo mode never sees an internal prompt on screen.

## Run the tests

```sh
npm test
```

Uses Node's built-in test runner (`node --test`) over every `*.test.js`
file, colocated next to the module it tests. Please add or update a test
alongside any behavior change — the suite is the contract for what the mesh
guarantees (stale-write protection, event ordering, provider failover).

## How the pieces fit

`POST /api/chat` records your message as an event, then runs the
`CognitiveArchitect` with the chosen topology. Each resident holds a cursor into
the shared event log and may only contribute when that cursor is current, which
is what stops a model from writing over something it never saw.

- `src/core/` — the mesh, the append-only log, working sessions, agents,
  documents, reading a failure. No I/O and no HTTP: everything is against an
  interface the platform layer supplies, which is why the mesh is testable
  without a server and the server testable without a model.
- `src/platform/` — the HTTP server, the workspace (file access behind a path
  boundary), the command runner, settings and `.env`.
- `src/web/` — the interface. Plain modules, no build step, no framework.
- `src/cli/` — the terminal client, over the same Context API the browser uses.

## Where care is owed

Three places in this codebase can do real damage, and each has tests that prove
the property rather than assert the rule. Treat a change to any of them as
security-relevant:

- **`src/platform/files.js`** — every path is resolved through symlinks and
  refused if it lands outside the workspace, for writes as well as reads.
- **`src/platform/runner.js`** — the command always comes from the person, only
  allowlisted programs start, they are matched by name so a path cannot
  substitute one, and nothing runs through a shell.
- **`src/core/cognitive-mesh.js`** — the staleness check and the write are one
  serialized unit. Splitting them reintroduces the lost-update bug the whole
  design exists to prevent.

## Code style

- Plain modern JS (ESM, `"type": "module"`), no build step
- Zero third-party dependencies in `src/core` and `src/platform` — if you
  think a dependency is truly needed, open an issue to discuss first
- Match the existing style in the file you're touching before introducing a
  new one

## Proposing a change

1. Open an issue first for anything beyond a small fix, so we can agree on
   the approach before you spend time on it
2. Fork, branch, make your change with tests
3. `npm test` must pass
4. Open a pull request describing what changed and why (the PR template
   will guide you)

## Reporting a bug

Open an issue with: what you ran, what you expected, what happened instead,
and whether it reproduces in demo mode or only with live providers.
