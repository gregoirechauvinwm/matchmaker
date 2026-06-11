// src/lib/analytics-data.js
// Read-only analytics for the back-office dashboard. Two datasets:
//   - funnel:  onboarding checkpoints (grey) -> task steps (blue) -> paid (green)
//   - revenue: daily revenue by payment capture date (green)
//
// Date filtering:
//   - The FUNNEL filters on users.created_at (when the user first entered their
//     phone) - "of the people who started in this window, how far did they get".
//   - REVENUE filters on payment_links.paid_at (capture time).
//
// The onboarding-checkpoint counts are computed in JS via the shared
// onboarding-progress module (single source of truth) over the user rows in the
// window. Task + paid counts come from SQL. At this scale (hundreds/thousands of
// users) loading the windowed user rows is inexpensive and keeps the checkpoint
// logic unduplicated.

import { query } from '../db/pool.js';
import { ONBOARDING_CHECKPOINTS, reachedCheckpoint } from './onboarding-progress.js';

// Build a parameterized "[col] BETWEEN ..." clause from optional from/to ISO
// date strings (YYYY-MM-DD). `to` is treated as inclusive of that whole day.
// Returns { clause, params } where clause is '' when no bounds are given.
function dateClause(col, from, to, startIndex = 1) {
  const parts = [];
  const params = [];
  let n = startIndex;
  if (from) { parts.push(`${col} >= $${n++}`); params.push(from); }
  if (to)   { parts.push(`${col} < ($${n++}::date + interval '1 day')`); params.push(to); }
  const clause = parts.length ? parts.join(' AND ') : '';
  return { clause, params };
}

// The columns the checkpoint tests read. Keep in sync with onboarding-progress.
const CHECKPOINT_COLUMNS = `
  id, phone_verified_at, email, birth_date, name, gender, gender_pref,
  partner_age_min, neighborhood, education, has_kids, ethnicity, religion,
  photos, chosen_amata, onboarding_done
`;

// FUNNEL: ordered bars with reached-counts, step-to-step %, and total % from
// the first bar. Shape per bar: { key, label, group:'onboarding'|'task'|'paid',
// count, pctOfFirst, pctOfPrev }.
export async function getFunnel({ from = null, to = null } = {}) {
  // --- denominator population: NON-ARCHIVED users created in the window ---
  // Archived users are excluded from all analytics. Because the task-bar and
  // paid-bar counts below are derived from THIS set of user ids, excluding
  // archived users here removes them from every bar in one place.
  const uWhere = dateClause('created_at', from, to);
  const conds = ['archived_at IS NULL'];
  if (uWhere.clause) conds.push(uWhere.clause);
  const users = (await query(
    `SELECT ${CHECKPOINT_COLUMNS} FROM users
      WHERE ${conds.join(' AND ')}`,
    uWhere.params
  )).rows;
  const userIds = users.map((u) => u.id);

  // --- top-of-funnel bars from `visits` (anonymous per-browser rows) ---
  // "Visited" = any visit row (landed on the phone page). "Phone number" =
  // visit rows that entered a number (deduped per browser). Every verified user
  // already has a visit row - a live one from their cookie, or a backfilled
  // 'user:<id>' row - so counting visits directly is both correct and avoids
  // double-counting (no union needed).
  const visitWhere = dateClause('first_seen_at', from, to);
  const visitedCount = (await query(
    `SELECT COUNT(*)::int AS c FROM visits
       ${visitWhere.clause ? 'WHERE ' + visitWhere.clause : ''}`,
    visitWhere.params
  )).rows[0].c;

  const enteredWhere = dateClause('phone_entered_at', from, to);
  const phoneCount = (await query(
    `SELECT COUNT(*)::int AS c FROM visits
       WHERE phone_e164 IS NOT NULL
         ${enteredWhere.clause ? 'AND ' + enteredWhere.clause : ''}`,
    enteredWhere.params
  )).rows[0].c;

  const visitedBar = { key: 'visited', label: 'Visited', group: 'onboarding', count: visitedCount };
  const phoneBar = { key: 'phone_number', label: 'Phone number', group: 'onboarding', count: phoneCount };

  // --- onboarding bars (grey): count via the shared checkpoint module ---
  const onboardingBars = ONBOARDING_CHECKPOINTS
    .filter((cp) => cp.key !== 'done') // 'done' is represented by reaching the first task
    .map((cp) => ({
      key: cp.key,
      label: cp.label,
      group: 'onboarding',
      count: users.filter((u) => reachedCheckpoint(u, cp.key)).length,
    }));

  // --- task bars (blue): active task_types in order; reached = has a tasks row ---
  const taskTypes = (await query(
    `SELECT id, name FROM task_types WHERE is_active = true ORDER BY position ASC`
  )).rows;

  let taskBars = [];
  if (taskTypes.length && userIds.length) {
    // Count, per task_type, how many of OUR windowed users have an instance.
    const counts = (await query(
      `SELECT task_type_id, COUNT(DISTINCT user_id)::int AS c
         FROM tasks
        WHERE user_id = ANY($1::uuid[])
        GROUP BY task_type_id`,
      [userIds]
    )).rows;
    const byType = new Map(counts.map((r) => [r.task_type_id, r.c]));
    taskBars = taskTypes.map((tt) => ({
      key: 'task:' + tt.id,
      label: tt.name,
      group: 'task',
      count: byType.get(tt.id) || 0,
    }));
  } else {
    taskBars = taskTypes.map((tt) => ({ key: 'task:' + tt.id, label: tt.name, group: 'task', count: 0 }));
  }

  // --- paid bar (green): windowed users who have a paid payment_link ---
  let paidCount = 0;
  if (userIds.length) {
    paidCount = (await query(
      `SELECT COUNT(DISTINCT user_id)::int AS c
         FROM payment_links
        WHERE paid_at IS NOT NULL AND user_id = ANY($1::uuid[])`,
      [userIds]
    )).rows[0].c;
  }
  const paidBar = { key: 'paid', label: 'paid', group: 'paid', count: paidCount };

  // --- assemble + compute percentages ---
  // Order: Visited -> Phone number -> Verif code -> rest of onboarding ->
  // tasks -> paid. "Visited" is the 100% baseline.
  const bars = [visitedBar, phoneBar, ...onboardingBars, ...taskBars, paidBar];
  const first = bars.length ? bars[0].count : 0;
  for (let i = 0; i < bars.length; i++) {
    const prev = i === 0 ? bars[i].count : bars[i - 1].count;
    bars[i].pctOfFirst = first > 0 ? Math.round((bars[i].count / first) * 100) : 0;
    bars[i].pctOfPrev = prev > 0 ? Math.round((bars[i].count / prev) * 100) : 0;
  }

  return { totalStarted: visitedBar.count, bars };
}

// DAILY REVENUE: sum of amount_cents grouped by paid_at date, within the window.
// Only rows with a stored amount_cents are included (payments captured after the
// amount-tracking migration). Returns { days: [{ date:'YYYY-MM-DD', cents, count }], totalCents }.
export async function getDailyRevenue({ from = null, to = null } = {}) {
  // Exclude payments from archived users (consistent with the funnel).
  const base = `paid_at IS NOT NULL AND amount_cents IS NOT NULL
    AND user_id NOT IN (SELECT id FROM users WHERE archived_at IS NOT NULL)`;
  const dc = dateClause('paid_at', from, to, 1);
  const where = base + (dc.clause ? ' AND ' + dc.clause : '');
  const rows = (await query(
    `SELECT to_char(date_trunc('day', paid_at), 'YYYY-MM-DD') AS date,
            SUM(amount_cents)::bigint AS cents,
            COUNT(*)::int AS count
       FROM payment_links
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 ASC`,
    dc.params
  )).rows;
  const days = rows.map((r) => ({ date: r.date, cents: Number(r.cents), count: r.count }));
  const totalCents = days.reduce((s, d) => s + d.cents, 0);
  return { days, totalCents };
}
