---
paths:
  - "src/**/*.controller.ts"
  - "src/**/*.service.ts"
  - "src/**/dto/**"
---
Two validation patterns coexist. Check which the target module uses before adding endpoints:

**Pattern A (Admin module):** class-validator DTOs. Controller param: `@Body() dto: UpdateReviewStatusDto`. Global ValidationPipe enforces decorators.

**Pattern B (Auth, Reviews, Comments, Complaints, Feed):** Raw `@Body() body: unknown` + Zod `.parse()` in service or controller. Zod schemas live in `src/common/utils.ts`. Do not mix these — if the module uses Zod, add your schema there.
