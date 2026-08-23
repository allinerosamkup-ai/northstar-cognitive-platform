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
start making real network calls mid-test.

## Run the tests

```sh
npm test
```

Uses Node's built-in test runner (`node --test`) over every `*.test.js`
file, colocated next to the module it tests. Please add or update a test
alongside any behavior change — the suite is the contract for what the mesh
guarantees (stale-write protection, event ordering, provider failover).

## How a turn flows

`POST /api/chat` records your message as an event, then runs the
`CognitiveArchitect` with the chosen topology. Each resident holds a cursor
into the shared event log and may only contribute when that cursor is
current, which is what stops a model from writing over something it never
saw. `src/core/` holds that machinery; `src/platform/` is the HTTP layer;
`src/web/` is the interface, plain modules with no build step.

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
