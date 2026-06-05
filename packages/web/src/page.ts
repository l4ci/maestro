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
<link rel="icon" href="data:," />
<title>maestro</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0e1116; color: #d8dee4;
  }
  header {
    display: flex; align-items: baseline; gap: 12px;
    padding: 18px 24px; border-bottom: 1px solid #21262d;
  }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .5px; }
  header .tag { color: #768390; font-size: 12px; }
  #daemon { margin-left: auto; font-size: 12px; }
  #daemon.up { color: #57ab5a; }
  #daemon.down { color: #f47067; }
  #updated { color: #768390; font-size: 12px; }
  main { padding: 24px; max-width: 1000px; margin: 0 auto; }
  form.add {
    display: flex; gap: 8px; margin-bottom: 24px;
  }
  form.add input {
    flex: 1; padding: 8px 12px; border-radius: 6px;
    border: 1px solid #30363d; background: #161b22; color: #d8dee4; font: inherit;
  }
  form.add button {
    padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d;
    background: #238636; color: #fff; font: inherit; cursor: pointer;
  }
  form.add button:disabled { opacity: .5; cursor: default; }
  .repo { border: 1px solid #21262d; border-radius: 8px; margin-bottom: 16px; }
  .repo h2 {
    margin: 0; padding: 12px 16px; font-size: 14px; border-bottom: 1px solid #21262d;
    display: flex; align-items: center; gap: 10px;
    cursor: pointer; user-select: none;
  }
  .chev { color: #768390; font-size: 12px; }
  .repo table[hidden] { display: none; }
  .repo:has(table[hidden]) h2 { border-bottom: none; } /* no double border when collapsed */
  .counts { margin-left: auto; display: flex; gap: 6px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 16px; border-top: 1px solid #161b22; }
  td.iid { color: #768390; width: 64px; }
  td.state { width: 130px; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 12px; border: 1px solid transparent;
  }
  .s-new { background:#1f2630; color:#9db1c5; }
  .s-in-progress { background:#3a2d12; color:#e3b341; }
  .s-in-review { background:#12283a; color:#58a6ff; }
  .s-blocked { background:#3a1216; color:#f47067; }
  .s-done { background:#12331c; color:#57ab5a; }
  td.iid a { color: inherit; text-decoration: none; }
  td.iid a:hover { color: #58a6ff; text-decoration: underline; }
  a.mr {
    margin-left: 8px; font-size: 12px; color: #58a6ff; text-decoration: none;
    border: 1px solid #21333f; border-radius: 999px; padding: 1px 7px;
  }
  a.mr:hover { text-decoration: underline; }
  a.mr.draft { color: #768390; border-color: #2a2f37; } /* draft MR/PR reads as muted */
  td.people { width: 96px; white-space: nowrap; }
  .avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%; vertical-align: middle;
    font-size: 10px; font-weight: 600; color: #d8dee4; overflow: hidden;
    border: 1px solid #30363d; object-fit: cover; background: #1f2630;
  }
  .avatar.reviewer { margin-left: 4px; outline: 1px solid #2f81f7; }
  .empty { color: #768390; padding: 16px; }
  .err { color: #f47067; padding: 12px 16px; font-size: 13px; word-break: break-word; }
  #msg { min-height: 20px; color: #f47067; font-size: 13px; margin-bottom: 12px; }
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
  <form class="add" id="addForm" hidden>
    <input id="token" name="token" type="password" placeholder="dashboard token" autocomplete="off" />
    <input id="url" name="url" placeholder="add a repo — e.g. gitlab.com/group/api" autocomplete="off" />
    <button type="submit">add</button>
  </form>
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
function initialBg(username) {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
  return 'hsl(' + h + ' 45% 32%)';
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

function render(view) {
  renderDaemon(view.daemon);
  const root = el('repos');
  if (!view.repos || view.repos.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'no repos watched yet — add one above';
    root.replaceChildren(none); // nothing keyed to preserve on an empty board
    return;
  }
  reconcile(root, view.repos, (r) => r.repo.url, createRepoCard, updateRepoCard);
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
  const rows = r.error
    ? [{ key: '~error', error: r.error }]
    : ((r.issues || []).length
        ? r.issues.map((i) => ({ key: r.repo.url + '#' + i.iid, issue: i, forge: r.repo.forge }))
        : [{ key: '~empty' }]);
  reconcile(card.querySelector('tbody'), rows, (x) => x.key, createRow, updateRow);
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
  } else {
    const iid = td('iid');
    iid.append(link('', '', '')); // forge issue link; text + href filled in updateRow
    const state = td('state');
    state.append(badge(x.issue.state));
    // People cell: author (+ reviewer once handed off) as round avatars, filled in updateRow.
    tr.append(iid, state, td(''), td('people'));
  }
  return tr;
}

function updateRow(tr, x) {
  if (x.key === '~empty') return;
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
  title.replaceChildren(...children);
  // Rebuild avatars every poll so a reviewer assigned (or unassigned) at handoff is
  // reflected without recreating the row — same update-path discipline the MR link uses.
  const avatars = [];
  if (x.issue.author) avatars.push(avatar('author', x.issue.author));
  if (x.issue.reviewer) avatars.push(avatar('reviewer', x.issue.reviewer));
  people.replaceChildren(...avatars);
}

async function refresh() {
  try {
    const res = await fetch('/', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('dashboard returned ' + res.status);
    const view = await res.json();
    // The add-repo form only exists when the server says writes are enabled; a read-only
    // host (no token configured) never shows an input that would just 404 on submit.
    el('addForm').hidden = !view.writesEnabled;
    render(view);
    el('msg').textContent = '';
    el('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    el('msg').textContent = 'could not load dashboard: ' + err.message;
  }
}

el('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const url = el('url').value.trim();
  const token = el('token').value.trim();
  if (!url) return;
  btn.disabled = true;
  el('msg').style.color = '#f47067';
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
      el('msg').textContent =
        res.status === 401 ? 'a dashboard token is required to add a repo' : 'token rejected';
      return;
    }
    const data = await res.json();
    if (data.added) {
      el('url').value = '';
      el('msg').style.color = '#57ab5a';
      el('msg').textContent = 'added ' + (data.repo?.project ?? url);
      await refresh();
    } else {
      el('msg').textContent = 'could not add: ' + (data.reason ?? 'unknown');
    }
  } catch (err) {
    el('msg').textContent = 'add failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
