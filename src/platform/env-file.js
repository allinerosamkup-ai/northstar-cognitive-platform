import { readFile, writeFile } from "node:fs/promises";

function unquote(value) {
  const trimmed = value.trim();
  const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted && trimmed.length > 1 ? trimmed.slice(1, -1) : trimmed;
}

// Only the first "=" separates the name from the value: API keys and URLs
// routinely contain more.
function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    values[trimmed.slice(0, separator).trim()] = unquote(trimmed.slice(separator + 1));
  }
  return values;
}

export async function readEnvFile(path) {
  try { return parseEnv(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

// Rewrites in place so the file a person hand-edited keeps its comments, its
// ordering, and any setting this app does not manage.
export async function writeEnvValues(path, values) {
  let existing = "";
  try { existing = await readFile(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const pending = new Map(Object.entries(values));
  const lines = existing ? existing.split(/\r?\n/) : [];
  const updated = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const separator = trimmed.indexOf("=");
    if (separator < 1) return line;
    const name = trimmed.slice(0, separator).trim();
    if (!pending.has(name)) return line;
    const value = pending.get(name);
    pending.delete(name);
    return value === null ? null : `${name}=${value}`;
  }).filter(line => line !== null);

  for (const [name, value] of pending) {
    if (value === null) continue;
    updated.push(`${name}=${value}`);
  }

  const text = updated.join("\n").replace(/\n+$/, "");
  await writeFile(path, `${text}\n`, "utf8");
}

// A real environment variable always wins: someone who exported a key in their
// shell means it, and a stale .env should never silently override that.
export function mergeEnv(fileValues, processEnv = process.env) {
  const merged = { ...fileValues };
  for (const [name, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== "") merged[name] = value;
  }
  return merged;
}
