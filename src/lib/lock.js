// src/lib/lock.js
// A tiny in-process lock keyed by user id, enforcing "one turn at a time per
// user." Because the local app is a single process, an in-memory Set is enough.
// (If this ever runs as multiple processes, this becomes a DB or Redis lock -
// but that's not needed at the current scale.)

const active = new Set();

// Try to acquire the lock for a user. Returns true if acquired, false if the
// user already has a turn in progress.
export function acquire(userId) {
  if (active.has(userId)) return false;
  active.add(userId);
  return true;
}

export function release(userId) {
  active.delete(userId);
}
