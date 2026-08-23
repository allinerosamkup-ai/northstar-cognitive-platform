import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile, writeEnvValues, mergeEnv } from "./env-file.js";

async function workspace(run) {
  const directory = await mkdtemp(join(tmpdir(), "cognitive-env-"));
  try { await run(join(directory, ".env")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Reading an env file ignores comments and blank lines", async () => {
  await workspace(async path => {
    await writeFile(path, "# a comment\n\nPORT=4310\n\n# another\nLIVE_RESIDENCY=false\n", "utf8");
    assert.deepEqual(await readEnvFile(path), { PORT: "4310", LIVE_RESIDENCY: "false" });
  });
});

test("A value containing '=' survives intact", async () => {
  await workspace(async path => {
    await writeFile(path, "OPENAI_API_KEY=sk-proj-aa=bb==cc\n", "utf8");
    assert.equal((await readEnvFile(path)).OPENAI_API_KEY, "sk-proj-aa=bb==cc");
  });
});

test("Quotes around a value are stripped", async () => {
  await workspace(async path => {
    await writeFile(path, `A="quoted"\nB='single'\nC=bare\n`, "utf8");
    assert.deepEqual(await readEnvFile(path), { A: "quoted", B: "single", C: "bare" });
  });
});

test("A missing env file reads as empty rather than failing", async () => {
  await workspace(async path => {
    assert.deepEqual(await readEnvFile(path), {});
  });
});

test("Writing a value preserves comments, ordering, and untouched settings", async () => {
  await workspace(async path => {
    await writeFile(path, "# Provider configuration\nOPENAI_API_KEY=\nOPENAI_MODEL=old-model\n\n# Server\nPORT=4310\n", "utf8");
    await writeEnvValues(path, { OPENAI_API_KEY: "sk-new", OPENAI_MODEL: "new-model" });

    const text = await readFile(path, "utf8");
    assert.match(text, /# Provider configuration/);
    assert.match(text, /# Server/);
    assert.ok(text.indexOf("OPENAI_API_KEY") < text.indexOf("PORT"), "ordering is kept");
    assert.deepEqual(await readEnvFile(path), {
      OPENAI_API_KEY: "sk-new", OPENAI_MODEL: "new-model", PORT: "4310"
    });
  });
});

test("Writing a name the file does not have appends it", async () => {
  await workspace(async path => {
    await writeFile(path, "PORT=4310\n", "utf8");
    await writeEnvValues(path, { GEMINI_API_KEY: "key" });
    assert.deepEqual(await readEnvFile(path), { PORT: "4310", GEMINI_API_KEY: "key" });
  });
});

test("Writing null removes the line entirely", async () => {
  await workspace(async path => {
    await writeFile(path, "OPENAI_API_KEY=sk-old\nPORT=4310\n", "utf8");
    await writeEnvValues(path, { OPENAI_API_KEY: null });
    assert.deepEqual(await readEnvFile(path), { PORT: "4310" });
  });
});

test("Writing to a file that does not exist creates it", async () => {
  await workspace(async path => {
    await writeEnvValues(path, { PORT: "5000" });
    assert.deepEqual(await readEnvFile(path), { PORT: "5000" });
  });
});

test("A real environment variable outranks the env file", () => {
  const merged = mergeEnv({ PORT: "4310", OPENAI_MODEL: "from-file" }, { PORT: "9999" });
  assert.equal(merged.PORT, "9999", "the exported variable wins");
  assert.equal(merged.OPENAI_MODEL, "from-file", "the file still supplies what the shell does not");
});

test("An empty environment variable does not blank out the file value", () => {
  const merged = mergeEnv({ OPENAI_API_KEY: "from-file" }, { OPENAI_API_KEY: "" });
  assert.equal(merged.OPENAI_API_KEY, "from-file");
});
