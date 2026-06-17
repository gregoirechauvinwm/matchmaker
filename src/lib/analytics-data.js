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
import { ONBOARDING_CHECKPOINTS } from './onboarding-progress.js';
import { FUNNEL_VERSIONS, CORE_MILESTONES, activeVersion, getVersion } from './funnel-versions.js';

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
  id, phone_verified_at, phone_entered_at, applied_at, email, birth_date, name, gender, gender_pref,
  partner_age_min, neighborhood, education, has_kids, ethnicity, religion,
  photos, chosen_amata, onboarding_done
`;

// FUNNEL: ordered bars with reached-counts, step-to-step %, and total % from
// the first bar. Shape per bar: { key, label, group:'onboarding'|'task'|'paid',
// count, pctOfFirst, pctOfPrev }.
//
// `version` selects which funnel to render:
//   - a version id (e.g. 'v1')  -> that version's exact step list/order, counted
//     over ONLY users stamped with that version (the faithful per-version view).
//   - 'core'                    -> the CORE_MILESTONES list, counted over ALL
//     users regardless of version (the cross-version KPI view).
//   - omitted/null              -> the active version.
export async function getFunnel({ from = null, to = null, version = null } = {}) {
  const isCore = version === 'core';
  const ver = isCore ? null : (getVersion(version) || activeVersion());

  // --- denominator population: NON-ARCHIVED users created in the window ---
  // For a per-version funnel, restrict to users stamped with that version. For
  // the cross-version 'core' view, include all (non-archived, windowed) users.
  const uWhere = dateClause('created_at', from, to);
  const conds = ['archived_at IS NULL'];
  const params = [...uWhere.params];
  if (uWhere.clause) conds.push(uWhere.clause);
  if (!isCore && ver) { conds.push(`funnel_version = $${params.length + 1}`); params.push(ver.id); }
  const users = (await query(
    `SELECT ${CHECKPOINT_COLUMNS}, funnel_version FROM users WHERE ${conds.join(' AND ')}`,
    params
  )).rows;
  const userIds = users.map((u) => u.id);

  // --- compute the COUNT for any step key over this user population ---
  // Top-of-funnel + onboarding checkpoints are field-presence (version-
  // independent facts). 'tasks' and 'paid' need SQL over the windowed ids.
  const checkpointByKey = new Map(ONBOARDING_CHECKPOINTS.map((cp) => [cp.key, cp]));

  // task instances per user (for 'tasks' expansion)
  const taskTypes = (await query(
    `SELECT id, name FROM task_types WHERE is_active = true ORDER BY position ASC`
  )).rows;
  let taskCountByType = new Map();
  if (taskTypes.length && userIds.length) {
    const counts = (await query(
      `SELECT task_type_id, COUNT(DISTINCT user_id)::int AS c
         FROM tasks WHERE user_id = ANY($1::uuid[]) GROUP BY task_type_id`,
      [userIds]
    )).rows;
    taskCountByType = new Map(counts.map((r) => [r.task_type_id, r.c]));
  }

  // "Completed" = users with a paid/confirmed payment_link, broken down by kind:
  //   token       - paid upfront for a date token (the original paywall)
  //   rsvp_card   - saved a card to authorize the no-show fee (card capture)
  // Both count as completed. We keep the split for the funnel's green-bar hover.
  let completedTotal = 0, tokenCount = 0, cardCaptureCount = 0;
  if (userIds.length) {
    const rows = (await query(
      `SELECT COALESCE(kind, 'token') AS kind, COUNT(DISTINCT user_id)::int AS c
         FROM payment_links
        WHERE paid_at IS NOT NULL AND user_id = ANY($1::uuid[])
        GROUP BY COALESCE(kind, 'token')`,
      [userIds]
    )).rows;
    for (const r of rows) {
      if (r.kind === 'rsvp_card') cardCaptureCount = r.c;
      else tokenCount += r.c;
    }
    // Distinct users who completed by ANY kind (a user could in theory have both;
    // count them once for the total).
    completedTotal = (await query(
      `SELECT COUNT(DISTINCT user_id)::int AS c
         FROM payment_links WHERE paid_at IS NOT NULL AND user_id = ANY($1::uuid[])`,
      [userIds]
    )).rows[0].c;
  }

  // Expand a step key into one or more concrete bars with counts.
  // Onboarding sign-up steps get an " ok" suffix on their label (a convention
  // requested for the dashboard) - EXCEPT 'visited'. Tasks keep their own names.
  function barsForKey(key) {
    if (key === 'visited') return [{ key, label: 'Visited', group: 'onboarding', count: users.length }];
    if (key === 'applied') return [{ key, label: 'Applied ok', group: 'onboarding', count: users.filter((u) => u.applied_at != null).length }];
    if (key === 'phone_number') return [{ key, label: 'Phone number ok', group: 'onboarding', count: users.filter((u) => u.phone_entered_at != null).length }];
    // 'completed' (green) = paid + card capture. breakdown rides along for the hover.
    if (key === 'completed' || key === 'paid') {
      return [{
        key: 'completed', label: 'completed', group: 'paid', count: completedTotal,
        breakdown: { token: tokenCount, card_capture: cardCaptureCount },
      }];
    }
    if (key === 'tasks') {
      return taskTypes.map((tt) => ({ key: 'task:' + tt.id, label: tt.name, group: 'task', count: taskCountByType.get(tt.id) || 0 }));
    }
    const cp = checkpointByKey.get(key);
    if (cp && key !== 'done') {
      // Count DIRECT presence of this step's own field (cp.has), not the
      // cumulative "reached this or any later checkpoint" - the cumulative
      // version assumes v1's step order and produces wrong counts once a version
      // reorders steps (e.g. birth_date filled would wrongly light up verif_code
      // because verif_code scans forward and finds birth_date set).
      return [{ key, label: cp.label + ' ok', group: 'onboarding', count: users.filter((u) => cp.has(u)).length }];
    }
    return []; // unknown key -> skip
  }

  // Assemble bars in the requested order (per-version step list, or milestones).
  const stepKeys = isCore ? CORE_MILESTONES : ver.steps;
  const bars = stepKeys.flatMap(barsForKey);

  // percentages
  const first = bars.length ? bars[0].count : 0;
  for (let i = 0; i < bars.length; i++) {
    const prev = i === 0 ? bars[i].count : bars[i - 1].count;
    bars[i].pctOfFirst = first > 0 ? Math.round((bars[i].count / first) * 100) : 0;
    bars[i].pctOfPrev = prev > 0 ? Math.round((bars[i].count / prev) * 100) : 0;
  }

  return {
    totalStarted: bars.length ? bars[0].count : 0,
    bars,
    version: isCore ? 'core' : ver.id,
    isCore,
  };
}

// List available funnel versions (for the dashboard tabs), newest first, plus
// the cross-version 'core' view. Each version carries `activeFrom`: the date of
// the FIRST user stamped with it (derived from data = when it effectively went
// live), used for the tab's "for users registering from mm/dd/yyyy" hover.
// Returns [{ id, label, active, activeFrom }].
export async function getFunnelVersions() {
  // First signup per version stamp.
  const rows = (await query(
    `SELECT funnel_version AS v, MIN(created_at) AS first_at
       FROM users WHERE funnel_version IS NOT NULL
      GROUP BY funnel_version`
  )).rows;
  const firstByVersion = new Map(rows.map((r) => [r.v, r.first_at]));

  const versions = [...FUNNEL_VERSIONS].reverse().map((v) => ({
    id: v.id,
    label: v.label,
    active: !!v.active,
    activeFrom: firstByVersion.get(v.id) || null, // null = no users yet
  }));
  return [{ id: 'core', label: 'All versions (milestones)', active: false, activeFrom: null }, ...versions];
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
