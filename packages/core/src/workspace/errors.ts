// Workspace errors. Module-local types (no other milestone's contract depends on
// them). MissingTokenError names the env var, NEVER the token value (§13/§0.8).

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export class MissingTokenError extends Error {
  readonly envVar: string;
  constructor(envVar: string) {
    super(`required token env var '${envVar}' is not set`);
    this.name = 'MissingTokenError';
    this.envVar = envVar;
  }
}
