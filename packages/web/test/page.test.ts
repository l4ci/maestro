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
    repo: { url: string; project: string; forge?: string };
    issues: Array<{
      iid: number;
      title: string;
      state: string;
      issueUrl?: string;
      mrUrl?: string;
      isDraft?: boolean;
      author?: { username: string; id: string; avatarUrl?: string };
      reviewer?: { username: string; id: string; avatarUrl?: string };
    }>;
    counts: Record<string, number>;
    error?: string;
  }>;
  daemon?: {
    lastTickAt: number;
    activeWorkers: number;
    maxWorkers: number;
    tickIntervalMs: number;
  };
};

const zero = { new: 0, 'in-progress': 0, 'in-review': 0, blocked: 0, done: 0 };

function view(): View {
  return {
    repos: [
      {
        repo: { url: 'gitlab.com/g/api', project: 'g/api', forge: 'gitlab' },
        issues: [
          {
            iid: 1,
            title: 'first',
            state: 'in-progress',
            issueUrl: 'https://gitlab.com/g/api/-/issues/1',
            mrUrl: 'https://gitlab.com/g/api/-/merge_requests/9',
            author: { username: 'alice', id: '1', avatarUrl: 'https://gitlab.com/u/alice.png' },
            reviewer: { username: 'bob', id: '2', avatarUrl: 'https://gitlab.com/u/bob.png' },
          },
          {
            iid: 2,
            title: 'second',
            state: 'new',
            issueUrl: 'https://gitlab.com/g/api/-/issues/2',
            author: { username: 'carol', id: '3' }, // no avatar URL → initials fallback
          },
        ],
        counts: { ...zero, 'in-progress': 1, new: 1 },
      },
      {
        repo: { url: 'github.com/o/web', project: 'o/web', forge: 'github' },
        issues: [
          {
            iid: 7,
            title: 'seventh',
            state: 'in-review',
            issueUrl: 'https://github.com/o/web/issues/7',
            author: { username: 'dan', id: '4', avatarUrl: 'https://github.com/u/dan.png' },
          },
        ],
        counts: { ...zero, 'in-review': 1 },
      },
    ],
  };
}

type PageWindow = Window &
  typeof globalThis & { render: (v: View) => void; refresh: () => Promise<void> };

let windows: Array<{ close(): void }> = [];

/** Load the shipped HTML, eval its inline script with fetch stubbed, return window. */
function loadPage(): PageWindow {
  // A non-opaque origin: avatar <img src> point at real https URLs, and jsdom touches
  // localStorage while resolving them — opaque (about:blank) origins make that throw.
  const dom = new JSDOM(DASHBOARD_HTML, {
    runScripts: 'outside-only',
    url: 'https://maestro.test/',
  });
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

describe('daemon heartbeat indicator (#40)', () => {
  const daemon = (w: PageWindow) => w.document.getElementById('daemon') as HTMLElement;

  it('a fresh heartbeat reads "daemon up" in green with the worker count', () => {
    const w = loadPage();
    const v = view();
    v.daemon = { lastTickAt: Date.now(), activeWorkers: 1, maxWorkers: 2, tickIntervalMs: 1000 };
    w.render(v);
    expect(daemon(w).textContent).toContain('daemon up');
    expect(daemon(w).textContent).toContain('1/2 workers');
    expect(daemon(w).className).toBe('up');
  });

  it('a stale heartbeat (older than ~3 ticks) reads "not seen" in red', () => {
    const w = loadPage();
    const v = view();
    // 5 minutes old, 1s tick → well past the 3-tick / 10s window.
    v.daemon = {
      lastTickAt: Date.now() - 5 * 60_000,
      activeWorkers: 0,
      maxWorkers: 2,
      tickIntervalMs: 1000,
    };
    w.render(v);
    expect(daemon(w).textContent).toContain('not seen for');
    expect(daemon(w).textContent).toContain('5m');
    expect(daemon(w).className).toBe('down');
  });

  it('no heartbeat at all reads "daemon not running" in red', () => {
    const w = loadPage();
    w.render(view()); // no daemon field
    expect(daemon(w).textContent).toBe('○ daemon not running');
    expect(daemon(w).className).toBe('down');
  });

  it('the freshness window scales with the daemon-reported tick cadence, not a constant', () => {
    const w = loadPage();
    const v = view();
    // 30s since last tick. A slow 20s daemon → 3×20s = 60s window → still fresh.
    v.daemon = {
      lastTickAt: Date.now() - 30_000,
      activeWorkers: 0,
      maxWorkers: 1,
      tickIntervalMs: 20_000,
    };
    w.render(v);
    expect(daemon(w).className).toBe('up');
  });

  it('the indicator updates in place across polls (daemon dying mid-session)', () => {
    const w = loadPage();
    const up = view();
    up.daemon = { lastTickAt: Date.now(), activeWorkers: 1, maxWorkers: 2, tickIntervalMs: 1000 };
    w.render(up);
    expect(daemon(w).className).toBe('up');
    const dead = view();
    dead.daemon = {
      lastTickAt: Date.now() - 60_000,
      activeWorkers: 1,
      maxWorkers: 2,
      tickIntervalMs: 1000,
    };
    w.render(dead);
    expect(daemon(w).className).toBe('down');
    expect(daemon(w).textContent).toContain('not seen');
  });

  it('renders the indicator even on an empty board (no repos)', () => {
    const w = loadPage();
    w.render({ repos: [] }); // no daemon → not running
    expect(daemon(w).textContent).toBe('○ daemon not running');
  });
});

describe('add-repo form tracks the server write-capability flag (#9)', () => {
  // Drive the page's own refresh() against a stubbed read-model. The auto-start refresh()
  // and the 5s setInterval are parked on a never-resolving fetch (as in loadPage) so the
  // only resolving call is the one we await here — no callback fires post-close.
  async function refreshWith(v: View & { writesEnabled?: boolean }): Promise<PageWindow> {
    const w = loadPage(); // fetch parked forever
    w.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => v,
    })) as unknown as typeof fetch;
    await w.refresh();
    return w;
  }

  it('hides the form by default before any refresh', () => {
    const w = loadPage();
    // Shipped markup is hidden by default — no flash of an unusable form on a read-only host.
    expect(w.document.getElementById('addForm')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows the form when the read-model reports writesEnabled:true', async () => {
    const w = await refreshWith({ ...view(), writesEnabled: true });
    expect((w.document.getElementById('addForm') as HTMLElement).hidden).toBe(false);
  });

  it('keeps the form hidden when the read-model reports writesEnabled:false', async () => {
    const w = await refreshWith({ ...view(), writesEnabled: false });
    expect((w.document.getElementById('addForm') as HTMLElement).hidden).toBe(true);
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
    // The title text must stay inert: no <img> materializes from it. Scope to the title
    // cell (3rd <td>) so a legitimate avatar img on the people cell doesn't mask the check.
    const titleCell = rowByKey(w, 'gitlab.com/g/api#1')?.children[2];
    expect(titleCell?.querySelector('img')).toBeNull();
    expect(titleCell?.textContent).toContain('<img src=x onerror=alert(1)>');
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

describe('issue + MR/PR forge links (#35)', () => {
  const issueAnchor = (w: PageWindow, key: string) =>
    rowByKey(w, key)?.querySelector('td.iid a') as HTMLAnchorElement | null;
  const mrAnchor = (w: PageWindow, key: string) =>
    rowByKey(w, key)?.querySelector('a.mr') as HTMLAnchorElement | null;

  it('links the issue number to the forge issue url, opening in a new tab', () => {
    const w = loadPage();
    w.render(view());
    const a = issueAnchor(w, 'gitlab.com/g/api#1');
    expect(a?.textContent).toBe('#1');
    expect(a?.getAttribute('href')).toBe('https://gitlab.com/g/api/-/issues/1');
    expect(a?.target).toBe('_blank');
    expect(a?.rel).toBe('noopener noreferrer');
  });

  it('refuses a non-http(s) issueUrl: a javascript: URI renders as an inert #', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (issue) {
      issue.issueUrl = 'javascript:alert(1)'; // hostile forge payload
      issue.mrUrl = 'javascript:alert(2)';
    }
    w.render(v);
    expect(issueAnchor(w, 'gitlab.com/g/api#1')?.getAttribute('href')).toBe('#');
    expect(mrAnchor(w, 'gitlab.com/g/api#1')?.getAttribute('href')).toBe('#');
  });

  it('renders an MR ↗ link on a GitLab issue that has one', () => {
    const w = loadPage();
    w.render(view());
    const a = mrAnchor(w, 'gitlab.com/g/api#1');
    expect(a?.textContent).toContain('MR');
    expect(a?.getAttribute('href')).toBe('https://gitlab.com/g/api/-/merge_requests/9');
  });

  it('labels the link PR ↗ on a GitHub repo', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[1]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.mrUrl = 'https://github.com/o/web/pull/3';
    w.render(v);
    const a = mrAnchor(w, 'github.com/o/web#7');
    expect(a?.textContent).toContain('PR');
    expect(a?.getAttribute('href')).toBe('https://github.com/o/web/pull/3');
  });

  it('shows no MR/PR link when the issue has no merge request', () => {
    const w = loadPage();
    w.render(view());
    expect(mrAnchor(w, 'gitlab.com/g/api#2')).toBeNull();
  });

  it('a draft MR link gets the muted draft class', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.isDraft = true;
    w.render(v);
    expect(mrAnchor(w, 'gitlab.com/g/api#1')?.className).toContain('draft');
  });

  it('an MR appearing on a later poll adds the link without recreating the row', () => {
    const w = loadPage();
    w.render(view());
    const row = rowByKey(w, 'gitlab.com/g/api#2');
    expect(mrAnchor(w, 'gitlab.com/g/api#2')).toBeNull();
    const v = view();
    const issue = v.repos[0]?.issues[1];
    if (!issue) throw new Error('fixture shape');
    issue.mrUrl = 'https://gitlab.com/g/api/-/merge_requests/12';
    w.render(v);
    expect(rowByKey(w, 'gitlab.com/g/api#2')).toBe(row); // same node, updated in place
    expect(mrAnchor(w, 'gitlab.com/g/api#2')?.getAttribute('href')).toBe(
      'https://gitlab.com/g/api/-/merge_requests/12',
    );
  });

  it('a vanishing MR drops its link on the next poll, same row node', () => {
    const w = loadPage();
    w.render(view());
    const row = rowByKey(w, 'gitlab.com/g/api#1');
    expect(mrAnchor(w, 'gitlab.com/g/api#1')).toBeTruthy();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.mrUrl = undefined;
    w.render(v);
    expect(rowByKey(w, 'gitlab.com/g/api#1')).toBe(row);
    expect(mrAnchor(w, 'gitlab.com/g/api#1')).toBeNull();
  });
});

describe('author + reviewer avatars (#37)', () => {
  const avatars = (w: PageWindow, key: string) =>
    [...(rowByKey(w, key)?.querySelectorAll('.avatar') ?? [])] as HTMLElement[];

  it('renders an author avatar img from the forge avatar URL, username on hover', () => {
    const w = loadPage();
    w.render(view());
    const [author] = avatars(w, 'gitlab.com/g/api#1');
    expect(author?.tagName).toBe('IMG');
    expect((author as HTMLImageElement).getAttribute('src')).toBe('https://gitlab.com/u/alice.png');
    expect(author?.title).toBe('author: alice');
    expect(author?.className).toContain('author');
  });

  it('renders the reviewer avatar only when the MR has an assignee', () => {
    const w = loadPage();
    w.render(view());
    expect(avatars(w, 'gitlab.com/g/api#1')).toHaveLength(2); // author + reviewer
    const reviewer = avatars(w, 'gitlab.com/g/api#1')[1];
    expect(reviewer?.title).toBe('reviewer: bob');
    expect(reviewer?.className).toContain('reviewer');
    // #2 has an author but no reviewer
    expect(avatars(w, 'gitlab.com/g/api#2')).toHaveLength(1);
  });

  it('falls back to an initials circle (no img) when avatarUrl is missing', () => {
    const w = loadPage();
    w.render(view());
    const [author] = avatars(w, 'gitlab.com/g/api#2'); // carol, no avatar URL
    expect(author?.tagName).toBe('SPAN');
    expect(author?.textContent).toBe('C');
    expect(author?.title).toBe('author: carol');
    expect(author?.style.background).toBeTruthy(); // colored circle
  });

  it('refuses a non-http(s) avatarUrl: degrades to initials, never an img with a hostile src', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue?.author) throw new Error('fixture shape');
    issue.author.avatarUrl = 'javascript:alert(1)'; // hostile forge payload
    w.render(v);
    const [author] = avatars(w, 'gitlab.com/g/api#1');
    expect(author?.tagName).toBe('SPAN'); // no <img> materialized
    expect(w.document.querySelector('#repos img[src^="javascript:"]')).toBeNull();
    expect(author?.textContent).toBe('A'); // alice → initials fallback
  });

  it('a reviewer assigned on a later poll appears without recreating the row', () => {
    const w = loadPage();
    w.render(view());
    const row = rowByKey(w, 'gitlab.com/g/api#2');
    expect(avatars(w, 'gitlab.com/g/api#2')).toHaveLength(1);
    const v = view();
    const issue = v.repos[0]?.issues[1];
    if (!issue) throw new Error('fixture shape');
    issue.reviewer = { username: 'eve', id: '5' };
    w.render(v);
    expect(rowByKey(w, 'gitlab.com/g/api#2')).toBe(row); // same node, updated in place
    const after = avatars(w, 'gitlab.com/g/api#2');
    expect(after).toHaveLength(2);
    expect(after[1]?.title).toBe('reviewer: eve');
  });

  it('a reviewer unassigned on a later poll drops their avatar, same row node', () => {
    const w = loadPage();
    w.render(view());
    const row = rowByKey(w, 'gitlab.com/g/api#1');
    expect(avatars(w, 'gitlab.com/g/api#1')).toHaveLength(2);
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.reviewer = undefined;
    w.render(v);
    expect(rowByKey(w, 'gitlab.com/g/api#1')).toBe(row);
    expect(avatars(w, 'gitlab.com/g/api#1')).toHaveLength(1);
  });
});

describe('collapsible repo cards (#34)', () => {
  const header = (w: PageWindow, url: string) =>
    w.document.querySelector(`[data-key="${url}"] h2`) as HTMLElement;
  const table = (w: PageWindow, url: string) =>
    w.document.querySelector(`[data-key="${url}"] table`) as HTMLTableElement;

  it('clicking the header hides the issue table; clicking again shows it', () => {
    const w = loadPage();
    w.render(view());
    expect(table(w, 'gitlab.com/g/api').hidden).toBe(false);
    header(w, 'gitlab.com/g/api').click();
    expect(table(w, 'gitlab.com/g/api').hidden).toBe(true);
    header(w, 'gitlab.com/g/api').click();
    expect(table(w, 'gitlab.com/g/api').hidden).toBe(false);
  });

  it('the chevron flips with the collapse state', () => {
    const w = loadPage();
    w.render(view());
    const h = header(w, 'gitlab.com/g/api');
    expect(h.textContent).toContain('▾');
    h.click();
    expect(h.textContent).toContain('▸');
    expect(h.textContent).not.toContain('▾');
  });

  it('collapsing one card leaves the others expanded', () => {
    const w = loadPage();
    w.render(view());
    header(w, 'gitlab.com/g/api').click();
    expect(table(w, 'gitlab.com/g/api').hidden).toBe(true);
    expect(table(w, 'github.com/o/web').hidden).toBe(false);
  });

  it('collapse state survives a poll re-render with changed data', () => {
    const w = loadPage();
    w.render(view());
    header(w, 'gitlab.com/g/api').click();
    const v = view(); // changed data: issue state moves on
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.state = 'in-review';
    w.render(v);
    expect(table(w, 'gitlab.com/g/api').hidden).toBe(true);
    expect(header(w, 'gitlab.com/g/api').textContent).toContain('▸');
  });

  it('per-state counts stay visible in the collapsed header', () => {
    const w = loadPage();
    w.render(view());
    header(w, 'gitlab.com/g/api').click();
    const h = header(w, 'gitlab.com/g/api');
    expect(h.textContent).toContain('in-progress');
    expect(h.textContent).toContain('new');
  });

  it('an unreachable repo still shows its badge in the collapsed header', () => {
    const w = loadPage();
    const v = view();
    const repo = v.repos[1];
    if (!repo) throw new Error('fixture shape');
    repo.error = 'auth failed (401)';
    repo.issues = [];
    w.render(v);
    header(w, 'github.com/o/web').click();
    expect(header(w, 'github.com/o/web').textContent).toContain('unreachable');
  });
});
