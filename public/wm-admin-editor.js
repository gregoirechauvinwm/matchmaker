// public/wm-admin-editor.js
// Editor with an in-memory working copy of the WHOLE config. You navigate
// between prompts/tasks/parts freely; edits accumulate in `working`; nothing
// touches the database until "Save & publish", which sends the entire config
// and publishes it as one new version. Cancel reloads the published config.

const menuPrompts = document.getElementById('menu-prompts');
const menuTasks = document.getElementById('menu-tasks');
const menuParts = document.getElementById('menu-parts');
const contentEl = document.getElementById('editor-content');
const dirtyNote = document.getElementById('dirty-note');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const historyBtn = document.getElementById('history-btn');
const copyAllBtn = document.getElementById('copyall-btn');

const MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'];
const PROMPT_ORDER = ['speaker', 'whisperer', 'initial_thought', 'detection', 'evaluation'];

let working = null;        // { prompts:[], tasks:[], parts:[] }
let versions = [];
let publishedId = null;
let dirty = false;
let selected = null;       // { kind:'prompt'|'task'|'part', key }
let tempCounter = 0;       // for client-side ids of new tasks/parts

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shortId(id) { return String(id || '').slice(0, 8); }

async function api(path, body) {
  const res = await fetch(`/wm-admin/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.redirected) { location.href = '/wm-admin/login'; return null; }
  return res.json();
}

async function load() {
  const data = await api('draft');
  if (!data) return;
  // Deep-copy into the working model so edits don't mutate the loaded snapshot.
  working = JSON.parse(JSON.stringify(data.draft));
  versions = data.versions || [];
  publishedId = data.published_version_id;
  // Ensure prompts sorted in a stable order.
  working.prompts.sort((a, b) => PROMPT_ORDER.indexOf(a.prompt_type) - PROMPT_ORDER.indexOf(b.prompt_type));
  ensureKeys();
  dirty = false;
  updateDirty();
  renderMenu();
  // Default selection: first prompt.
  if (working.prompts[0]) select('prompt', working.prompts[0].prompt_type);
  else contentEl.innerHTML = '';
}

function markDirty() { dirty = true; updateDirty(); }
function updateDirty() {
  dirtyNote.textContent = dirty ? 'Unpublished changes' : '';
  dirtyNote.className = dirty ? 'dirty-note on' : 'dirty-note';
}

// --- menu ------------------------------------------------------------------
function renderMenu() {
  menuPrompts.innerHTML = working.prompts.map((p) =>
    `<li class="menu-item ${isSel('prompt', p.prompt_type) ? 'active' : ''}"
        data-kind="prompt" data-key="${p.prompt_type}">${esc(cap(p.prompt_type))}</li>`).join('');

  // tasks ordered by their array order (which IS the order)
  menuTasks.innerHTML = working.tasks.map((t, i) =>
    `<li class="menu-item ${t.is_active === false ? 'inactive' : ''} ${isSel('task', t._key) ? 'active' : ''}"
        draggable="true" data-kind="task" data-key="${t._key}" data-idx="${i}">
        <span class="drag">⋮⋮</span>${esc(t.name || '(untitled)')}${t.is_active === false ? ' (inactive)' : ''}</li>`).join('');

  menuParts.innerHTML = working.parts.map((p) =>
    `<li class="menu-item ${isSel('part', p._key) ? 'active' : ''}"
        data-kind="part" data-key="${p._key}">${esc(p.name || '(unnamed)')}</li>`).join('');

  document.querySelectorAll('.menu-item').forEach((li) => {
    li.addEventListener('click', () => select(li.dataset.kind, li.dataset.key));
  });
  // Reflect selection on the static scripted-line items.
  ['flow_opener', 'payment_prompt', 'payment_success', 'rate_prompt', 'rate_success'].forEach((k) => {
    const el = document.querySelector(`.menu-item[data-kind="scripted"][data-key="${k}"]`);
    if (el) el.classList.toggle('active', isSel('scripted', k));
  });
  setupTaskDrag();
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function isSel(kind, key) { return selected && selected.kind === kind && String(selected.key) === String(key); }

// Assign stable client keys to tasks/parts so selection survives edits/reorder.
function ensureKeys() {
  working.tasks.forEach((t) => { if (!t._key) t._key = t.id || `new-${++tempCounter}`; });
  working.parts.forEach((p) => { if (!p._key) p._key = p.id || `new-${++tempCounter}`; });
}

// --- selection + element editors ------------------------------------------
function select(kind, key) {
  selected = { kind, key };
  renderMenu();
  if (kind === 'prompt') renderPromptEditor(key);
  else if (kind === 'task') renderTaskEditor(key);
  else if (kind === 'part') renderPartEditor(key);
  else if (kind === 'scripted') renderScriptedEditor(key);
}

// Editor for the app-wide scripted lines (first message, payment prompt, payment
// success). All stored in app_config and snapshotted with the config.
const SCRIPTED_META = {
  flow_opener: {
    title: 'First message',
    hint: "The very first AI message, shown before any user input. Belongs to no task. Supports {{user.*}} variables.",
  },
  payment_prompt: {
    title: 'Payment prompt',
    hint: "Sent (with the payment card) when evaluation returns [SEND_PAYMENT]. Supports {{user.*}} variables.",
  },
  payment_success: {
    title: 'Payment success',
    hint: "Shown after a successful payment. Supports {{tokens_purchased}} and {{user.*}} variables.",
  },
  rate_prompt: {
    title: 'Rate prompt',
    hint: "Sent (with the rating card) when evaluation returns [RATE_PHOTOS]. Also used as the heading on the rating page. Supports {{user.*}} variables.",
  },
  rate_success: {
    title: 'Rate success',
    hint: "Shown after the user finishes rating all the photos. Supports {{user.*}} variables.",
  },
};
function renderScriptedEditor(key) {
  const meta = SCRIPTED_META[key] || { title: key, hint: '' };
  contentEl.innerHTML = `
    <h2>${esc(meta.title)}</h2>
    <textarea id="scripted-text" class="big-body" rows="6">${esc(working[key] || '')}</textarea>
    <p class="hint">${esc(meta.hint)}</p>`;
  document.getElementById('scripted-text')
    .addEventListener('input', (e) => { working[key] = e.target.value; markDirty(); });
}

function renderPromptEditor(type) {
  const p = working.prompts.find((x) => x.prompt_type === type);
  if (!p) return;
  contentEl.innerHTML = `
    <h2>${esc(cap(type))}</h2>
    <label class="fld inline">
      <span>Model</span>
      <select id="f-model">
        ${MODELS.map((m) => `<option ${m === p.model ? 'selected' : ''}>${m}</option>`).join('')}
        ${MODELS.includes(p.model) ? '' : `<option selected>${esc(p.model)}</option>`}
      </select>
    </label>
    <textarea id="f-body" class="big-body" rows="20">${esc(p.body)}</textarea>
    <p class="hint">This whole text is the payload. Variables: {{chat_history}}, {{chat_history_with_whisperer}}, {{detection}}, {{whisperer}}, {{initial_thought}}, {{initial_thought_instruction}}, {{task.instruction}}, {{task_instruction}}, {{user.name}}, {{user.age}}, {{user.gender | their}}, {% if initial_thought %}…{% endif %}, {% include 'part-name' %}.</p>`;
  document.getElementById('f-model').addEventListener('change', (e) => { p.model = e.target.value; markDirty(); });
  document.getElementById('f-body').addEventListener('input', (e) => { p.body = e.target.value; markDirty(); });
}

function renderTaskEditor(key) {
  const t = working.tasks.find((x) => x._key === key);
  if (!t) return;
  contentEl.innerHTML = `
    <input id="t-name" class="title-input" value="${esc(t.name || '')}" placeholder="Task name"/>
    ${ta('Task instruction', 't-instruction', t.instruction)}
    ${ta('Task evaluation (when is it done? must yield END_TASK / CONTINUE)', 't-evaluation', t.evaluation)}
    ${ta('Initial thought (instructions for a one-time reasoning call when this task opens; leave empty to skip). Result is available as {{initial_thought}}.', 't-initial_thought', t.initial_thought)}
    ${ta('Task end message (steers the closing message)', 't-end_message', t.end_message)}
    <label class="fld inline"><span>Max user messages (cap)</span>
      <input id="t-cap" type="number" value="${t.max_user_messages ?? ''}" style="width:90px"/></label>
    <label class="chk"><input type="checkbox" id="t-active" ${t.is_active === false ? '' : 'checked'}/> Active</label>
    <p class="hint">Order is set by dragging tasks in the left menu. Everything is saved together on Save &amp; publish.</p>`;
  bind('t-name', (v) => { t.name = v; renderMenu(); });
  bind('t-instruction', (v) => { t.instruction = v; });
  bind('t-evaluation', (v) => { t.evaluation = v; });
  bind('t-initial_thought', (v) => { t.initial_thought = v; });
  bind('t-end_message', (v) => { t.end_message = v; });
  bind('t-cap', (v) => { t.max_user_messages = v === '' ? null : parseInt(v, 10); });
  document.getElementById('t-active').addEventListener('change', (e) => {
    t.is_active = e.target.checked; markDirty(); renderMenu();
  });
}

function renderPartEditor(key) {
  const p = working.parts.find((x) => x._key === key);
  if (!p) return;
  contentEl.innerHTML = `
    <input id="p-name" class="title-input" value="${esc(p.name || '')}" placeholder="Part name (used in {% include 'name' %})"/>
    ${ta('Body', 'p-body', p.body)}
    <button id="p-delete" class="btn-ghost-sm" style="margin-top:8px">Delete this part</button>`;
  bind('p-name', (v) => { p.name = v; renderMenu(); });
  bind('p-body', (v) => { p.body = v; });
  document.getElementById('p-delete').addEventListener('click', () => {
    working.parts = working.parts.filter((x) => x._key !== key);
    markDirty(); selected = null; renderMenu();
    if (working.prompts[0]) select('prompt', working.prompts[0].prompt_type);
  });
}

function ta(label, id, value) {
  return `<label class="fld"><span>${label}</span><textarea id="${id}" rows="5">${esc(value || '')}</textarea></label>`;
}
function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', (e) => { fn(e.target.value); markDirty(); });
}

// --- create new ------------------------------------------------------------
document.getElementById('new-task').addEventListener('click', () => {
  const t = { _key: `new-${++tempCounter}`, name: 'New task', is_active: true,
    instruction: '', evaluation: '', initial_thought: '', end_message: '', max_user_messages: 4 };
  working.tasks.push(t); markDirty(); select('task', t._key);
});
document.getElementById('new-part').addEventListener('click', () => {
  const p = { _key: `new-${++tempCounter}`, name: 'new_part', body: '' };
  working.parts.push(p); markDirty(); select('part', p._key);
});

// --- task drag reorder (within the menu) -----------------------------------
function setupTaskDrag() {
  let dragged = null;
  menuTasks.querySelectorAll('.menu-item').forEach((row) => {
    row.addEventListener('dragstart', () => { dragged = row; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      // Rebuild working.tasks order from the DOM order.
      const order = [...menuTasks.querySelectorAll('.menu-item')].map((r) => r.dataset.key);
      working.tasks.sort((a, b) => order.indexOf(a._key) - order.indexOf(b._key));
      markDirty();
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const after = afterEl(menuTasks, e.clientY);
      if (!after) menuTasks.appendChild(dragged);
      else menuTasks.insertBefore(dragged, after);
    });
  });
}
function afterEl(list, y) {
  const els = [...list.querySelectorAll('.menu-item:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: -Infinity }).element;
}

// --- save / cancel / history ----------------------------------------------
saveBtn.addEventListener('click', async () => {
  const label = prompt('Optional label for this version:', '') || null;
  // Strip client-only _key before sending.
  const config = {
    flow_opener: working.flow_opener || '',
    payment_prompt: working.payment_prompt || '',
    payment_success: working.payment_success || '',
    rate_prompt: working.rate_prompt || '',
    rate_success: working.rate_success || '',
    prompts: working.prompts.map((p) => ({ prompt_type: p.prompt_type, body: p.body, model: p.model })),
    parts: working.parts.map((p) => ({ name: p.name, body: p.body })),
    tasks: working.tasks.map((t) => ({
      id: (t.id && !String(t.id).startsWith('new-')) ? t.id : undefined,
      name: t.name, is_active: t.is_active !== false, instruction: t.instruction,
      evaluation: t.evaluation, initial_thought: t.initial_thought, end_message: t.end_message,
      max_user_messages: t.max_user_messages, has_pretask_hook: t.has_pretask_hook || false,
    })),
  };
  saveBtn.disabled = true;
  const r = await api('save', { config, label });
  saveBtn.disabled = false;
  if (r && r.ok) { await load(); alert('Saved & published.'); }
});

cancelBtn.addEventListener('click', async () => {
  if (dirty && !confirm('Discard your unpublished changes?')) return;
  await load();
});

if (copyAllBtn) copyAllBtn.addEventListener('click', async () => {
  // Export the full config as JSON (same shape as the save payload, so a future
  // import maps directly). Includes prompts, parts, and tasks.
  const exportObj = {
    _exported_at: new Date().toISOString(),
    flow_opener: working.flow_opener || '',
    payment_prompt: working.payment_prompt || '',
    payment_success: working.payment_success || '',
    rate_prompt: working.rate_prompt || '',
    rate_success: working.rate_success || '',
    prompts: working.prompts.map((p) => ({ prompt_type: p.prompt_type, model: p.model, body: p.body })),
    parts: working.parts.map((p) => ({ name: p.name, body: p.body })),
    tasks: working.tasks.map((t) => ({
      name: t.name, position: t.position, is_active: t.is_active !== false,
      instruction: t.instruction, evaluation: t.evaluation,
      initial_thought: t.initial_thought, end_message: t.end_message,
      max_user_messages: t.max_user_messages, has_pretask_hook: t.has_pretask_hook || false,
    })),
  };
  const json = JSON.stringify(exportObj, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    const orig = copyAllBtn.textContent;
    copyAllBtn.textContent = 'Copied!';
    setTimeout(() => { copyAllBtn.textContent = orig; }, 1500);
  } catch {
    // Fallback: select-in-prompt so the user can copy manually.
    window.prompt('Copy the JSON below:', json);
  }
});

historyBtn.addEventListener('click', () => {
  const real = versions.filter((v) => v.is_real);
  const list = real.map((v) => `${shortId(v.id)}  ${v.label || ''}  ${new Date(v.published_at).toLocaleString()}${v.id === publishedId ? '  (live)' : ''}`).join('\n');
  const pick = prompt(`Versions (newest first):\n\n${list}\n\nType a version id prefix to reload it into the editor, or Cancel:`, '');
  if (!pick) return;
  const match = real.find((v) => shortId(v.id).startsWith(pick.trim()) || v.id === pick.trim());
  if (!match) { alert('No matching version.'); return; }
  reloadVersion(match.id);
});
async function reloadVersion(id) {
  if (dirty && !confirm('Reloading will discard your unpublished changes. Continue?')) return;
  const r = await api('reload', { id });
  if (r && r.ok) { await load(); alert('Version loaded into the editor. Save & publish to make it live.'); }
}

// --- init ------------------------------------------------------------------
load();
