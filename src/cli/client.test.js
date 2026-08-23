import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveClient } from "./client.js";

// Stands in for the server, recording what the client sent so each command can
// be checked against the route it is supposed to reach.
function recordingFetch(responder = () => ({})) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    const { status = 200, value = responder(url) } = responder(url) ?? {};
    const payload = value ?? responder(url) ?? {};
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetcher };
}

test("CLI client reads and changes the same project through the Context API", async () => {
  const { calls, fetcher } = recordingFetch(url =>
    url.endsWith("/api/snapshot")
      ? { value: { project: { name: "Northstar" }, state: { version: 7 }, residents: [{ id: "gpt", status: "present" }] } }
      : { value: { event: { sequence: 8 } } });

  const client = new CognitiveClient("http://localhost:4310", fetcher);
  assert.equal((await client.status()).project.name, "Northstar");
  assert.equal((await client.message("Continue without losing the whole")).event.sequence, 8);
  assert.equal(calls[1].url, "http://localhost:4310/api/messages");
  assert.deepEqual(calls[1].body, { text: "Continue without losing the whole" });
});

test("Every command reaches the route it belongs to", async () => {
  const { calls, fetcher } = recordingFetch(() => ({ value: { ok: true } }));
  const client = new CognitiveClient("http://localhost:4310", fetcher);

  await client.chat("a question", "solo", ["gpt"]);
  await client.build("an instruction");
  await client.work("an objective");
  await client.attach("notes/brief.md");
  await client.write("out.md", "content");
  await client.files("notes");
  await client.testProvider("claude");

  assert.deepEqual(calls.map(call => call.url.replace("http://localhost:4310", "")), [
    "/api/chat", "/api/build", "/api/work", "/api/files/attach",
    "/api/files/write", "/api/files?path=notes", "/api/settings/test"
  ]);
  assert.deepEqual(calls[0].body, { text: "a question", topology: "solo", residentIds: ["gpt"] });
});

test("Removing a provider uses DELETE rather than a second create route", async () => {
  const { calls, fetcher } = recordingFetch(() => ({ value: {} }));
  await new CognitiveClient("http://localhost:4310", fetcher).forget("gemini");
  assert.equal(calls[0].options.method, "DELETE");
  assert.deepEqual(calls[0].body, { provider: "gemini" });
});

// A person running a command has a terminal open and can act on advice — but
// only if the advice names the actual problem.
test("An unreachable server produces advice, not a runtime error", async () => {
  const client = new CognitiveClient("http://127.0.0.1:9999", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => client.status(), error => {
    assert.match(error.message, /Could not reach Northstar at http:\/\/127\.0\.0\.1:9999/);
    assert.match(error.message, /npm start/, "it says how to fix it");
    return true;
  });
});

test("A server error keeps its status so the caller can react to a conflict", async () => {
  const client = new CognitiveClient("http://localhost:4310", async () => ({
    ok: false, status: 409, text: async () => JSON.stringify({ error: "That file already exists: out.md" })
  }));
  await assert.rejects(() => client.write("out.md", "x"), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /already exists/);
    return true;
  });
});

test("A non-JSON response is reported as unreadable instead of crashing", async () => {
  const client = new CognitiveClient("http://localhost:4310", async () => ({
    ok: true, status: 200, text: async () => "<html>a proxy error page</html>"
  }));
  await assert.rejects(() => client.status(), /Unreadable response/);
});

test("A trailing slash in the base url does not double up in the path", async () => {
  const { calls, fetcher } = recordingFetch(() => ({ value: {} }));
  await new CognitiveClient("http://localhost:4310/", fetcher).status();
  assert.equal(calls[0].url, "http://localhost:4310/api/snapshot");
});
