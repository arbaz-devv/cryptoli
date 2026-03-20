0a. Study `specs/testing-strategy.md` with up to 500 parallel Sonnet subagents to learn the testing conventions, isolation guarantees, and three-tier architecture.
0b. Study @IMPLEMENTATION_PLAN.md to determine the next highest-priority unchecked item.
0c. For reference, the application source code is in `src/*` and the application specs are in `specs/*`.

SCOPE CONSTRAINT: Your ONLY job is to write tests. You must NOT modify any source file under `src/` unless a test reveals a genuine bug that prevents the test from passing. If you find a bug, fix it minimally and document it in @IMPLEMENTATION_PLAN.md. You must NOT add features, refactor production code, update specs, or change application behavior.

IMPLEMENTATION_PLAN.md CONSTRAINT: This file is the source of truth. You may ONLY: (1) check off items `[ ]` → `[x]`, (2) append learnings under `> **Learnings:**` blocks, (3) add items to the "Remaining Gaps" section at the bottom. You must NOT delete task descriptions, rewrite phases, rename the document, add new phases, restructure, or collapse completed phases into summaries. The detailed task specifications must remain intact for future verification.

The only files you should be creating or modifying are:
- `src/**/*.spec.ts` (unit tests, co-located)
- `test/**/*.spec.ts` (integration tests)
- `test/**/*.e2e-spec.ts` (e2e tests)
- `test/helpers/*` (shared test infrastructure)
- `test/jest-integration.json`, `test/jest-e2e.json` (jest configs)
- `package.json` (only jest config, scripts, and devDependencies)
- `IMPLEMENTATION_PLAN.md` (progress updates)
- `AGENTS.md` (operational notes)

1. Follow @IMPLEMENTATION_PLAN.md and pick the next unchecked `[ ]` item in phase order (Phase 0 first, then Phase 1, etc.). Before writing tests, read the source file being tested to understand its actual behavior. Search the codebase using Sonnet subagents — don't assume. You may use up to 500 parallel Sonnet subagents for searches/reads and only 1 Sonnet subagent for writing tests. Use Opus subagents when complex reasoning is needed (debugging, understanding tricky logic).
2. After writing tests, run them: `npx jest path/to/file.spec.ts` for unit tests, `npm run test:integration` for integration, `npm run test:e2e` for e2e. All existing tests must continue to pass (`npm test`). Ultrathink.
3. When you discover issues, immediately update @IMPLEMENTATION_PLAN.md with your findings using a subagent. When resolved, update and check off the item.
4. When the tests pass (both new and existing), update @IMPLEMENTATION_PLAN.md (check off `[x]` the completed item), then `git add -A` then `git commit` with a message like `test(scope): description`. After the commit, `git push`.

99999. Important: When writing tests, capture the why — what invariant does this test protect? Not just "it works" but "it prevents X regression".
999999. Important: If existing tests break due to your changes, fix them as part of the same increment. Never leave the test suite red.
9999999. As soon as there are no test errors create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1 for example 0.0.1 if 0.0.0 does not exist.
99999999. You may add extra logging if required to debug test failures.
999999999. Keep @IMPLEMENTATION_PLAN.md current with learnings using a subagent — future iterations depend on this to avoid duplicating efforts. Update especially after finishing your turn.
9999999999. When you learn something new about running tests, update @AGENTS.md using a subagent but keep it brief.
99999999999. For any bugs you discover in source code while testing, fix them minimally and document in @IMPLEMENTATION_PLAN.md using a subagent.
999999999999. Implement tests completely. Skeleton tests with `.todo()` or empty `it()` blocks waste future iterations.
9999999999999. When @IMPLEMENTATION_PLAN.md becomes large periodically clean out completed items using a subagent.
99999999999999. IMPORTANT: Keep @AGENTS.md operational only — status updates and progress notes belong in `IMPLEMENTATION_PLAN.md`. A bloated AGENTS.md pollutes every future loop's context.
999999999999999. IMPORTANT: Use the shared mock factories from `test/helpers/` (once created in Phase 0). Do not define ad-hoc mocks in individual test files. If a helper doesn't exist yet and you need it, create it in `test/helpers/` first.
