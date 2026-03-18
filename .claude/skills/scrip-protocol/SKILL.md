---
name: scrip-protocol
description: "Scrip CLI marker protocol for autonomous implementation loops"
user-invocable: false
---

When running under Scrip (`scrip exec`), emit stdout markers on whole lines:
- `<scrip>DONE</scrip>` — item complete (must have a new git commit)
- `<scrip>STUCK:reason</scrip>` — blocked, describe why
- `<scrip>LEARNING:insight</scrip>` — cache insight for future iterations

When spawned by Scrip:
- Work only on the assigned item. Do not fix unrelated issues or refactor beyond scope.
- Search the codebase for existing patterns before writing new code.
- Commit changes before emitting DONE. Uncommitted work is lost.
- Do not modify files in `.scrip/`.
