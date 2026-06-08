// src/lib/published-config.js
// Helpers to read prompts/parts out of a published config snapshot, so the
// pipeline uses the PUBLISHED config (Model A) rather than the live draft tables.
//
// Task identity/progression still uses live task rows (by id) per our decision,
// so there is no task accessor here - tasks come from src/lib/tasks.js as before.

// Get a prompt { body, model } of a given type from a snapshot, or null.
export function promptFromSnapshot(snapshot, promptType) {
  const row = (snapshot?.prompts || []).find((p) => p.prompt_type === promptType);
  return row ? { body: row.body, model: row.model } : null;
}

// Build the { name: body } parts map from a snapshot.
export function partsFromSnapshot(snapshot) {
  const map = {};
  for (const part of snapshot?.parts || []) map[part.name] = part.body;
  return map;
}
