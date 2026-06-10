// Authorized-actor predicate (§13.1) — THE trigger allowlist rule, implemented once.
// Shared by the issue trigger guard (reconciler) and the command-MR edge; it lives in
// neutral ground here so the reconciler stays MR-free (mr-command-thesis guard).
//
// Fail-closed: an empty allowlist trusts everyone (the private-repo default; public
// repos require an explicit opt-in, see public-guard). Once the list is non-empty, a
// missing username is REJECTED — never allow what cannot be identified.

export function isAuthorizedActor(username: string | undefined, allowedActors: string[]): boolean {
  if (allowedActors.length === 0) return true;
  if (username === undefined) return false; // fail-closed
  return allowedActors.includes(username);
}
