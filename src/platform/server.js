import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { FileProjectBrain } from "../core/file-project-brain.js";
import { CognitiveMesh } from "../core/cognitive-mesh.js";
import { CognitiveArchitect } from "../core/cognitive-architect.js";
import { createResidentProviders } from "../core/providers/provider-factory.js";
import { ContinuityManager } from "../core/continuity.js";
import { Workspace, PathOutsideWorkspaceError, AttachmentRejectedError, FileExistsError } from "./files.js";
import { Settings } from "./settings.js";
import { parseRevision, proposedFiles, nextRevision, buildPrompt } from "../core/document.js";
import { WorkingSession } from "../core/session.js";
import { callCount } from "../core/deliberation.js";
import { assignmentCost } from "../core/assignment.js";
import { validateAgent, agentBriefing, specialise, AgentRejectedError } from "../core/agents.js";
import { skillsFrom, briefingSkills } from "../core/skills.js";

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function createPlatformServer({ dataPath, port = 4310, workspacePath = process.cwd(), envPath = join(process.cwd(), ".env"), processEnv = process.env }) {
  const brain = new FileProjectBrain(dataPath);
  let [project] = await brain.listProjects();
  if (!project) project = await brain.createProject({ name: "Northstar", purpose: "Build a model-independent cognitive project platform" });
  const mesh = new CognitiveMesh(brain);
  const settings = await Settings.load({ envPath, processEnv });
  const baseResidents = createResidentProviders(settings.values);
  for (const resident of baseResidents) await mesh.addResident(project.id, resident);

  // A dedicated agent is a resident with a job. It is recorded in the log, so
  // restoring the room after a restart means replaying those events — the agents
  // a person created must not evaporate with the process.
  const dedicated = new Map();
  const briefingFor = async spec => agentBriefing({
    ...spec, skills: briefingSkills(await brain.eventsSince(project.id, 0))
  });
  const raise = async spec => {
    const backing = baseResidents.find(resident => resident.id === spec.backedBy) ?? baseResidents[0];
    const resident = {
      id: spec.id,
      model: `${spec.role} (${backing.model})`,
      provider: specialise(backing.provider, await briefingFor(spec))
    };
    await mesh.addResident(project.id, resident);
    dedicated.set(spec.id, spec);
    return resident;
  };
  for (const event of await brain.eventsSince(project.id, 0)) {
    if (event.type === "agent.created") await raise(event.payload);
    if (event.type === "agent.dismissed") { mesh.dismiss(project.id, event.payload.id); dedicated.delete(event.payload.id); }
  }
  const architect = new CognitiveArchitect(mesh, brain);
  const continuity = new ContinuityManager(mesh, brain);
  const session = new WorkingSession(mesh, brain);
  const workspace = new Workspace(workspacePath);
  let server;
  const snapshot = async () => ({
    project,
    state: await brain.getState(project.id),
    events: await brain.eventsSince(project.id, 0),
    residents: mesh.residents(project.id).map(({ provider, ...resident }) => ({ ...resident, provider: provider.name, live: Boolean(provider.apiKey) })),
    settings: settings.describe(),
    environment: { dataPath, workspacePath: workspace.root },
    sessionCost: sessionCost(),
    agents: [...dedicated.values()],
    skills: skillsFrom(await brain.eventsSince(project.id, 0))
  });

  // What a working session will spend, so it is on screen before anyone starts one.
  const sessionCost = () => {
    const participants = mesh.residents(project.id).filter(resident => resident.provider.apiKey).length;
    return {
      liveParticipants: participants,
      deliberationCalls: callCount(participants),
      assignmentCalls: assignmentCost(participants)
    };
  };

  // Collects the files a person attached, so a build can actually work from them.
  const attachments = async () => (await brain.eventsSince(project.id, 0))
    .filter(event => event.type === "file.attached")
    .map(event => ({ path: event.payload.path, content: event.payload.content }));

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/snapshot") return json(response, 200, await snapshot());
      if (request.method === "POST" && url.pathname === "/api/messages") {
        const input = await body(request);
        if (!input.text?.trim()) return json(response, 400, { error: "Message text is required" });
        const event = await mesh.publish(project.id, { type: "message.created", actorId: "user", payload: { text: input.text.trim() } });
        return json(response, 201, { event, snapshot: await snapshot() });
      }
      if (request.method === "POST" && url.pathname === "/api/decisions") {
        const input = await body(request);
        const event = await mesh.publish(project.id, { type: "decision.created", actorId: "user", payload: { statement: input.statement } });
        return json(response, 201, { event, snapshot: await snapshot() });
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(response, 200, settings.describe());
      }
      if (request.method === "POST" && url.pathname === "/api/settings/providers") {
        const input = await body(request);
        const replacement = await settings.save(input.provider, { apiKey: input.apiKey, model: input.model });
        await mesh.replaceProvider(project.id, replacement.id, replacement);
        await mesh.publish(project.id, { type: "settings.changed", actorId: "user", payload: { provider: replacement.id, configured: true } });
        return json(response, 200, { settings: settings.describe(), snapshot: await snapshot() });
      }
      if (request.method === "DELETE" && url.pathname === "/api/settings/providers") {
        const input = await body(request);
        const replacement = await settings.clear(input.provider);
        await mesh.replaceProvider(project.id, replacement.id, replacement);
        await mesh.publish(project.id, { type: "settings.changed", actorId: "user", payload: { provider: replacement.id, configured: false } });
        return json(response, 200, { settings: settings.describe(), snapshot: await snapshot() });
      }
      if (request.method === "POST" && url.pathname === "/api/settings/test") {
        const input = await body(request);
        return json(response, 200, await settings.test(input.provider));
      }
      // The residents read and answer each other, then one writes the conclusion.
      // What comes back is a proposal: nothing is decided until a person says so.
      if (request.method === "GET" && url.pathname === "/api/agents") {
        return json(response, 200, {
          agents: [...dedicated.values()],
          backing: baseResidents.map(resident => ({ id: resident.id, model: resident.model })),
          skills: skillsFrom(await brain.eventsSince(project.id, 0))
        });
      }
      if (request.method === "POST" && url.pathname === "/api/agents") {
        const input = await body(request);
        const spec = validateAgent(input, mesh.residents(project.id).map(resident => resident.id));
        spec.backedBy = baseResidents.some(resident => resident.id === input.backedBy) ? input.backedBy : baseResidents[0].id;
        await raise(spec);
        await mesh.publish(project.id, { type: "agent.created", actorId: "user", payload: spec });
        return json(response, 201, { agent: spec, snapshot: await snapshot() });
      }
      if (request.method === "DELETE" && url.pathname === "/api/agents") {
        const input = await body(request);
        if (!dedicated.has(input.id)) return json(response, 404, { error: `No dedicated agent called ${input.id}` });
        mesh.dismiss(project.id, input.id);
        dedicated.delete(input.id);
        await mesh.publish(project.id, { type: "agent.dismissed", actorId: "user", payload: { id: input.id } });
        return json(response, 200, { snapshot: await snapshot() });
      }
      if (request.method === "POST" && url.pathname === "/api/deliberate") {
        const input = await body(request);
        if (!input.question?.trim()) return json(response, 400, { error: "A question is required" });
        const result = await session.deliberate(project.id, {
          question: input.question.trim(),
          synthesisBy: input.synthesisBy,
          residentIds: input.residentIds
        });
        return json(response, 201, { session: result, snapshot: await snapshot() });
      }
      // Where the person has the last word: accept the conclusion, or take a
      // side on something the residents left unresolved.
      if (request.method === "POST" && url.pathname === "/api/deliberate/resolve") {
        const input = await body(request);
        const open = (await brain.getState(project.id)).session;
        if (!open) return json(response, 400, { error: "There is no open session to resolve" });
        const statement = (input.decision ?? open.synthesis.conclusion ?? "").trim();
        if (!statement) return json(response, 400, { error: "A decision is required" });

        await mesh.publish(project.id, {
          type: "decision.created", actorId: "user",
          payload: { statement, fromSession: open.sequence, question: open.question }
        });
        await mesh.publish(project.id, {
          type: "session.resolved", actorId: "user",
          payload: { sequence: open.sequence, accepted: !input.decision }
        });
        return json(response, 201, { snapshot: await snapshot() });
      }
      if (request.method === "POST" && url.pathname === "/api/assign") {
        const input = await body(request);
        const phases = (input.phases ?? []).map(phase => String(phase).trim()).filter(Boolean);
        if (phases.length < 2) return json(response, 400, { error: "At least two parts are needed to divide the work" });
        const result = await session.divide(project.id, {
          phases, residentIds: input.residentIds, dividedBy: input.dividedBy
        });
        return json(response, 201, { assignment: result, snapshot: await snapshot() });
      }
      // Confirming is what turns a proposed split into something the project
      // believes; the person may edit it on the way through.
      if (request.method === "POST" && url.pathname === "/api/assign/confirm") {
        const input = await body(request);
        const proposal = (await brain.getState(project.id)).assignment;
        if (!proposal) return json(response, 400, { error: "There is no proposed division to confirm" });
        const assignments = input.assignments?.length ? input.assignments : proposal.assignments;
        if (!assignments.length) return json(response, 400, { error: "An empty division cannot be confirmed" });

        const known = new Set(mesh.residents(project.id).map(resident => resident.id));
        const unknown = assignments.find(item => !known.has(item.residentId));
        if (unknown) return json(response, 400, { error: `No such resident: ${unknown.residentId}` });

        const event = await mesh.publish(project.id, {
          type: "assignment.confirmed", actorId: "user",
          payload: { kind: "assignment", assignments, phases: proposal.phases, status: "confirmed" }
        });
        return json(response, 201, { event, snapshot: await snapshot() });
      }
      // What a session will cost before anyone starts one.
      if (request.method === "GET" && url.pathname === "/api/session/cost") {
        return json(response, 200, sessionCost());
      }
      // The point of the product: the residents produce the project document
      // itself, revision by revision, rather than talking about it.
      if (request.method === "POST" && url.pathname === "/api/build") {
        const input = await body(request);
        if (!input.instruction?.trim()) return json(response, 400, { error: "An instruction is required" });
        const current = (await brain.getState(project.id)).document;
        const attached = await attachments();
        const prompt = buildPrompt({ instruction: input.instruction.trim(), document: current, attachments: attached });
        const run = await architect.run(project.id, {
          topology: input.topology ?? "composite",
          objective: prompt,
          residentIds: input.residentIds?.length ? input.residentIds : mesh.residents(project.id).map(item => item.id),
          kind: "build",
          instruction: input.instruction.trim(),
          document: current,
          attachments: attached
        });
        const parsed = parseRevision(run.synthesis, current?.title);
        const revision = nextRevision(current, {
          title: parsed.title,
          markdown: parsed.markdown,
          contributors: run.contributions.map(item => item.residentId)
        });
        await mesh.publish(project.id, { type: "document.revised", actorId: "cognitive-architect", payload: revision });
        return json(response, 201, { revision, files: proposedFiles(revision.markdown), snapshot: await snapshot() });
      }
      if (request.method === "POST" && url.pathname === "/api/files/write") {
        const input = await body(request);
        if (!input.path) return json(response, 400, { error: "A file path is required" });

        // An edit carries the modification time it was opened at. If the file
        // moved on since — another editor, a build, the residents — saving would
        // erase that change silently, so it stops and says so.
        if (input.expectedModifiedAt) {
          const current = await workspace.read(input.path).catch(() => null);
          if (current && Math.abs(current.modifiedAt - input.expectedModifiedAt) > 1) {
            return json(response, 409, {
              error: "This file changed since you opened it. Reload it to see the new version before saving.",
              path: input.path,
              staleEdit: true
            });
          }
        }
        const written = await workspace.write(input.path, input.content ?? "", { overwrite: Boolean(input.overwrite) });
        await mesh.publish(project.id, { type: "file.written", actorId: "user", payload: written });
        return json(response, 201, { file: written, snapshot: await snapshot() });
      }
      // One turn of the conversation: record what the user said, then let the room
      // answer with the chosen topology. A chat UI needs both halves atomically.
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const input = await body(request);
        if (!input.text?.trim()) return json(response, 400, { error: "Message text is required" });
        await mesh.publish(project.id, { type: "message.created", actorId: "user", payload: { text: input.text.trim() } });
        const result = await architect.run(project.id, {
          topology: input.topology ?? "composite",
          objective: input.text.trim(),
          residentIds: input.residentIds?.length ? input.residentIds : mesh.residents(project.id).map(item => item.id)
        });
        return json(response, 201, { result, snapshot: await snapshot() });
      }
      // Routes the work through ContinuityManager so a provider failure hands the
      // task to another resident that is already caught up, instead of failing.
      if (request.method === "POST" && url.pathname === "/api/work") {
        const input = await body(request);
        if (!input.objective?.trim()) return json(response, 400, { error: "An objective is required" });
        const residents = mesh.residents(project.id);
        const result = await continuity.execute(project.id, {
          taskId: input.taskId ?? `work:${Date.now()}`,
          prompt: input.objective.trim(),
          preferredResidentId: input.preferredResidentId ?? residents[0]?.id
        });
        return json(response, 201, { result, snapshot: await snapshot() });
      }
      if (request.method === "GET" && url.pathname === "/api/files") {
        return json(response, 200, await workspace.list(url.searchParams.get("path") ?? "."));
      }
      // Opening a file to edit it. Same boundary as everything else, and the
      // modification time comes with it so the editor can tell whether the file
      // changed underneath while it was open.
      if (request.method === "GET" && url.pathname === "/api/files/content") {
        const path = url.searchParams.get("path");
        if (!path) return json(response, 400, { error: "A file path is required" });
        return json(response, 200, await workspace.read(path));
      }
      if (request.method === "POST" && url.pathname === "/api/files/attach") {
        const input = await body(request);
        if (!input.path) return json(response, 400, { error: "A file path is required" });
        const file = await workspace.read(input.path);
        const event = await mesh.publish(project.id, {
          type: "file.attached",
          actorId: "user",
          payload: { path: file.path, size: file.size, content: file.content }
        });
        return json(response, 201, { event, file: { path: file.path, size: file.size }, snapshot: await snapshot() });
      }
      if (request.method === "POST" && url.pathname === "/api/collaborate") {
        const input = await body(request);
        const result = await architect.run(project.id, {
          topology: input.topology ?? "composite",
          objective: input.objective,
          residentIds: input.residentIds?.length ? input.residentIds : mesh.residents(project.id).map(item => item.id)
        });
        return json(response, 201, result);
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const webRoot = join(process.cwd(), "src", "web");
        try {
          const content = await readFile(join(webRoot, relative));
          response.writeHead(200, { "content-type": mime[extname(relative)] ?? "application/octet-stream" });
          return response.end(content);
        } catch {
          const content = await readFile(join(webRoot, "index.html"));
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return response.end(content);
        }
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof AgentRejectedError) return json(response, 400, { error: error.message });
      if (error instanceof PathOutsideWorkspaceError) return json(response, 403, { error: "That path is outside the workspace" });
      if (error instanceof FileExistsError) return json(response, 409, { error: error.message, path: error.path });
      if (error instanceof AttachmentRejectedError) return json(response, 400, { error: error.message });
      if (error.code === "ENOENT") return json(response, 404, { error: "No such file or folder" });
      json(response, 500, { error: error.message });
    }
  };

  return {
    project,
    brain,
    mesh,
    settings,
    get port() { return server?.address()?.port ?? port; },
    async start() { server = createServer(handler); await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); },
    async stop() { if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}
