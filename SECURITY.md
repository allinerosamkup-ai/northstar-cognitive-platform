# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"). That channel is private between
you and the maintainers.

## A note on API keys

Northstar runs locally and calls provider APIs with **your own** keys. It
never transmits them anywhere except to the provider you configured.

- Keys belong in `.env`, which is git-ignored. Never commit one. The Settings
  screen writes there for you; no route ever returns a stored key, only a
  masked hint like `sk-…4a2f`.
- Never paste a key into an issue, a pull request, or a chat log. If you
  do, treat it as compromised: revoke it and issue a new one.
- A fresh clone has no keys and cannot spend anything until you add one.
- `LIVE_RESIDENCY=true` makes residents call their provider on every surface
  event, not only when you ask for work. It is off by default and consumes
  credit while a model appears idle.

## A note on local file access

The Files view lets the app read files from a folder on your machine and put
their content into the project brain.

- The readable root is `COGNITIVE_WORKSPACE_PATH`, defaulting to the folder
  the server was started from. Set it deliberately if that default is wider
  than you want.
- Every requested path is resolved through symlinks and refused if it lands
  outside that root — for writes as well as reads. This boundary has its own
  tests in `src/platform/files.test.js`; treat a change there as
  security-relevant.
- Writing never replaces an existing file unless the caller explicitly asks.
- Attached content becomes part of the project brain, and with live providers
  enabled it is sent to the model provider you configured. Do not attach
  secrets.

## A note on running commands

`POST /api/run` and `POST /api/fix` execute programs on your machine, in the
workspace folder. That is the most dangerous thing this app can do, and four
rules contain it:

- The command comes from you. A model can read a failure and rewrite a file; it
  never chooses what runs.
- Only programs on the allowlist start. Set `COGNITIVE_ALLOWED_COMMANDS` to
  narrow it further for a project.
- A program is matched by name, never by path, so `./npm` cannot stand in for
  `npm`.
- Nothing runs through a shell, so `;` and `|` are ordinary characters in an
  argument rather than a way to start a second command. On Windows a `.cmd` file
  forces `cmd.exe` into the picture; arguments are quoted and their own quotes
  doubled so nothing is reinterpreted.

Runs are stopped after two minutes. These boundaries have tests in
`src/platform/runner.test.js` that prove the property rather than assert the
rule — treat a change there as security-relevant.

## What the repository access can do

Working on a branch runs git in the workspace. Only a listed set of subcommands
is available — `push`, `remote`, `config` and `reset` are deliberately absent —
so this can branch, commit, diff and discard, and cannot publish anything or
rewrite history. Commits use your own git identity; the app never sets one.

Nothing goes through a shell, so a branch name stays a branch name.

## What a repair can change

`POST /api/fix` rewrites files on your machine, so its reach is bounded:

- It only offers a model files that are **already in the workspace** — a stack
  trace full of node internals and dependency paths yields nothing to rewrite.
- An edit to a file that was not offered is discarded, so a model cannot touch
  something it was never shown.
- An edit is applied only where its text appears **exactly once**. Nowhere means
  the model misremembered the file; twice is ambiguous. Both are refused.
- A run that ends still failing **puts every touched file back** as it was.

Even so, run it against work you can review. It is a repair loop, not a code
reviewer, and nothing here judges whether a passing test was made to pass for
the right reason.

## Scope

Northstar is a prototype with no authentication, no multi-tenancy, and no secret
management beyond a local `.env`. It binds to `127.0.0.1` only. Do not expose the
server to a network, and do not run it with credentials you would not want a
local process to hold.

Because it binds to loopback, anything already running on your machine can reach
it. That is the same trust boundary as your editor and your shell — treat it the
same way.
