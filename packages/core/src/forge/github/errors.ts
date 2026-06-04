// Forge error — carries the failing command context and stderr, but NEVER the
// token (§13, §0.8). The api() layer constructs these; the token only ever lives
// in ExecOptions.env (GH_TOKEN), so it cannot reach a message built from argv/stderr.
// Mirrors gitlab/errors.ts; only the forge label differs.

export class ForgeError extends Error {
  readonly code: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, code: number, stderr: string) {
    super(`github ${method} ${path} failed (exit ${code}): ${stderr.trim()}`);
    this.name = 'ForgeError';
    this.code = code;
    this.method = method;
    this.path = path;
  }
}
