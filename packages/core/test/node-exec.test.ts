import { describe, expect, it, vi } from 'vitest';
import { NodeExec } from '../src/exec/node-exec.js';

const exec = new NodeExec();

describe('NodeExec (real seam)', () => {
  it('captures stdout and exit code from an argv-array spawn (no shell)', async () => {
    const r = await exec.run('node', ['-e', 'process.stdout.write("hi")']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
  });

  it('passes secrets via env, not argv', async () => {
    const r = await exec.run('node', ['-e', 'process.stdout.write(process.env.TOKEN||"none")'], {
      env: { TOKEN: 's3cret' },
    });
    expect(r.stdout).toBe('s3cret');
  });

  it('feeds stdin via input', async () => {
    const r = await exec.run(
      'node',
      [
        '-e',
        'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))',
      ],
      { input: 'body' },
    );
    expect(r.stdout).toBe('BODY');
  });

  it('reports non-zero exit without throwing', async () => {
    const r = await exec.run('node', ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('an env key mapped to undefined is DELETED from the child env (token scrub, §13.1)', async () => {
    vi.stubEnv('M8_SECRET', 'glpat-leak');
    try {
      const r = await exec.run(
        'node',
        ['-e', 'process.stdout.write(process.env.M8_SECRET??"ABSENT")'],
        {
          env: { M8_SECRET: undefined },
        },
      );
      expect(r.stdout).toBe('ABSENT'); // inherited key removed, not re-added by the merge
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
