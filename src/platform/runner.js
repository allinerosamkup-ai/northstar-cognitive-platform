import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join, extname, delimiter } from "node:path";

// Running commands is the most dangerous thing this app does, and the danger is
// not hypothetical: a page in any browser tab can POST to localhost. Three rules
// contain it, and none of them is optional.
//
// 1. The command always comes from the person, never from a model. A model can
//    rewrite a file and see the error; it can never choose what runs.
// 2. Only programs on the allowlist start, matched on the program name alone.
// 3. Nothing runs through a shell, so a name with a semicolon in it is a name
//    that does not match, not a second command.

export const DEFAULT_ALLOWED = [
  "npm", "npx", "node", "yarn", "pnpm", "deno", "bun",
  "python", "python3", "pytest", "uv",
  "go", "cargo", "dotnet", "mvn", "gradle",
  "make", "tsc", "eslint", "vitest", "jest"
];

export const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 60_000;

export class CommandRejectedError extends Error {
  constructor(reason) { super(reason); this.name = "CommandRejectedError"; }
}

// Splits on whitespace, honouring quotes, so an argument with a space survives
// and nothing is handed to a shell to reinterpret.
export function parseCommand(line) {
  const parts = String(line ?? "").match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map(part =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part);
}

// The real protection is that nothing reaches a shell, not a ban on punctuation.
// An argument like 'console.log("x")' is an ordinary thing to run and must
// survive intact; a line break is not, because the Windows .cmd path builds a
// single command line and a newline would end it.
export function checkCommand(line, allowed = DEFAULT_ALLOWED) {
  const [program, ...args] = parseCommand(line);
  if (!program) throw new CommandRejectedError("A command is required");
  // A path is how an allowlist gets walked around, so a path is not a name.
  if (/[\\/]/.test(program)) {
    throw new CommandRejectedError("Give the program by name, not by path");
  }
  if (args.some(argument => /[\r\n]/.test(argument))) {
    throw new CommandRejectedError("An argument cannot contain a line break");
  }
  const name = program.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
  if (!allowed.includes(name)) {
    throw new CommandRejectedError(`"${program}" is not on the allowed list. Allowed: ${allowed.join(", ")}`);
  }
  return { program, args };
}

export function createRunner({ cwd, allowed = DEFAULT_ALLOWED, timeout = RUN_TIMEOUT_MS }) {
  return async function run(line) {
    const { program, args } = checkCommand(line, allowed);
    const started = Date.now();

    return new Promise((resolve, reject) => { (async () => {
      let out = "";
      let err = "";
      let timedOut = false;
      const keep = (buffer, chunk) => (buffer + chunk).slice(-MAX_OUTPUT);

      function finish(result) {
        return {
          command: line,
          stdout: out,
          stderr: err,
          durationMs: Date.now() - started,
          exitCode: null,
          signal: null,
          timedOut: false,
          failure: null,
          ...result
        };
      }

      let child;
      try {
        child = await launch(program, args, cwd);
      } catch (error) {
        return resolve(finish({ ok: false, failure: error.message }));
      }

      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
      child.stdout?.on("data", chunk => { out = keep(out, chunk.toString()); });
      child.stderr?.on("data", chunk => { err = keep(err, chunk.toString()); });

      child.on("error", error => {
        clearTimeout(timer);
        resolve(finish({
          ok: false,
          failure: error.code === "ENOENT" ? `${program} is not installed, or not on PATH` : error.message
        }));
      });

      // A process can time out *and* exit zero, by trapping the signal. Reporting
      // those independently keeps a cut-short run from reading as a clean pass.
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve(finish({ ok: code === 0 && !timedOut, exitCode: code, signal, timedOut }));
      });

    })().catch(reject); });
  };
}

// What a model is shown when a command failed. Long output is trimmed from the
// middle, not the end: an assertion puts the useful part last, but a module that
// failed to load puts it first and fills the rest with runtime internals. Keeping
// only one end loses whichever kind this was.
export function failureReport(result, limit = 6000) {
  const trim = text => {
    const clean = String(text ?? "").trim();
    if (clean.length <= limit) return clean;
    const half = Math.floor(limit / 2);
    return `${clean.slice(0, half)}\n\n[… ${clean.length - limit} characters omitted …]\n\n${clean.slice(-half)}`;
  };
  return [
    `COMMAND\n\n${result.command}`,
    result.timedOut ? "It was still running after the time limit and was stopped." : `It exited with code ${result.exitCode}.`,
    result.failure ? `PROBLEM STARTING IT\n\n${result.failure}` : null,
    result.stderr?.trim() ? `STANDARD ERROR\n\n${trim(result.stderr)}` : null,
    result.stdout?.trim() ? `STANDARD OUTPUT\n\n${trim(result.stdout)}` : null
  ].filter(Boolean).join("\n\n");
}

// Windows resolves a bare name through PATH and PATHEXT, and getting that wrong
// is how "node" becomes "node.cmd" and never starts. Resolving it here keeps the
// spawn explicit about what it is actually running.
async function resolveExecutable(program) {
  if (process.platform !== "win32") return program;
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extname(program) ? [""] : extensions) {
      const candidate = join(directory, program + extension);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  }
  return program;
}

async function launch(program, args, cwd) {
  const executable = await resolveExecutable(program);

  // Node refuses to spawn a .cmd without a shell, because cmd.exe re-parses what
  // it is handed. Every argument is quoted and its own quotes doubled, so there
  // is nothing left for it to reinterpret.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    return spawn(process.env.COMSPEC ?? "cmd.exe",
      // With /s, cmd strips the first and last quote of what follows /c and takes
      // the rest verbatim — so the whole line needs one more pair around it, or a
      // path containing a space is read as two words.
      ["/d", "/s", "/c", `""${executable}" ${args.map(argument => `"${argument.replace(/"/g, '""')}"`).join(" ")}"`],
      { cwd, shell: false, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(executable, args, { cwd, shell: false, windowsHide: true });
}
