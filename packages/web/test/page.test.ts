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
      lastActivity?: { at: string; source: string; summary: string };
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

type Repo = View['repos'][number];
type Issue = Repo['issues'][number];
// A keyed row item, as updateRepoCard hands it to createRow/updateRow.
type RowItem =
  | { key: string; issue: Issue; forge?: string; repoId: string }
  | { key: '~error'; error: string }
  | { key: '~empty' }
  | { key: string; detail: true };

type PageWindow = Window &
  typeof globalThis & {
    render: (v: View) => void;
    refresh: () => Promise<void>;
    // The keyed create/update pairs, reachable because the inline script evals in window
    // scope. The parity suite (#106) drives them directly.
    createRow: (x: RowItem) => HTMLElement;
    updateRow: (tr: HTMLElement, x: RowItem) => void;
    createRepoCard: () => HTMLElement;
    updateRepoCard: (card: HTMLElement, r: Repo) => void;
  };

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

describe('single render path — create/update parity (#106)', () => {
  // The decided design: create* builds a keyed skeleton, update* renders every field.
  // Parity pins the rule structurally: a freshly created node painted with a view must be
  // byte-identical (outerHTML) to a stub node later updated with the same view. A field
  // rendered on the create path only — or rendered differently on the two paths, the #35
  // XSS bug class — breaks this for any view that exercises the field.
  const repoId = 'gitlab.com/g/api';

  const stubRow = (): RowItem => ({
    key: `${repoId}#1`,
    issue: { iid: 1, title: '', state: 'new' },
    forge: 'gitlab',
    repoId,
  });

  // Row field variants: every field present, everything optional absent, hostile URLs.
  // The activity timestamp sits mid-bucket (3m) so the two renders, ms apart, agree.
  const fullRow = (): RowItem => ({
    key: `${repoId}#1`,
    forge: 'gitlab',
    repoId,
    issue: {
      iid: 1,
      title: 'full row',
      state: 'in-progress',
      issueUrl: 'https://gitlab.com/g/api/-/issues/1',
      mrUrl: 'https://gitlab.com/g/api/-/merge_requests/9',
      isDraft: true,
      author: { username: 'alice', id: '1', avatarUrl: 'https://gitlab.com/u/alice.png' },
      reviewer: { username: 'bob', id: '2' }, // no avatar URL → initials circle
      lastActivity: {
        at: new Date(Date.now() - 3 * 60_000).toISOString(),
        source: 'mr',
        summary: 'bot pushed a commit',
      },
    },
  });
  const minimalRow = (): RowItem => ({
    key: `${repoId}#1`,
    forge: 'gitlab',
    repoId,
    issue: { iid: 1, title: 'bare', state: 'done' },
  });
  const hostileRow = (): RowItem => ({
    key: `${repoId}#1`,
    forge: 'gitlab',
    repoId,
    issue: {
      iid: 1,
      title: '<img src=x onerror=alert(1)>',
      state: 'blocked',
      issueUrl: 'javascript:alert(1)',
      mrUrl: 'javascript:alert(2)',
      author: { username: 'mallory', id: '6', avatarUrl: 'javascript:alert(3)' },
    },
  });

  const freshRowDom = (w: PageWindow, item: RowItem) => {
    const n = w.createRow(item);
    w.updateRow(n, item);
    return n.outerHTML;
  };
  const stubRowDom = (w: PageWindow, stub: RowItem, item: RowItem) => {
    const n = w.createRow(stub);
    w.updateRow(n, item);
    return n.outerHTML;
  };
  const staleRowDom = (w: PageWindow, stale: RowItem, item: RowItem) => {
    const n = w.createRow(stale);
    w.updateRow(n, stale); // painted with old data first…
    w.updateRow(n, item); // …then the current poll lands
    return n.outerHTML;
  };

  it('createRow builds a value-free skeleton: same DOM for any issue item', () => {
    const w = loadPage();
    expect(w.createRow(fullRow()).outerHTML).toBe(w.createRow(stubRow()).outerHTML);
    expect(w.createRow(hostileRow()).outerHTML).toBe(w.createRow(stubRow()).outerHTML);
  });

  it('issue row: createRow(view)+paint ≡ createRow(stub) then update(view), all variants', () => {
    const w = loadPage();
    for (const item of [fullRow(), minimalRow(), hostileRow()]) {
      expect(stubRowDom(w, stubRow(), item)).toBe(freshRowDom(w, item));
    }
  });

  it('issue row: a row painted with old data converges to the fresh DOM on update', () => {
    const w = loadPage();
    const full = fullRow(); // one instance, so the activity ISO matches on both paths
    const minimal = minimalRow();
    // Rich → minimal: vanished MR link, reviewer, and activity must leave no residue.
    expect(staleRowDom(w, full, minimal)).toBe(freshRowDom(w, minimal));
    // Minimal → rich: every field must appear via the update path alone.
    expect(staleRowDom(w, minimal, full)).toBe(freshRowDom(w, full));
  });

  it('error and empty placeholder rows render their text on the one path too', () => {
    const w = loadPage();
    const err: RowItem = { key: '~error', error: 'auth failed (401)' };
    expect(stubRowDom(w, { key: '~error', error: 'old' }, err)).toBe(freshRowDom(w, err));
    const empty: RowItem = { key: '~empty' };
    expect(stubRowDom(w, { key: '~empty' }, empty)).toBe(freshRowDom(w, empty));
  });

  // Repo card variants: healthy with issues, idle-empty, unreachable.
  const stubCard = (): Repo => ({
    repo: { url: repoId, project: '' },
    issues: [],
    counts: { ...zero },
  });
  const healthyCard = (): Repo => {
    const r = view().repos[0];
    if (!r) throw new Error('fixture shape');
    return r;
  };
  const idleCard = (): Repo => ({
    repo: { url: repoId, project: 'g/api' },
    issues: [],
    counts: { ...zero },
  });
  const errorCard = (): Repo => ({
    repo: { url: repoId, project: 'g/api' },
    issues: [],
    counts: { ...zero },
    error: 'auth failed (401)',
  });

  const freshCardDom = (w: PageWindow, r: Repo) => {
    const n = w.createRepoCard();
    w.updateRepoCard(n, r);
    return n.outerHTML;
  };
  const staleCardDom = (w: PageWindow, stale: Repo, r: Repo) => {
    const n = w.createRepoCard();
    w.updateRepoCard(n, stale);
    w.updateRepoCard(n, r);
    return n.outerHTML;
  };

  it('repo card: create+paint ≡ stub card updated with the same repo, all variants', () => {
    const w = loadPage();
    for (const r of [healthyCard(), idleCard(), errorCard()]) {
      expect(staleCardDom(w, stubCard(), r)).toBe(freshCardDom(w, r));
    }
  });

  it('repo card: flipping healthy ↔ unreachable converges to the fresh DOM', () => {
    const w = loadPage();
    expect(staleCardDom(w, healthyCard(), errorCard())).toBe(freshCardDom(w, errorCard()));
    expect(staleCardDom(w, errorCard(), healthyCard())).toBe(freshCardDom(w, healthyCard()));
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

describe('add-repo button tracks the server write-capability flag (#9)', () => {
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

  it('hides the button by default before any refresh', () => {
    const w = loadPage();
    // Shipped markup is hidden by default — no flash of an unusable button on a read-only host.
    expect(w.document.getElementById('addBtn')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows the button when the read-model reports writesEnabled:true', async () => {
    const w = await refreshWith({ ...view(), writesEnabled: true });
    expect((w.document.getElementById('addBtn') as HTMLElement).hidden).toBe(false);
  });

  it('keeps the button hidden when the read-model reports writesEnabled:false', async () => {
    const w = await refreshWith({ ...view(), writesEnabled: false });
    expect((w.document.getElementById('addBtn') as HTMLElement).hidden).toBe(true);
  });
});

describe('add-repo dialog opens from the button, closes on cancel', () => {
  const dialog = (w: PageWindow) => w.document.getElementById('addDialog') as HTMLDialogElement;

  it('ships closed; the Add Repo button opens it as a modal', () => {
    const w = loadPage();
    expect(dialog(w).open).toBe(false);
    (w.document.getElementById('addBtn') as HTMLElement).click();
    expect(dialog(w).open).toBe(true);
  });

  it('the cancel button closes it', () => {
    const w = loadPage();
    (w.document.getElementById('addBtn') as HTMLElement).click();
    (w.document.getElementById('addCancel') as HTMLElement).click();
    expect(dialog(w).open).toBe(false);
  });

  it('opening clears a stale error message from a previous attempt', () => {
    const w = loadPage();
    const msg = w.document.getElementById('addMsg') as HTMLElement;
    msg.textContent = 'token rejected';
    (w.document.getElementById('addBtn') as HTMLElement).click();
    expect(msg.textContent).toBe('');
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

describe('unified last-activity line (#39)', () => {
  const activity = (w: PageWindow, key: string) =>
    rowByKey(w, key)?.querySelector('.activity') as HTMLElement | null;

  it('renders relative time + source tag + summary, absolute ISO on hover', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    const iso = new Date(Date.now() - 3 * 60_000).toISOString(); // 3m ago
    issue.lastActivity = { at: iso, source: 'mr', summary: 'bot pushed a commit' };
    w.render(v);
    const line = activity(w, 'gitlab.com/g/api#1');
    expect(line).toBeTruthy();
    expect(line?.textContent).toContain('3m ago');
    expect(line?.textContent?.toLowerCase()).toContain('mr');
    expect(line?.textContent).toContain('bot pushed a commit');
    expect(line?.title).toBe(iso); // absolute time tooltip
  });

  it('omits the line entirely when the issue has no activity', () => {
    const w = loadPage();
    w.render(view()); // fixture issues carry no lastActivity
    expect(activity(w, 'gitlab.com/g/api#1')).toBeNull();
  });

  it('renders on the CREATE path too, not only on a later update (#35 bug class)', () => {
    // First render is create+update for every row; the line must appear on that first paint.
    const w = loadPage();
    const v = view();
    const issue = v.repos[1]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.lastActivity = {
      at: new Date(Date.now() - 90 * 60_000).toISOString(),
      source: 'agent',
      summary: 'cloned workspace',
    };
    w.render(v);
    const line = activity(w, 'github.com/o/web#7');
    expect(line?.textContent).toContain('cloned workspace');
    expect(line?.textContent).toContain('h ago');
  });

  it('keeps the summary inert: an HTML-injection comment body is literal text', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.lastActivity = {
      at: new Date().toISOString(),
      source: 'issue',
      summary: '@x: <img src=x onerror=alert(1)>',
    };
    w.render(v);
    const line = activity(w, 'gitlab.com/g/api#1');
    expect(line?.querySelector('img')).toBeNull();
    expect(line?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('updates the line in place across a poll without recreating the row', () => {
    const w = loadPage();
    const v1 = view();
    const i1 = v1.repos[0]?.issues[0];
    if (!i1) throw new Error('fixture shape');
    i1.lastActivity = {
      at: new Date(Date.now() - 60_000).toISOString(),
      source: 'issue',
      summary: 'first comment',
    };
    w.render(v1);
    const row = rowByKey(w, 'gitlab.com/g/api#1');
    const v2 = view();
    const i2 = v2.repos[0]?.issues[0];
    if (!i2) throw new Error('fixture shape');
    i2.lastActivity = {
      at: new Date().toISOString(),
      source: 'mr',
      summary: 'bot pushed a commit',
    };
    w.render(v2);
    expect(rowByKey(w, 'gitlab.com/g/api#1')).toBe(row); // same node
    expect(activity(w, 'gitlab.com/g/api#1')?.textContent).toContain('bot pushed a commit');
  });

  it('drops the line when activity disappears on a later poll, same row node', () => {
    const w = loadPage();
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue) throw new Error('fixture shape');
    issue.lastActivity = { at: new Date().toISOString(), source: 'issue', summary: 'hi' };
    w.render(v);
    const row = rowByKey(w, 'gitlab.com/g/api#1');
    expect(activity(w, 'gitlab.com/g/api#1')).toBeTruthy();
    w.render(view()); // no lastActivity
    expect(rowByKey(w, 'gitlab.com/g/api#1')).toBe(row);
    expect(activity(w, 'gitlab.com/g/api#1')).toBeNull();
  });
});

describe('blocked visibility — sort, title, favicon (#43)', () => {
  const titleOf = (w: PageWindow) => w.document.title;
  const faviconHref = (w: PageWindow) =>
    (w.document.getElementById('favicon') as HTMLLinkElement).getAttribute('href');
  // jsdom has no canvas 2d backend, so getContext('2d') is null and dotFavicon falls back to
  // 'data:,'. Stub a context whose toDataURL returns a marker so the swap is observable.
  const stubCanvas = (w: PageWindow) => {
    w.HTMLCanvasElement.prototype.getContext = (() => ({
      beginPath() {},
      arc() {},
      fill() {},
      fillStyle: '',
    })) as unknown as HTMLCanvasElement['getContext'];
    w.HTMLCanvasElement.prototype.toDataURL = (() => 'data:image/png;base64,DOT') as never;
  };

  it('plain "maestro" title and empty favicon when nothing is blocked', () => {
    const w = loadPage();
    stubCanvas(w);
    w.render(view()); // fixture has no blocked issues
    expect(titleOf(w)).toBe('maestro');
    expect(faviconHref(w)).toBe('data:,');
  });

  it('title shows the blocked count and the favicon turns into a dot when blocked', () => {
    const w = loadPage();
    stubCanvas(w);
    const v = view();
    const i0 = v.repos[0]?.issues[0];
    const i1 = v.repos[1]?.issues[0];
    if (!i0 || !i1 || !v.repos[0] || !v.repos[1]) throw new Error('fixture shape');
    i0.state = 'blocked';
    v.repos[0].counts = { ...zero, blocked: 1 };
    i1.state = 'blocked';
    v.repos[1].counts = { ...zero, blocked: 1 };
    w.render(v);
    expect(titleOf(w)).toBe('maestro · 2 blocked');
    expect(faviconHref(w)).toBe('data:image/png;base64,DOT');
  });

  it('an unreachable repo counts toward the title badge like a blocked one', () => {
    const w = loadPage();
    stubCanvas(w);
    const v = view();
    const repo = v.repos[1];
    if (!repo) throw new Error('fixture shape');
    repo.error = 'auth failed (401)';
    repo.issues = [];
    w.render(v);
    expect(titleOf(w)).toBe('maestro · 1 blocked');
    expect(faviconHref(w)).toBe('data:image/png;base64,DOT');
  });

  it('title and favicon clear within one poll when the blocked issue resolves', () => {
    const w = loadPage();
    stubCanvas(w);
    const v = view();
    const issue = v.repos[0]?.issues[0];
    if (!issue || !v.repos[0]) throw new Error('fixture shape');
    issue.state = 'blocked';
    v.repos[0].counts = { ...zero, blocked: 1 };
    w.render(v);
    expect(titleOf(w)).toBe('maestro · 1 blocked');
    w.render(view()); // next poll: nothing blocked
    expect(titleOf(w)).toBe('maestro');
    expect(faviconHref(w)).toBe('data:,');
  });

  it('sorts repos with blocked issues to the top, others stay in order', () => {
    const w = loadPage();
    const v = view(); // [gitlab.com/g/api, github.com/o/web], neither blocked
    const second = v.repos[1];
    if (!second?.issues[0]) throw new Error('fixture shape');
    second.issues[0].state = 'blocked';
    second.counts = { ...zero, blocked: 1 };
    w.render(v);
    const order = repoCards(w).map((c) => (c as HTMLElement).dataset.key);
    expect(order).toEqual(['github.com/o/web', 'gitlab.com/g/api']);
  });

  it('sorts an unreachable repo to the top alongside blocked ones', () => {
    const w = loadPage();
    const v = view();
    const second = v.repos[1];
    if (!second) throw new Error('fixture shape');
    second.error = 'auth failed (401)';
    second.issues = [];
    w.render(v);
    expect(repoCards(w)[0]?.getAttribute('data-key')).toBe('github.com/o/web');
  });

  it('sorting repos moves existing card nodes instead of recreating them (#42)', () => {
    const w = loadPage();
    w.render(view());
    const [cardA, cardB] = repoCards(w);
    const v = view();
    const second = v.repos[1];
    if (!second?.issues[0]) throw new Error('fixture shape');
    second.issues[0].state = 'blocked'; // now sorts to the top
    second.counts = { ...zero, blocked: 1 };
    w.render(v);
    const after = repoCards(w);
    expect(after[0]).toBe(cardB); // same node, moved up
    expect(after[1]).toBe(cardA);
  });

  it('within a repo, blocked rows render above the rest, others keep their order', () => {
    const w = loadPage();
    const v = view();
    const repo = v.repos[0];
    if (!repo) throw new Error('fixture shape');
    // issues incoming as [#1 in-progress, #2 new]; make #2 blocked → it must lead.
    repo.issues = [
      { iid: 1, title: 'first', state: 'in-progress' },
      { iid: 2, title: 'second', state: 'blocked' },
      { iid: 3, title: 'third', state: 'new' },
    ];
    repo.counts = { ...zero, 'in-progress': 1, blocked: 1, new: 1 };
    w.render(v);
    // Each issue also emits a hidden `~detail` drill-down row (#41); filter to the summary
    // rows so the assertion is about issue ordering, not the panel rows interleaved with them.
    const keys = [...(repoCards(w)[0]?.querySelectorAll('tr.issue[data-key]') ?? [])].map((r) =>
      (r as HTMLElement).getAttribute('data-key'),
    );
    expect(keys).toEqual(['gitlab.com/g/api#2', 'gitlab.com/g/api#1', 'gitlab.com/g/api#3']);
  });

  it('reordering rows to put blocked first keeps row node identity (#42)', () => {
    const w = loadPage();
    w.render(view());
    const keepRow = rowByKey(w, 'gitlab.com/g/api#2');
    const v = view();
    const issue = v.repos[0]?.issues[1];
    if (!issue || !v.repos[0]) throw new Error('fixture shape');
    issue.state = 'blocked'; // #2 jumps above #1
    v.repos[0].counts = { ...zero, 'in-progress': 1, blocked: 1 };
    w.render(v);
    expect(rowByKey(w, 'gitlab.com/g/api#2')).toBe(keepRow); // moved, not recreated
    const card = repoCards(w).find((c) => (c as HTMLElement).dataset.key === 'gitlab.com/g/api');
    const firstRow = card?.querySelector('tr[data-key]');
    expect(firstRow?.getAttribute('data-key')).toBe('gitlab.com/g/api#2');
  });
});

describe('themed palette + responsive layout (#44)', () => {
  // The dashboard ships as one static HTML string with inline CSS, so the palette and the
  // media queries are asserted at the string level on DASHBOARD_HTML — there is no separate
  // stylesheet to parse and jsdom does not resolve cascaded custom properties.
  const css = DASHBOARD_HTML;

  it('declares the palette as :root custom properties (dark defaults)', () => {
    for (const v of [
      '--bg:',
      '--fg:',
      '--muted:',
      '--line:',
      '--surface:',
      '--border:',
      '--accent:',
      '--up:',
      '--down:',
      '--btn-bg:',
      '--avatar-bg:',
      '--avatar-fg:',
      '--avatar-lum:',
    ]) {
      expect(css).toContain(v);
    }
  });

  it('declares a per-state badge variable pair for every lifecycle state', () => {
    for (const s of ['new', 'in-progress', 'in-review', 'blocked', 'done']) {
      expect(css).toContain(`--s-${s}-bg:`);
      expect(css).toContain(`--s-${s}-fg:`);
    }
  });

  it('paints the page off the palette variables, not hardcoded hexes', () => {
    // Core surfaces must reference the vars so a scheme switch actually repaints them.
    expect(css).toContain('background: var(--bg); color: var(--fg)');
    expect(css).toContain(
      '.s-blocked { background: var(--s-blocked-bg); color: var(--s-blocked-fg); }',
    );
    expect(css).toContain('color: var(--avatar-fg)');
    expect(css).toContain('background: var(--avatar-bg)');
    // No literal dark-palette hex should survive on the body/badge surfaces.
    expect(css).not.toContain('background: #0e1116');
    expect(css).not.toContain('background:#3a1216');
  });

  it('provides a real light-mode palette override via prefers-color-scheme', () => {
    expect(css).toContain('@media (prefers-color-scheme: light)');
    // The light block must redefine the surface vars (a readable light theme, not just
    // color-scheme:light with dark hexes bleeding through).
    const light = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
    expect(light).toContain('--bg: #ffffff');
    expect(light).toContain('--fg: #1f2328');
    expect(light).toContain('--s-blocked-bg: #ffebe9');
  });

  it('adds a narrow-screen layout below 600px that drops fixed column widths', () => {
    expect(css).toContain('@media (max-width: 600px)');
    const narrow = css.slice(css.indexOf('@media (max-width: 600px)'));
    // Fixed iid/state column widths collapse so the title cell takes the slack — no overflow.
    expect(narrow).toContain('td.iid { width: auto; }');
    expect(narrow).toContain('td.state { width: auto; }');
    // The add form already stacks inside its dialog; the opener button goes full width.
    expect(narrow).toContain('#addBtn { width: 100%; }');
  });

  it('keeps the favicon dot and message colors themable (read from --down/--up)', () => {
    expect(css).toContain("dotFavicon(cssVar('--down'");
    expect(css).toContain("el('msg').style.color = cssVar('--down'");
    expect(css).toContain("el('msg').style.color = cssVar('--up'");
    // The initials circle lightness comes from the themed --avatar-lum, not a fixed 32%.
    expect(css).toContain("cssVar('--avatar-lum'");
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

describe('per-issue drill-down (#41)', () => {
  // The summary row is `tr.issue[data-key="<url>#<iid>"]`; its detail panel rides the very
  // next keyed row `<url>#<iid>~detail`, a full-width <td.detail> that starts hidden and
  // lazy-fetches GET /repos/<encoded repoId>/issues/<iid> on first expand.
  const summary = (w: PageWindow, key: string) =>
    w.document.querySelector(`tr.issue[data-key="${key}"]`) as HTMLElement;
  const detailCell = (w: PageWindow, key: string) =>
    w.document.querySelector(`tr[data-key="${key}~detail"] td.detail`) as HTMLElement;
  const panel = (w: PageWindow, key: string) => detailCell(w, key).querySelector('.panel');

  // A canned IssueView the stubbed detail endpoint returns. `flush()` lets the awaited
  // fetch + render microtasks settle before assertions.
  type DetailView = Record<string, unknown>;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function withDetail(detail: DetailView): { w: PageWindow; calls: string[] } {
    const w = loadPage();
    const calls: string[] = [];
    w.fetch = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => detail };
    }) as unknown as typeof fetch;
    w.render(view());
    return { w, calls };
  }

  it('emits a hidden detail row per issue; the collapsed board fetches nothing', () => {
    const { w, calls } = withDetail({});
    expect(detailCell(w, 'gitlab.com/g/api#1')).toBeTruthy();
    expect(detailCell(w, 'gitlab.com/g/api#1').hidden).toBe(true);
    // No detail payload is pulled until a row is actually expanded.
    expect(calls).toHaveLength(0);
  });

  it('clicking a row expands its panel and lazy-fetches the encoded issue route', async () => {
    const { w, calls } = withDetail({ iid: 1, recentLogs: [] });
    summary(w, 'gitlab.com/g/api#1').click();
    expect(detailCell(w, 'gitlab.com/g/api#1').hidden).toBe(false);
    await flush();
    // repoId is URL-encoded so the slash in group/api stays one path segment.
    expect(calls).toEqual(['/repos/gitlab.com%2Fg%2Fapi/issues/1']);
  });

  it('clicking again collapses without a second fetch (loaded once, kept alive)', async () => {
    const { w, calls } = withDetail({ iid: 1, recentLogs: [] });
    const row = summary(w, 'gitlab.com/g/api#1');
    row.click();
    await flush();
    row.click(); // collapse
    expect(detailCell(w, 'gitlab.com/g/api#1').hidden).toBe(true);
    row.click(); // re-open
    await flush();
    expect(calls).toHaveLength(1); // still just the one fetch
  });

  it('renders plan progress: n/m tasks, a meter, and the checklist', async () => {
    const { w } = withDetail({
      iid: 1,
      plan: {
        done: 1,
        total: 2,
        items: [
          { checked: true, text: 'scaffold' },
          { checked: false, text: 'write tests' },
        ],
      },
      recentLogs: [],
    });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    const p = panel(w, 'gitlab.com/g/api#1');
    expect(p?.textContent).toContain('1/2 tasks');
    expect(p?.querySelector('.progress-meter i')).toBeTruthy();
    const items = [...(p?.querySelectorAll('ul.plan li') ?? [])];
    expect(items).toHaveLength(2);
    expect(items[0]?.className).toContain('checked');
    expect(items[0]?.textContent).toContain('scaffold');
    expect(items[1]?.className).not.toContain('checked');
  });

  it('renders MR status pills and a link, labelled MR on GitLab / PR on GitHub', async () => {
    const { w } = withDetail({
      iid: 1,
      mrUrl: 'https://gitlab.com/g/api/-/merge_requests/9',
      isDraft: false,
      approved: true,
      changesRequested: false,
      recentLogs: [],
    });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    const p = panel(w, 'gitlab.com/g/api#1');
    expect(p?.textContent).toContain('MR status');
    expect(p?.querySelector('.pill.approved')).toBeTruthy();
    const mrLink = p?.querySelector('a.mr') as HTMLAnchorElement | null;
    expect(mrLink?.getAttribute('href')).toBe('https://gitlab.com/g/api/-/merge_requests/9');
    expect(mrLink?.rel).toBe('noopener noreferrer');
  });

  it('marks a changes-requested MR distinctly from an approved one', async () => {
    const { w } = withDetail({
      iid: 1,
      mrUrl: 'https://gitlab.com/g/api/-/merge_requests/9',
      isDraft: false,
      approved: false,
      changesRequested: true,
      recentLogs: [],
    });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    const p = panel(w, 'gitlab.com/g/api#1');
    expect(p?.querySelector('.pill.changes')).toBeTruthy();
    expect(p?.querySelector('.pill.approved')).toBeNull();
  });

  it('renders recent log lines with their level class', async () => {
    const { w } = withDetail({
      iid: 1,
      recentLogs: [
        { ts: 't1', repo: 'g/api', issueIid: 1, level: 'info', msg: 'cloned workspace' },
        { ts: 't2', repo: 'g/api', issueIid: 1, level: 'error', msg: 'build failed' },
      ],
    });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    const logs = [...(panel(w, 'gitlab.com/g/api#1')?.querySelectorAll('ul.logs li') ?? [])];
    expect(logs).toHaveLength(2);
    expect(logs[0]?.textContent).toContain('cloned workspace');
    expect(logs[1]?.className).toContain('error');
    expect(logs[1]?.textContent).toContain('build failed');
  });

  it('shows an empty-activity note when there are no logs', async () => {
    const { w } = withDetail({ iid: 1, recentLogs: [] });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    expect(panel(w, 'gitlab.com/g/api#1')?.textContent).toContain('no agent logs yet');
  });

  it('renders the latest issue comments with author handles', async () => {
    const { w } = withDetail({
      iid: 1,
      recentLogs: [],
      recentComments: [
        { id: 'c1', author: { username: 'alice', id: '1' }, body: 'looks good', createdAt: 't' },
      ],
    });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    const p = panel(w, 'gitlab.com/g/api#1');
    expect(p?.textContent).toContain('@alice');
    expect(p?.textContent).toContain('looks good');
  });

  it('keeps panel content inert: an injection in a log/comment is literal text (§13.1)', async () => {
    const { w } = withDetail({
      iid: 1,
      recentLogs: [
        { ts: 't', repo: 'g/api', issueIid: 1, level: 'info', msg: '<img src=x onerror=alert(1)>' },
      ],
      recentComments: [
        { id: 'c1', author: { username: 'x' }, body: '<script>boom</script>', createdAt: 't' },
      ],
      plan: { done: 0, total: 1, items: [{ checked: false, text: '<b>todo</b>' }] },
    });
    summary(w, 'gitlab.com/g/api#1').click();
    await flush();
    const p = panel(w, 'gitlab.com/g/api#1');
    expect(p?.querySelector('img')).toBeNull();
    expect(p?.querySelector('script')).toBeNull();
    expect(p?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(p?.textContent).toContain('<script>boom</script>');
    expect(p?.textContent).toContain('<b>todo</b>');
  });

  it('surfaces a fetch failure in the panel and allows a retry', async () => {
    const w = loadPage();
    let attempts = 0;
    w.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ iid: 1, recentLogs: [] }) };
    }) as unknown as typeof fetch;
    w.render(view());
    const row = summary(w, 'gitlab.com/g/api#1');
    row.click();
    await flush();
    expect(panel(w, 'gitlab.com/g/api#1')?.textContent).toContain('could not load detail');
    // The failed open cleared the once-guard, so collapsing and re-opening re-fetches.
    row.click(); // collapse
    row.click(); // re-open → second attempt succeeds
    await flush();
    expect(attempts).toBe(2);
    expect(panel(w, 'gitlab.com/g/api#1')?.textContent).toContain('no agent logs yet');
  });

  it('a forge link inside the row does not toggle the panel', () => {
    const { w } = withDetail({ iid: 1, recentLogs: [] });
    const link = summary(w, 'gitlab.com/g/api#1').querySelector('td.iid a') as HTMLElement;
    link.click();
    // Clicking the issue link must not expand the drill-down (it opens the forge in a new tab).
    expect(detailCell(w, 'gitlab.com/g/api#1').hidden).toBe(true);
  });

  it('the panel node survives a poll re-render (keyed identity)', async () => {
    const { w } = withDetail({ iid: 1, recentLogs: [] });
    const row = summary(w, 'gitlab.com/g/api#1');
    row.click();
    await flush();
    const node = panel(w, 'gitlab.com/g/api#1');
    expect(node?.textContent).toContain('no agent logs yet');
    w.render(view()); // poll
    expect(panel(w, 'gitlab.com/g/api#1')).toBe(node); // same node, content preserved
    expect(detailCell(w, 'gitlab.com/g/api#1').hidden).toBe(false); // stays open
  });
});

describe('drill-down panel CSS is themed, not hardcoded (#41/#44)', () => {
  const css = DASHBOARD_HTML;
  it('paints the panel and pills off palette vars', () => {
    expect(css).toContain('.panel {');
    expect(css).toContain('background: var(--surface)');
    expect(css).toContain(
      '.progress-meter > i { display: block; height: 100%; background: var(--up); }',
    );
    expect(css).toContain('.pill.changes { background: var(--s-blocked-bg)');
  });
});

// Grabbable-issues UI: the open-badge on each repo card, the issues modal, the Work button.
// The modal itself relies on openDialog/closeDialog which feature-detect showModal (jsdom
// doesn't implement it) and fall back to setting .open directly, so dialog.open assertions
// work fine. window.prompt is not implemented in jsdom — we pre-seed dashToken via the
// add-form submit path (which writes to dashToken directly) instead of stubbing prompt.
describe('grabbable-issues UI', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // Build a view that includes grabbableCount on the first repo. writesEnabled is a
  // page-level variable updated only by refresh(), not render(), so badge/render tests that
  // don't need Work buttons use render() directly; tests that need writesEnabled use
  // refreshWith() (same pattern as the "add-repo button" describe above).
  type GrabbableView = View & {
    writesEnabled?: boolean;
    repos: Array<View['repos'][number] & { grabbableCount?: number }>;
  };

  function viewWith(grabbable: number | undefined): GrabbableView {
    const v = view() as GrabbableView;
    v.repos[0]!.grabbableCount = grabbable;
    return v;
  }

  // refreshWith adapted from the existing add-repo tests: stubs the / endpoint and awaits
  // refresh() to set writesEnabled AND render the repos in one shot.
  async function refreshWithGrabbable(
    grabbable: number | undefined,
    writesEnabled: boolean,
    openIssues: object,
    workResponse?: object,
  ): Promise<{ w: PageWindow; calls: Array<{ url: string; init?: RequestInit }> }> {
    const w = loadPage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const dashView: GrabbableView = viewWith(grabbable);
    dashView.writesEnabled = writesEnabled;
    w.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/' || url === '') return { ok: true, status: 200, json: async () => dashView };
      if (url.includes('/open-issues'))
        return { ok: true, status: 200, json: async () => openIssues };
      if (url.includes('/work'))
        return { ok: true, status: 200, json: async () => workResponse ?? { ok: true } };
      // add-repo POST:
      return { ok: true, status: 200, json: async () => ({ added: false, reason: 'ok' }) };
    }) as unknown as typeof fetch;
    await w.refresh();
    return { w, calls };
  }

  // --- Badge visibility / text ---

  it('renders an .open-badge with "3 open" when grabbableCount is 3', () => {
    const w = loadPage();
    w.render(viewWith(3));
    const badge = w.document.querySelector(
      '[data-key="gitlab.com/g/api"] .open-badge',
    ) as HTMLElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.hidden).toBe(false);
    expect(badge!.textContent).toBe('3 open');
  });

  it('renders no visible badge when grabbableCount is 0', () => {
    const w = loadPage();
    w.render(viewWith(0));
    const badge = w.document.querySelector(
      '[data-key="gitlab.com/g/api"] .open-badge',
    ) as HTMLElement | null;
    expect(badge!.hidden).toBe(true);
  });

  it('renders no visible badge when grabbableCount is undefined', () => {
    const w = loadPage();
    w.render(viewWith(undefined));
    const badge = w.document.querySelector(
      '[data-key="gitlab.com/g/api"] .open-badge',
    ) as HTMLElement | null;
    expect(badge!.hidden).toBe(true);
  });

  it('renders no visible badge on an error repo even if grabbableCount is set', () => {
    const w = loadPage();
    const v = viewWith(5);
    v.repos[0]!.error = 'auth failed';
    w.render(v);
    const badge = w.document.querySelector(
      '[data-key="gitlab.com/g/api"] .open-badge',
    ) as HTMLElement | null;
    expect(badge!.hidden).toBe(true);
  });

  it('renders "100+ open" when grabbableCount is >= 100', () => {
    const w = loadPage();
    w.render(viewWith(120));
    const badge = w.document.querySelector(
      '[data-key="gitlab.com/g/api"] .open-badge',
    ) as HTMLElement | null;
    expect(badge!.textContent).toBe('100+ open');
  });

  it('renders "99 open" (not capped) when grabbableCount is 99', () => {
    const w = loadPage();
    w.render(viewWith(99));
    const badge = w.document.querySelector(
      '[data-key="gitlab.com/g/api"] .open-badge',
    ) as HTMLElement | null;
    expect(badge!.textContent).toBe('99 open');
  });

  // --- Badge opens modal + lazy fetch ---

  it('clicking the badge opens the issues dialog and fetches /repos/<enc>/open-issues', async () => {
    const { w, calls } = await refreshWithGrabbable(1, false, {
      issues: [
        {
          iid: 42,
          title: 'Fix the bug',
          issueUrl: 'https://gitlab.com/g/api/-/issues/42',
          labels: [],
        },
      ],
    });
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const dlg = w.document.getElementById('issuesDialog') as HTMLDialogElement;
    expect(dlg.open).toBe(true);
    expect(calls.some((c) => c.url === '/repos/gitlab.com%2Fg%2Fapi/open-issues')).toBe(true);
  });

  it('populates #issuesList with one .issue-row per returned issue', async () => {
    const { w } = await refreshWithGrabbable(2, false, {
      issues: [
        {
          iid: 1,
          title: 'First issue',
          issueUrl: 'https://gitlab.com/g/api/-/issues/1',
          labels: [],
        },
        {
          iid: 2,
          title: 'Second issue',
          issueUrl: 'https://gitlab.com/g/api/-/issues/2',
          labels: [],
        },
      ],
    });
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const issueRows = [...w.document.querySelectorAll('#issuesList .issue-row')];
    expect(issueRows).toHaveLength(2);
    expect(issueRows[0]?.textContent).toContain('First issue');
    expect(issueRows[1]?.textContent).toContain('Second issue');
  });

  it('issue title is rendered as inert text via the link helper, not innerHTML', async () => {
    const { w } = await refreshWithGrabbable(1, false, {
      issues: [
        {
          iid: 3,
          title: '<img src=x onerror=alert(1)>',
          issueUrl: 'https://gitlab.com/g/api/-/issues/3',
          labels: [],
        },
      ],
    });
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const list = w.document.getElementById('issuesList')!;
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  // --- Work button gating on writesEnabled ---

  it('renders .work-btn on each issue row when writesEnabled is true', async () => {
    const { w } = await refreshWithGrabbable(1, true, {
      issues: [
        { iid: 5, title: 'Do work', issueUrl: 'https://gitlab.com/g/api/-/issues/5', labels: [] },
      ],
    });
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    expect(w.document.querySelector('#issuesList .work-btn')).toBeTruthy();
  });

  it('renders no .work-btn when writesEnabled is false', async () => {
    const { w } = await refreshWithGrabbable(1, false, {
      issues: [
        { iid: 5, title: 'Do work', issueUrl: 'https://gitlab.com/g/api/-/issues/5', labels: [] },
      ],
    });
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    expect(w.document.querySelector('#issuesList .work-btn')).toBeNull();
  });

  // --- Work button POST ---
  // window.prompt is not available in jsdom. We pre-seed dashToken by triggering the
  // add-form submit (which sets `if (token) dashToken = token`) so requestWork's getToken()
  // finds a non-falsy dashToken and skips the prompt entirely.

  async function seedToken(w: PageWindow, token: string): Promise<void> {
    (w.document.getElementById('addBtn') as HTMLElement).hidden = false;
    (w.document.getElementById('addBtn') as HTMLElement).click();
    (w.document.getElementById('token') as HTMLInputElement).value = token;
    (w.document.getElementById('url') as HTMLInputElement).value = 'example.com/test';
    const form = w.document.getElementById('addForm') as HTMLFormElement;
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  }

  it('clicking .work-btn POSTs to /repos/<enc>/issues/<iid>/work with Authorization header', async () => {
    const { w, calls } = await refreshWithGrabbable(
      1,
      true,
      {
        issues: [
          {
            iid: 7,
            title: 'Work item',
            issueUrl: 'https://gitlab.com/g/api/-/issues/7',
            labels: [],
          },
        ],
      },
      { ok: true },
    );
    await seedToken(w, 'my-secret-token');
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const btn = w.document.querySelector('#issuesList .work-btn') as HTMLElement;
    btn.click();
    await flush();
    const workCall = calls.find((c) => c.url.includes('/work'));
    expect(workCall).toBeTruthy();
    expect(workCall!.url).toBe('/repos/gitlab.com%2Fg%2Fapi/issues/7/work');
    expect((workCall!.init as RequestInit).method).toBe('POST');
    expect((workCall!.init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer my-secret-token',
    });
  });

  it('on ok:true response the button text becomes "Queued ✓"', async () => {
    const { w } = await refreshWithGrabbable(
      1,
      true,
      {
        issues: [
          { iid: 8, title: 'Task', issueUrl: 'https://gitlab.com/g/api/-/issues/8', labels: [] },
        ],
      },
      { ok: true },
    );
    await seedToken(w, 'tok');
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const btn = w.document.querySelector('#issuesList .work-btn') as HTMLElement;
    btn.click();
    await flush();
    expect(btn.textContent).toBe('Queued ✓');
  });

  it('on warning:actor-allowlist-blocks-autostart the button text becomes "Assigned (blocked)"', async () => {
    const { w } = await refreshWithGrabbable(
      1,
      true,
      {
        issues: [
          {
            iid: 9,
            title: 'Blocked task',
            issueUrl: 'https://gitlab.com/g/api/-/issues/9',
            labels: [],
          },
        ],
      },
      { ok: true, warning: 'actor-allowlist-blocks-autostart' },
    );
    await seedToken(w, 'tok');
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const btn = w.document.querySelector('#issuesList .work-btn') as HTMLElement;
    btn.click();
    await flush();
    expect(btn.textContent).toBe('Assigned (blocked)');
  });

  // --- Token retry trap fix ---

  it('a 401 from /work clears dashToken so the next click re-prompts (token reset)', async () => {
    const w = loadPage();
    const dashView: GrabbableView = Object.assign(viewWith(1), { writesEnabled: true });
    w.fetch = (async (url: string, init?: RequestInit) => {
      if (url === '/' || url === '') return { ok: true, status: 200, json: async () => dashView };
      if (url.includes('/open-issues'))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            issues: [{ iid: 10, title: 'T', issueUrl: 'https://x.com/i/10', labels: [] }],
          }),
        };
      if (url.includes('/work')) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ added: false, reason: 'ok' }) };
    }) as unknown as typeof fetch;
    await w.refresh();
    await seedToken(w, 'bad-token');
    (w.document.querySelector('[data-key="gitlab.com/g/api"] .open-badge') as HTMLElement).click();
    await flush();
    const btn = w.document.querySelector('#issuesList .work-btn') as HTMLElement;
    btn.click();
    await flush();
    // After the 401, the button is re-enabled with the error tooltip.
    expect(btn.disabled).toBe(false);
    expect(btn.title).toContain('401');
    // dashToken must have been cleared — stub prompt to observe it being called.
    let promptCalled = false;
    w.prompt = (() => {
      promptCalled = true;
      return null;
    }) as unknown as typeof w.prompt;
    btn.click();
    await flush();
    expect(promptCalled).toBe(true);
  });
});

// Keyboard navigation + live filter. Drive the shipped artifact: render the fixture, then
// dispatch real KeyboardEvents at document (where the page binds its single handler) and
// observe the .selected class, the filter's .filtered hides, and the help dialog.
describe('keyboard navigation (j/k/o/g/G) + live filter', () => {
  const press = (w: PageWindow, key: string, init: KeyboardEventInit = {}) =>
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  const selectedKey = (w: PageWindow) =>
    (w.document.querySelector('tr.issue.selected') as HTMLElement | null)?.dataset.key ?? null;
  const filterInput = (w: PageWindow) => w.document.getElementById('filter') as HTMLInputElement;
  const typeFilter = (w: PageWindow, value: string) => {
    filterInput(w).value = value;
    filterInput(w).dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const K_API1 = 'gitlab.com/g/api#1';
  const K_API2 = 'gitlab.com/g/api#2';
  const K_WEB7 = 'github.com/o/web#7';

  it('first j selects the top row; j/k walk visible rows and clamp at the ends', () => {
    const w = loadPage();
    w.render(view());
    expect(selectedKey(w)).toBeNull();
    press(w, 'j');
    expect(selectedKey(w)).toBe(K_API1);
    press(w, 'j');
    expect(selectedKey(w)).toBe(K_API2);
    press(w, 'j');
    expect(selectedKey(w)).toBe(K_WEB7);
    press(w, 'j'); // already last → clamp, no wrap
    expect(selectedKey(w)).toBe(K_WEB7);
    press(w, 'k');
    expect(selectedKey(w)).toBe(K_API2);
  });

  it('g g jumps to the first row, G to the last', () => {
    const w = loadPage();
    w.render(view());
    press(w, 'G');
    expect(selectedKey(w)).toBe(K_WEB7);
    press(w, 'g');
    press(w, 'g');
    expect(selectedKey(w)).toBe(K_API1);
  });

  it('a lone g followed by a non-g is consumed without acting', () => {
    const w = loadPage();
    w.render(view());
    press(w, 'g');
    press(w, 'x'); // not a chord completion, not a binding
    expect(selectedKey(w)).toBeNull();
  });

  it('o opens the selected issue detail; Esc closes it', () => {
    const w = loadPage();
    w.render(view());
    press(w, 'j');
    press(w, 'o');
    const row = w.document.querySelector('tr.issue.selected') as HTMLElement;
    expect(row.classList.contains('open')).toBe(true);
    press(w, 'Escape');
    expect(row.classList.contains('open')).toBe(false);
  });

  it('selection survives a poll, and hands off when the selected row vanishes', () => {
    const w = loadPage();
    w.render(view());
    press(w, 'j');
    press(w, 'j');
    expect(selectedKey(w)).toBe(K_API2);
    w.render(view()); // an unchanged poll keeps the same selection
    expect(selectedKey(w)).toBe(K_API2);
    // Drop issue #2 from the first repo; selection falls back to a still-visible row.
    const v = view();
    v.repos[0]!.issues = v.repos[0]!.issues.filter((i) => i.iid !== 2);
    w.render(v);
    expect(selectedKey(w)).toBe(K_API1);
  });

  it('/ focuses the filter; typing hides non-matching rows by title, #iid, and state', () => {
    const w = loadPage();
    w.render(view());
    press(w, '/');
    expect(w.document.activeElement).toBe(filterInput(w));
    typeFilter(w, 'second'); // matches issue #2 only
    expect(rowByKey(w, K_API2)?.classList.contains('filtered')).toBe(false);
    expect(rowByKey(w, K_API1)?.classList.contains('filtered')).toBe(true);
    expect(rowByKey(w, K_WEB7)?.classList.contains('filtered')).toBe(true);
    // The repo whose every issue is filtered out collapses too.
    expect(repoCards(w)[1]?.classList.contains('filtered')).toBe(true);
    typeFilter(w, 'in-review'); // match by state
    expect(rowByKey(w, K_WEB7)?.classList.contains('filtered')).toBe(false);
    typeFilter(w, '#7'); // match by issue number
    expect(rowByKey(w, K_WEB7)?.classList.contains('filtered')).toBe(false);
    typeFilter(w, ''); // cleared → everything visible again
    expect(rows(w).filter((r) => r.classList.contains('filtered'))).toHaveLength(0);
  });

  it('a filter that hides the selected row hands selection to the nearest visible one', () => {
    const w = loadPage();
    w.render(view());
    press(w, 'j'); // selects #1
    expect(selectedKey(w)).toBe(K_API1);
    typeFilter(w, 'second'); // hides #1, leaves #2
    expect(selectedKey(w)).toBe(K_API2);
  });

  it('single-key shortcuts are inert while typing in the filter (Esc still works)', () => {
    const w = loadPage();
    w.render(view());
    press(w, 'j'); // select #1
    filterInput(w).focus();
    press(w, 'j'); // typed into the field, not a nav key
    expect(selectedKey(w)).toBe(K_API1); // unchanged
    filterInput(w).value = 'zzz';
    press(w, 'Escape'); // Esc is the one key honored while typing
    expect(filterInput(w).value).toBe('');
  });

  it('? toggles the shortcuts help dialog', () => {
    const w = loadPage();
    w.render(view());
    const help = w.document.getElementById('helpDialog') as HTMLDialogElement;
    expect(help.open).toBe(false);
    press(w, '?');
    expect(help.open).toBe(true);
    press(w, '?');
    expect(help.open).toBe(false);
  });
});

// Forge mark + quick repo filters. The mark is a CSS-mask glyph keyed by repo.forge; the
// chips hide whole repo cards by forge / state, riding the same applyFilter() pass as the
// text filter so chip state survives the 5s poll.
describe('forge mark + quick repo filters', () => {
  type FView = View & { repos: Array<View['repos'][number] & { grabbableCount?: number }> };
  const card = (w: PageWindow, url: string) =>
    w.document.querySelector(`#repos > [data-key="${url}"]`) as HTMLElement;
  const forgeMark = (w: PageWindow, url: string) =>
    card(w, url).querySelector('.forge') as HTMLElement;
  const chip = (w: PageWindow, name: string) =>
    w.document.querySelector(`#filters .chip[data-filter="${name}"]`) as HTMLElement;
  const filteredOut = (w: PageWindow, url: string) => card(w, url).classList.contains('filtered');
  const press = (w: PageWindow, key: string) =>
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));

  it('stamps each repo card with its forge glyph class and hover title', () => {
    const w = loadPage();
    w.render(view());
    expect(forgeMark(w, 'gitlab.com/g/api').className).toContain('gitlab');
    expect(forgeMark(w, 'gitlab.com/g/api').title).toBe('GitLab');
    expect(forgeMark(w, 'github.com/o/web').className).toContain('github');
    expect(forgeMark(w, 'github.com/o/web').title).toBe('GitHub');
  });

  it('hides the forge mark for an unrecognised forge', () => {
    const w = loadPage();
    const v = view();
    if (v.repos[0]) v.repos[0].repo.forge = undefined;
    w.render(v);
    expect(forgeMark(w, 'gitlab.com/g/api').hidden).toBe(true);
  });

  it('the github chip keeps only github repos; gitlab only gitlab', () => {
    const w = loadPage();
    w.render(view());
    chip(w, 'github').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(true);
    expect(filteredOut(w, 'github.com/o/web')).toBe(false);
  });

  it('forge chips OR together: both selected shows every repo', () => {
    const w = loadPage();
    w.render(view());
    chip(w, 'github').click();
    chip(w, 'gitlab').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(false);
    expect(filteredOut(w, 'github.com/o/web')).toBe(false);
  });

  it('the open-issues chip keeps only repos with a grabbable backlog', () => {
    const w = loadPage();
    const v = view() as FView;
    if (v.repos[0]) v.repos[0].grabbableCount = 3; // gitlab has a backlog, github does not
    w.render(v);
    chip(w, 'open').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(false);
    expect(filteredOut(w, 'github.com/o/web')).toBe(true);
  });

  it('the working chip keeps only repos with in-progress work', () => {
    const w = loadPage();
    w.render(view()); // gitlab: in-progress 1, github: in-review 1
    chip(w, 'working').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(false);
    expect(filteredOut(w, 'github.com/o/web')).toBe(true);
  });

  it('the in-review chip keeps only repos with issues in review', () => {
    const w = loadPage();
    w.render(view());
    chip(w, 'review').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(true);
    expect(filteredOut(w, 'github.com/o/web')).toBe(false);
  });

  it('the unreachable chip keeps only errored repos', () => {
    const w = loadPage();
    const v = view();
    if (v.repos[1]) {
      v.repos[1].error = 'auth failed (401)';
      v.repos[1].issues = [];
    }
    w.render(v);
    chip(w, 'unreachable').click();
    expect(filteredOut(w, 'github.com/o/web')).toBe(false);
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(true);
  });

  it('attribute chips AND together across groups', () => {
    const w = loadPage();
    const v = view() as FView;
    if (v.repos[0]) v.repos[0].grabbableCount = 2; // gitlab: open backlog AND in-progress work
    w.render(v);
    chip(w, 'open').click();
    chip(w, 'working').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(false);
    expect(filteredOut(w, 'github.com/o/web')).toBe(true);
  });

  it('a forge chip composes with the text filter (both must match)', () => {
    const w = loadPage();
    w.render(view());
    chip(w, 'gitlab').click(); // only gitlab repo
    const filter = w.document.getElementById('filter') as HTMLInputElement;
    filter.value = 'nomatch';
    filter.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(true); // forge ok but no issue text match
    expect(filteredOut(w, 'github.com/o/web')).toBe(true); // wrong forge
  });

  it('chip filter state survives a poll re-render', () => {
    const w = loadPage();
    w.render(view());
    chip(w, 'github').click();
    w.render(view()); // poll
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(true);
    expect(filteredOut(w, 'github.com/o/web')).toBe(false);
    expect(chip(w, 'github').getAttribute('aria-pressed')).toBe('true');
  });

  it('Esc clears active chips when there is no text filter to clear', () => {
    const w = loadPage();
    w.render(view());
    chip(w, 'github').click();
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(true);
    press(w, 'Escape');
    expect(filteredOut(w, 'gitlab.com/g/api')).toBe(false);
    expect(chip(w, 'github').classList.contains('active')).toBe(false);
    expect(chip(w, 'github').getAttribute('aria-pressed')).toBe('false');
  });
});
