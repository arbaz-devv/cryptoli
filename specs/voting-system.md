---
Status: Implemented
Last verified: 2026-03-31
---

# Voting System

> Source of truth: `src/reviews/reviews.service.ts` (the `vote()` method).
> If this spec contradicts the code, the code is correct — update this spec.

<!-- Review when src/reviews/ changes -->
<!-- Review when src/comments/comments.service.ts changes -->
<!-- Review when src/complaints/complaints.service.ts changes -->

## Overview

Cryptoli has two distinct voting mechanisms: a transactional vote system
(HelpfulVote/ComplaintVote/CommentVote) with denormalized counters, and a
polymorphic reaction system (LIKE/DISLIKE/LOVE/HELPFUL) without denormalized
counters. The canonical implementation is `ReviewsService.vote()`.

## Non-Goals

- Weighted votes (all votes are equal regardless of user reputation)
- Vote history or audit log
- Shared/importable vote utility (delta function is intentionally file-local)

## Key Patterns

### Transaction-Delta Pattern

The critical invariant: **compute the counter delta from the vote state
transition, then apply via `{ increment: delta }` inside
`prisma.$transaction()`**. Never hardcode `{ increment: 1 }` or
`{ increment: -1 }` directly.

Each voting service defines a file-local `buildVoteCounterDelta(previousVoteType,
nextVoteType)` function (not a shared import) that returns `{ helpfulDelta,
downDelta }`. The math: `(next === 'UP' ? 1 : 0) - (prev === 'UP' ? 1 : 0)`.

The sequence inside `prisma.$transaction()`:

1. Verify entity exists
2. Find existing vote
3. Delete/update/create vote as needed (toggle: same vote = remove, different = switch)
4. Compute delta via `buildVoteCounterDelta(previousVoteType, nextVoteType)`
5. Update denormalized counter with `{ increment: helpfulDelta }` / `{ increment: downDelta }`

All three services (reviews, comments, complaints) follow this identical pattern.

### Transaction Retry

All three `vote()` methods wrap the transaction in a `runVoteTransaction()`
function with retry-once logic for Prisma error code `P2028` (interactive
transaction error) and messages matching `/Transaction not found/i`. If the
first attempt fails with either condition, it retries once; other errors
propagate immediately. Note: `helpful()` does NOT have this retry wrapper.

### Endpoints

- **`POST /reviews/:id/helpful`** — UP-only toggle. Uses the same transaction +
  delta pattern as `vote()` but without the P2028 retry wrapper and without
  creating notifications. Maintained for backwards compatibility.
- **`POST /reviews/:id/vote`** — Full UP/DOWN toggle with delta pattern.
- **`POST /comments/:id/vote`** — Full UP/DOWN toggle with delta pattern.
- **`POST /complaints/:id/vote`** — Full UP/DOWN toggle with delta pattern.

### Post-Vote Side Effects

After the `$transaction` completes (never inside it):

- **Socket:** `ReviewsService.vote()` and `helpful()` both emit
  `emitReviewVoteUpdated()`. Comments and complaints do NOT emit socket events
  after voting.
- **Notifications:** Reviews create a `NEW_REACTION` notification on both UP
  and DOWN votes. Comments create a notification only on UP votes
  (`isNewUpVote` flag). Complaints do NOT create vote notifications.
- **Analytics:** All three services call `analyticsService.track('vote_cast', ...)`
  when an optional `analyticsCtx` parameter is provided.

### Reaction System (Separate)

Reactions (LIKE/DISLIKE/LOVE/HELPFUL) are polymorphic via nullable FKs on the
Reaction model. They do NOT have denormalized counters — counts are computed
at query time via `_count`. Adding a reaction endpoint is simpler than a vote
endpoint because there is no counter to maintain.

See `specs/data-model.md` for the polymorphic model structure.

## Verification

```
grep -rn 'buildVoteCounterDelta' src/reviews/ src/comments/ src/complaints/
grep -rn 'vote(' src/reviews/reviews.service.ts
grep -rn '\$transaction' src/reviews/ src/comments/ src/complaints/
grep -rn 'helpfulCount\|downVoteCount' src/reviews/ src/comments/ src/complaints/
grep -rn 'analyticsCtx' src/reviews/ src/comments/ src/complaints/
```
