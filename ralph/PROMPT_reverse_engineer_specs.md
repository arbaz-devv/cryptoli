0a. Study `specs/*` with up to 250 parallel Sonnet subagents to learn existing specifications.
0b. Study `src/*` to understand the codebase. Use up to 500 parallel Sonnet subagents for reads/searches.
0c. Study @AGENTS.md to understand the project architecture and conventions.

1. For each topic assigned (or discovered), reverse-engineer the source code and produce a specification in `specs/`. Use Opus subagents for complex tracing. Ultrathink. Before writing a spec, search to confirm one doesn't already exist for that topic.
2. One topic per spec. Must pass the "one sentence without 'and'" test. Split if "and" joins unrelated capabilities.
3. **Two-phase process:** Phase 1 (Investigation) — trace every entry point, branch, code path to terminal. Map data flow, side effects, state mutations, error handling, concurrency, config-driven paths, implicit behavior. Phase 2 (Output) — write the spec with three layers:
   - **Behavioral frame** (top) — implementation-free overview and non-goals. A different team on a different stack must understand the behavior from this alone.
   - **Code anchors** (middle) — source paths, key patterns, gotchas. Each anchor: "If this contradicts the code, the code is correct — update this spec."
   - **Verification commands** (bottom) — executable grep patterns for staleness detection.
4. **Document reality, not intent.** Bugs are features. Never add behaviors the code doesn't implement. Never suggest improvements. If a source comment contradicts the code, document the code's behavior and ignore the comment.
5. **Scope boundaries:** When tracing leaves the topic, stop. Document what crosses the boundary (sent/received) only. Test: "Could this change without changing my topic's outcomes?" If yes, it's across the boundary.
6. **Shared behavior:** Inline fully in every spec (self-contained). Note shared topics for cross-spec tracking. Shared behavior also gets its own canonical spec.
7. **Spec format:** Markdown in `specs/`. Each spec includes:
   - Status frontmatter (Status: Implemented, Last verified: date)
   - Source-of-truth anchor with "code is correct" disclaimer
   - `<!-- Review when [source files] changes -->` staleness anchor
   - Overview (2-3 sentences)
   - Non-Goals
   - Key Patterns (behavioral outcomes in execution order)
   - Verification commands (grep patterns)
   - File naming: descriptive kebab-case (`auth-system.md`, `voting-system.md`)
8. When specs are complete and validated, stage specific files with `git add <file>` then `git commit` with a message describing which specs were added/updated. Then `git push`.
9. Update `specs/README.md` index with 3-column tables (Spec | Code | Purpose) grouped by category.

99999. **Exhaustive checklist before finalizing:** Every entry point documented. Every branch traced to terminal. Every data contract. Every side effect in execution order. Every error path (caught/propagated/ignored). Every config-driven path. Concurrency outcomes. Unreachable paths marked. Notable/surprising behavior marked. Zero implementation details in behavioral frame. If any item is missing, trace again.
999999. The code is the source of truth. If specs are inconsistent with the code, update the spec using an Opus subagent.
9999999. Single sources of truth, no duplicated specs. Update existing specs rather than creating new ones.
99999999. When you learn something new about the project, update @AGENTS.md using a subagent but keep it brief and operational only. AGENTS.md must stay under 150 lines.
999999999. Source comments explaining why behavior must be preserved (regulatory, compatibility, intentional) — capture rationale, strip implementation references. Stale comments are not spec.
9999999999. Document all configuration-driven paths, not just the currently active one.
99999999999. Do NOT use `git add .` or `git add -A` — stage specific files with `git add <file>`.
