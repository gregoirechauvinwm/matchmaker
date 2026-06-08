// public/chat.js
// Mobile-first chat behavior. Built to feel like a native app in iOS Safari:
//  - append-based rendering (never blows away the DOM, so the keyboard/focus and
//    in-progress animations are never disturbed)
//  - the keyboard stays up after sending (we never blur the textarea, and the
//    send button is prevented from stealing focus)
//  - send button appears only when there's text
//  - sent bubbles rise+fade in; the pill lightens briefly on send
//  - the app shell + input bar track the visual viewport so the keyboard doesn't
//    push the layout off-screen

const scrollEl = document.getElementById('chat-list');
const messagesEl = document.getElementById('chat-messages');
const composer = document.getElementById('composer');
const sendBtn = document.getElementById('send-btn');
const pill = document.getElementById('composer-pill');

// Load the user's chosen Amata into the header avatar.
let amataAvatarUrl = null;
(async function loadAmata() {
  try {
    const me = await (await fetch('/auth/me')).json();
    if (me && me.chosen_amata) {
      amataAvatarUrl = '/amatas/' + me.chosen_amata + '.png';
      // Warm the cache up front so per-run avatars paint with no blank frame on
      // iOS Safari. We do two things: (1) decode the bitmap, and (2) prime the
      // CSS background-image layer with an offscreen warm-up node (Safari caches
      // the decoded background so later background-image uses paint instantly).
      try {
        const pre = new Image();
        pre.src = amataAvatarUrl;
        if (pre.decode) { await pre.decode().catch(() => {}); }
      } catch {}
      try {
        const warm = document.createElement('div');
        warm.style.cssText =
          'position:absolute;left:-9999px;top:-9999px;width:26px;height:26px;' +
          `background-image:url("${amataAvatarUrl}");background-size:cover;`;
        document.body.appendChild(warm);
        // keep it around briefly so Safari finishes rasterizing the layer
        setTimeout(() => warm.remove(), 4000);
      } catch {}
      const av = document.getElementById('chat-avatar');
      if (av) {
        av.textContent = '';
        const img = document.createElement('img');
        img.src = amataAvatarUrl;
        img.alt = '';
        img.style.width = '100%'; img.style.height = '100%';
        img.style.objectFit = 'cover'; img.style.borderRadius = '50%';
        av.appendChild(img);
      }
      reconcileAvatars(false);
    }
  } catch {}
})();

let messages = [];      // {id, role, text} - mirror of what's rendered
let sending = false;
let rendering = false;  // true only during full renderAll (suppresses live-avatar work)

// --- run avatars (bubble-anchored model) -----------------------------------
// Each AI "run" (consecutive AI bubbles) shows ONE avatar, attached as a CHILD
// of that run's LAST bubble. Its resting position is defined purely in CSS
// (.run-avatar { position:absolute; left:-36px; bottom:8px } inside .bubble.ai),
// so it rides with its bubble through any reflow - bottom-aligned short chats,
// the iOS keyboard, URL-bar collapse - with no offsetTop math to go stale.
// reconcileAvatars() makes the DOM match that rule: every run-ender owns exactly
// one avatar; when a run grows we MOVE the same node to the new ender.
const AVATAR_SLIDE = 'transform .34s cubic-bezier(.33,1,.68,1)';

function makeAvatarNode() {
  const a = document.createElement('div');
  a.className = 'run-avatar';
  // CSS background-image (not <img>): on iOS Safari a fresh <img> shows a blank
  // frame while decoding, but a cached background paints synchronously.
  if (amataAvatarUrl) a.style.backgroundImage = `url("${amataAvatarUrl}")`;
  // One-shot entrance pop for a brand-new run's avatar. Cleared on move below so
  // reparenting within a run can't replay it.
  a.style.animation = 'avatarpop .26s cubic-bezier(.34,1.56,.64,1) both';
  return a;
}

function aiEndsRun(nodes, i) {
  const n = nodes[i];
  if (!n || !n.classList.contains('ai')) return false;
  const next = nodes[i + 1];
  return !next || !next.classList.contains('ai');
}

// Make avatars match the rule. `animate` slides the moved avatar (FLIP);
// `firstRect` is the avatar's pre-move viewport rect (captured before the new
// bubble shifted layout) so the slide measures from the true start.
function reconcileAvatars(animate, firstRect) {
  if (!amataAvatarUrl) return;
  const nodes = [...messagesEl.querySelectorAll('.bubble')];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const has = node.querySelector(':scope > .run-avatar');
    const isEnder = aiEndsRun(nodes, i);
    if (isEnder && !has) {
      const prev = nodes[i - 1];
      const prevAv = prev && prev.classList.contains('ai')
        ? prev.querySelector(':scope > .run-avatar') : null;
      if (prevAv) {
        prevAv.style.animation = '';   // moving must never replay the entrance pop
        if (animate) {
          const first = firstRect || prevAv.getBoundingClientRect();
          node.appendChild(prevAv);
          const last = prevAv.getBoundingClientRect();
          const dy = first.top - last.top, dx = first.left - last.left;
          if (dy || dx) {
            prevAv.style.transition = 'none';
            prevAv.style.transform = `translate(${dx}px,${dy}px)`;
            void prevAv.offsetHeight;
            requestAnimationFrame(() => {
              prevAv.style.transition = AVATAR_SLIDE;
              prevAv.style.transform = 'translate(0,0)';
            });
          }
        } else {
          node.appendChild(prevAv);
        }
      } else {
        node.appendChild(makeAvatarNode());
      }
    } else if (!isEnder && has) {
      has.remove();
    }
  }
}

// Bubble/viewport changes that move bubbles are handled automatically (the
// avatar is anchored to its bubble in CSS); we only need to ensure the set of
// avatars is correct, which append/render already do. Resize/font load need no
// repositioning pass now, but reconcile is cheap and keeps the set correct.
window.addEventListener('resize', () => reconcileAvatars(false));
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => reconcileAvatars(false));
}
function groupClass(list, i) {
  const m = list[i], prev = list[i - 1], next = list[i + 1];
  const samePrev = prev && prev.role === m.role;
  const sameNext = next && next.role === m.role;
  if (samePrev && sameNext) return 'grouped-mid';
  if (sameNext) return 'grouped-top';
  if (samePrev) return 'grouped-bot';
  return '';
}

// Re-evaluate grouping classes on the last few bubbles (cheap) so consecutive
// bubbles tuck together without a full re-render.
function refreshGrouping() {
  const nodes = [...messagesEl.querySelectorAll('.bubble')];
  nodes.forEach((node, i) => {
    node.classList.remove('grouped-top', 'grouped-mid', 'grouped-bot', 'run-gap');
    const g = groupClass(messages, i);
    if (g) node.classList.add(g);
    if (i > 0 && messages[i - 1].role !== messages[i].role) node.classList.add('run-gap');
  });
}

// Append one bubble to the DOM (optionally animated). Keeps `messages` in sync.
function appendBubble(m, { animate = false, animateAvatar = false } = {}) {
  messages.push(m);

  // Payment card bubble: a styled card with a "Get my spot" button linking to
  // the payment page. (In history/back-office this same message reads as text.)
  if (m.kind === 'payment_card') {
    const card = document.createElement('a');
    card.className = 'pay-card';
    card.href = m.payUrl || '#';
    card.dataset.id = m.id;
    card.innerHTML = `
      <div class="pay-card-title">Blind Tuesdate event</div>
      <div class="pay-card-divider"></div>
      <div class="pay-card-cta">Get my spot</div>`;
    messagesEl.appendChild(card);
    if (!rendering) reconcileAvatars(false);
    scrollToBottom();
    return;
  }

  // Rating card bubble: same card design as payment, different copy + link.
  // Title "Your physical preferences", blue CTA "See our members", -> /rate.
  if (m.kind === 'rate_card') {
    const card = document.createElement('a');
    card.className = 'pay-card';
    card.href = m.rateUrl || '#';
    card.dataset.id = m.id;
    card.innerHTML = `
      <div class="pay-card-title">Your physical preferences</div>
      <div class="pay-card-divider"></div>
      <div class="pay-card-cta">See our members</div>`;
    messagesEl.appendChild(card);
    if (!rendering) reconcileAvatars(false);
    scrollToBottom();
    return;
  }

  const div = document.createElement('div');
  div.className = `bubble ${m.role}`;
  if (animate && m.role === 'user') div.classList.add('animate-in');
  div.textContent = m.text;
  div.dataset.id = m.id;

  // Capture the current run avatar's position BEFORE this bubble shifts layout,
  // so a same-run slide measures from the true start. (Travel is usually tiny.)
  let firstRect = null;
  if (!rendering && m.role === 'ai' && animateAvatar) {
    const prev = messages[messages.length - 2];
    const firstOfRun = !prev || prev.role !== 'ai';
    if (!firstOfRun) {
      const cur = messagesEl.querySelector('.bubble.ai > .run-avatar');
      if (cur) firstRect = cur.getBoundingClientRect();
    }
  }

  messagesEl.appendChild(div);
  refreshGrouping();

  if (!rendering) {
    // One reconcile pass handles every case: new run (create + pop), run growth
    // (move the avatar, optionally sliding), and a user bubble closing a run
    // (the avatar simply stays on the now-final AI bubble of the prior run).
    reconcileAvatars(/*animate=*/ !!firstRect, firstRect);
  }
  scrollToBottom();
}

// Full render (used once on load). Builds all bubbles, then one reconcile pass
// attaches exactly one avatar to each run's last bubble.
function renderAll() {
  messagesEl.innerHTML = '';
  const saved = messages;
  messages = [];
  rendering = true;
  for (const m of saved) appendBubble(m);
  rendering = false;
  reconcileAvatars(false);     // single pass: one avatar per run-ender
}

// --- typing indicator ------------------------------------------------------
let typingEl = null;
function showTyping() {
  if (typingEl) { scrollToBottom(); return; }  // already showing: don't recreate
  typingEl = document.createElement('div');
  typingEl.className = 'typing';
  typingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesEl.appendChild(typingEl);
  scrollToBottom();
}
function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

// --- bubble pacing queue ---------------------------------------------------
// Streamed AI replies arrive as several bubbles (one per sentence). Rather than
// popping them as fast as the model writes them, we queue them and reveal one
// at a time with a typing pause BETWEEN bubbles, so a split message feels like
// someone texting. The first bubble of a turn shows immediately; each later one
// waits GAP_MS (showing dots) before appearing.
const GAP_MS = 1200;
let bubbleQueue = [];      // pending bubbles for the current turn
let draining = false;       // is the drainer loop running?
let streamDone = false;     // has the network stream signalled no-more-bubbles?
let firstOfTurn = true;     // skip the pre-gap on the very first bubble

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueBubble(m) {
  bubbleQueue.push(m);
  if (!draining) drainQueue();
}

async function drainQueue() {
  draining = true;
  while (true) {
    if (bubbleQueue.length === 0) {
      // Nothing queued. If the stream is finished, we're done; otherwise wait
      // for the next bubble to arrive (keep dots up in the meantime).
      if (streamDone) break;
      showTyping();
      await sleep(120);      // idle poll while waiting for the next bubble
      continue;
    }
    // Pause (with dots) before every bubble except the first of the turn.
    if (!firstOfTurn) {
      showTyping();
      await sleep(GAP_MS);
    }
    firstOfTurn = false;
    const m = bubbleQueue.shift();
    hideTyping();
    appendBubble(m, { animateAvatar: true });
  }
  hideTyping();
  draining = false;
  // The turn is fully revealed now: re-enable sending.
  sending = false;
  updateSendButton();
}

function nearBottom() {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 140;
}
function scrollToBottom() { scrollEl.scrollTop = scrollEl.scrollHeight; }

// --- load history ----------------------------------------------------------
async function loadMessages() {
  const res = await fetch('/api/messages');
  if (res.status === 401) { window.location.href = '/'; return; }
  const data = await res.json();
  const list = data.messages || [];

  // Fresh conversation: only the scripted first AI message, no user messages yet.
  // Show a 2s typing animation, then reveal it (feels human, per spec).
  const isFreshOpener = list.length === 1 && list[0].role === 'ai';
  if (isFreshOpener) {
    messages = [];
    renderAll();              // empty
    showTyping();
    await new Promise((r) => setTimeout(r, 2000));
    hideTyping();
    appendBubble(list[0]);
    return;
  }

  messages = list;
  renderAll();
  return;
}

// Just returned from a successful payment: the webhook injected a "payment
// successful" message as the last AI bubble. Reveal it with a 2s typing
// animation, like the first message.
async function loadMessagesAfterPayment() {
  const res = await fetch('/api/messages');
  if (res.status === 401) { window.location.href = '/'; return; }
  const data = await res.json();
  const list = data.messages || [];
  if (list.length === 0) { messages = []; renderAll(); return; }

  const last = list[list.length - 1];
  if (last.role === 'ai') {
    // Render everything except the last, then type it out.
    messages = list.slice(0, -1);
    renderAll();
    showTyping();
    await new Promise((r) => setTimeout(r, 2000));
    hideTyping();
    appendBubble(last);
  } else {
    messages = list;
    renderAll();
  }
}

// --- sending ---------------------------------------------------------------
async function send() {
  const text = composer.value.trim();
  if (!text || sending) return;

  sending = true;

  // Reset the pacing queue for this turn.
  bubbleQueue = [];
  streamDone = false;
  firstOfTurn = true;

  // Optimistic echo with rise+fade. Keep focus on the composer the whole time
  // so the keyboard stays up.
  appendBubble({ id: 'tmp-' + Date.now(), role: 'user', text }, { animate: true });
  composer.value = '';
  autosize();
  updateSendButton();

  // Briefly lighten the pill on send.
  pill.classList.add('sending');
  setTimeout(() => pill.classList.remove('sending'), 160);

  showTyping();

  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) { window.location.href = '/'; return; }
    if (res.status === 409) { hideTyping(); return; }
    if (!res.ok || !res.body) throw new Error('bad response');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        handleEvent(event);
      }
    }
  } catch {
    streamDone = true;
    enqueueBubble({ id: 'e-' + Date.now(), role: 'ai', text: 'Something went wrong. Try again.' });
  } finally {
    // Mark the stream finished so the drainer can stop once the queue empties.
    // The drainer (not this block) hides the typing dots and re-enables sending,
    // because bubbles may still be pacing out after the network stream closes.
    streamDone = true;
    if (!draining && bubbleQueue.length === 0) {
      // Edge case: nothing was ever queued (e.g. early 401/409 returns above
      // already handled, or a no-op turn). Unlock here so we don't get stuck.
      hideTyping();
      sending = false;
      updateSendButton();
    }
    // Do NOT blur or refocus aggressively; keep the keyboard up. If focus was
    // retained throughout (it should be), the keyboard never closed.
  }
}

// Incoming AI bubbles are queued and revealed with a paced typing gap between
// them (see drainQueue). The queue handles showing/hiding the typing dots.
function handleEvent(event) {
  if (event.type === 'typing') {
    // Server hint that more is coming; the drainer manages the actual dots, but
    // showing them here covers the gap before the first queued bubble arrives.
    if (bubbleQueue.length === 0) showTyping();
  } else if (event.type === 'bubble') {
    enqueueBubble({
      id: 'a-' + Date.now() + '-' + Math.random(),
      role: 'ai',
      text: event.text,
      ...(event.kind === 'payment_card' ? { kind: 'payment_card', payUrl: event.payUrl } : {}),
      ...(event.kind === 'rate_card' ? { kind: 'rate_card', rateUrl: event.rateUrl } : {}),
    });
  } else if (event.type === 'error') {
    enqueueBubble({ id: 'e-' + Date.now(), role: 'ai', text: 'Sorry, something hiccuped. Try again.' });
  } else if (event.type === 'done') {
    // No more bubbles will arrive; let the drainer finish the queue and stop.
    streamDone = true;
  }
}

// --- composer behavior -----------------------------------------------------
function autosize() {
  composer.style.height = 'auto';
  composer.style.height = Math.min(composer.scrollHeight, 120) + 'px';
}
function updateSendButton() {
  if (composer.value.trim()) pill.classList.add('has-text');
  else pill.classList.remove('has-text');
}
composer.addEventListener('input', () => { autosize(); updateSendButton(); });

// Keep the keyboard up: prevent the send button from taking focus away from the
// textarea. preventDefault on mousedown is the well-supported way to stop the
// blur (iOS Safari fires mousedown). We deliberately do NOT preventDefault on
// touchstart, because that can suppress the click on iOS. iOS ignores focus()
// outside a user gesture, so the strategy is to never lose focus, not restore it.
sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
sendBtn.addEventListener('click', (e) => { e.preventDefault(); send(); });

// Enter sends on desktop; on touch keyboards the "send" enter key also sends
// (we set enterkeyhint="send"); Shift+Enter is a newline on desktop.
composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// --- visual viewport ------------------------------------------------------
// No JS viewport manipulation. The layout is hard-locked (html/body fixed,
// list is the only scroller, input bar fixed at the bottom); iOS Safari lifts
// the fixed input above the keyboard natively. This proved the most robust.

// --- init ------------------------------------------------------------------
updateSendButton();
// On load: if we just returned from a successful payment, reveal the success
// message with typing; otherwise load normally.
let _justPaid = false;
try { _justPaid = sessionStorage.getItem('justPaid') === '1'; if (_justPaid) sessionStorage.removeItem('justPaid'); } catch {}
let _justRated = false;
try { _justRated = sessionStorage.getItem('justRated') === '1'; if (_justRated) sessionStorage.removeItem('justRated'); } catch {}
if (_justPaid || _justRated) loadMessagesAfterPayment();
else loadMessages();
