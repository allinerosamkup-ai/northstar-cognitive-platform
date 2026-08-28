import { join } from "node:path";
import { createPlatformServer } from "./platform/server.js";
import { readEnvFile, mergeEnv } from "./platform/env-file.js";
import { PROVIDERS } from "./core/providers/provider-factory.js";

const envPath = process.env.COGNITIVE_ENV_PATH ?? join(process.cwd(), ".env");
const env = mergeEnv(await readEnvFile(envPath), process.env);

function getPort() {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");

  if (portIndex !== -1 && args[portIndex + 1]) {
    return Number(args[portIndex + 1]);
  }

  return Number(env.PORT || 4310);
}

const dataPath = env.COGNITIVE_DATA_PATH ?? join(process.cwd(), "data", "project-brain.jsonl");
const port = getPort();
const workspacePath = env.COGNITIVE_WORKSPACE_PATH ?? process.cwd();

const app = await createPlatformServer({ dataPath, port, workspacePath, envPath, processEnv: process.env });
await app.start();

const live = PROVIDERS.filter(spec => env[spec.keyName]).map(spec => spec.label);
console.log(`Northstar Cognitive Project is live at http://127.0.0.1:${app.port}`);
console.log(`Project: ${app.project.name} · One context · Three resident intelligences`);
console.log(`Workspace: ${workspacePath}`);
console.log(live.length
  ? `Live providers: ${live.join(", ")} · the rest answer with demo responses`
  : `All residents are in demo mode. Add API keys in Settings to use real intelligences.`);
