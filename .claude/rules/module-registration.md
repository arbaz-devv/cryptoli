---
paths:
  - "src/**/*.module.ts"
---
New feature modules must be added to the `imports` array in `src/app.module.ts`. Missing this causes silent failures — the module's controllers won't register routes.

Global modules (Config, Prisma, Redis, Socket) are already available everywhere. Do not import them in feature modules.

If your module needs AuthGuard/OptionalAuthGuard, import AuthModule. If it needs NotificationsService, import NotificationsModule. Check existing modules for the pattern.
