import { spawn } from "node:child_process";

// Working on a repository is what lets a task outlive one command. A branch
// holds work in progress, a commit records a point worth returning to, and a
// diff is how a person reviews what the residents did before any of it merges.
//
// Every argument is passed as its own argv entry and nothing runs through a
// shell, so a branch name is a branch name even when it contains something
// unfortunate. Only the subcommands listed here can run: this is not a way to
// reach arbitrary git.

const ALLOWED = new Set([
  "status", "branch", "checkout", "switch", "add", "commit",
  "diff", "log", "rev-parse", "stash", "restore", "show", "merge"
]);

const GIT_TIMEOUT_MS = 30_000;

export class GitRejectedError extends Error {
  constructor(reason) { super(reason); this.name = "GitRejectedError"; }
}
export class NotARepositoryError extends Error {
  constructor(path) {
    super(`${path} is not a git repository. Run "git init" there first.`);
    this.name = "NotARepositoryError";
  }
}

// A branch a person will see in their own repository afterwards, so it has to be
// a name git accepts and a human recognises.
export function branchName(intent, { prefix = "northstar" } = {}) {
  const slug = String(intent ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return `${prefix}/${slug || "work"}`;
}

export function checkBranchName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw new GitRejectedError("A branch name is required");
  // git's own rules, the ones that matter here.
  if (/[\s~^:?*[\\]/.test(value) || value.includes("..") || value.endsWith(".lock")
    || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) {
    throw new GitRejectedError(`"${value}" is not a valid branch name`);
  }
  return value;
}

export function createGit({ cwd, timeout = GIT_TIMEOUT_MS }) {
  const git = (args, { allowFailure = false } = {}) => new Promise((resolve, reject) => {
    if (!ALLOWED.has(args[0])) {
      return reject(new GitRejectedError(`git ${args[0]} is not available here`));
    }
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new GitRejectedError("git is not installed, or not on PATH") : error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim(), exitCode: code });
      else reject(new GitRejectedError(err.trim() || `git ${args[0]} failed with code ${code}`));
    });
  });

  return {
    async isRepository() {
      const result = await git(["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
      return result.ok && result.stdout === "true";
    },

    async require() {
      if (!(await this.isRepository())) throw new NotARepositoryError(cwd);
    },

    async currentBranch() {
      return (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout;
    },

    async isClean() {
      return (await git(["status", "--porcelain"])).stdout === "";
    },

    async changedFiles() {
      const { stdout } = await git(["status", "--porcelain"]);
      // Porcelain aligns its status in two columns, but the output is trimmed
      // before it reaches here, so the leading space of the first line is already
      // gone. Splitting on whitespace survives that; fixed offsets do not.
      return stdout.split("\n")
        .map(line => line.match(/^(\S+)\s+(.+)$/))
        .filter(Boolean)
        .map(match => ({ status: match[1], path: match[2].trim().replace(/^"|"$/g, "") }));
    },

    // Starting work on its own branch is what makes it reviewable and what makes
    // abandoning it cost nothing.
    async startBranch(name) {
      const branch = checkBranchName(name);
      const exists = await git(["rev-parse", "--verify", branch], { allowFailure: true });
      await git(exists.ok ? ["switch", branch] : ["switch", "-c", branch]);
      return { branch, created: !exists.ok };
    },

    async switchTo(name) {
      await git(["switch", checkBranchName(name)]);
      return checkBranchName(name);
    },

    async commit(message, { paths } = {}) {
      const text = String(message ?? "").trim();
      if (!text) throw new GitRejectedError("A commit message is required");
      await git(paths?.length ? ["add", "--", ...paths] : ["add", "-A"]);
      if (await this.isClean()) return { committed: false, reason: "nothing to commit" };

      // Identity comes from the caller's own git configuration; this never sets
      // one, so a commit is attributable to the person whose repository it is.
      await git(["commit", "-m", text]);
      const { stdout } = await git(["log", "-1", "--format=%H %s"]);
      const [hash, ...subject] = stdout.split(" ");
      return { committed: true, hash: hash.slice(0, 8), subject: subject.join(" ") };
    },

    async diff({ staged = false, against } = {}) {
      const args = ["diff", "--stat"];
      if (staged) args.push("--staged");
      if (against) args.push(against);
      const summary = await git(args);
      const patch = await git(args.filter(argument => argument !== "--stat"));
      return { summary: summary.stdout, patch: patch.stdout };
    },

    async log(limit = 10) {
      const { stdout } = await git(["log", `-${Math.min(Math.max(limit, 1), 50)}`, "--format=%h|%an|%s"]);
      return stdout.split("\n").filter(Boolean).map(line => {
        const [hash, author, ...subject] = line.split("|");
        return { hash, author, subject: subject.join("|") };
      });
    },

    // Abandoning is as important as committing: work that went nowhere should
    // leave nothing behind.
    async discard(paths) {
      if (!paths?.length) return { discarded: [] };
      // --worktree restores from the index, which is what "throw away my edit"
      // means. --source=HEAD writes the file but leaves it counted as modified,
      // so a discard that used it would look done and not be.
      await git(["restore", "--worktree", "--", ...paths], { allowFailure: true });
      return { discarded: paths };
    },

    async branches() {
      const { stdout } = await git(["branch", "--format=%(refname:short)"]);
      return stdout.split("\n").map(line => line.trim()).filter(Boolean);
    }
  };
}
