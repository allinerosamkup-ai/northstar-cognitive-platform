import { isSurfaceEvent, surfaceEvents } from "../event-catalog.js";

// TLS interception by antivirus software or a corporate proxy is common on
// Windows and produces a certificate error that reads like a network outage.
// Naming it is the difference between a fixable problem and a mystery.
const INTERCEPTED_TLS = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
]);

// "fetch failed" is what the runtime says and it tells a person nothing. Every
// adapter routes its request through here so a network problem reads like one.
async function callProvider(url, options, vendor) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const code = error.cause?.code ?? error.message;
    if (INTERCEPTED_TLS.has(code)) {
      throw new Error(`Could not verify the secure connection to ${vendor}. Antivirus software or a corporate proxy is inspecting HTTPS traffic on this machine. Add its root certificate with NODE_EXTRA_CA_CERTS, or allow this app through it. (${code})`);
    }
    throw new Error(`Could not reach ${vendor}. Check your internet connection or a firewall. (${code})`);
  }
}

class LiveApiProvider {
  constructor({ name, model, apiKey, live = false }) {
    this.name = name;
    this.model = model;
    this.apiKey = apiKey;
    this.live = live;
    this.projectEvents = [];
  }
  // Restores what this provider would have observed had it been present all
  // along. A provider object is new on every boot and on every key change, so
  // without this a resident reports itself caught up while knowing nothing.
  // Deliberately makes no API call: the context is replayed, not re-processed.
  hydrate(events = []) {
    this.projectEvents = [...events];
  }
  // Log-only events are recorded locally but never cost a provider call: a paused resident
  // or a started collective is bookkeeping, not something a model needs to read.
  async observe({ event }) {
    this.projectEvents.push(event);
    if (this.live && isSurfaceEvent(event.type)) await this.complete("Process this project event silently. Reply only ACK.", [event]);
    return { intervention: null };
  }
  async work(request) {
    const context = surfaceEvents(this.projectEvents).map(event => `#${event.sequence} ${event.type} ${JSON.stringify(event.payload)}`).join("\n");
    const text = await this.complete(`You are a resident intelligence in one shared cognitive project. You have cohabited the events below. Continue the objective without retelling or resetting the project.\n\nPROJECT EVENTS\n${context}\n\nOBJECTIVE\n${request.prompt}`, this.projectEvents);
    return { text };
  }
}

export class OpenAIProvider extends LiveApiProvider {
  constructor(options) { super({ name: "openai", ...options }); }
  async complete(prompt) {
    const response = await callProvider("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.model, input: prompt }) }, "OpenAI");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? "OpenAI request failed");
    return value.output_text ?? value.output?.flatMap(item => item.content ?? []).find(item => item.text)?.text ?? "";
  }
}

export class AnthropicProvider extends LiveApiProvider {
  constructor(options) { super({ name: "anthropic", ...options }); }
  async complete(prompt) {
    const response = await callProvider("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: this.model, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }) }, "Anthropic");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? "Anthropic request failed");
    return value.content?.find(item => item.type === "text")?.text ?? "";
  }
}

export class GeminiProvider extends LiveApiProvider {
  constructor(options) { super({ name: "google", ...options }); }
  async complete(prompt) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await callProvider(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }, "Gemini");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? "Gemini request failed");
    return value.candidates?.[0]?.content?.parts?.map(part => part.text).join("") ?? "";
  }
}
