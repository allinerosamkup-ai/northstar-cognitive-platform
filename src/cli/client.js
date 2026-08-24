export class CognitiveClient {
  constructor(baseUrl = "http://127.0.0.1:4310", fetcher = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetcher = fetcher;
  }

  // The server answers errors as JSON, but an unreachable server answers
  // nothing at all — and "fetch failed" would send a person hunting the wrong
  // problem when the answer is simply "start it with npm start".
  async #request(path, options) {
    let response;
    try { response = await this.fetcher(`${this.baseUrl}${path}`, options); }
    catch { throw new Error(`Could not reach Northstar at ${this.baseUrl}. Is the server running? Start it with: npm start`); }

    const raw = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
    let value;
    try { value = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`Unreadable response from ${this.baseUrl}${path}`); }
    if (!response.ok) {
      const failure = new Error(value.error ?? `Request failed with status ${response.status}`);
      failure.status = response.status;
      throw failure;
    }
    return value;
  }
  #send(path, data, method = "POST") {
    return this.#request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  }

  status() { return this.#request("/api/snapshot"); }
  message(text) { return this.#send("/api/messages", { text }); }
  decision(statement) { return this.#send("/api/decisions", { statement }); }
  chat(text, topology = "composite", residentIds) { return this.#send("/api/chat", { text, topology, residentIds }); }
  build(instruction, topology = "composite", residentIds) { return this.#send("/api/build", { instruction, topology, residentIds }); }
  work(objective, preferredResidentId) { return this.#send("/api/work", { objective, preferredResidentId }); }
  collaborate(objective, topology = "composite", residentIds = ["gpt", "claude", "gemini"]) {
    return this.#send("/api/collaborate", { objective, topology, residentIds });
  }

  deliberate(question, residentIds, synthesisBy) { return this.#send("/api/deliberate", { question, residentIds, synthesisBy }); }
  resolve(decision) { return this.#send("/api/deliberate/resolve", { decision }); }
  assign(phases, residentIds, dividedBy) { return this.#send("/api/assign", { phases, residentIds, dividedBy }); }
  confirmAssignment(assignments) { return this.#send("/api/assign/confirm", { assignments }); }
  sessionCost() { return this.#request("/api/session/cost"); }

  generate(path, instruction, by) { return this.#send("/api/files/generate", { path, instruction, by }); }
  runCommand(command) { return this.#send("/api/run", { command }); }
  fix(paths, command, attempts, by) { return this.#send("/api/fix", { paths, command, attempts, by }); }
  git() { return this.#request("/api/git"); }
  branch(intent, name) { return this.#send("/api/git/branch", { intent, name }); }
  commit(message, paths) { return this.#send("/api/git/commit", { message, paths }); }
  diff(staged) { return this.#request(`/api/git/diff${staged ? "?staged=true" : ""}`); }
  discard(paths) { return this.#send("/api/git/discard", { paths }); }
  agents() { return this.#request("/api/agents"); }
  hire(agent) { return this.#send("/api/agents", agent); }
  dismiss(id) { return this.#send("/api/agents", { id }, "DELETE"); }
  open(path) { return this.#request(`/api/files/content?path=${encodeURIComponent(path)}`); }
  save(path, content, expectedModifiedAt) {
    return this.#send("/api/files/write", { path, content, overwrite: true, expectedModifiedAt });
  }

  files(path = ".") { return this.#request(`/api/files?path=${encodeURIComponent(path)}`); }
  attach(path) { return this.#send("/api/files/attach", { path }); }
  write(path, content, overwrite = false) { return this.#send("/api/files/write", { path, content, overwrite }); }

  settings() { return this.#request("/api/settings"); }
  configure(provider, { apiKey, model }) { return this.#send("/api/settings/providers", { provider, apiKey, model }); }
  forget(provider) { return this.#send("/api/settings/providers", { provider }, "DELETE"); }
  testProvider(provider) { return this.#send("/api/settings/test", { provider }); }
}
