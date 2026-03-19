# Implementation Plan: Cryptoli Backend

> **Created:** 2026-03-19 | **Current:** 343 unit tests, 17 integration, 78 e2e = 438 total
> **Spec:** See `specs/testing-strategy.md` for test conventions; `specs/README.md` for feature specs

---

## Phase 10: Feature Implementation — Filling Schema-to-API Gaps

> Schema models exist for these features but service/controller logic is missing.

- [x] **10.1 — Company follows** ✅ `POST/DELETE /api/companies/:slug/follow`, viewerState on getBySlug, 8 new unit tests
- [ ] **10.2 — Reactions CRUD** — Schema has Reaction model (LIKE/DISLIKE/LOVE/HELPFUL), polymorphic across Review/Post/Comment/Complaint. Read-side (_count) exists in services. Need: ReactionsModule with create/delete endpoints, toggle logic, unit tests.
- [ ] **10.3 — Reports** — Schema has Report model with nullable FKs. Need: ReportsModule with create endpoint (authenticated), admin list/update-status. Report count denormalization.
- [ ] **10.4 — Posts CRUD** — Schema has Post model (authorId, content, media, comments, reactions). Need: PostsModule with full CRUD, feed integration, unit tests.
- [ ] **10.5 — Products endpoints** — Schema has Product model linked from Review/Complaint. Need: products list under company, product detail by slug.
- [ ] **10.6 — Media upload** — Schema has Media model (IMAGE/VIDEO, linked to Review/Post). Need: upload endpoint, storage integration, media management.

> **Learnings:**
> - `companyFollow.deleteMany` was missing from prisma mock — added it
> - CompaniesModule now imports AuthModule for guard access
> - `getBySlug` now accepts optional `viewerId` and returns `viewerState: { isFollowing }`
> - User follows pattern (idempotent create via catch, deleteMany for remove) works well for company follows too

---

## Deferred Integration Tests (from Phase 7)

- [ ] **7.3 — complaints-voting** *(patterns identical to reviews-voting)*
- [ ] **7.4 — comments-voting** *(deferred)*
- [ ] **7.7 — analytics-tracking** *(requires Redis container in test)*

---

## Known Issues

- Pre-existing TS errors in test files (spec files use loose typing with `as unknown` casts, `userVote` property access on Prisma types) — these don't affect runtime or jest execution since `tsconfig.build.json` excludes `test/`
- `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` read from `process.env` directly in `push.service.ts`, bypassing the validated config system in `env.schema.ts`
- Notification logic in `comments.service.ts` only fires for `reviewId` targets — post and complaint comment notifications are silently skipped

---

## Completed Phases (0–9)

All test infrastructure, unit tests, integration tests, e2e tests, and CI pipeline are complete. See git history for details.

**Actual totals:** 343 unit tests + 17 integration tests + 78 e2e tests = **438 tests**
