// src/lib/template.js
// The prompt template engine, built on Nunjucks.
//
// SECURITY MODEL (read this): Nunjucks has no execution sandbox. That is fine
// here because ONLY trusted admins author templates (in the back-office). The
// single load-bearing rule is: user-provided content is always passed as DATA
// in the context object, NEVER concatenated into a template string. This module
// exposes exactly one render entry point that takes (templateString, context),
// so there is no code path that turns user text into template source.
//
// Autoescape is OFF on purpose: our rendered output is a PROMPT sent to an AI
// model, not HTML shown in a browser. HTML-escaping would corrupt quotes and
// angle brackets in the prompt text. (This is the one setting where "off" is
// the correct, safe choice, precisely because the output isn't HTML.)

import nunjucks from 'nunjucks';

// Pronoun maps. male -> he/his/him, female -> she/her/her, else -> they/their/them.
// Seeded defaults; refine as needed.
const SUBJECT = { male: 'he', female: 'she' };   // {{ gender | they }}
const POSSESS = { male: 'his', female: 'her' };   // {{ gender | their }}
const OBJECT  = { male: 'him', female: 'her' };    // {{ gender | them }}

function pronoun(map, fallback) {
  return (gender) => {
    if (gender == null) return fallback;
    const key = String(gender).toLowerCase();
    return map[key] || fallback;
  };
}

// One shared environment. No file loader is configured for templates (they come
// from the database as strings); parts are registered as globals/handled at
// render time (see render()).
const env = new nunjucks.Environment(null, {
  autoescape: false,    // output is prompt text, not HTML
  throwOnUndefined: false, // undefined variables render as empty string
});

// Custom pronoun filters, matching the other project's conventions.
env.addFilter('they', pronoun(SUBJECT, 'they'));
env.addFilter('their', pronoun(POSSESS, 'their'));
env.addFilter('them', pronoun(OBJECT, 'them'));

// Render a trusted template string with a data context. Returns the rendered
// string, or - if the template has an error - a safe fallback (empty string by
// default) plus the error, so callers can record it and degrade gracefully.
//
// `parts` is an optional map of { partName: templateString } to support
// {% include 'part-name' %}. Because Nunjucks `include` needs a loader, we
// resolve includes by pre-registering parts in a simple in-memory loader.
export function renderTemplate(templateString, context = {}, parts = {}) {
  // Always provide `random` (0..1) so templates can vary phrasing, matching the
  // {% if random < 1/3 %} pattern.
  const ctx = { random: Math.random(), ...context };

  try {
    const localEnv = buildEnvWithParts(parts);
    const result = localEnv.renderString(templateString, ctx);
    return { text: result, ok: true };
  } catch (err) {
    return { text: '', ok: false, error: err.message };
  }
}

// Build an environment that can resolve {% include 'name' %} against the given
// parts map. Parts may themselves include other parts. We reuse the filters.
function buildEnvWithParts(parts) {
  const loader = {
    getSource(name) {
      if (Object.prototype.hasOwnProperty.call(parts, name)) {
        return { src: parts[name], path: name, noCache: true };
      }
      // Unknown include resolves to empty rather than throwing.
      return { src: '', path: name, noCache: true };
    },
  };
  const e = new nunjucks.Environment(loader, {
    autoescape: false,
    throwOnUndefined: false,
  });
  e.addFilter('they', pronoun(SUBJECT, 'they'));
  e.addFilter('their', pronoun(POSSESS, 'their'));
  e.addFilter('them', pronoun(OBJECT, 'them'));
  return e;
}
