export function createLock() {
  const chains = new Map();
  return function withLock(key, fn) {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    chains.set(key, next.catch(() => {}));
    return next;
  };
}
