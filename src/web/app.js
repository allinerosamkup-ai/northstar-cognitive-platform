const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const colors = { gpt: "#d9ff43", claude: "#ff6b4a", gemini: "#6a8cff" };

let topology = "composite";
let snapshot = null;
let renderedVersion = -1;
let pending = null;
let folder = ".";
let busy = false;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}
function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

/* ---------------------------------------------------------------- transport */

// The server answers errors as JSON, but a proxy or a crash can answer HTML.
// Reading the body as text first means a non-JSON error surfaces as a real
// message instead of a raw parser exception.
async function request(url, options) {
  let response;
  // A rejected fetch means the server is unreachable, and the browser's own wording
  // for that ("Failed to fetch") tells a person nothing they can act on.
  try { response = await fetch(url, options); }
  catch { throw new Error("Could not reach the project. Is the server still running?"); }
  const raw = await response.text();
  let value;
  try { value = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(response.ok ? "The server sent a response we could not read" : `Server error ${response.status}`); }
  if (!response.ok) {
    const failure = new Error(value.error ?? `Server error ${response.status}`);
    failure.status = response.status;
    throw failure;
  }
  return value;
}
const post = (url, data) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const remove = (url, data) => request(url, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

/* ------------------------------------------------------------------ routing */

function showView(name) {
  $$("[data-view-panel]").forEach(panel => { panel.hidden = panel.dataset.viewPanel !== name; });
  $$(".rail-item").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  if (name === "artifacts") loadFolder(folder).catch(showFileError);
}

/* ------------------------------------------------------------- conversation */

function bubble(event) {
  const collective = event.payload?.kind === "collective-result";
  if (event.type === "message.created") {
    return `<article class="bubble from-user"><div class="bubble-body">${escapeHtml(event.payload.text)}</div></article>`;
  }
  if (event.type === "file.attached") {
    return `<article class="bubble from-system"><div class="bubble-body">Added <b>${escapeHtml(event.payload.path)}</b> to the project. Every resident can see it now.</div></article>`;
  }
  if (event.type === "resident.paused") {
    return `<article class="bubble from-warning"><div class="bubble-body"><b>${escapeHtml(event.payload.residentId)}</b> could not answer this time — ${escapeHtml(event.payload.reason ?? "its provider failed")}. The others carried on.</div></article>`;
  }
  if (event.type === "document.revised") {
    return `<article class="bubble from-system"><div class="bubble-body">Built revision ${event.payload.version} of <b>${escapeHtml(event.payload.title)}</b>.</div></article>`;
  }
  const who = collective ? "All intelligences together" : (event.payload?.model ?? event.actorId);
  const takeover = event.payload?.takeover
    ? `<p class="takeover">Continued from where the previous intelligence stopped.</p>` : "";
  return `<article class="bubble from-ai ${collective ? "collective" : ""}" style="--who:${colors[event.actorId] ?? "#bbb"}">
    <div class="bubble-who">${escapeHtml(who)}</div>
    <div class="bubble-body">${takeover}${escapeHtml(event.payload?.text ?? "")}</div>
  </article>`;
}

function renderConversation() {
  const shown = snapshot.events.filter(event =>
    event.type === "message.created" ||
    event.type === "file.attached" ||
    event.type === "document.revised" ||
    event.type === "resident.paused" ||
    (event.type === "contribution.created" && (event.payload?.kind === "collective-result" || event.payload?.kind === "llm-contribution" || event.payload?.taskId)));

  const timeline = $("#timeline");
  const parts = shown.length
    ? shown.map(bubble)
    : [`<article class="bubble from-system"><div class="bubble-body">Every resident intelligence is present and sharing one context. Ask anything to begin.</div></article>`];

  if (pending) {
    parts.push(`<article class="bubble from-user"><div class="bubble-body">${escapeHtml(pending)}</div></article>`);
    parts.push(`<article class="bubble from-ai thinking"><div class="bubble-who">Working</div><div class="bubble-body"><i></i><i></i><i></i></div></article>`);
  }
  timeline.innerHTML = parts.join("");
  timeline.scrollTop = timeline.scrollHeight;
}

function showConversationError(message) {
  const timeline = $("#timeline");
  timeline.insertAdjacentHTML("beforeend",
    `<article class="bubble from-error"><div class="bubble-body">${escapeHtml(message)}</div></article>`);
  timeline.scrollTop = timeline.scrollHeight;
}

/* -------------------------------------------------------------- other views */

function renderResidents() {
  $("#residents").innerHTML = snapshot.residents.map(resident => `
    <article class="resident" data-resident="${escapeHtml(resident.id)}" style="--resident-color:${colors[resident.id] ?? "#ddd"}">
      <div class="resident-avatar">${escapeHtml(resident.model.slice(0, 2).toUpperCase())}</div>
      <div><h3>${escapeHtml(resident.model)}</h3><p>${resident.live ? "live" : "demo"} · heard through #${resident.cursor}</p></div>
      <span class="status ${resident.status === "paused" ? "status-paused" : ""}">${resident.status === "paused" ? "not answering" : escapeHtml(resident.status)}</span>
    </article>`).join("");
}

// The cursor advancing is the shared brain working. Flash the cards that moved so
// it reads as "everyone heard that", not a number quietly changing.
function flagResidentsThatHeard(previous) {
  if (!previous) return;
  for (const resident of snapshot.residents) {
    const before = previous.find(item => item.id === resident.id);
    if (!before || before.cursor === resident.cursor) continue;
    const card = $(`[data-resident="${resident.id}"]`);
    if (!card) continue;
    card.classList.remove("heard");
    void card.offsetWidth;
    card.classList.add("heard");
  }
}

function renderBrain() {
  const files = snapshot.events.filter(event => event.type === "file.attached");
  $("#project-name").textContent = snapshot.project.name;
  $("#project-purpose").textContent = snapshot.project.purpose;
  $("#project-version").textContent = `V${snapshot.state.version}`;
  $("#event-count").textContent = snapshot.events.length;
  $("#decision-count").textContent = snapshot.state.decisions.length;
  $("#file-count").textContent = files.length;
  $("#decisions").innerHTML = snapshot.state.decisions.length
    ? snapshot.state.decisions.map(decision => `<div class="decision">${escapeHtml(decision)}</div>`).join("")
    : '<div class="decision empty">No canonical decisions yet.</div>';
  $("#event-log").innerHTML = snapshot.events.length
    ? [...snapshot.events].reverse().map(event => `
      <div class="log-row">
        <span class="log-seq">#${String(event.sequence).padStart(3, "0")}</span>
        <span class="log-type">${escapeHtml(event.type)}</span>
        <span class="log-actor">${escapeHtml(event.actorId)}</span>
      </div>`).join("")
    : '<div class="decision empty">No events yet.</div>';
  $("#attached-list").innerHTML = files.length
    ? files.map(event => `<div class="decision">${escapeHtml(event.payload.path)} <span class="muted">${formatSize(event.payload.size)} · event #${event.sequence}</span></div>`).join("")
    : '<div class="decision empty">No files attached yet.</div>';
}

/* ------------------------------------------------------------------ session */

function renderSession() {
  const open = snapshot.state.session;
  const cost = snapshot.sessionCost;
  $("#session-cost").textContent = cost
    ? (cost.liveParticipants
        ? `${cost.deliberationCalls} provider calls per session`
        : "all residents on demo — a session costs nothing")
    : "";

  if (!open) {
    $("#session-body").innerHTML = '<p class="empty-document">No open session. Ask the room something and they will work it through together.</p>';
    return;
  }

  const voices = list => list.map(item => `
    <article class="voice">
      <div class="voice-who">${escapeHtml(item.model ?? item.residentId)}</div>
      <div class="voice-body">${renderMarkdown(item.text)}</div>
    </article>`).join("");

  $("#session-body").innerHTML = `
    <p class="session-question">${escapeHtml(open.question)}</p>

    <div class="brain-block"><h3>What each one proposed</h3>${voices(open.proposals)}</div>
    ${open.critiques.length ? `<div class="brain-block"><h3>How they answered each other</h3>${voices(open.critiques)}</div>` : ""}
    ${open.unavailable.map(missing => `<p class="session-missing">${escapeHtml(missing.model ?? missing.residentId)} could not take part — ${escapeHtml(missing.error)}</p>`).join("")}

    <div class="brain-block">
      <h3>Conclusion${open.synthesisBy ? ` · written by ${escapeHtml(open.synthesisBy)}` : ""}</h3>
      <div class="conclusion">${renderMarkdown(open.synthesis.conclusion || "(none)")}</div>
      ${open.synthesis.agreed.length ? `<h4 class="mini-heading">Agreed</h4><ul class="plain-list">${open.synthesis.agreed.map(point => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}
      ${open.synthesis.unresolved.length ? `
        <h4 class="mini-heading unresolved-heading">Still unresolved — yours to settle</h4>
        <ul class="plain-list">${open.synthesis.unresolved.map(point => `<li><b>${escapeHtml(point.topic)}</b>${point.detail ? ` — ${escapeHtml(point.detail)}` : ""}</li>`).join("")}</ul>` : ""}
    </div>

    <form id="resolve-form" class="composer build-composer">
      <label for="resolve-decision">Nothing is decided until you say so</label>
      <div>
        <textarea id="resolve-decision" rows="2" placeholder="Leave empty to accept their conclusion, or write your own decision here."></textarea>
        <button type="submit" id="resolve">Decide</button>
      </div>
    </form>`;
}

function renderAssignment() {
  const proposal = snapshot.state.assignment;
  if (!proposal) {
    $("#assignment-body").innerHTML = "";
    return;
  }
  const confirmed = proposal.status === "confirmed";
  $("#assignment-body").innerHTML = `
    <div class="assignment ${confirmed ? "confirmed" : ""}">
      <div class="assignment-head">
        <span class="badge ${confirmed ? "badge-live" : ""}">${confirmed ? "confirmed" : `proposed${proposal.dividedBy ? ` by ${escapeHtml(proposal.dividedBy)}` : ""}`}</span>
      </div>
      ${proposal.assignments.map(item => `
        <div class="decision">
          <b>${escapeHtml(item.phase)}</b> → ${escapeHtml(item.residentId)}
          ${item.reason ? `<span class="muted">${escapeHtml(item.reason)}</span>` : ""}
        </div>`).join("")}
      ${proposal.unassigned?.length ? `<p class="session-missing">Nobody was given: ${escapeHtml(proposal.unassigned.join(", "))}</p>` : ""}
      ${confirmed ? "" : `<button type="button" id="confirm-division">Approve this division</button>`}
    </div>`;
}

function showSessionStatus(message, failed = false) {
  const status = $("#session-status");
  status.textContent = message;
  status.classList.toggle("failed", failed);
}

async function runSession(field, run) {
  if (busy) return;
  const value = field.value.trim();
  if (!value) return;
  busy = true;
  field.disabled = true;
  showSessionStatus("The residents are working through it…");
  try {
    applySnapshot((await run(value)).snapshot);
    field.value = "";
    showSessionStatus("");
  } catch (error) {
    showSessionStatus(error.message, true);
  } finally {
    busy = false;
    field.disabled = false;
  }
}

/* ----------------------------------------------------------------- document */

function renderDocument() {
  const current = snapshot.state.document;
  const revisions = snapshot.events.filter(event => event.type === "document.revised");

  $("#document-title").textContent = current?.title ?? "Project document";
  $("#document-version").textContent = current ? `Revision ${current.version}` : "No revisions yet";
  $("#document-contributors").textContent = current?.contributors?.length
    ? `Built by ${current.contributors.join(", ")}`
    : "";
  $("#save-document").hidden = !current;

  $("#document-body").innerHTML = current?.markdown
    ? renderMarkdown(current.markdown)
    : '<p class="empty-document">Nothing built yet. Describe what this project should produce, and the intelligences write the first revision together.</p>';

  const files = current ? filesFromMarkdown(current.markdown) : [];
  $("#proposed-files-block").hidden = files.length === 0;
  $("#proposed-files").innerHTML = files.map(file => `
    <div class="decision proposed-file">
      <span>${escapeHtml(file.path)}</span>
      <button type="button" data-write="${escapeHtml(file.path)}">Save to disk</button>
    </div>`).join("");

  $("#revision-history").innerHTML = revisions.length
    ? [...revisions].reverse().map(event => `
      <div class="decision">
        <b>Revision ${event.payload.version}</b> · ${escapeHtml(event.payload.title)}
        <span class="muted">event #${event.sequence} · ${escapeHtml((event.payload.contributors ?? []).join(", "))}</span>
      </div>`).join("")
    : '<div class="decision empty">No revisions yet.</div>';
}

// Just enough markdown to read a document: headings, lists, code, emphasis.
// The source is escaped before any of this runs, so rendering can only ever add
// structure — never markup the model wrote.
function renderMarkdown(markdown) {
  const inline = text => text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const blocks = [];
  for (const chunk of escapeHtml(markdown).split(/\n{2,}/)) {
    const block = chunk.trim();
    if (!block) continue;

    if (block.startsWith("```")) {
      const code = block.replace(/^```[\w+-]*[^\n]*\n?/, "").replace(/```\s*$/, "");
      blocks.push(`<pre><code>${code.trim()}</code></pre>`);
      continue;
    }
    const heading = block.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const lines = block.split("\n");
    const items = lines.filter(line => /^\s*[-*]\s+/.test(line));
    if (items.length && items.length === lines.length) {
      blocks.push(`<ul>${items.map(item => `<li>${inline(item.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`);
      continue;
    }
    blocks.push(`<p>${inline(block).split("\n").join("<br>")}</p>`);
  }
  return blocks.join("");
}

// Mirrors the server's parser so the interface offers exactly the files the
// server would accept.
function filesFromMarkdown(markdown) {
  const pattern = /(?:^|\n)(?:(?:\*\*)?([\w./-]+\.[\w]{1,8})(?:\*\*)?\s*:?\s*\n+)?```[\w+-]*(?:\s+path=("?)([^\s"`]+)\2)?\s*\n([\s\S]*?)```/g;
  const files = [];
  const seen = new Set();
  for (const match of String(markdown ?? "").matchAll(pattern)) {
    const path = match[3] ?? match[1];
    const content = match[4];
    if (!path || !/\.[\w]{1,8}$/.test(path) || path.startsWith("/") || path.includes("..") || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, content: content.replace(/\s+$/, "") });
  }
  return files;
}

/* ----------------------------------------------------------------- settings */

function renderSettings() {
  const settings = snapshot.settings ?? { providers: [] };
  const environment = snapshot.environment ?? {};

  $("#provider-settings").innerHTML = settings.providers.map(provider => `
    <form class="provider-card" data-provider="${escapeHtml(provider.id)}">
      <div class="provider-head">
        <h3>${escapeHtml(provider.label)}</h3>
        <span class="badge ${provider.configured ? "badge-live" : ""}">${provider.configured ? "live provider" : "demo mode"}</span>
      </div>
      <label>
        <span>API key${provider.configured ? ` — currently ${escapeHtml(provider.keyHint)}` : ""}</span>
        <input type="password" name="apiKey" autocomplete="off" spellcheck="false"
          placeholder="${provider.configured ? "Enter a new key to replace it" : "Paste your key"}">
      </label>
      <label>
        <span>Model</span>
        <input type="text" name="model" value="${escapeHtml(provider.model)}" spellcheck="false">
      </label>
      <div class="provider-actions">
        <button type="submit">Save</button>
        <button type="button" data-action="test"${provider.configured ? "" : " disabled"}>Test connection</button>
        <button type="button" data-action="clear" class="danger"${provider.configured ? "" : " disabled"}>Remove key</button>
        <a href="${escapeHtml(provider.keysUrl)}" target="_blank" rel="noreferrer noopener">Get a key</a>
      </div>
      <p class="provider-result" data-result></p>
    </form>`).join("");

  $("#settings-environment").innerHTML = [
    ["Configuration file", settings.envPath],
    ["Project brain", environment.dataPath],
    ["Workspace folder", environment.workspacePath],
    ["Live residency", settings.liveResidency
      ? "on — every resident calls its provider on every event, which multiplies cost"
      : "off — the context travels with each request instead"]
  ].map(([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(String(value ?? "—"))}</dd></div>`).join("");
}

/* -------------------------------------------------------------------- files */

function showFileError(error) {
  $("#file-list").innerHTML = `<div class="decision empty">${escapeHtml(error.message)}</div>`;
}

async function loadFolder(path) {
  const listing = await request(`/api/files?path=${encodeURIComponent(path)}`);
  folder = listing.path || ".";
  const segments = folder === "." ? [] : folder.split("/");
  $("#breadcrumb").innerHTML = [
    `<button data-path=".">workspace</button>`,
    ...segments.map((segment, index) =>
      `<button data-path="${escapeHtml(segments.slice(0, index + 1).join("/"))}">${escapeHtml(segment)}</button>`)
  ].join('<span aria-hidden="true">/</span>');

  const up = folder === "." ? "" :
    `<button class="file-row" data-folder="${escapeHtml(segments.slice(0, -1).join("/") || ".")}"><span class="file-icon">↰</span><span>..</span></button>`;
  $("#file-list").innerHTML = up + (listing.items.length
    ? listing.items.map(item => item.directory
      ? `<button class="file-row" data-folder="${escapeHtml(item.path)}"><span class="file-icon">▸</span><span>${escapeHtml(item.name)}</span></button>`
      : `<button class="file-row" data-file="${escapeHtml(item.path)}"><span class="file-icon">◇</span><span>${escapeHtml(item.name)}</span><span class="muted">${formatSize(item.size)}</span></button>`).join("")
    : '<div class="decision empty">This folder is empty.</div>');
}

async function attachFile(path) {
  const result = await post("/api/files/attach", { path });
  applySnapshot(result.snapshot);
  const note = $("#attached-note");
  note.textContent = `${result.file.path} added to the project`;
  note.hidden = false;
  setTimeout(() => { note.hidden = true; }, 4000);
}

// Overwriting is the one action here that can destroy work, so a conflict always
// becomes a question rather than a silent replacement.
async function writeFile(path, content) {
  try {
    return await post("/api/files/write", { path, content });
  } catch (error) {
    if (error.status !== 409) throw error;
    if (!confirm(`${path} already exists. Replace it?`)) return null;
    return post("/api/files/write", { path, content, overwrite: true });
  }
}

/* ----------------------------------------------------------------- snapshot */

function applySnapshot(value) {
  const previous = snapshot?.residents;
  snapshot = value;
  renderedVersion = value.state.version;
  renderConversation();
  renderResidents();
  flagResidentsThatHeard(previous);
  renderBrain();
  renderDocument();
  renderSession();
  renderAssignment();
  renderSettings();
}

// Background polling fails silently by design, but silence is the wrong signal:
// a person would keep reading a frozen screen believing it was current.
function showConnection(connected) {
  document.querySelector(".cloud")?.classList.toggle("offline", !connected);
  const label = document.querySelector(".cloud span");
  if (label) label.textContent = connected ? "LIVE" : "OFFLINE";
}

async function refresh({ force = false } = {}) {
  try {
    const value = await request("/api/snapshot");
    showConnection(true);
    if (!force && value.state.version === renderedVersion) return;
    applySnapshot(value);
  } catch (error) {
    showConnection(false);
    throw error;
  }
}

/* ----------------------------------------------------------------- handlers */

$$(".rail-item").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
$("#open-settings").addEventListener("click", () => showView("settings"));

$$("[data-topology]").forEach(button => button.addEventListener("click", () => {
  topology = button.dataset.topology;
  $$("[data-topology]").forEach(item => item.classList.toggle("selected", item === button));
}));

$("#breadcrumb").addEventListener("click", event => {
  const button = event.target.closest("[data-path]");
  if (button) loadFolder(button.dataset.path).catch(showFileError);
});
$("#file-list").addEventListener("click", event => {
  const row = event.target.closest("[data-folder],[data-file]");
  if (!row) return;
  if (row.dataset.folder !== undefined) loadFolder(row.dataset.folder).catch(showFileError);
  else attachFile(row.dataset.file).catch(showFileError);
});

async function send() {
  if (busy) return;
  const field = $("#message");
  const text = field.value.trim();
  if (!text) return;

  busy = true;
  pending = text;
  field.value = "";
  field.disabled = true;
  $("#send").disabled = true;
  renderConversation();

  try {
    const result = await post("/api/chat", { text, topology });
    pending = null;
    applySnapshot(result.snapshot);
  } catch (error) {
    pending = null;
    field.value = text;               // never lose what the person wrote
    renderConversation();
    showConversationError(error.message);
  } finally {
    busy = false;
    field.disabled = false;
    $("#send").disabled = false;
    field.focus();
  }
}

$("#message-form").addEventListener("submit", event => { event.preventDefault(); send(); });
$("#message").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
});

/* -------------------------------------------------------------------- build */

function showBuildStatus(message, failed = false) {
  const status = $("#document-contributors");
  status.textContent = message;
  status.classList.toggle("failed", failed);
}

async function build() {
  if (busy) return;
  const field = $("#build-instruction");
  const instruction = field.value.trim();
  if (!instruction) return;

  busy = true;
  field.disabled = true;
  $("#build").disabled = true;
  showBuildStatus("The intelligences are building…");

  try {
    const result = await post("/api/build", { instruction, topology });
    field.value = "";
    applySnapshot(result.snapshot);
  } catch (error) {
    showBuildStatus(error.message, true);
  } finally {
    busy = false;
    field.disabled = false;
    $("#build").disabled = false;
  }
}

$("#build-form").addEventListener("submit", event => { event.preventDefault(); build(); });
$("#build-instruction").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); build(); }
});

$("#save-document").addEventListener("click", async () => {
  const current = snapshot.state.document;
  if (!current) return;
  // Into its own folder: dropping generated files beside the README pollutes the
  // repository and invites an accidental commit.
  const slug = (current.title || "project-document")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-");
  try {
    const result = await writeFile(`documents/${slug || "project-document"}.md`, current.markdown);
    if (result) showBuildStatus(`Saved to ${result.file.path}`);
  } catch (error) {
    showBuildStatus(error.message, true);
  }
});

$("#proposed-files").addEventListener("click", async event => {
  const button = event.target.closest("[data-write]");
  if (!button) return;
  const file = filesFromMarkdown(snapshot.state.document?.markdown).find(item => item.path === button.dataset.write);
  if (!file) return;
  button.disabled = true;
  try {
    const result = await writeFile(file.path, file.content);
    button.textContent = result ? "Saved" : "Save to disk";
    button.disabled = Boolean(result);
  } catch (error) {
    button.disabled = false;
    showBuildStatus(error.message, true);
  }
});

/* -------------------------------------------------------- settings handlers */

function providerResult(form, message, failed = false) {
  const result = form?.querySelector("[data-result]");
  if (!result) return;
  result.textContent = message;
  result.classList.toggle("failed", failed);
}

$("#provider-settings").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target.closest(".provider-card");
  const provider = form.dataset.provider;
  const apiKey = form.elements.apiKey.value.trim();
  const model = form.elements.model.value.trim();
  if (!apiKey) return providerResult(form, "Paste a key before saving.", true);

  providerResult(form, "Saving…");
  try {
    applySnapshot((await post("/api/settings/providers", { provider, apiKey, model })).snapshot);
    // The card list re-renders, so the message goes on the fresh card.
    providerResult($(`.provider-card[data-provider="${provider}"]`),
      "Saved. Use Test connection to confirm the key and model work.");
  } catch (error) {
    providerResult(form, error.message, true);
  }
});

$("#provider-settings").addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const form = button.closest(".provider-card");
  const provider = form.dataset.provider;

  if (button.dataset.action === "test") {
    providerResult(form, "Contacting the provider…");
    button.disabled = true;
    try {
      const result = await post("/api/settings/test", { provider });
      providerResult(form, result.ok ? `Working. ${result.model} replied.` : `Failed: ${result.error}`, !result.ok);
    } catch (error) {
      providerResult(form, error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  if (button.dataset.action === "clear") {
    if (!confirm("Remove this key and return the resident to demo mode?")) return;
    try {
      applySnapshot((await remove("/api/settings/providers", { provider })).snapshot);
    } catch (error) {
      providerResult(form, error.message, true);
    }
  }
});


/* --------------------------------------------------------- session handlers */

$("#meet-form").addEventListener("submit", event => {
  event.preventDefault();
  runSession($("#meet-question"), question => post("/api/deliberate", { question }));
});
$("#meet-question").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#meet-form").requestSubmit(); }
});

$("#divide-form").addEventListener("submit", event => {
  event.preventDefault();
  runSession($("#divide-phases"), value =>
    post("/api/assign", { phases: value.split("|").map(part => part.trim()).filter(Boolean) }));
});

// The decision form and the approve button are rendered with the session, so
// they are reached by delegation rather than bound once at load.
$("#session-body").addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id !== "resolve-form") return;
  const field = $("#resolve-decision");
  if (busy) return;
  busy = true;
  try {
    applySnapshot((await post("/api/deliberate/resolve", { decision: field.value.trim() || undefined })).snapshot);
  } catch (error) {
    showSessionStatus(error.message, true);
  } finally {
    busy = false;
  }
});

$("#assignment-body").addEventListener("click", async event => {
  if (!event.target.closest("#confirm-division")) return;
  try {
    applySnapshot((await post("/api/assign/confirm", {})).snapshot);
  } catch (error) {
    showSessionStatus(error.message, true);
  }
});

/* ------------------------------------------------------------ drag and drop */

const room = $(".room");
["dragenter", "dragover"].forEach(name => room.addEventListener(name, event => {
  event.preventDefault();
  room.classList.add("dropping");
}));
["dragleave", "drop"].forEach(name => room.addEventListener(name, () => room.classList.remove("dropping")));
room.addEventListener("drop", async event => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  // A browser hands over the content but never a usable absolute path, so dropped
  // bytes go straight into the project instead of through the workspace reader.
  try {
    const text = await file.text();
    const result = await post("/api/messages", { text: `Attached file ${file.name}:\n\n${text.slice(0, 200000)}` });
    applySnapshot(result.snapshot);
  } catch (error) {
    showConversationError(error.message);
  }
});

/* -------------------------------------------------------------------- start */

refresh({ force: true })
  .catch(error => showConversationError(`Could not reach the project: ${error.message}`));

setInterval(() => { if (!busy) refresh().catch(() => {}); }, 3000);
