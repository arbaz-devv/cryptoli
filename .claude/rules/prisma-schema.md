---
paths:
  - "prisma/**"
---
After modifying `schema.prisma`, always run `npx prisma migrate dev` to create a migration, then `npx prisma generate` to regenerate the client. Never modify migration files directly.

For multi-table writes, use `prisma.$transaction()`. Recount denormalized fields inside the transaction rather than using increment/decrement.

Deleting a User cascades to 14+ tables. Never add cascade deletes without checking the full chain in the schema.
