export class ProviderUnavailableError extends Error {
  constructor(reason) { super(reason); this.name = "ProviderUnavailableError"; this.reason = reason; }
}

export class RecordingProvider {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.processedSequences = [];
    this.workRequests = [];
    this.hydratedEvents = [];
  }
  hydrate(events = []) { this.hydratedEvents = [...events]; }
  async observe({ event }) {
    this.processedSequences.push(event.sequence);
    return { intervention: null };
  }
  async work(request) {
    this.workRequests.push(request);
    if (this.options.failWorkWith) throw new ProviderUnavailableError(this.options.failWorkWith);
    return { text: this.options.response ?? `Work completed by ${this.name}` };
  }
}
