// public/wm-admin.js
// Drives the four-column back-office: load users, render the selected user's
// conversation, and fill the completion panel when a "see completion" is clicked.

const usersList = document.getElementById('users-list');
const convoHead = document.getElementById('convo-head');
const convoEl = document.getElementById('convo');
const compEl = document.getElementById('comp');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shortId(id) { return String(id || '').slice(0, 8); }

// Which user is in the URL (/wm-admin/u/:id), if any.
function selectedUserId() {
  const m = location.pathname.match(/\/wm-admin\/u\/([^/]+)/);
  return m ? m[1] : null;
}

const ORDER = { detection: 0, evaluation: 1, whisperer: 2, speaker: 3 };

async function loadUsers() {
  const showArchived = !!document.getElementById('show-archived')?.checked;
  const status = document.getElementById('status-filter')?.value || 'all';
  const params = new URLSearchParams();
  if (showArchived) params.set('archived', '1');
  if (status && status !== 'all') params.set('status', status);
  const qs = params.toString();
  const res = await fetch('/wm-admin/api/users' + (qs ? '?' + qs : ''));
  if (res.status === 401 || res.redirected) { location.href = '/wm-admin/login'; return; }
  const { users } = await res.json();
  const sel = selectedUserId();
  usersList.innerHTML = users.map((u) => {
    const stage = u.stage || { kind: 'onboarding', label: 'not started' };
    // Stage pill: grey while onboarding, blue once signed up / in a task.
    const stageClass = stage.kind === 'onboarding' ? 'pill-grey' : 'pill-blue';
    const stagePill = `<span class="u-pill ${stageClass}">${esc(stage.label)}</span>`;
    // Optional green pill: tokens purchased (token paywall).
    const tokens = u.token_count || 0;
    const tokenPill = tokens > 0
      ? `<span class="u-pill pill-green">${tokens} token${tokens === 1 ? '' : 's'}</span>`
      : '';
    // Optional green pill: card captured (RSVP / no-show-fee flow).
    const cardPill = u.has_card_capture
      ? `<span class="u-pill pill-green">card capture</span>`
      : '';
    const photo = (Array.isArray(u.photos) && u.photos[0]) ? u.photos[0] : null;
    const avatar = photo
      ? `<img class="u-photo" src="${esc(photo)}" alt="">`
      : `<div class="u-photo u-photo-blank">${esc((u.name || '?').slice(0,1))}</div>`;
    const archivedTag = u.archived_at ? ' <span class="u-archived">archived</span>' : '';
    return `<li class="user-item ${u.id === sel ? 'active' : ''}" data-id="${u.id}" data-archived="${u.archived_at ? '1' : '0'}">
      ${avatar}
      <div class="u-meta">
        ${u.name ? `<div class="u-name">${esc(u.name)}</div>` : ''}
        <div class="u-phone">${u.phone_e164
          ? esc(u.phone_e164)
          : (u.phone_entered ? esc(u.phone_entered) + ' <span class="u-unverified">(unverified)</span>' : '<span class="u-nophone">no phone</span>')}</div>
        <div class="u-status">${stagePill}${tokenPill}${cardPill}${archivedTag}</div>
      </div>
    </li>`;
  }).join('') || '<li class="muted" style="padding:12px 16px">No users yet.</li>';

  usersList.querySelectorAll('.user-item').forEach((li) => {
    li.addEventListener('click', () => {
      history.pushState({}, '', `/wm-admin/u/${li.dataset.id}`);
      usersList.querySelectorAll('.user-item').forEach((x) => x.classList.remove('active'));
      li.classList.add('active');
      loadConversation(li.dataset.id);
    });
  });
}

// Re-load the list when the archived toggle changes.
document.getElementById('show-archived')?.addEventListener('change', loadUsers);
document.getElementById('status-filter')?.addEventListener('change', loadUsers);

let resultCache = {}; // key -> result object, for the completion panel

// Profile card shown atop the conversation.
function profileCard(u) {
  const row = (label, val) => (val || val === 0)
    ? `<div class="pf-row"><span class="pf-k">${esc(label)}</span><span class="pf-v">${esc(String(val))}</span></div>` : '';
  const ageRange = (u.partner_age_min && u.partner_age_max) ? `${u.partner_age_min}–${u.partner_age_max}` : '';
  const photos = (u.photos || []).map(p => `<img class="pf-photo" src="${esc(p)}" alt="">`).join('');
  const amata = u.chosen_amata ? `<img class="pf-amata" src="/amatas/${esc(u.chosen_amata)}.png" alt="">` : '';
  return `<div class="profile-card">
    <div class="pf-head">${amata}<div>
      ${u.name ? `<div class="pf-name">${esc(u.name)}</div>` : ''}
      <div class="pf-phone">${u.phone_e164
        ? esc(u.phone_e164)
        : (u.phone_entered ? esc(u.phone_entered) + ' (unverified)' : 'no phone')}</div>
    </div></div>
    <div class="pf-grid">
      ${row('Age', u.age)}
      ${row('Gender', u.gender)}
      ${row('Email', u.email)}
      ${row('Wants to meet', u.gender_pref)}
      ${row('Partner age', ageRange)}
      ${row('Religion', u.religion)}
      ${row('Ethnicity', u.ethnicity)}
      ${row('Children', u.has_kids)}
    </div>
    ${photos ? `<div class="pf-photos">${photos}</div>` : ''}
    <div class="pf-actions" style="margin-top:14px;display:flex;gap:8px">
      <button class="pf-archive link" data-id="${u.id}">${u.archived_at ? 'Unarchive' : 'Archive'}</button>
      <button class="pf-delete link" data-id="${u.id}" style="color:#FF3B30">Delete user</button>
    </div>
  </div>`;
}

// Wire the archive/delete buttons inside a freshly-rendered profile card.
function wireProfileActions(container, userId) {
  const archiveBtn = container.querySelector('.pf-archive');
  const deleteBtn = container.querySelector('.pf-delete');
  if (archiveBtn) archiveBtn.addEventListener('click', async () => {
    const unarchiving = archiveBtn.textContent.trim() === 'Unarchive';
    const r = await fetch(`/wm-admin/api/users/${userId}/${unarchiving ? 'unarchive' : 'archive'}`, { method: 'POST' });
    if (r.ok) { await loadUsers(); await loadConversation(userId); }
    else alert('Could not update archive status.');
  });
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    const typed = prompt(
      'PERMANENTLY DELETE this user and ALL their data?\n' +
      'This cannot be undone. The phone number will be freed for fresh re-registration.\n\n' +
      'Type  DELETE  to confirm:'
    );
    if (typed !== 'DELETE') { if (typed !== null) alert('Cancelled - nothing was deleted.'); return; }
    const r = await fetch(`/wm-admin/api/users/${userId}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    if (r.ok) {
      alert('User deleted.');
      history.pushState({}, '', '/wm-admin');
      convoEl.innerHTML = '<div class="muted" style="padding:16px">Select a user.</div>';
      await loadUsers();
    } else {
      alert('Delete failed.');
    }
  });
}

async function loadConversation(userId) {
  convoEl.innerHTML = '<div class="muted" style="padding:16px">Loading…</div>';
  compEl.className = 'comp-empty';
  compEl.textContent = 'Select "see completion" on any result.';

  const res = await fetch(`/wm-admin/api/conversation/${userId}`);
  if (!res.ok) { convoEl.innerHTML = '<div class="muted" style="padding:16px">Not found.</div>'; return; }
  const { user, turns } = await res.json();
  const headPhone = user.phone_e164 || user.phone_entered || 'no phone';
  convoHead.textContent = (user.name ? user.name + ' · ' : '') + headPhone + (user.completed_at ? ' · completed' : '');

  resultCache = {};
  const blocks = [];
  blocks.push(profileCard(user));
  let prevTaskId = undefined;

  for (const turn of turns) {
    const parts = [`<div class="turnseq">turn ${turn.seq}</div>`];

    if (turn.user_message) {
      parts.push(`<div class="msg user"><div class="bubble">${esc(turn.user_message)}</div></div>`);
    }

    // Results are already in true execution order (seq_in_turn) from the API.
    // Do NOT re-sort by prompt_type - that would destroy the real order and the
    // intra-turn task transition.
    for (let idx = 0; idx < turn.results.length; idx++) {
      const r = turn.results[idx];

      // Draw a "new task" divider whenever the task changes from the previous
      // result (works both across turns and WITHIN a turn at a transition).
      if (prevTaskId !== undefined && r.task_id && r.task_id !== prevTaskId) {
        parts.push(`<div class="task-divider"><span>new task${r.task_name ? ': ' + esc(r.task_name) : ''}</span></div>`);
      }
      if (r.task_id) prevTaskId = r.task_id;

      const key = `${turn.id}:${r.seq_in_turn ?? idx}:${r.prompt_type}`;
      resultCache[key] = r;
      const canSee = r.resolved_prompt && r.status !== 'skipped';
      const seeLink = canSee
        ? `<a class="seecomp" data-key="${key}" href="#">see completion</a>` : '';

      if (r.prompt_type === 'speaker') {
        parts.push(`<div class="msg ai">
          <div class="bubble">${esc(r.output)}</div>
          <div class="meta"><span class="badge b-${r.status}">${esc(r.status)}</span> speaker · ${esc(r.model || '')} ${seeLink}</div>
        </div>`);
      } else {
        const out = r.status === 'skipped' ? '<span class="muted">(skipped)</span>' : esc(r.output);
        parts.push(`<div class="card">
          <div class="card-body"><span class="ptype">${esc(r.prompt_type)}</span>${out}</div>
          <div class="meta"><span class="badge b-${r.status}">${esc(r.status)}</span> ${seeLink}</div>
        </div>`);
      }
    }
    blocks.push(`<div class="turn">${parts.join('')}</div>`);
  }
  convoEl.innerHTML = blocks.join('') || '<div class="muted" style="padding:16px">No messages yet.</div>';
  wireProfileActions(convoEl, userId);

  convoEl.querySelectorAll('.seecomp').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      convoEl.querySelectorAll('.seecomp').forEach((x) => x.classList.remove('on'));
      a.classList.add('on');
      showCompletion(resultCache[a.dataset.key]);
    });
  });
}

function metaRow(label, value) {
  return `<div class="m-row"><span class="m-label">${label}</span><span class="m-val">${esc(value)}</span></div>`;
}

function showCompletion(r) {
  if (!r) return;
  compEl.className = 'comp';
  const when = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
  const dur = (r.latency_ms != null) ? `${r.latency_ms} ms` : '—';
  compEl.innerHTML = `
    <div class="comp-meta">
      ${metaRow('type', r.prompt_type)}
      ${metaRow('status', r.status)}
      ${metaRow('model', r.model || '—')}
      ${metaRow('token input', r.prompt_tokens != null ? r.prompt_tokens : '—')}
      ${metaRow('token output', r.completion_tokens != null ? r.completion_tokens : '—')}
      ${metaRow('timestamp', when)}
      ${metaRow('duration', dur)}
      ${metaRow('version', shortId(r.config_version_id))}
    </div>
    <div class="comp-section-label">Rendered prompt</div>
    <pre class="comp-prompt">${esc(r.resolved_prompt)}</pre>
    <div class="comp-section-label">AI answer</div>
    <pre class="comp-answer">${esc(r.output)}</pre>`;
}

window.addEventListener('popstate', () => {
  const id = selectedUserId();
  if (id) loadConversation(id);
});

(async function init() {
  await loadUsers();
  const id = selectedUserId();
  if (id) loadConversation(id);
})();
