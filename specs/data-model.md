---
Status: Implemented
Last verified: 2026-03-27
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
`prisma.$transaction()` with a transactional delta pattern. The canonical
implementation is `ReviewsService.vote()`. Each voting service defines a
file-local `buildVoteCounterDelta()` to compute deltas, applied via
`{ increment: delta }`. Never hardcode `{ increment: 1 }` directly.

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

See `specs/voting-system.md` for the full transaction-delta pattern.

### Analytics Models

**AnalyticsEvent** — append-only event log, no FK to User (intentional for
write throughput). Uses `@@map("analytics_events")` with `@map` on columns.
Fields include eventType, sessionId, userId (nullable), ipHash, country,
device, browser, os, path, referrer, UTM fields, durationSeconds, properties (Json).

**AnalyticsDailySummary** — EAV design: `(date, dimension, dimensionValue, count)`.
Unique constraint on `[date, dimension, dimensionValue]`. Uses
`@@map("analytics_daily_summaries")`. Populated by the rollup service.

These are the only models using `@@map` table/column mapping.

### Additional Models

- **UserModeration** — 1:1 with User (optional). `AdminUserStatus` enum
  (ACTIVE/SUSPENDED). Cascades from User.
- **ComplaintReply** — company-authored replies to complaints. Cascades from
  both Complaint and Company.
- **PushSubscription** — web push endpoints (endpoint, p256dh, auth).
  Cascades from User.
- **CompanyFollow** — `@@unique([userId, companyId])`. Cascades from User
  and Company.

### Session & User Extensions

**Session** has request-context fields: `ip`, `ipHash`, `userAgent`, `device`,
`browser`, `os`, `country`, `timezone`, `trigger` — persisted at login.

**User** has `registrationIp` and `registrationCountry` — set at registration.

**Notification.actor** relation has NO `onDelete` cascade (unlike the `user`
relation which cascades). Deleting an actor preserves notification history.

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
