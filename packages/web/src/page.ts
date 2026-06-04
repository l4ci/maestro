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
  #updated { margin-left: auto; color: #768390; font-size: 12px; }
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
  }
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
  .empty { color: #768390; padding: 16px; }
  #msg { min-height: 20px; color: #f47067; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
<header>
  <h1>maestro</h1>
  <span class="tag">read-only dashboard</span>
  <span id="updated"></span>
</header>
<main>
  <form class="add" id="addForm">
    <input id="url" name="url" placeholder="add a repo — e.g. gitlab.com/group/api" autocomplete="off" />
    <button type="submit">add</button>
  </form>
  <div id="msg"></div>
  <div id="repos"><div class="empty">loading…</div></div>
</main>
<script>
const STATES = ['new','in-progress','in-review','blocked','done'];
const el = (id) => document.getElementById(id);

function badge(state) {
  return '<span class="badge s-' + state + '">' + state + '</span>';
}

function render(view) {
  const root = el('repos');
  if (!view.repos || view.repos.length === 0) {
    root.innerHTML = '<div class="empty">no repos watched yet — add one above</div>';
    return;
  }
  root.innerHTML = view.repos.map((r) => {
    const counts = STATES
      .filter((s) => r.counts[s] > 0)
      .map((s) => badge(s) + ' ' + r.counts[s])
      .join('  ') || '<span class="tag">idle</span>';
    const rows = (r.issues || []).length
      ? r.issues.map((i) =>
          '<tr><td class="iid">#' + i.iid + '</td>' +
          '<td class="state">' + badge(i.state) + '</td>' +
          '<td>' + escapeHtml(i.title) + '</td></tr>').join('')
      : '<tr><td class="empty" colspan="3">no open issues assigned to the bot</td></tr>';
    return '<div class="repo"><h2>' + escapeHtml(r.repo.project) +
      '<span class="counts">' + counts + '</span></h2>' +
      '<table>' + rows + '</table></div>';
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function refresh() {
  try {
    const res = await fetch('/', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('dashboard returned ' + res.status);
    render(await res.json());
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
  if (!url) return;
  btn.disabled = true;
  el('msg').style.color = '#f47067';
  try {
    const res = await fetch('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url }).toString(),
    });
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
