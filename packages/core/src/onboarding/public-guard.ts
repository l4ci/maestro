// Public-repo opt-in guard (§13.1, M8 Slice 11). Onboarding a PUBLIC repo means the
// agent will act on attacker-controllable issue/comment text with the bot's
// credentials. v1's honest stance: that is a conscious human decision, not a default.
// `maestro add` on a public repo with no actor allowlist must require an explicit
// `--public` opt-in. A private repo, or a public repo already gated by an
// allowed_actors allowlist, passes without ceremony. The runtime rejection of an
// untrusted actor still lives in the reconciler's trigger guard (M1 A3).

export interface PublicOptInInput {
  visibility: 'public' | 'private';
  allowedActors: string[]; // resolved trigger.allowed_actors
  optIn: boolean; // the `--public` flag the operator set consciously
}

export type PublicOptInResult = { ok: true } | { ok: false; reason: string };

export function requirePublicOptIn(input: PublicOptInInput): PublicOptInResult {
  if (input.visibility !== 'public') return { ok: true }; // private: no extra gate
  if (input.allowedActors.length > 0) return { ok: true }; // trigger guard already on
  if (input.optIn) return { ok: true }; // explicit conscious opt-in
  return {
    ok: false,
    reason:
      'refusing to onboard a PUBLIC repo without protection (§13.1): the agent would act ' +
      'on attacker-controllable issue text with the bot token. Set trigger.allowed_actors ' +
      'or pass --public to opt in consciously.',
  };
}
