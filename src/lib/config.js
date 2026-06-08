// src/lib/config.js
// Static config for now. The flow opener moves into editable config later.

export const PERSONA = {
  // The single scripted first message, sent before any user input. Editable
  // later. (No persona name is hardcoded anywhere - the voice lives entirely
  // in the editable prompts.)
  flowOpener: "Hey, glad you're interested in our next Blind Tuesdate event in Manhattan! Ready to begin?",
};

// Fallback used ONLY if the speaker prompt row isn't seeded in the database.
// Normally the speaker prompt comes from the DB (see scripts/seed-prompts.js).
export const SPEAKER = {
  model: 'gpt-4.1-mini',
  prompt: [
    "You are a warm, upbeat matchmaker for Blind Tuesdate, a singles-event",
    "company running blind-date dinners in Manhattan, texting someone who just",
    "signed up. Keep replies short and texty, friendly and curious, one question",
    "at a time. No emoji unless they use them first.",
  ].join('\n'),
};
