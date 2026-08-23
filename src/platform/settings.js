import { readEnvFile, writeEnvValues, mergeEnv } from "./env-file.js";
import { PROVIDERS, providerSpec, createResidentProvider } from "../core/providers/provider-factory.js";

// Enough of the key to recognise which one is installed, never enough to use it.
function maskKey(key) {
  if (!key) return null;
  return key.length <= 8 ? "…" : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export class Settings {
  constructor({ envPath, values }) {
    this.envPath = envPath;
    this.values = values;
  }

  static async load({ envPath, processEnv = process.env }) {
    return new Settings({ envPath, values: mergeEnv(await readEnvFile(envPath), processEnv) });
  }

  // The only shape that leaves the server. There is no route, and no branch,
  // that returns an api key: a key travels inwards only.
  describe() {
    return {
      envPath: this.envPath,
      liveResidency: this.values.LIVE_RESIDENCY === "true",
      providers: PROVIDERS.map(spec => ({
        id: spec.id,
        label: spec.label,
        vendor: spec.vendor,
        keysUrl: spec.keysUrl,
        defaultModel: spec.defaultModel,
        model: this.values[spec.modelName] || spec.defaultModel,
        configured: Boolean(this.values[spec.keyName]),
        keyHint: maskKey(this.values[spec.keyName])
      }))
    };
  }

  resident(id) {
    const spec = providerSpec(id);
    if (!spec) throw new Error(`Unknown provider: ${id}`);
    return createResidentProvider(spec, this.values);
  }

  async save(id, { apiKey, model }) {
    const spec = providerSpec(id);
    if (!spec) throw new Error(`Unknown provider: ${id}`);
    const changes = {};

    if (apiKey !== undefined) {
      const trimmed = String(apiKey).trim();
      if (!trimmed) throw new Error("An API key is required");
      this.values[spec.keyName] = trimmed;
      changes[spec.keyName] = trimmed;
    }
    if (model !== undefined) {
      const trimmed = String(model).trim() || spec.defaultModel;
      this.values[spec.modelName] = trimmed;
      changes[spec.modelName] = trimmed;
    }

    await writeEnvValues(this.envPath, changes);
    return this.resident(id);
  }

  async clear(id) {
    const spec = providerSpec(id);
    if (!spec) throw new Error(`Unknown provider: ${id}`);
    delete this.values[spec.keyName];
    await writeEnvValues(this.envPath, { [spec.keyName]: null });
    return this.resident(id);
  }

  // A saved key is not a working key. This is the smallest real call that tells
  // the difference, and it surfaces a wrong model id before a whole conversation
  // fails on it.
  async test(id) {
    const spec = providerSpec(id);
    if (!spec) throw new Error(`Unknown provider: ${id}`);
    if (!this.values[spec.keyName]) return { ok: false, error: "No API key is configured for this provider" };

    const { provider, model } = this.resident(id);
    if (typeof provider.complete !== "function") return { ok: false, error: "This provider is running in demo mode" };
    try {
      const reply = await provider.complete("Reply with the single word: ready");
      return { ok: true, model, reply: String(reply ?? "").trim().slice(0, 120) };
    } catch (error) {
      return { ok: false, model, error: error.message };
    }
  }
}
