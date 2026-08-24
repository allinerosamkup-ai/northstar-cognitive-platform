const SURFACE_EVENTS = new Set(["message.created", "decision.created", "task.created", "contribution.created", "file.attached", "document.revised", "session.concluded", "assignment.confirmed"]);
// A proposal is not yet what the project believes, so it stays out of what the
// residents read back — only a confirmed assignment becomes shared truth.
const LOG_ONLY_EVENTS = new Set(["collective.started", "resident.paused", "file.written", "settings.changed", "session.started", "assignment.proposed", "agent.created", "agent.dismissed", "command.run", "branch.started", "work.committed"]);

export const SURFACE_EVENT_TYPES = [...SURFACE_EVENTS];

export function isSurfaceEvent(type) {
  return !LOG_ONLY_EVENTS.has(type);
}

export function surfaceEvents(events) {
  return events.filter(event => isSurfaceEvent(event.type));
}
