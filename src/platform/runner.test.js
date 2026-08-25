import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand, checkCommand, createRunner, failureReport, CommandRejectedError, DEFAULT_ALLOWED } from "./runner.js";

test("A command is split on whitespace, honouring quotes", () => {
  assert.deepEqual(parseCommand("npm test"), ["npm", "test"]);
  assert.deepEqual(parseCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
  assert.deepEqual(parseCommand("npm run build --if-present"), ["npm", "run", "build", "--if-present"]);
  assert.deepEqual(parseCommand("   "), []);
});

test("A program on the allowed list runs", () => {
  assert.deepEqual(checkCommand("npm test"), { program: "npm", args: ["test"] });
  assert.deepEqual(checkCommand("NPM.CMD test").args, ["test"], "the extension and case do not matter");
});

test("A program not on the list is refused, and the list is shown", () => {
  assert.throws(() => checkCommand("curl https://example.com"), error => {
    assert.ok(error instanceof CommandRejectedError);
    assert.match(error.message, /not on the allowed list/);
    assert.match(error.message, /npm/, "so a person can see what is allowed");
    return true;
  });
});

async function workspace(run) {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-run-"));
  try { await run(directory, createRunner({ cwd: directory })); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// The protection is that nothing reaches a shell, so this proves the property
// rather than asserting a rule: a semicolon becomes an inert argument, and the
// command after it never runs.
test("A semicolon cannot start a second command", async () => {
  await workspace(async (directory, run) => {
    // The first script prints nothing, so anything in the output could only have
    // come from the command after the semicolon actually running.
    const result = await run('node -e "0" ; node -e "console.log(\'SHOULD NOT RUN\')"');
    assert.doesNotMatch(result.stdout, /SHOULD NOT RUN/, "what follows the semicolon must never execute");
  });
});

test("A pipe cannot hand output to another program", async () => {
  await workspace(async (directory, run) => {
    const result = await run("node -e 'console.log(1)' | node -e 'console.log(\"PIPED\")'");
    assert.doesNotMatch(result.stdout, /PIPED/, "the second program must never run");
  });
});

// Banning quotes would make `node -e 'console.log("x")'` impossible to run,
// which is exactly the shape a fix loop needs. They are escaped, not refused.
test("An argument carrying quotes survives to the program", async () => {
  await workspace(async (directory, run) => {
    const result = await run('node -e "console.log(JSON.stringify({ok:1}))"');
    assert.equal(result.ok, true);
    assert.match(result.stdout, /\{"ok":1\}/);
  });
});

// A path is how an allowlist gets walked around.
test("A program given by path is refused", () => {
  for (const attempt of ["./npm test", "../../evil/npm test", "/usr/bin/npm test", "C:\\evil\\npm.exe"]) {
    assert.throws(() => checkCommand(attempt), /by name, not by path/, attempt);
  }
});

test("An empty command is refused", () => {
  assert.throws(() => checkCommand("   "), /A command is required/);
});

test("The allowed list can be narrowed for a project", () => {
  assert.throws(() => checkCommand("npm test", ["python"]), /not on the allowed list/);
  assert.deepEqual(checkCommand("python -V", ["python"]).args, ["-V"]);
});

test("A command that succeeds reports its output and a clean exit", async () => {
  await workspace(async (directory, run) => {
    const result = await run('node -e "console.log(\'it worked\')"');
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /it worked/);
    assert.equal(result.timedOut, false);
  });
});

test("A command that fails reports the exit code and what it printed", async () => {
  await workspace(async (directory, run) => {
    const result = await run('node -e "console.error(\'boom\'); process.exit(3)"');
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /boom/);
  });
});

test("A command runs inside the workspace, not wherever the server started", async () => {
  await workspace(async (directory, run) => {
    await writeFile(join(directory, "marker.txt"), "here", "utf8");
    const result = await run('node -e "console.log(require(\'fs\').existsSync(\'marker.txt\'))"');
    assert.match(result.stdout, /true/);
  });
});

test("A program that is not installed says so instead of hanging", async () => {
  await workspace(async (directory) => {
    const run = createRunner({ cwd: directory, allowed: ["definitely-not-installed"] });
    const result = await run("definitely-not-installed --version");
    assert.equal(result.ok, false);
    assert.match(result.failure, /not installed|ENOENT|not on PATH/i);
  });
});

// A run that never ends must not hold the app open forever.
test("A command that will not finish is stopped and reported as timed out", async () => {
  await workspace(async directory => {
    const run = createRunner({ cwd: directory, timeout: 700 });
    const result = await run('node -e "setInterval(() => {}, 1000)"');
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false, "a run that was cut short is not a pass");
  });
});

test("A failure report gives a model the command and the error", () => {
  const report = failureReport({
    command: "npm test", exitCode: 1, timedOut: false,
    stdout: "3 passing", stderr: "AssertionError: expected 2 to equal 3"
  });
  assert.match(report, /npm test/);
  assert.match(report, /exited with code 1/);
  assert.match(report, /AssertionError/);
  assert.match(report, /3 passing/);
});

// An assertion puts the useful part at the end; a module that failed to load
// puts it at the start and fills the rest with runtime internals. Keeping one
// end loses whichever kind this was.
test("A long failure report keeps both ends of the output", () => {
  const report = failureReport({
    command: "npm test", exitCode: 1,
    stderr: [
      "ReferenceError: describe is not defined",
      ...Array.from({ length: 2000 }, () => "at node:internal"),
      "THE LAST LINE"
    ].join("\n")
  }, 400);

  assert.match(report, /ReferenceError: describe is not defined/, "the error type survives");
  assert.match(report, /THE LAST LINE/, "and so does the end of the trace");
  assert.match(report, /characters omitted/, "with the middle accounted for");
  assert.ok(report.length < 1200, "and it stays small enough to send");
});

test("A timeout is reported as a timeout, not as an exit code", () => {
  assert.match(failureReport({ command: "npm test", timedOut: true, exitCode: null }), /still running after the time limit/);
});

test("The default allowed list is names only, never paths", () => {
  for (const name of DEFAULT_ALLOWED) assert.doesNotMatch(name, /[\/]/, name);
});
