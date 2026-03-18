---
name: voting-system
description: "Vote and reaction systems: transaction-recount pattern, denormalized counters, legacy vs current endpoints"
---

> Source of truth: `src/reviews/reviews.service.ts` (the `vote()` method). Read it before implementing any new vote endpoint.

## Correct Vote Pattern

The canonical pattern is in `ReviewsService.vote()`. The critical invariant: **recount from the DB source of truth inside the transaction**. Never use `{ increment: 1 }` — it drifts under concurrent writes.

The sequence inside `prisma.$transaction()`:
1. Verify entity exists
2. Find existing vote
3. Delete/update/create vote as needed
4. **Recount** from DB (e.g., `tx.helpfulVote.count({ where: { reviewId, type: 'UP' } })`)
5. Update denormalized counter on parent entity with the recount result

## Legacy vs Current

- `POST /reviews/:id/helpful` — LEGACY. No transaction, UP-only, uses raw increment. Exists for backwards compat.
- `POST /reviews/:id/vote` — CURRENT. Full transaction, UP/DOWN, recount pattern.

All new vote endpoints (for any entity) must follow the transaction-recount pattern.

## Reaction System (Separate)

Reactions (LIKE/DISLIKE/LOVE/HELPFUL) are polymorphic via nullable FKs. They do NOT have denormalized counters — counts are computed at query time via `_count`. Adding a reaction endpoint is simpler because there's no counter to maintain.
