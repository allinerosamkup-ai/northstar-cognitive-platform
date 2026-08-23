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

## Scope

Northstar is a prototype with no authentication, no multi-tenancy, and no
secret management. Do not expose the server to a public network or run it
with credentials you would not want a local process to hold.
