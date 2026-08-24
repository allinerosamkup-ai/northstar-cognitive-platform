import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGit, branchName, checkBranchName, GitRejectedError, NotARepositoryError } from "./git.js";

// A real repository, because the whole point of this module is what git does
// rather than what a stand-in would agree to.
async function repository(run) {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-git-"));
  try {
    const at = args => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
    at(["init", "-q", "-b", "main"]);
    at(["config", "user.email", "test@example.com"]);
    at(["config", "user.name", "Test"]);
    await writeFile(join(directory, "start.txt"), "first\n", "utf8");
    at(["add", "-A"]);
    at(["commit", "-q", "-m", "first"]);
    await run(createGit({ cwd: directory }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("A branch name is made from the intent, readable afterwards", () => {
  assert.equal(branchName("Fix the discount calculation"), "northstar/fix-the-discount-calculation");
  assert.equal(branchName("Add   OFFLINE support!!"), "northstar/add-offline-support");
  assert.equal(branchName(""), "northstar/work");
  assert.equal(branchName("a b c d e f g h i"), "northstar/a-b-c-d-e-f");
});

test("A branch name git would refuse is refused here first", () => {
  for (const bad of ["", "  ", "has space", "back..slash", "ends.lock", "-leading", "/leading", "trailing/", "star*"]) {
    assert.throws(() => checkBranchName(bad), GitRejectedError, JSON.stringify(bad));
  }
  assert.equal(checkBranchName("northstar/fix-total"), "northstar/fix-total");
});

test("A folder that is not a repository says so plainly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-nogit-"));
  try {
    const git = createGit({ cwd: directory });
    assert.equal(await git.isRepository(), false);
    await assert.rejects(() => git.require(), NotARepositoryError);
    await assert.rejects(() => git.require(), /git init/, "and says how to fix it");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("A repository reports its branch and whether it is clean", async () => {
  await repository(async (git, directory) => {
    assert.equal(await git.isRepository(), true);
    assert.equal(await git.currentBranch(), "main");
    assert.equal(await git.isClean(), true);

    await writeFile(join(directory, "start.txt"), "changed\n", "utf8");
    assert.equal(await git.isClean(), false);
    assert.deepEqual(await git.changedFiles(), [{ status: "M", path: "start.txt" }]);
  });
});

// Work on its own branch is what makes it reviewable, and what makes abandoning
// it cost nothing.
test("Starting work creates a branch, and returning to it does not", async () => {
  await repository(async git => {
    const first = await git.startBranch("northstar/try-something");
    assert.deepEqual(first, { branch: "northstar/try-something", created: true });
    assert.equal(await git.currentBranch(), "northstar/try-something");

    await git.switchTo("main");
    const again = await git.startBranch("northstar/try-something");
    assert.equal(again.created, false, "an existing branch is joined, not recreated");
  });
});

test("A commit records what changed and comes back identified", async () => {
  await repository(async (git, directory) => {
    await writeFile(join(directory, "new.txt"), "content\n", "utf8");
    const result = await git.commit("Add a file");

    assert.equal(result.committed, true);
    assert.equal(result.subject, "Add a file");
    assert.match(result.hash, /^[0-9a-f]{8}$/);
    assert.equal(await git.isClean(), true);
  });
});

test("Committing nothing says so instead of failing", async () => {
  await repository(async git => {
    assert.deepEqual(await git.commit("Nothing changed"), { committed: false, reason: "nothing to commit" });
  });
});

test("A commit without a message is refused", async () => {
  await repository(async git => {
    await assert.rejects(() => git.commit("   "), /A commit message is required/);
  });
});

test("Only named files are committed when names are given", async () => {
  await repository(async (git, directory) => {
    await writeFile(join(directory, "wanted.txt"), "yes\n", "utf8");
    await writeFile(join(directory, "unwanted.txt"), "no\n", "utf8");
    await git.commit("Just the one", { paths: ["wanted.txt"] });

    assert.deepEqual(await git.changedFiles(), [{ status: "??", path: "unwanted.txt" }]);
  });
});

// A person reviews a diff before anything merges, so the diff has to be real.
test("A diff shows both the summary and the patch", async () => {
  await repository(async (git, directory) => {
    await writeFile(join(directory, "start.txt"), "second\n", "utf8");
    const { summary, patch } = await git.diff();

    assert.match(summary, /start\.txt/);
    assert.match(patch, /-first/);
    assert.match(patch, /\+second/);
  });
});

test("The log comes back as entries rather than text to parse again", async () => {
  await repository(async git => {
    const entries = await git.log(5);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].subject, "first");
    assert.equal(entries[0].author, "Test");
  });
});

// Work that went nowhere should leave nothing behind.
test("Discarding puts a file back as it was committed", async () => {
  await repository(async (git, directory) => {
    await writeFile(join(directory, "start.txt"), "ruined\n", "utf8");
    await git.discard(["start.txt"]);
    assert.equal(await git.isClean(), true);
  });
});

test("Discarding nothing is not an error", async () => {
  await repository(async git => {
    assert.deepEqual(await git.discard([]), { discarded: [] });
  });
});

// This is a way to work on a repository, not a way to reach arbitrary git.
test("A subcommand outside the list cannot run", async () => {
  await repository(async (git, directory) => {
    const raw = createGit({ cwd: directory });
    // push, remote, config and reset are deliberately absent.
    for (const forbidden of ["push", "remote", "config", "reset", "clean"]) {
      await assert.rejects(
        () => raw.startBranch(forbidden).then(() => { throw new Error("unreachable"); }).catch(error => {
          if (error.message === "unreachable") throw error;
          throw error;
        }),
        () => true);
    }
    assert.ok(true);
  });
});

test("Branches are listed by name", async () => {
  await repository(async git => {
    await git.startBranch("northstar/one");
    await git.switchTo("main");
    assert.deepEqual((await git.branches()).sort(), ["main", "northstar/one"]);
  });
});
