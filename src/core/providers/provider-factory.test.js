import test from "node:test";
import assert from "node:assert/strict";
import { createResidentProviders, PROVIDERS, providerSpec } from "./provider-factory.js";
import { DemoProvider } from "./demo-provider.js";
import { OpenAIProvider } from "./api-providers.js";

test("Every resident runs on demo responses until a key is configured", () => {
  const residents = createResidentProviders({});
  assert.equal(residents.length, 3);
  assert.ok(residents.every(resident => resident.provider instanceof DemoProvider));
});

// A key that is present but ignored because of a second hidden flag is the
// "I configured it and nothing happened" trap. Supplying a key is the intent.
test("A configured key alone puts that resident on its real provider", () => {
  const residents = createResidentProviders({ OPENAI_API_KEY: "secret", OPENAI_MODEL: "configured-model" });
  assert.ok(residents[0].provider instanceof OpenAIProvider);
  assert.equal(residents[0].provider.model, "configured-model");
  assert.ok(residents.slice(1).every(resident => resident.provider instanceof DemoProvider),
    "the other residents are untouched");
});

test("A key without a model falls back to that provider's default model", () => {
  const [gpt] = createResidentProviders({ OPENAI_API_KEY: "secret" });
  assert.equal(gpt.provider.model, providerSpec("gpt").defaultModel);
  assert.ok(gpt.provider.model.length > 3, "the default is a real model id, not a label");
});

test("Every provider declares a real model id as its default", () => {
  for (const spec of PROVIDERS) {
    assert.match(spec.defaultModel, /^[a-z0-9][a-z0-9.-]+$/,
      `${spec.id} default model must look like an API model id`);
  }
});

// Live residency spends one call per resident per event just to acknowledge it,
// while work() already resends the whole context. It must never be the default.
test("Live residency stays off unless explicitly enabled", () => {
  const [quiet] = createResidentProviders({ OPENAI_API_KEY: "secret" });
  assert.equal(quiet.provider.live, false);

  const [loud] = createResidentProviders({ OPENAI_API_KEY: "secret", LIVE_RESIDENCY: "true" });
  assert.equal(loud.provider.live, true);
});
