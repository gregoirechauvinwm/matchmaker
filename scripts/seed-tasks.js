// scripts/seed-tasks.js
// Seeds two starter tasks so there's a real flow to walk through before the
// back-office (Step 6) exists. Run once with:  npm run seed:tasks
// Re-running clears the seeded starters and re-inserts them (so you get a clean
// pair); it does NOT touch users' progress. Replace these in the back-office
// later.

import { pool } from '../src/db/pool.js';

const TASKS = [
  {
    position: 1,
    name: 'Dating criteria',
    instruction:
      "Get the person talking about what they're looking for in a partner - " +
      "their must-haves, dealbreakers, the kind of person they click with. Keep " +
      "it light and conversational, one question at a time.",
    evaluation:
      "The task is complete once the person has shared at least a couple of " +
      "concrete things they're looking for in a partner (e.g. traits, values, " +
      "lifestyle). If they've given real substance about their criteria, output " +
      "END_TASK; otherwise CONTINUE.",
    initial_thought:
      "Warmly kick things off by asking what they're hoping to find in someone - " +
      "make it feel like a friend asking, not a form.",
    end_message:
      "Acknowledge what they told you about what they're looking for, and let " +
      "them know you'd love to learn a bit about them now.",
    max_user_messages: 4,
  },
  {
    position: 2,
    name: 'About them',
    instruction:
      "Get the person to share a bit about themselves - what they do, what " +
      "they're into, what makes them them. Keep it warm and curious.",
    evaluation:
      "The task is complete once the person has shared a few real things about " +
      "themselves (work, interests, personality). If so, output END_TASK; " +
      "otherwise CONTINUE.",
    initial_thought:
      "Transition naturally into getting to know them - ask something easy and " +
      "open about who they are or what they enjoy.",
    end_message:
      "Warmly wrap up - thank them for sharing, and let them know you've got a " +
      "good sense of them now and will be in touch about matches.",
    max_user_messages: 4,
  },
];

async function main() {
  // Remove any previously-seeded starters by name, then re-insert cleanly.
  await pool.query(`DELETE FROM task_types WHERE name = ANY($1)`, [TASKS.map((t) => t.name)]);

  for (const t of TASKS) {
    await pool.query(
      `INSERT INTO task_types
         (name, position, is_active, instruction, evaluation, initial_thought, end_message, max_user_messages)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7)`,
      [t.name, t.position, t.instruction, t.evaluation, t.initial_thought, t.end_message, t.max_user_messages]
    );
    console.log(`seeded task ${t.position}: ${t.name} (cap ${t.max_user_messages})`);
  }
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Task seeding failed:', err.message);
  process.exit(1);
});
