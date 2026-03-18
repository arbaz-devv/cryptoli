---
name: prisma-models
description: "Prisma schema relationship map, cascade rules, polymorphic patterns, denormalized counters"
---

> Source of truth: `prisma/schema.prisma`. If this skill contradicts the schema, the schema is correct.

## Cascade Deletes

Cascade chains are defined in `prisma/schema.prisma` via `onDelete: Cascade`. Before adding or modifying cascade deletes, read the schema to trace the full chain. Key facts:
- A **User deletion cascades to 14+ tables** — the heaviest operation in the system. No soft-delete exists.
- Company, Product, Review, Post, Comment, Complaint all cascade to their dependents.
- Run `grep -n 'onDelete: Cascade' prisma/schema.prisma` to see the full chain.

## Polymorphic Models

**Reaction**: Belongs to exactly one of Review/Post/Comment/Complaint via nullable FKs. Four `@@unique` constraints prevent duplicate reactions per user per target per type.

**Comment**: Belongs to one of Review/Post/Complaint. Self-referential threading via `parentId` ("CommentReplies" relation). Only one level deep in list queries.

**Media**: Belongs to Review or Post.

**Report**: Has nullable FKs but NO Prisma relation fields — append-only, not actively queried by any service.

## Denormalized Counters

Several models have denormalized count fields updated via `$transaction` with a recount pattern. The canonical implementation is `ReviewsService.vote()`. Run `grep -rn 'helpfulCount\|downVoteCount\|reportCount' src/` to find all denormalized fields and their update sites. Note: `commentCount` is NOT a schema field — it is computed at query time via `_count`.

The `criteriaScores` field on Review is Json. Scoring weights are in `calculateOverallScore()` at `src/common/utils.ts`.

## Two Voting Systems

- **HelpfulVote/ComplaintVote/CommentVote** — UP/DOWN enum, unique per user per entity, denormalized counters with transaction recount
- **Reaction** — LIKE/DISLIKE/LOVE/HELPFUL enum, polymorphic, no denormalized counters (counts computed at query time via `_count`)
- `POST /reviews/:id/helpful` is LEGACY (no transaction). `POST /reviews/:id/vote` is the correct endpoint.
