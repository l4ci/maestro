// The minimal read-only dashboard SHELL (M6 Part F, web UI). A single static HTML string:
// no framework, no build step, no server-side templating. The page fetches the SAME JSON
// read-model the API serves (GET / with `Accept: application/json`) and renders it client
// side, polling every few seconds so an operator can watch lifecycle states move. The only
// write is the add-repo form → POST /repos, the identical path `maestro add` uses.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" id="favicon" href="data:," />
<title>maestro</title>
<style>
  /* Palette as custom properties (#44): one set of names, themed per scheme. The dark
     values below are the original hardcoded look, now the dark theme; the light override
     lives in the prefers-color-scheme:light block. Per-state badges keep distinct hues in
     both schemes — their light variants are tuned for contrast on a light card. Surfaces
     reference var(--name) only, so nothing bleeds the wrong scheme (UA controls included,
     via color-scheme). */
  :root {
    color-scheme: light dark;
    --bg: #0e1116;
    --fg: #d8dee4;
    --muted: #768390;
    --muted-2: #8b98a5;
    --line: #21262d;
    --line-soft: #161b22;
    --surface: #161b22;
    --surface-2: #1f2630;
    --border: #30363d;
    --border-soft: #2a2f37;
    --accent: #58a6ff;
    --accent-line: #21333f;
    --accent-ring: #2f81f7;
    --up: #57ab5a;
    --down: #f47067;
    --btn-bg: #238636;
    --btn-fg: #fff;
    --avatar-bg: #1f2630;
    --avatar-fg: #f0f3f6; /* initials text — light, the circle is always a saturated mid-dark hue */
    --avatar-lum: 32%; /* initials-circle lightness, recomputed per scheme */
    /* Per-state badge backgrounds/foregrounds. */
    --s-new-bg: #1f2630; --s-new-fg: #9db1c5;
    --s-in-progress-bg: #3a2d12; --s-in-progress-fg: #e3b341;
    --s-in-review-bg: #12283a; --s-in-review-fg: #58a6ff;
    --s-blocked-bg: #3a1216; --s-blocked-fg: #f47067;
    --s-done-bg: #12331c; --s-done-fg: #57ab5a;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff;
      --fg: #1f2328;
      --muted: #59636e;
      --muted-2: #59636e;
      --line: #d1d9e0;
      --line-soft: #eaeef2;
      --surface: #f6f8fa;
      --surface-2: #eaeef2;
      --border: #d1d9e0;
      --border-soft: #d1d9e0;
      --accent: #0969da;
      --accent-line: #b6d4f5;
      --accent-ring: #0969da;
      --up: #1a7f37;
      --down: #cf222e;
      --btn-bg: #1f883d;
      --btn-fg: #ffffff;
      --avatar-bg: #eaeef2;
      --avatar-fg: #f0f3f6; /* still light: initials sit on a saturated circle, not the card */
      --avatar-lum: 38%; /* slightly lighter circle in light mode, white initials still read */
      --s-new-bg: #eaeef2; --s-new-fg: #344150;
      --s-in-progress-bg: #fff3d4; --s-in-progress-fg: #7d4e00;
      --s-in-review-bg: #ddf4ff; --s-in-review-fg: #0550ae;
      --s-blocked-bg: #ffebe9; --s-blocked-fg: #a40e26;
      --s-done-bg: #dafbe1; --s-done-fg: #0a6628;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--bg); color: var(--fg);
  }
  header {
    display: flex; align-items: baseline; gap: 12px;
    padding: 18px 24px; border-bottom: 1px solid var(--line);
  }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .5px; }
  header .tag { color: var(--muted); font-size: 12px; }
  #daemon { margin-left: auto; font-size: 12px; }
  #daemon.up { color: var(--up); }
  #daemon.down { color: var(--down); }
  #updated { color: var(--muted); font-size: 12px; }
  main { padding: 24px; max-width: 1000px; margin: 0 auto; }
  /* Add-repo entry point: a single button on the board; the token/url form lives in a
     native <dialog> it opens, so the inputs never crowd the read view. Dialog padding is
     0 (the form carries it) so a click that targets the dialog element itself can only be
     the backdrop — that's the light-dismiss test in the click handler. */
  #addBtn {
    padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--btn-bg); color: var(--btn-fg); font: inherit; cursor: pointer;
    margin-bottom: 24px;
  }
  dialog#addDialog {
    padding: 0; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); color: var(--fg);
    width: min(440px, calc(100vw - 32px));
  }
  dialog#addDialog::backdrop { background: rgba(0, 0, 0, .5); }
  form.add {
    display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 20px;
  }
  form.add h3 { margin: 0 0 2px; font-size: 14px; }
  form.add input {
    min-width: 0; padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--surface); color: var(--fg); font: inherit;
  }
  form.add button {
    padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--btn-bg); color: var(--btn-fg); font: inherit; cursor: pointer;
  }
  form.add button:disabled { opacity: .5; cursor: default; }
  form.add .actions { display: flex; gap: 8px; justify-content: flex-end; }
  form.add button.cancel { background: var(--surface); color: var(--fg); }
  #addMsg { min-height: 0; color: var(--down); font-size: 13px; }
  #addMsg:empty { display: none; }
  .repo { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 16px; }
  .repo h2 {
    margin: 0; padding: 12px 16px; font-size: 14px; border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 10px;
    cursor: pointer; user-select: none;
  }
  .chev { color: var(--muted); font-size: 12px; }
  .repo table[hidden] { display: none; }
  .repo:has(table[hidden]) h2 { border-bottom: none; } /* no double border when collapsed */
  .counts { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 16px; border-top: 1px solid var(--line-soft); }
  td.iid { color: var(--muted); width: 64px; }
  td.state { width: 130px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 12px; border: 1px solid transparent;
  }
  .s-new { background: var(--s-new-bg); color: var(--s-new-fg); }
  .s-in-progress { background: var(--s-in-progress-bg); color: var(--s-in-progress-fg); }
  .s-in-review { background: var(--s-in-review-bg); color: var(--s-in-review-fg); }
  .s-blocked { background: var(--s-blocked-bg); color: var(--s-blocked-fg); }
  .s-done { background: var(--s-done-bg); color: var(--s-done-fg); }
  td.iid a { color: inherit; text-decoration: none; }
  td.iid a:hover { color: var(--accent); text-decoration: underline; }
  /* Unified last-activity line (#39): a muted secondary row under the title. */
  .activity {
    display: block; margin-top: 3px; color: var(--muted); font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 520px;
  }
  .activity .src {
    text-transform: uppercase; font-size: 10px; letter-spacing: .4px;
    border: 1px solid var(--border-soft); border-radius: 4px; padding: 0 4px; margin: 0 6px;
  }
  .activity .when { color: var(--muted-2); }
  a.mr {
    margin-left: 8px; font-size: 12px; color: var(--accent); text-decoration: none;
    border: 1px solid var(--accent-line); border-radius: 999px; padding: 1px 7px;
  }
  a.mr:hover { text-decoration: underline; }
  a.mr.draft { color: var(--muted); border-color: var(--border-soft); } /* draft MR/PR reads as muted */
  td.people { width: 96px; white-space: nowrap; }
  .avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%; vertical-align: middle;
    font-size: 10px; font-weight: 600; color: var(--avatar-fg); overflow: hidden;
    border: 1px solid var(--border); object-fit: cover; background: var(--avatar-bg);
  }
  .avatar.reviewer { margin-left: 4px; outline: 1px solid var(--accent-ring); }
  .empty { color: var(--muted); padding: 16px; }
  .err { color: var(--down); padding: 12px 16px; font-size: 13px; word-break: break-word; }
  /* Per-issue drill-down (#41): the clickable issue row + the inline detail panel that
     expands beneath it. The panel is a full-width cell that lazy-loads its JSON on first
     open; everything inside references the themed palette vars, never a literal hex. */
  tr.issue { cursor: pointer; }
  tr.issue:hover td { background: var(--line-soft); }
  tr.issue.open td { background: var(--line-soft); }
  td.detail { padding: 0; }
  td.detail[hidden] { display: none; }
  .panel { padding: 14px 16px; border-top: 1px solid var(--accent-line); background: var(--surface); }
  .panel section { margin-bottom: 14px; }
  .panel section:last-child { margin-bottom: 0; }
  .panel h3 {
    margin: 0 0 8px; font-size: 11px; letter-spacing: .5px; text-transform: uppercase;
    color: var(--muted);
  }
  .panel .loading, .panel .none { color: var(--muted); font-size: 13px; }
  .progress-meter {
    height: 6px; border-radius: 999px; background: var(--surface-2);
    overflow: hidden; margin: 6px 0 10px;
  }
  .progress-meter > i { display: block; height: 100%; background: var(--up); }
  .progress-count { color: var(--muted); font-size: 12px; margin-left: 8px; }
  ul.plan { list-style: none; margin: 0; padding: 0; }
  ul.plan li { display: flex; gap: 8px; padding: 2px 0; font-size: 13px; }
  ul.plan li .box { color: var(--muted); }
  ul.plan li.checked .box { color: var(--up); }
  ul.plan li.checked .text { color: var(--muted); text-decoration: line-through; }
  .mr-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px;
    background: var(--surface-2); color: var(--fg); border: 1px solid var(--border-soft);
  }
  .pill.ready { background: var(--s-done-bg); color: var(--s-done-fg); }
  .pill.draft { background: var(--s-new-bg); color: var(--s-new-fg); }
  .pill.approved { background: var(--s-done-bg); color: var(--s-done-fg); }
  .pill.changes { background: var(--s-blocked-bg); color: var(--s-blocked-fg); }
  ul.logs { list-style: none; margin: 0; padding: 0; font-size: 12px; }
  ul.logs li { padding: 2px 0; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
  ul.logs li .lvl { color: var(--muted-2); margin-right: 8px; }
  ul.logs li.warn .lvl { color: var(--s-in-progress-fg); }
  ul.logs li.error .lvl { color: var(--down); }
  ul.comments { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  ul.comments li { padding: 4px 0; border-top: 1px solid var(--line-soft); }
  ul.comments li:first-child { border-top: none; }
  ul.comments li .who { color: var(--accent); margin-right: 6px; }
  ul.comments li .body { color: var(--fg); white-space: pre-wrap; word-break: break-word; }
  #msg { min-height: 20px; color: var(--down); font-size: 13px; margin-bottom: 12px; }
  /* Narrow screens (#44): a 390px phone must not scroll sideways. Cut paddings, let the
     header wrap, drop the fixed iid/state/people column widths so the title cell takes the
     slack. The add form already stacks (it's a column inside the dialog); the opener button
     just goes full width. */
  @media (max-width: 600px) {
    header { padding: 14px 16px; flex-wrap: wrap; gap: 6px 10px; }
    #daemon { flex-basis: 100%; margin-left: 0; }
    main { padding: 16px; }
    #addBtn { width: 100%; }
    .repo h2 { padding: 10px 12px; }
    td { padding: 8px 12px; }
    td.iid { width: auto; }
    td.state { width: auto; }
    td.people { width: auto; }
    .activity { max-width: 60vw; }
  }
</style>
</head>
<body>
<header>
  <h1>maestro</h1>
  <span class="tag">read-only dashboard</span>
  <span id="daemon"></span>
  <span id="updated"></span>
</header>
<main>
  <button id="addBtn" type="button" hidden>Add Repo</button>
  <dialog id="addDialog">
    <form class="add" id="addForm">
      <h3>Add a repo</h3>
      <input id="token" name="token" type="password" placeholder="dashboard token" autocomplete="off" />
      <input id="url" name="url" placeholder="add a repo — e.g. gitlab.com/group/api" autocomplete="off" />
      <div id="addMsg"></div>
      <div class="actions">
        <button type="button" class="cancel" id="addCancel">cancel</button>
        <button type="submit">add</button>
      </div>
    </form>
  </dialog>
  <div id="msg"></div>
  <div id="repos"><div class="empty">loading…</div></div>
</main>
<script>
const STATES = ['new','in-progress','in-review','blocked','done'];
const el = (id) => document.getElementById(id);

// Everything below builds DOM via createElement/textContent — forge-controlled text
// (titles, error messages) never passes through innerHTML, so it stays inert (§13.1).

function span(className, text) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function badge(state) {
  return span('badge s-' + state, state);
}

// Allowlist a forge-controlled URL to http(s) so a hostile webUrl can't smuggle a
// javascript: URI into an anchor. Unparsable or off-scheme → inert '#'.
function safeUrl(href) {
  try {
    const u = new URL(href, window.location.href);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {
    // unparsable URL → fall through to '#'
  }
  return '#';
}

// An external forge link (#35). href is set as a property, not via innerHTML, so the
// forge-controlled URL can never break out into markup — same inert-text guarantee
// as titles (§13.1). Opens in a new tab; rel guards against tab-nabbing.
function link(className, text, href) {
  const a = document.createElement('a');
  a.className = className;
  a.textContent = text;
  a.href = safeUrl(href);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

// A small round person avatar (#37). When the forge gives an avatar_url we render an
// <img> — but its src is forge-controlled, so it goes through the SAME http(s) allowlist
// as every other URL that lands in the DOM (#35); a javascript:/data: payload degrades to
// the initials fallback rather than being assigned raw. Without a usable URL we draw the
// username's initial in a circle whose hue is derived from the name — no external avatar
// service is guessed. The title carries a role-prefixed username for hover.
// Read a themed CSS custom property off :root, falling back to a literal when the
// computed value is empty (e.g. jsdom, which doesn't resolve cascaded vars). This is how
// the canvas favicon and the initials circle pick up the active scheme's palette without
// duplicating the hexes here (#44).
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function initialBg(username) {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
  // Lightness comes from --avatar-lum so the same hue stays legible: deeper in dark mode,
  // lighter (but still readable against white text) in light mode.
  return 'hsl(' + h + ' 45% ' + cssVar('--avatar-lum', '32%') + ')';
}
function avatar(role, person) {
  const title = role + ': ' + person.username;
  const safe = person.avatarUrl ? safeUrl(person.avatarUrl) : '#';
  if (safe !== '#') {
    const img = document.createElement('img');
    img.className = 'avatar ' + role;
    img.src = safe;
    img.alt = person.username;
    img.title = title;
    return img;
  }
  const initial = (person.username.trim()[0] || '?').toUpperCase();
  const s = span('avatar ' + role, initial);
  s.title = title;
  s.style.background = initialBg(person.username);
  return s;
}

// A compact "3m ago" relative time from an ISO 8601 string, recomputed every poll so the
// dashboard ages in place without a reload. Future or unparsable timestamps degrade to
// 'just now' rather than throwing. Returns '' on a bad input so callers can skip the line.
function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

// The unified last-activity line (#39): relative time + source tag + truncated summary,
// e.g. "2m ago · mr · review thread". The summary is forge-controlled (comment bodies,
// log lines), so it lands via textContent — inert, never innerHTML (§13.1). The absolute
// ISO time rides as the title tooltip. Returns null when there's nothing to show.
function activityLine(a) {
  if (!a || !a.at) return null;
  const when = relativeTime(a.at);
  if (!when) return null;
  const line = document.createElement('span');
  line.className = 'activity';
  line.title = a.at; // absolute time on hover
  const whenEl = span('when', when);
  const srcEl = span('src', a.source);
  const sumEl = document.createElement('span');
  sumEl.textContent = a.summary || '';
  line.append(whenEl, srcEl, sumEl);
  return line;
}

// Keyed child reconciliation (#42): reuse nodes by data-key, create missing ones,
// move (never rebuild) on reorder, drop leftovers. Node identity survives the 5s
// poll, so UI state attached to a node (collapse, expansion, selection) survives too.
function reconcile(container, items, keyOf, create, update) {
  const byKey = new Map();
  for (const child of [...container.children]) {
    if (child.dataset.key === undefined) child.remove(); // placeholder (e.g. loading…)
    else byKey.set(child.dataset.key, child);
  }
  let cursor = container.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    let node = byKey.get(key);
    if (node) byKey.delete(key);
    else {
      node = create(item);
      node.dataset.key = key;
    }
    if (node === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(node, cursor);
    update(node, item);
  }
  for (const leftover of byKey.values()) leftover.remove();
}

// Daemon liveness (#40). The dashboard reads the forge directly, so without this it renders
// a healthy board while the daemon is dead and issues silently stop moving. The heartbeat is
// the daemon's own per-tick stamp; we judge freshness against the tick cadence IT recorded
// (tickIntervalMs), never a constant guessed here. Three states:
//   · fresh  (age < ~3 ticks)  → green '● daemon up · A/M workers'
//   · stale  (older)           → red   '○ daemon not seen for Nm'
//   · no file (daemon never ran)→ red   '○ daemon not running'
// All text via textContent — the only field that ever came off disk is numeric, but the
// inert-text discipline holds regardless (§13.1).
function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h';
}

function renderDaemon(d) {
  const node = el('daemon');
  if (!d) {
    node.className = 'down';
    node.textContent = '○ daemon not running';
    return;
  }
  const age = Date.now() - d.lastTickAt;
  // Floor the window at 10s so a fast 1s tick plus the 5s poll cadence and clock skew
  // doesn't flap the indicator; otherwise allow ~3 of the daemon's own tick intervals.
  const stale = age > Math.max(3 * d.tickIntervalMs, 10000);
  if (stale) {
    node.className = 'down';
    node.textContent = '○ daemon not seen for ' + fmtAge(age);
  } else {
    node.className = 'up';
    node.textContent = '● daemon up · ' + d.activeWorkers + '/' + d.maxWorkers + ' workers';
  }
}

// Blocked visibility (#43). 'blocked' is the only state needing a human; an unreachable
// repo (error marker) is the same "needs a human" class. Make the count ambient so a
// background tab still surfaces it: a tab-title suffix and a red favicon dot, both derived
// from the already-polled counts — no API change. setFavicon paints a 16×16 dot on a
// canvas and assigns the data-URI to the <link rel=icon>, so it stays dependency-free; we
// only touch the DOM when the icon actually changes to avoid needless re-decodes per poll.
function attentionCount(repos) {
  let n = 0;
  for (const r of repos) n += r.error ? 1 : r.counts.blocked || 0;
  return n;
}

let faviconHref = null;
function setFavicon(href) {
  if (href === faviconHref) return;
  faviconHref = href;
  el('favicon').href = href;
}

function dotFavicon(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'data:,'; // no 2d context (e.g. jsdom) → leave the icon empty
  ctx.beginPath();
  ctx.arc(8, 8, 6, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  return canvas.toDataURL('image/png');
}

function renderAttention(repos) {
  const blocked = attentionCount(repos);
  // Tab title: 'maestro · 2 blocked' when any repo needs a human, plain 'maestro' otherwise.
  document.title = blocked > 0 ? 'maestro · ' + blocked + ' blocked' : 'maestro';
  // Favicon: a red dot while anything is blocked/unreachable, otherwise the empty default.
  // The dot reads the themed --down so it stays a legible red against either OS scheme's
  // tab strip rather than a single hardcoded hex (#44).
  setFavicon(blocked > 0 ? dotFavicon(cssVar('--down', '#f47067')) : 'data:,');
}

// Sort repos that need a human to the top (blocked rows or an unreachable error), keeping
// the rest in stable input order. Returns a new array — never mutates the polled view, so
// the keyed reconcile still moves (never rebuilds) the existing card nodes on reorder.
function sortReposByAttention(repos) {
  return [...repos]
    .map((r, i) => [r, i])
    .sort((a, b) => attentionRank(b[0]) - attentionRank(a[0]) || a[1] - b[1])
    .map((pair) => pair[0]);
}
function attentionRank(r) {
  if (r.error) return 1;
  return (r.counts && r.counts.blocked) > 0 ? 1 : 0;
}

function render(view) {
  renderDaemon(view.daemon);
  renderAttention(view.repos || []);
  const root = el('repos');
  if (!view.repos || view.repos.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'no repos watched yet — add one above';
    root.replaceChildren(none); // nothing keyed to preserve on an empty board
    return;
  }
  reconcile(root, sortReposByAttention(view.repos), (r) => r.repo.url, createRepoCard, updateRepoCard);
}

function createRepoCard(r) {
  const card = document.createElement('div');
  card.className = 'repo';
  const h2 = document.createElement('h2');
  const chev = span('chev', '▾');
  h2.append(chev, r.repo.project, span('counts', ''));
  const table = document.createElement('table');
  table.append(document.createElement('tbody'));
  // Collapse on header click (#34): plain node state — the keyed renderer never
  // recreates this card across polls, so the toggle survives every refresh for free.
  h2.addEventListener('click', () => {
    table.hidden = !table.hidden;
    chev.textContent = table.hidden ? '▸' : '▾';
  });
  card.append(h2, table);
  return card;
}

function updateRepoCard(card, r) {
  // A repo whose forge call failed carries an error marker — show it as unreachable
  // instead of a misleading idle, so broken auth never looks like a healthy empty repo.
  const counts = card.querySelector('.counts');
  if (r.error) counts.replaceChildren(span('badge s-blocked', 'unreachable'));
  else {
    const badges = STATES
      .filter((s) => r.counts[s] > 0)
      .flatMap((s) => [badge(s), ' ' + r.counts[s] + '  ']);
    counts.replaceChildren(...(badges.length ? badges : [span('tag', 'idle')]));
  }
  // Error and empty placeholders ride the same keyed path, so the CARD node (and any
  // UI state on it) survives a repo flipping between healthy and unreachable.
  // Blocked rows first (#43): a stable partition pulls blocked issues to the top of the card
  // while leaving every other row in its incoming LifecycleState order (§11). Stable so the
  // keyed reconcile moves (never rebuilds) rows on the rare reorder.
  const ordered = sortIssuesByBlocked(r.issues || []);
  // Each issue contributes TWO keyed rows: the clickable summary row and a detail row that
  // holds the drill-down panel (#41), hidden until the summary is clicked. Pairing them as
  // adjacent keyed siblings lets the reconcile preserve the panel node (and its fetched-once
  // content + open/closed state) across the 5s poll, exactly like every other keyed row.
  const rows = r.error
    ? [{ key: '~error', error: r.error }]
    : (ordered.length
        ? ordered.flatMap((i) => [
            { key: r.repo.url + '#' + i.iid, issue: i, forge: r.repo.forge, repoId: r.repo.url },
            { key: r.repo.url + '#' + i.iid + '~detail', detail: true },
          ])
        : [{ key: '~empty' }]);
  reconcile(card.querySelector('tbody'), rows, (x) => x.key, createRow, updateRow);
}

// Stable partition: blocked issues first, the rest left in incoming order (#43).
function sortIssuesByBlocked(issues) {
  const blocked = [];
  const rest = [];
  for (const i of issues) (i.state === 'blocked' ? blocked : rest).push(i);
  return blocked.concat(rest);
}

function createRow(x) {
  const tr = document.createElement('tr');
  const td = (className) => {
    const c = document.createElement('td');
    if (className) c.className = className;
    return c;
  };
  if (x.key === '~error' || x.key === '~empty') {
    const cell = td(x.key === '~error' ? 'err' : 'empty');
    cell.colSpan = 4;
    if (x.key === '~empty') cell.textContent = 'no open issues assigned to the bot';
    tr.append(cell);
  } else if (x.detail) {
    // The drill-down panel row (#41): one full-width cell, hidden until its summary row is
    // clicked. The panel itself is built lazily on first open, so a collapsed board renders
    // (and polls) without ever fetching a single detail payload.
    const cell = td('detail');
    cell.colSpan = 4;
    cell.hidden = true;
    cell.append(panelEl());
    tr.append(cell);
  } else {
    tr.className = 'issue';
    const iid = td('iid');
    iid.append(link('', '', '')); // forge issue link; text + href filled in updateRow
    const state = td('state');
    state.append(badge(x.issue.state));
    // People cell: author (+ reviewer once handed off) as round avatars, filled in updateRow.
    tr.append(iid, state, td(''), td('people'));
    // Click anywhere on the summary row (except the forge links, which open in a new tab)
    // toggles its detail row open/closed and lazy-loads it once. The detail row is the
    // immediate next sibling, by construction of the paired keyed rows above.
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let the issue/MR links do their thing
      toggleDetail(tr, x.repoId, x.issue.iid, x.forge);
    });
  }
  return tr;
}

function updateRow(tr, x) {
  if (x.key === '~empty' || x.detail) return;
  if (x.key === '~error') {
    tr.firstElementChild.textContent = '⚠ ' + x.error;
    return;
  }
  const [iid, state, title, people] = tr.children;
  const issueLink = iid.firstElementChild;
  issueLink.textContent = '#' + x.issue.iid;
  issueLink.href = safeUrl(x.issue.issueUrl);
  const b = state.firstElementChild;
  b.className = 'badge s-' + x.issue.state;
  b.textContent = x.issue.state;
  // Title cell holds the title text node plus an optional MR/PR link; rebuild both so a
  // newly-opened (or vanished) MR is reflected across polls without recreating the row.
  const noun = x.forge === 'github' ? 'PR' : 'MR';
  const children = [x.issue.title];
  if (x.issue.mrUrl) {
    children.push(link('mr' + (x.issue.isDraft ? ' draft' : ''), noun + ' ↗', x.issue.mrUrl));
  }
  // Last-activity line (#39): rebuilt every poll so the relative time ages and a newer
  // signal (MR push, fresh comment) replaces a stale one without recreating the row.
  const activity = activityLine(x.issue.lastActivity);
  if (activity) children.push(activity);
  title.replaceChildren(...children);
  // Rebuild avatars every poll so a reviewer assigned (or unassigned) at handoff is
  // reflected without recreating the row — same update-path discipline the MR link uses.
  const avatars = [];
  if (x.issue.author) avatars.push(avatar('author', x.issue.author));
  if (x.issue.reviewer) avatars.push(avatar('reviewer', x.issue.reviewer));
  people.replaceChildren(...avatars);
}

// --- Per-issue drill-down (#41) ---------------------------------------------------------
// Toggle the detail row that follows a summary row. On the FIRST open we fetch the issue
// view from GET /repos/<encoded repoId>/issues/<iid> — the route fixed in this change — and
// render it into the panel; subsequent opens just re-show the already-loaded node (no second
// fetch, the keyed reconcile keeps it alive across polls). Detail fetches happen on expand
// ONLY, never folded into the 5s dashboard poll, so the collapsed payload stays small.
function panelEl() {
  const panel = document.createElement('div');
  panel.className = 'panel';
  return panel;
}

function toggleDetail(summaryRow, repoId, iid, forge) {
  const detailRow = summaryRow.nextElementSibling;
  const cell = detailRow && detailRow.firstElementChild;
  if (!cell) return;
  const opening = cell.hidden;
  cell.hidden = !opening;
  summaryRow.classList.toggle('open', opening);
  if (opening && !cell.dataset.loaded) loadDetail(cell, repoId, iid, forge);
}

async function loadDetail(cell, repoId, iid, forge) {
  cell.dataset.loaded = '1'; // fetch-once guard; cleared on error so a retry can re-fetch
  const panel = cell.firstElementChild;
  panel.replaceChildren(span('loading', 'loading…'));
  try {
    const url = '/repos/' + encodeURIComponent(repoId) + '/issues/' + iid;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('detail returned ' + res.status);
    renderDetail(panel, await res.json(), forge);
  } catch (err) {
    cell.dataset.loaded = '';
    const e = span('none', 'could not load detail: ' + err.message);
    panel.replaceChildren(e);
  }
}

// Build the detail panel from an IssueView (#41): plan progress, MR status, recent logs,
// recent comments. Every forge-controlled string (plan item text, log messages, comment
// bodies, usernames) lands via textContent — inert, never innerHTML (§13.1).
function renderDetail(panel, view, forge) {
  const sections = [];
  const planSec = planSection(view.plan);
  if (planSec) sections.push(planSec);
  const mrSec = mrSection(view, forge);
  if (mrSec) sections.push(mrSec);
  sections.push(logsSection(view.recentLogs || []));
  const commentsSec = commentsSection(view.recentComments || []);
  if (commentsSec) sections.push(commentsSec);
  panel.replaceChildren(...sections);
}

function sectionEl(heading) {
  const sec = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = heading;
  sec.append(h);
  return sec;
}

function planSection(plan) {
  if (!plan || !plan.total) return null;
  const sec = sectionEl('Plan');
  const meter = document.createElement('div');
  meter.className = 'progress-meter';
  const fill = document.createElement('i');
  const pct = Math.round((plan.done / plan.total) * 100);
  fill.style.width = pct + '%';
  meter.append(fill);
  const head = document.createElement('div');
  head.append(document.createTextNode(plan.done + '/' + plan.total + ' tasks'));
  const list = document.createElement('ul');
  list.className = 'plan';
  for (const item of plan.items) {
    const li = document.createElement('li');
    if (item.checked) li.className = 'checked';
    li.append(span('box', item.checked ? '☑' : '☐'), span('text', item.text));
    list.append(li);
  }
  sec.append(head, meter, list);
  return sec;
}

function mrSection(view, forge) {
  if (!view.mrUrl) return null;
  const noun = forge === 'github' ? 'PR' : 'MR';
  const sec = sectionEl(noun + ' status');
  const row = document.createElement('div');
  row.className = 'mr-status';
  // Posture pills, derived from the same flags the board reads. Draft and "changes
  // requested" are the two "needs work" states; approved/ready are the green ones.
  if (view.isDraft) row.append(span('pill draft', 'draft'));
  else row.append(span('pill ready', 'ready for review'));
  if (view.changesRequested) row.append(span('pill changes', 'changes requested'));
  else if (view.approved) row.append(span('pill approved', 'approved'));
  row.append(link('mr', noun + ' ↗', view.mrUrl));
  sec.append(row);
  return sec;
}

function logsSection(logs) {
  const sec = sectionEl('Recent activity');
  if (logs.length === 0) {
    sec.append(span('none', 'no agent logs yet'));
    return sec;
  }
  const list = document.createElement('ul');
  list.className = 'logs';
  for (const line of logs) {
    const li = document.createElement('li');
    if (line.level === 'warn' || line.level === 'error') li.className = line.level;
    li.append(span('lvl', '[' + line.level + ']'), document.createTextNode(line.msg));
    list.append(li);
  }
  sec.append(list);
  return sec;
}

function commentsSection(comments) {
  if (comments.length === 0) return null;
  const sec = sectionEl('Latest comments');
  const list = document.createElement('ul');
  list.className = 'comments';
  for (const c of comments) {
    const li = document.createElement('li');
    li.append(span('who', '@' + (c.author ? c.author.username : '?')), span('body', c.body || ''));
    list.append(li);
  }
  sec.append(list);
  return sec;
}

async function refresh() {
  try {
    const res = await fetch('/', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('dashboard returned ' + res.status);
    const view = await res.json();
    // The add-repo button only exists when the server says writes are enabled; a read-only
    // host (no token configured) never shows an entry point that would just 404 on submit.
    el('addBtn').hidden = !view.writesEnabled;
    render(view);
    el('msg').textContent = '';
    el('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    el('msg').style.color = cssVar('--down', '#f47067');
    el('msg').textContent = 'could not load dashboard: ' + err.message;
  }
}

// The add form lives in a modal <dialog> behind the Add Repo button: showModal() gives
// focus trapping and Esc-to-close for free. The dialog itself has no padding (the form
// carries it), so a click whose target is the dialog element can only land on the
// backdrop — that's the whole light-dismiss test. The method calls feature-detect because
// jsdom only reflects the open property, not show/showModal/close (e.g. our page tests);
// there the modal degrades to a plain open/close toggle.
function openDialog(d) {
  if (d.showModal) d.showModal();
  else d.open = true;
}
function closeDialog(d) {
  if (d.close) d.close();
  else d.open = false;
}
el('addBtn').addEventListener('click', () => {
  el('addMsg').textContent = '';
  openDialog(el('addDialog'));
});
el('addCancel').addEventListener('click', () => closeDialog(el('addDialog')));
el('addDialog').addEventListener('click', (e) => {
  if (e.target === el('addDialog')) closeDialog(el('addDialog'));
});

el('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const url = el('url').value.trim();
  const token = el('token').value.trim();
  if (!url) return;
  btn.disabled = true;
  el('addMsg').textContent = '';
  try {
    // The token never leaves the browser except as the Bearer header on this write call;
    // the server compares it in constant time and never echoes it back.
    const res = await fetch('/repos', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: new URLSearchParams({ url }).toString(),
    });
    if (res.status === 401 || res.status === 403) {
      el('addMsg').textContent =
        res.status === 401 ? 'a dashboard token is required to add a repo' : 'token rejected';
      return;
    }
    const data = await res.json();
    if (data.added) {
      // Success closes the dialog and reports on the board; the token field keeps its
      // value so adding several repos in a row only asks for the secret once.
      el('url').value = '';
      closeDialog(el('addDialog'));
      // Refresh FIRST: its success path clears #msg, so the confirmation has to land after.
      await refresh();
      el('msg').style.color = cssVar('--up', '#57ab5a');
      el('msg').textContent = 'added ' + (data.repo?.project ?? url);
    } else {
      el('addMsg').textContent = 'could not add: ' + (data.reason ?? 'unknown');
    }
  } catch (err) {
    el('addMsg').textContent = 'add failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
