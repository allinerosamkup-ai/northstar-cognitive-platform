const SURFACE_EVENTS = new Set(["message.created", "decision.created", "task.created", "contribution.created", "file.attached", "document.revised"]);
const LOG_ONLY_EVENTS = new Set(["collective.started", "resident.paused", "file.written", "settings.changed"]);

export const SURFACE_EVENT_TYPES = [...SURFACE_EVENTS];

export function isSurfaceEvent(type) {
  return !LOG_ONLY_EVENTS.has(type);
}

export function surfaceEvents(events) {
  return events.filter(event => isSurfaceEvent(event.type));
}
