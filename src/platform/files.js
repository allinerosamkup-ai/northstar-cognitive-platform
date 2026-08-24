import { readdir, readFile, writeFile, mkdir, stat, realpath } from "node:fs/promises";
import { resolve, join, relative, sep, isAbsolute, dirname } from "node:path";

export const MAX_ATTACHMENT_BYTES = 256 * 1024;

export class PathOutsideWorkspaceError extends Error {
  constructor(path) {
    super(`Path is outside the workspace: ${path}`);
    this.name = "PathOutsideWorkspaceError";
  }
}
export class FileExistsError extends Error {
  constructor(path) {
    super(`That file already exists: ${path}`);
    this.name = "FileExistsError";
    this.path = path;
  }
}
export class AttachmentRejectedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "AttachmentRejectedError";
  }
}

// A byte is control-but-not-whitespace, or a NUL. Text files essentially never
// carry these; binaries almost always do within the first few kilobytes.
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) return true;
  }
  return false;
}

export class Workspace {
  constructor(root) { this.root = resolve(root); }

  // The single security boundary of this module: every path the caller supplies
  // is resolved against the root and refused unless it stays inside it. realpath
  // is what closes the symlink escape — resolve() alone cannot see through a link.
  async #safePath(requested = ".") {
    const rootReal = await realpath(this.root).catch(() => this.root);
    const candidate = resolve(rootReal, requested);
    const real = await realpath(candidate).catch(error => {
      if (error.code === "ENOENT") return candidate;
      throw error;
    });
    const rel = relative(rootReal, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new PathOutsideWorkspaceError(requested);
    return real;
  }

  async list(requested = ".") {
    const directory = await this.#safePath(requested);
    const entries = await readdir(directory, { withFileTypes: true });
    const items = await Promise.all(entries
      .filter(entry => !entry.name.startsWith("."))
      .map(async entry => {
        const full = join(directory, entry.name);
        const info = entry.isDirectory() ? null : await stat(full).catch(() => null);
        return {
          name: entry.name,
          directory: entry.isDirectory(),
          size: info?.size ?? null,
          modifiedAt: info?.mtimeMs ?? null,
          path: relative(this.root, full).split(sep).join("/")
        };
      }));
    items.sort((a, b) => a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1);
    return { path: relative(this.root, directory).split(sep).join("/"), items };
  }

  // Writing is the most destructive thing this app can do, so it goes through the
  // same boundary as reading and refuses to clobber anything unless the caller
  // says so explicitly — the interface asks a person first.
  async write(requested, content, { overwrite = false } = {}) {
    if (typeof content !== "string") throw new AttachmentRejectedError("File content must be text");
    if (Buffer.byteLength(content, "utf8") > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejectedError(`Content exceeds the ${MAX_ATTACHMENT_BYTES / 1024} KB limit`);
    }
    const file = await this.#safePath(requested);
    const existing = await stat(file).catch(() => null);
    if (existing?.isDirectory()) throw new AttachmentRejectedError("That path is a folder, not a file");
    if (existing && !overwrite) throw new FileExistsError(relative(this.root, file).split(sep).join("/"));

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    const written = await stat(file);
    return {
      path: relative(this.root, file).split(sep).join("/"),
      size: Buffer.byteLength(content, "utf8"),
      modifiedAt: written.mtimeMs,
      replaced: Boolean(existing)
    };
  }

  async read(requested) {
    const file = await this.#safePath(requested);
    const info = await stat(file);
    if (info.isDirectory()) throw new AttachmentRejectedError("That path is a folder, not a file");
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejectedError(`File is ${Math.round(info.size / 1024)} KB; the limit is ${MAX_ATTACHMENT_BYTES / 1024} KB`);
    }
    const buffer = await readFile(file);
    if (looksBinary(buffer)) throw new AttachmentRejectedError("Only text files can be attached");
    return {
      path: relative(this.root, file).split(sep).join("/"),
      size: info.size,
      modifiedAt: info.mtimeMs,
      content: buffer.toString("utf8")
    };
  }
}
