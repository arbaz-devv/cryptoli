0a. Study `specs/*` with up to 500 parallel Sonnet subagents to learn the application specifications.
0b. Study @AGENTS.md to understand commands, boundaries, testing tiers, and conventions.
0c. Study @ralph/IMPLEMENTATION_PLAN.md to determine the next highest-priority unchecked item.
0d. For reference, the application source code is in `src/*`.

SCOPE CONSTRAINT: Your job is to implement the next unchecked item in @ralph/IMPLEMENTATION_PLAN.md. You must NOT add features beyond what the current item specifies. You must NOT refactor code unrelated to the current item. You must NOT modify AGENTS.md or specs/*.md unless the current item explicitly requires it. If you discover bugs outside your current item's scope, document them via a LEARNING marker in @ralph/IMPLEMENTATION_PLAN.md, do not fix them.

IMPLEMENTATION_PLAN.md CONSTRAINT: This file is the source of truth for implementation scope. You may ONLY: (1) check off items `[ ]` -> `[x]`, (2) append learnings under `> **Learnings:**` blocks, (3) add items to the "Remaining Gaps" section at the bottom. You must NOT delete task descriptions, rewrite phases, rename the document, add new phases, restructure, or collapse completed phases into summaries. The detailed task specifications must remain intact for future verification.

The only files you should be creating or modifying are:
- `src/**/*.ts` (application source code)
- `src/**/*.spec.ts` (unit tests, co-located)
- `test/**/*.spec.ts` (integration tests)
- `test/**/*.e2e-spec.ts` (e2e tests)
- `test/helpers/*` (shared test infrastructure)
- `prisma/schema.prisma` (only if the item requires schema changes)
- `package.json` (only scripts, dependencies required by the item)
- `ralph/IMPLEMENTATION_PLAN.md` (progress updates only — checkoff + learnings)

SIBLING REPOS: When the current plan item requires changes to frontend projects, you may also modify:
- `/home/scrip/Code/cryptoi-admin/` (Next.js admin dashboard)
  - Source: `app/`, `lib/`, `components/`
  - Tests: `cd /home/scrip/Code/cryptoi-admin && npm run test`
  - Key contract files: `lib/admin-api.ts`, `lib/types.ts`
  - Git: `git -C /home/scrip/Code/cryptoi-admin add/commit/push`
- `/home/scrip/Code/cryptoli-frontend/` (Next.js public frontend)
  - Source: `app/`, `features/`, `lib/`, `shared/`
  - Tests: `cd /home/scrip/Code/cryptoli-frontend && npm run test`
  - Key contract files: `lib/types.ts`, `lib/api/core.ts`, `features/*/api/client.ts`
  - Git: `git -C /home/scrip/Code/cryptoli-frontend add/commit/push`
Only modify sibling repos when the current plan item explicitly requires it.

1. Follow @ralph/IMPLEMENTATION_PLAN.md and pick the next unchecked `[ ]` item in phase order. Before making changes, read the relevant source files and specs to understand the existing patterns. Search the codebase using Sonnet subagents — don't assume not implemented. You may use up to 500 parallel Sonnet subagents for searches/reads and only 1 Sonnet subagent for build/tests. Use Opus subagents when complex reasoning is needed (debugging, architectural decisions). Ultrathink.
2. Implement the item per the acceptance criteria. Write tests at every applicable tier (see AGENTS.md Testing section):
   - Unit tests for every new service/guard/pipe/utility (`src/**/*.spec.ts`)
   - Integration tests if the change involves transactions, constraints, or cascades (`test/integration/`)
   - E2E tests for any new or changed HTTP endpoints (`test/e2e/`)
   - Use existing test helpers from `test/helpers/` — do NOT create ad-hoc mocks
3. Run tests: `npm run test:all` (unit + integration + e2e). All existing tests must continue to pass. If tests unrelated to your work fail, resolve them as part of the increment. If sibling repos were modified, also run their tests: `cd /home/scrip/Code/cryptoi-admin && npm run test` and `cd /home/scrip/Code/cryptoli-frontend && npm run test`.
4. When tests pass, update @ralph/IMPLEMENTATION_PLAN.md (check off `[x]` the completed item and append learnings), then stage specific files with `git add <file>` (do NOT use `git add -A`), then `git commit` with a message like `feat(scope): description`. After the commit, `git push`.

99999. Important: When authoring documentation or tests, capture the why — what invariant does this test protect? Not just "it works" but "it prevents X regression".
999999. Important: If existing tests break due to your changes, fix them as part of the same increment. Never leave the test suite red.
9999999. Important: Run `prisma migrate dev` then `prisma generate` after any schema change.
99999999. You may add extra logging if required to debug issues.
999999999. Keep @ralph/IMPLEMENTATION_PLAN.md current with learnings using a subagent — future iterations depend on this to avoid duplicating efforts. Update especially after finishing your turn.
9999999999. When you learn something operationally new about running the application, update @AGENTS.md using a subagent but keep it brief and operational only. AGENTS.md must stay under 150 lines.
99999999999. For any bugs you discover outside your current item's scope, document them in @ralph/IMPLEMENTATION_PLAN.md "Remaining Gaps" section using a subagent. Do NOT fix them in this iteration.
999999999999. Implement functionality completely. Placeholders and stubs waste efforts and time redoing the same work.
9999999999999. Important: Do NOT use `git add .` or `git add -A` — stage specific files with `git add <file>`. Review staged changes with `git diff --staged` before committing.
99999999999999. IMPORTANT: Keep @AGENTS.md operational only — status updates and progress notes belong in `ralph/IMPLEMENTATION_PLAN.md`. A bloated AGENTS.md pollutes every future loop's context.
999999999999999. IMPORTANT: Use the shared mock factories from `test/helpers/`. Do not define ad-hoc mocks in individual test files. If a helper doesn't exist yet and you need it, create it in `test/helpers/` first.
9999999999999999. IMPORTANT: Read the relevant spec from `specs/` before modifying any domain. The specs index in @AGENTS.md tells you which spec to read. If your change contradicts a spec, the code change is correct — note the spec drift in learnings.
