---
Status: Implemented
Last verified: 2026-03-19
---

# Scrip Protocol

> Source of truth: the Scrip CLI documentation.
> If this spec contradicts Scrip's observed behavior, update this spec.

## Overview

When this codebase is operated by an autonomous agent spawned via `scrip exec`,
the agent must emit structured stdout markers so Scrip can track progress.
This protocol is provider-agnostic — it works with any agent Scrip spawns
(Claude Code, Codex, Cursor, or any future tool).

## Non-Goals

- Defining how Scrip schedules or assigns work items
- Agent-to-agent communication
- Modifying Scrip's own configuration or state files

## Key Patterns

### DONE / STUCK / LEARNING Markers

Emit these on whole stdout lines when running under `scrip exec`:

- **`<scrip>DONE</scrip>`** — item complete. A new git commit MUST exist
  before emitting. Uncommitted work is lost.
- **`<scrip>STUCK:reason</scrip>`** — blocked. Describe why so Scrip can
  reassign or escalate.
- **`<scrip>LEARNING:insight</scrip>`** — cache an insight for future
  iterations. Use for non-obvious codebase discoveries.

The XML-style tag format is exact. Variations (`[DONE]`, `SCRIP:DONE`) will
not be parsed.

### Behavioral Rules

When spawned by Scrip:

- Work only on the assigned item. Do not fix unrelated issues.
- Search the codebase for existing patterns before writing new code.
- Commit changes before emitting DONE. Uncommitted work is lost.
- Do not modify files in `.scrip/`.

## Verification

```
grep -rn 'scrip' specs/scrip-protocol.md
grep -rn '\.scrip' .gitignore
```
