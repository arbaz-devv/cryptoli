---
Status: Implemented
Last verified: 2026-03-19
---

# Data Model

> Source of truth: `prisma/schema.prisma`.
> If this spec contradicts the schema, the schema is correct — update this spec.

<!-- Review when prisma/ changes -->

## Overview

The Prisma schema defines the relational model for a crypto product review
platform. PostgreSQL with cascade deletes, polymorphic associations via
nullable foreign keys, denormalized counters updated inside transactions,
and a dual voting system (HelpfulVote vs Reaction).

## Non-Goals

- Soft deletes (all deletes are hard, no deleted_at columns)
- Multi-database or read replicas
- Direct migration file editing (always use `npx prisma migrate dev`)

## Key Patterns

### Cascade Delete Chains

User deletion cascades to **14+ tables** — the heaviest operation in the
system. Company, Product, Review, Post, Comment, and Complaint all cascade
to their dependents. Never add cascade deletes without tracing the full chain.

Run `grep -n 'onDelete: Cascade' prisma/schema.prisma` to see the full chain.

### Polymorphic Models

**Reaction** — belongs to exactly one of Review/Post/Comment/Complaint via
nullable FKs. Four `@@unique` constraints prevent duplicate reactions per
user per target per type.

**Comment** — belongs to one of Review/Post/Complaint. Self-referential
threading via `parentId` ("CommentReplies" relation). Only one level deep
in list queries — the implementation is intentionally shallow.

**Media** — belongs to Review or Post.

**Report** — has nullable FKs but **NO Prisma relation fields**. Append-only,
not actively queried by any service. Do not add `include` on Report — the
relation fields don't exist.

### Denormalized Counters

Several models have denormalized count fields updated via
`prisma.$transaction()` with a recount pattern. The canonical implementation
is `ReviewsService.vote()`. Recount from DB inside the transaction — never
use `{ increment: 1 }`.

Run `grep -rn 'helpfulCount\|downVoteCount\|reportCount' src/` to find all
denormalized fields and their update sites.

**`commentCount` is NOT a schema field** — it is computed at query time via
Prisma's `_count`. Do not add it to the schema.

The `criteriaScores` field on Review is `Json` type. Scoring weights are in
`calculateOverallScore()` at `src/common/utils.ts`.

### Two Voting Systems

- **HelpfulVote / ComplaintVote / CommentVote** — UP/DOWN enum, unique per
  user per entity, denormalized counters with transaction recount
- **Reaction** — LIKE/DISLIKE/LOVE/HELPFUL enum, polymorphic, no denormalized
  counters (counts computed at query time via `_count`)

See `specs/voting-system.md` for the full transaction-recount pattern.

### Schema Change Workflow

After modifying `schema.prisma`:

1. `npx prisma migrate dev` — create migration
2. `npx prisma generate` — regenerate client

Never modify migration files directly. For multi-table writes, use
`prisma.$transaction()`.

## Verification

```
grep -n 'onDelete: Cascade' prisma/schema.prisma
grep -rn 'helpfulCount\|downVoteCount\|reportCount' src/
grep -rn '\$transaction' src/
grep -n '@@unique' prisma/schema.prisma
grep -rn 'calculateOverallScore' src/common/utils.ts
```
