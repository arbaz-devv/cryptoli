---
Status: Implemented
Last verified: 2026-03-19
---

# Voting System

> Source of truth: `src/reviews/reviews.service.ts` (the `vote()` method).
> If this spec contradicts the code, the code is correct — update this spec.

<!-- Review when src/reviews/ changes -->

## Overview

Cryptoli has two distinct voting mechanisms: a transactional vote system
(HelpfulVote/ComplaintVote/CommentVote) with denormalized counters, and a
polymorphic reaction system (LIKE/DISLIKE/LOVE/HELPFUL) without denormalized
counters. The canonical implementation is `ReviewsService.vote()`.

## Non-Goals

- Weighted votes (all votes are equal regardless of user reputation)
- Vote history or audit log
- Changing the legacy `/helpful` endpoint behavior (backwards compat)

## Key Patterns

### Transaction-Recount Pattern

The critical invariant: **recount from DB inside the transaction**. Never use
`{ increment: 1 }` — it drifts under concurrent writes.

The sequence inside `prisma.$transaction()`:

1. Verify entity exists
2. Find existing vote
3. Delete/update/create vote as needed (toggle: same vote = remove, different = switch)
4. **Recount** from DB (e.g., `tx.helpfulVote.count({ where: { reviewId, type: 'UP' } })`)
5. Update denormalized counter on parent entity with the recount result

All new vote endpoints (for any entity) must follow this pattern.

### Legacy vs Current Endpoints

- **`POST /reviews/:id/helpful`** — LEGACY. No transaction, UP-only, uses raw
  increment. Kept for backwards compatibility. Do not replicate this pattern.
- **`POST /reviews/:id/vote`** — CURRENT. Full transaction, UP/DOWN toggle,
  recount pattern.

### Reaction System (Separate)

Reactions (LIKE/DISLIKE/LOVE/HELPFUL) are polymorphic via nullable FKs on the
Reaction model. They do NOT have denormalized counters — counts are computed
at query time via `_count`. Adding a reaction endpoint is simpler than a vote
endpoint because there is no counter to maintain.

See `specs/data-model.md` for the polymorphic model structure.

## Verification

```
grep -rn 'vote(' src/reviews/reviews.service.ts
grep -rn '\$transaction' src/reviews/
grep -rn 'helpfulCount\|downVoteCount' src/reviews/
grep -rn 'POST.*helpful\|POST.*vote' src/reviews/reviews.controller.ts
```
