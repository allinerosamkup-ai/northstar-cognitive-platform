import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, PathOutsideWorkspaceError, AttachmentRejectedError, FileExistsError, MAX_ATTACHMENT_BYTES } from "./files.js";

async function workspace(run) {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-files-"));
  try {
    await mkdir(join(directory, "root", "notes"), { recursive: true });
    await writeFile(join(directory, "root", "readme.txt"), "project readme", "utf8");
    await writeFile(join(directory, "root", "notes", "idea.md"), "# an idea", "utf8");
    await writeFile(join(directory, "outside-secret.txt"), "must never be readable", "utf8");
    await run(new Workspace(join(directory, "root")), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Listing a folder returns its entries with folders first", async () => {
  await workspace(async space => {
    const listing = await space.list(".");
    assert.deepEqual(listing.items.map(item => item.name), ["notes", "readme.txt"]);
    assert.equal(listing.items[0].directory, true);
    assert.equal(listing.items[1].size, "project readme".length);
    assert.equal(listing.items[1].path, "readme.txt");
  });
});

test("Listing descends into a subfolder", async () => {
  await workspace(async space => {
    const listing = await space.list("notes");
    assert.equal(listing.path, "notes");
    assert.deepEqual(listing.items.map(item => item.path), ["notes/idea.md"]);
  });
});

test("Reading a file returns its content", async () => {
  await workspace(async space => {
    const file = await space.read("notes/idea.md");
    assert.equal(file.content, "# an idea");
    assert.equal(file.path, "notes/idea.md");
  });
});

test("A relative path escaping the workspace is refused", async () => {
  await workspace(async space => {
    for (const attempt of ["../outside-secret.txt", "notes/../../outside-secret.txt", "../../../../../../etc/passwd"]) {
      await assert.rejects(() => space.read(attempt), PathOutsideWorkspaceError, attempt);
      await assert.rejects(() => space.list(attempt), PathOutsideWorkspaceError, attempt);
    }
  });
});

test("An absolute path outside the workspace is refused", async () => {
  await workspace(async (space, directory) => {
    await assert.rejects(() => space.read(join(directory, "outside-secret.txt")), PathOutsideWorkspaceError);
  });
});

test("A file larger than the limit is refused", async () => {
  await workspace(async (space, directory) => {
    await writeFile(join(directory, "root", "big.txt"), "x".repeat(MAX_ATTACHMENT_BYTES + 1), "utf8");
    await assert.rejects(() => space.read("big.txt"), AttachmentRejectedError);
  });
});

test("A binary file is refused", async () => {
  await workspace(async (space, directory) => {
    await writeFile(join(directory, "root", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    await assert.rejects(() => space.read("image.png"), AttachmentRejectedError);
  });
});

test("Attaching a folder instead of a file is refused", async () => {
  await workspace(async space => {
    await assert.rejects(() => space.read("notes"), AttachmentRejectedError);
  });
});

test("Writing a file creates it inside the workspace", async () => {
  await workspace(async space => {
    const result = await space.write("notes/plan.md", "# The plan\n");
    assert.equal(result.path, "notes/plan.md");
    assert.equal(result.replaced, false);
    assert.equal((await space.read("notes/plan.md")).content, "# The plan\n");
  });
});

test("Writing creates missing folders along the way", async () => {
  await workspace(async space => {
    await space.write("build/output/app.js", "export const a = 1;");
    assert.equal((await space.read("build/output/app.js")).content, "export const a = 1;");
  });
});

// Silent overwrite is how generated content destroys someone's work.
test("Writing over an existing file is refused unless asked for", async () => {
  await workspace(async space => {
    await assert.rejects(() => space.write("readme.txt", "clobbered"), FileExistsError);
    assert.equal((await space.read("readme.txt")).content, "project readme", "the original survives");

    const result = await space.write("readme.txt", "deliberate", { overwrite: true });
    assert.equal(result.replaced, true);
    assert.equal((await space.read("readme.txt")).content, "deliberate");
  });
});

test("Writing outside the workspace is refused", async () => {
  await workspace(async (space, directory) => {
    for (const attempt of ["../escaped.txt", "notes/../../escaped.txt", join(directory, "escaped.txt")]) {
      await assert.rejects(() => space.write(attempt, "should never land"), PathOutsideWorkspaceError, attempt);
    }
  });
});

test("Writing a folder path or oversized content is refused", async () => {
  await workspace(async space => {
    await assert.rejects(() => space.write("notes", "x"), AttachmentRejectedError);
    await assert.rejects(() => space.write("big.txt", "x".repeat(MAX_ATTACHMENT_BYTES + 1)), AttachmentRejectedError);
    await assert.rejects(() => space.write("nope.txt", { not: "text" }), AttachmentRejectedError);
  });
});
