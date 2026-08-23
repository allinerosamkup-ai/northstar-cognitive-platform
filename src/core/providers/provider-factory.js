import { DemoProvider } from "./demo-provider.js";
import { OpenAIProvider, AnthropicProvider, GeminiProvider } from "./api-providers.js";

// One entry per resident: how it is configured, what it is called, and what it
// contributes in demo mode. The Settings view is generated from this list, so a
// fourth provider only has to be added here.
export const PROVIDERS = [
  {
    id: "gpt",
    label: "GPT",
    vendor: "openai",
    keyName: "OPENAI_API_KEY",
    modelName: "OPENAI_MODEL",
    defaultModel: "gpt-4o",
    perspective: "Strategy and synthesis",
    Provider: OpenAIProvider,
    keysUrl: "https://platform.openai.com/api-keys"
  },
  {
    id: "claude",
    label: "Claude",
    vendor: "anthropic",
    keyName: "ANTHROPIC_API_KEY",
    modelName: "ANTHROPIC_MODEL",
    defaultModel: "claude-opus-5",
    perspective: "Architecture and critical review",
    Provider: AnthropicProvider,
    keysUrl: "https://console.anthropic.com/settings/keys"
  },
  {
    id: "gemini",
    label: "Gemini",
    vendor: "google",
    keyName: "GEMINI_API_KEY",
    modelName: "GEMINI_MODEL",
    defaultModel: "gemini-3.6-flash",
    perspective: "Research and evidence",
    Provider: GeminiProvider,
    keysUrl: "https://aistudio.google.com/apikey"
  }
];

export const providerSpec = id => PROVIDERS.find(entry => entry.id === id);

// Live residency makes one API call per resident per event purely to acknowledge
// it, which multiplies cost without adding capability — work() already carries
// the full context in its prompt. Off unless someone deliberately turns it on.
const residencyEnabled = env => env.LIVE_RESIDENCY === "true";

export function createResidentProvider(spec, env = process.env) {
  const apiKey = env[spec.keyName];
  const model = env[spec.modelName] || spec.defaultModel;
  if (!apiKey) return { id: spec.id, model: spec.label, provider: new DemoProvider(spec.vendor, spec.perspective) };
  return {
    id: spec.id,
    model,
    provider: new spec.Provider({ apiKey, model, live: residencyEnabled(env) })
  };
}

export function createResidentProviders(env = process.env) {
  return PROVIDERS.map(spec => createResidentProvider(spec, env));
}
