// zod schemas for the §0.2 forge model pieces (forge-model.ts) — the runtime half of
// the ForgePrimitives promise. Adapters hand assembleSnapshot "normalized model pieces";
// these schemas are what verifies that promise at assembly (issue #108), for the same
// semi-trusted-input reason WorkflowSchema exists. The model file stays FROZEN and
// type-only; this sibling is additive.
//
// Each schema is statically tied to its model type by the `Tied` assertions at the
// bottom: if a field is added, removed, retyped, or its optionality flipped on either
// side, the `true satisfies …` line stops compiling. Schemas use zod's default
// non-strict objects, so future additive optional fields on the raw values never break
// validation — only the schema/type pair must move together.

import { z } from 'zod';
import type {
  ApprovalState,
  CiStatus,
  Comment,
  ForgeUser,
  Issue,
  MergeRequest,
} from './forge-model.js';

export const ForgeUserSchema = z.object({
  username: z.string(),
  id: z.string(),
  avatarUrl: z.string().optional(),
});

export const IssueSchema = z.object({
  iid: z.number(),
  id: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  assignees: z.array(ForgeUserSchema),
  labels: z.array(z.string()),
  author: ForgeUserSchema,
  webUrl: z.string(),
  lastActor: ForgeUserSchema.optional(),
});

export const ApprovalStateSchema = z.object({
  approved: z.boolean(),
  approvedBy: z.array(ForgeUserSchema),
  changesRequested: z.boolean(),
});

export const CiStatusSchema = z.object({
  conclusion: z.enum(['success', 'failed', 'running', 'none']),
  at: z.string().optional(),
  webUrl: z.string().optional(),
});

export const MergeRequestSchema = z.object({
  iid: z.number(),
  id: z.string(),
  title: z.string(),
  description: z.string(),
  state: z.enum(['opened', 'merged', 'closed']),
  isDraft: z.boolean(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  assignees: z.array(ForgeUserSchema),
  reviewers: z.array(ForgeUserSchema),
  labels: z.array(z.string()),
  approvals: ApprovalStateSchema,
  webUrl: z.string(),
  closesIssueIid: z.number().optional(),
  ci: CiStatusSchema.optional(),
});

export const CommentSchema = z.object({
  id: z.string(),
  author: ForgeUserSchema,
  body: z.string(),
  createdAt: z.string(),
});

// --- static schema/type tie ------------------------------------------------
//
// zod v3's `.optional()` infers `prop?: T | undefined`, which under this repo's
// exactOptionalPropertyTypes is a DIFFERENT type from the model's `prop?: T`. `Norm`
// strips that spurious `| undefined` from property VALUES (recursively, keeping the
// `?` flag itself) on both sides, so `Equals` compares exactly what can drift: key
// set, per-key optionality, and value types.

type Norm<T> = T extends readonly (infer E)[]
  ? Norm<E>[]
  : T extends object
    ? { [K in keyof T]: Norm<Exclude<T[K], undefined>> }
    : T;

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

true satisfies Equals<Norm<z.infer<typeof CiStatusSchema>>, Norm<CiStatus>>;
true satisfies Equals<Norm<z.infer<typeof ForgeUserSchema>>, Norm<ForgeUser>>;
true satisfies Equals<Norm<z.infer<typeof IssueSchema>>, Norm<Issue>>;
true satisfies Equals<Norm<z.infer<typeof ApprovalStateSchema>>, Norm<ApprovalState>>;
true satisfies Equals<Norm<z.infer<typeof MergeRequestSchema>>, Norm<MergeRequest>>;
true satisfies Equals<Norm<z.infer<typeof CommentSchema>>, Norm<Comment>>;
