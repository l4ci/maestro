// Focused transport tests for the shared ForgeCli (the M2/M7 merge of the two
// per-forge clients). The adapter suites exercise it end-to-end; these pin the
// transport contract directly at its seam: argv shape, env-only token, 404 handling,
// the paginate flag, stdin bodies, the gh GraphQL field-form, and the forge-labelled
// ForgeError. Both forge configs are asserted so neither drifts.

import { describe, expect, it } from 'vitest';
import { ForgeCli } from '../src/forge/cli.js';
import { ForgeError } from '../src/forge/errors.js';
import { FakeExec } from './helpers/fake-exec.js';

const GL = { bin: 'glab', forge: 'gitlab' as const, env: { GITLAB_TOKEN: 't-gl' }, botUser: 'bot' };
const GH = { bin: 'gh', forge: 'github' as const, env: { GH_TOKEN: 't-gh' }, botUser: 'bot' };

describe('ForgeCli — transport seam', () => {
  it('builds `api <path> -X METHOD`, token in env never argv', async () => {
    const fake = new FakeExec().onApi('GET', '/issues', [{ iid: 1 }]);
    const cli = new ForgeCli(fake, GL);
    const r = await cli.api('GET', '/issues', { query: { state: 'opened' } });
    expect(r).toEqual([{ iid: 1 }]);
    const call = fake.calls[0];
    expect(call?.cmd).toBe('glab');
    expect(call?.args).toEqual(['api', '/issues?state=opened', '-X', 'GET']);
    expect(call?.opts?.env?.GITLAB_TOKEN).toBe('t-gl');
    expect(call?.args.join(' ')).not.toContain('t-gl');
  });

  it('uses the configured binary + env per forge', async () => {
    const fake = new FakeExec().onApi('GET', '/repos', { ok: true });
    await new ForgeCli(fake, GH).api('GET', '/repos/o/r');
    expect(fake.calls[0]?.cmd).toBe('gh');
    expect(fake.calls[0]?.opts?.env?.GH_TOKEN).toBe('t-gh');
  });

  it('sends a JSON body on stdin via --input -', async () => {
    const fake = new FakeExec().onApi('POST', '/issues', { iid: 9 });
    await new ForgeCli(fake, GL).api('POST', '/issues', { body: { title: 'x' } });
    const call = fake.calls[0];
    expect(call?.args).toContain('--input');
    expect(call?.opts?.input).toBe(JSON.stringify({ title: 'x' }));
  });

  it('appends --paginate only when requested', async () => {
    const fake = new FakeExec().onApi('GET', '/issues', []).onApi('GET', '/labels', []);
    const cli = new ForgeCli(fake, GH);
    await cli.api('GET', '/issues', { paginate: true });
    await cli.api('GET', '/labels');
    expect(fake.calls[0]?.args).toContain('--paginate');
    expect(fake.calls[1]?.args).not.toContain('--paginate');
  });

  it('api() returns null on 404; apiRequired() throws', async () => {
    const fake = new FakeExec().onApiError('GET', '/missing', 1, 'HTTP 404 not found');
    const cli = new ForgeCli(fake, GL);
    expect(await cli.api('GET', '/missing')).toBeNull();
    await expect(cli.apiRequired('GET', '/missing')).rejects.toThrow(ForgeError);
  });

  it('non-404 error throws a forge-labelled ForgeError without leaking the token', async () => {
    const fake = new FakeExec().onApiError('GET', '/boom', 1, '500 Internal');
    await expect(new ForgeCli(fake, GH).api('GET', '/boom')).rejects.toThrow(/^github GET/);
    await expect(new ForgeCli(fake, GH).api('GET', '/boom')).rejects.toThrow(/^(?!.*t-gh).*$/);
  });

  it('graphql uses gh field-form (-f query=… -f var=…)', async () => {
    const fake = new FakeExec().on((c) => c.args.includes('graphql'), {
      code: 0,
      stdout: '{"data":{}}',
      stderr: '',
    });
    await new ForgeCli(fake, GH).graphql('mutation($id:ID!){x}', { id: 'NODE1' });
    expect(fake.calls[0]?.args).toEqual([
      'api',
      'graphql',
      '-f',
      'query=mutation($id:ID!){x}',
      '-f',
      'id=NODE1',
    ]);
  });
});
