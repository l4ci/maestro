// Behavioral tests for the dashboard page script (#42): the renderer must update the
// DOM in place, keyed by repo url / issue iid, so node identity survives the 5s poll.
// UI state queued behind this (collapse #34, avatars #37, expand #41) hangs off that
// identity. The page ships as ONE static HTML string — we test exactly that artifact:
// load it in jsdom without auto-running the inline script, stub fetch, eval the script
// in window scope, and drive the global render() directly.

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { DASHBOARD_HTML } from '../src/page.js';

// A render-shaped view; the page only reads repos[].{repo.url,repo.project,issues,counts,error}.
type View = {
  repos: Array<{
    repo: { url: string; project: string };
    issues: Array<{ iid: number; title: string; state: string }>;
    counts: Record<string, number>;
    error?: string;
  }>;
};

const zero = { new: 0, 'in-progress': 0, 'in-review': 0, blocked: 0, done: 0 };

function view(): View {
  return {
    repos: [
      {
        repo: { url: 'gitlab.com/g/api', project: 'g/api' },
        issues: [
          { iid: 1, title: 'first', state: 'in-progress' },
          { iid: 2, title: 'second', state: 'new' },
        ],
        counts: { ...zero, 'in-progress': 1, new: 1 },
      },
      {
        repo: { url: 'github.com/o/web', project: 'o/web' },
        issues: [{ iid: 7, title: 'seventh', state: 'in-review' }],
        counts: { ...zero, 'in-review': 1 },
      },
    ],
  };
}

type PageWindow = Window & typeof globalThis & { render: (v: View) => void };

let windows: Array<{ close(): void }> = [];

/** Load the shipped HTML, eval its inline script with fetch stubbed, return window. */
function loadPage(): PageWindow {
  const dom = new JSDOM(DASHBOARD_HTML, { runScripts: 'outside-only' });
  windows.push(dom.window);
  const w = dom.window as unknown as PageWindow;
  // The script's auto-start refresh() must not hit the network; park it forever.
  w.fetch = (() => new Promise(() => {})) as typeof fetch;
  const script = dom.window.document.querySelector('script')?.textContent;
  if (!script) throw new Error('page has no inline script');
  dom.window.eval(script);
  return w;
}

const rows = (w: PageWindow) => [...w.document.querySelectorAll('tr[data-key]')];
const repoCards = (w: PageWindow) => [...w.document.querySelectorAll('#repos > [data-key]')];
const rowByKey = (w: PageWindow, key: string) => w.document.querySelector(`tr[data-key="${key}"]`);

afterEach(() => {
  for (const w of windows) w.close(); // kills the page's own setInterval
  windows = [];
});

describe('keyed rendering — node identity across polls (#42)', () => {
  it('an unchanged row keeps its identical DOM node across renders', () => {
    const w = loadPage();
    w.render(view());
    const row = rowByKey(w, 'gitlab.com/g/api#1') as HTMLElement & { _stash?: string };
    expect(row).toBeTruthy();
    row._stash = 'survived';
    w.render(view()); // structurally equal, fresh object
    const again = rowByKey(w, 'gitlab.com/g/api#1') as HTMLElement & { _stash?: string };
    expect(again).toBe(row);
    expect(again._stash).toBe('survived');
  });

  it('a changed row updates badge and title in place, same node', () => {
    const w = loadPage();
    w.render(view());
    const row = rowByKey(w, 'gitlab.com/g/api#1');
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.state = 'in-review';
    issue.title = 'first (renamed)';
    w.render(v);
    const again = rowByKey(w, 'gitlab.com/g/api#1');
    expect(again).toBe(row);
    expect(again?.querySelector('.badge')?.textContent).toBe('in-review');
    expect(again?.querySelector('.badge')?.className).toContain('s-in-review');
    expect(again?.textContent).toContain('first (renamed)');
  });

  it('repo cards keep identity; appearing/vanishing issues touch only their own rows', () => {
    const w = loadPage();
    w.render(view());
    const [cardA, cardB] = repoCards(w);
    const keepRow = rowByKey(w, 'gitlab.com/g/api#1');
    const v = view();
    const repo = v.repos[0];
    if (!repo) throw new Error('fixture shape');
    repo.issues = [
      ...repo.issues.filter((i) => i.iid !== 2), // #2 vanishes
      { iid: 3, title: 'third', state: 'new' }, // #3 appears
    ];
    w.render(v);
    expect(repoCards(w)[0]).toBe(cardA);
    expect(repoCards(w)[1]).toBe(cardB);
    expect(rowByKey(w, 'gitlab.com/g/api#1')).toBe(keepRow);
    expect(rowByKey(w, 'gitlab.com/g/api#2')).toBeNull();
    expect(rowByKey(w, 'gitlab.com/g/api#3')).toBeTruthy();
  });

  it('a removed repo removes exactly its card; the survivor keeps identity', () => {
    const w = loadPage();
    w.render(view());
    const [, cardB] = repoCards(w);
    const v = view();
    v.repos = v.repos.filter((r) => r.repo.url !== 'gitlab.com/g/api');
    w.render(v);
    const after = repoCards(w);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(cardB);
  });

  it('reordering repos moves the existing cards instead of recreating them', () => {
    const w = loadPage();
    w.render(view());
    const [cardA, cardB] = repoCards(w);
    const v = view();
    v.repos.reverse();
    w.render(v);
    const after = repoCards(w);
    expect(after[0]).toBe(cardB);
    expect(after[1]).toBe(cardA);
  });
});

describe('degraded states stay on the same card node', () => {
  it('a repo turning unreachable keeps its card; error row replaces issue rows', () => {
    const w = loadPage();
    w.render(view());
    const [cardA] = repoCards(w);
    const v = view();
    const repo = v.repos[0];
    if (!repo) throw new Error('fixture shape');
    repo.error = 'auth failed (401)';
    repo.issues = [];
    w.render(v);
    expect(repoCards(w)[0]).toBe(cardA);
    expect(cardA?.textContent).toContain('unreachable');
    expect(cardA?.textContent).toContain('auth failed (401)');
    expect(rowByKey(w, 'gitlab.com/g/api#1')).toBeNull();
  });

  it('a repo with no issues shows the empty placeholder row', () => {
    const w = loadPage();
    const v = view();
    const repo = v.repos[0];
    if (!repo) throw new Error('fixture shape');
    repo.issues = [];
    repo.counts = { ...zero };
    w.render(v);
    expect(repoCards(w)[0]?.textContent).toContain('no open issues');
  });

  it('empty dashboard message renders and recovers when repos appear', () => {
    const w = loadPage();
    w.render({ repos: [] });
    expect(w.document.getElementById('repos')?.textContent).toContain('no repos watched yet');
    w.render(view());
    expect(repoCards(w)).toHaveLength(2);
    expect(rows(w).length).toBeGreaterThan(0);
  });
});

describe('forge-controlled text stays inert (§13.1)', () => {
  it('an HTML-injection title renders as literal text, no element materializes', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.title = '<img src=x onerror=alert(1)>';
    w.render(v);
    expect(w.document.querySelector('#repos img')).toBeNull();
    expect(rowByKey(w, 'gitlab.com/g/api#1')?.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('an HTML-injection error message renders as literal text too', () => {
    const w = loadPage();
    const v = view();
    const repo = v.repos[0];
    if (!repo) throw new Error('fixture shape');
    repo.error = '<script>boom</script>';
    w.render(v);
    expect(w.document.querySelector('#repos script')).toBeNull();
    expect(repoCards(w)[0]?.textContent).toContain('<script>boom</script>');
  });
});
