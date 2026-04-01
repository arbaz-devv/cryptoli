# Monorepo Migration Plan

> Merge 3 repos into one. Preserve harness + ralph workflow. Local dev, CI, deploy to one Linux server.

---

## Open Decisions

Resolve before starting migration.

| # | Decision | Options |
|---|----------|---------|
| 1 | **Production domains** | e.g., `api.cryptoli.com`, `admin.cryptoli.com`, `cryptoli.com` |
| 2 | **Server specs** | RAM, CPU, storage. Minimum 4GB RAM. Requires: Node.js 24, pnpm, PM2, Caddy, Docker (Postgres/Redis only) |
| 3 | **GitHub repo name** | e.g., `arbbaz/cryptoli` or new org |
| 4 | **Sentry projects** | Keep 3 separate or consolidate? (Separate recommended) |

---

## Tool Stack

| Concern | Tool |
|---------|------|
| Package manager | pnpm 10+ with workspaces |
| Process manager | PM2 (fork mode, 1 instance per app) |
| Reverse proxy | Caddy 2 (native install, auto-SSL) |
| Infra services | Docker Compose (Postgres + Redis only) |
| CI/CD | GitHub Actions |
| Git history merge | git-filter-repo |
| Harness | Single root AGENTS.md + specs/ |

No Turborepo -- pnpm workspace scripts handle 3 apps with no shared packages. Add turbo when the first shared package arrives.

No Docker for apps -- PM2 fork mode handles Socket.IO without sticky sessions. Apps deploy as built artifacts, not container images.

---

## Target Architecture

```
cryptoli/
  # -- Harness --
  AGENTS.md                    # ~130 lines, covers all 3 apps
  CLAUDE.md -> AGENTS.md       # symlink
  specs/                       # domain specs (moved from backend)
  ralph/                       # autonomous build loop

  # -- Root Config --
  pnpm-workspace.yaml          # packages: [apps/*]
  .npmrc                       # NestJS/Prisma hoisting
  package.json                 # root scripts
  .node-version                # pins Node 24
  .gitignore

  # -- Deployment --
  ecosystem.config.js          # PM2 process config
  Caddyfile                    # reverse proxy
  docker-compose.yml           # Postgres + Redis only

  # -- CI --
  .github/workflows/ci.yml    # 6 parallel jobs, deploy on main

  # -- Apps (code only, no per-app harness) --
  apps/
    backend/                   # NestJS 11
      package.json
      prisma/
      src/
      test/
    frontend/                  # Next.js 16.2
      package.json
      next.config.ts           # output: "standalone"
    admin/                     # Next.js 16.1
      package.json
      next.config.ts           # output: "standalone"
```

### Deployment Architecture

```
       Caddy (:80/:443) -- auto-SSL
       +-- api.domain    -> PM2: backend (:8000)
       +-- domain        -> PM2: frontend (:3000)
       +-- admin.domain  -> PM2: admin   (:3001)
                              |
                Docker: Postgres (:5432) + Redis (:6379)
```

No `packages/` directory. Each app keeps its own types and deps. Shared packages extracted later only if drift becomes a real problem.

No per-app harness files. One AGENTS.md + one specs/ at root.

---

## Migration Steps

| # | Step |
|---|------|
| 1 | Merge 3 repos via `git filter-repo --to-subdirectory-filter` + merge |
| 2 | Post-merge cleanup: remove old `.github/` dirs, consolidate `.gitignore`, normalize package names |
| 3 | Add scaffolding: `pnpm-workspace.yaml`, `.npmrc`, root `package.json`, `.node-version` |
| 4 | Clean up frontend: remove `@prisma/client`, `prisma`, dead `db:*` scripts, dead `prisma.seed` config |
| 5 | App config: add `output: "standalone"` to frontend + admin `next.config.ts`; add `"dev"` script alias to backend |
| 6 | Align Node version to 24 across all apps |
| 7 | Write deployment configs: `ecosystem.config.js`, `Caddyfile`, `docker-compose.yml` |
| 8 | Write CI workflow: `.github/workflows/ci.yml` |
| 9 | Write root `AGENTS.md` (~130 lines), move `specs/` to root, expand spec scope, symlink `CLAUDE.md` |
| 10 | Update `ralph/` for monorepo: paths in `PROMPT_build.md`, delete sibling push from `loop_streamed.sh` |
| 11 | Test: `pnpm setup`, `pnpm dev`, `pnpm test`, `pnpm build` |

---

## Git History Merge

Method: `git filter-repo --to-subdirectory-filter` + merge with `--allow-unrelated-histories`. Tested on actual repos -- preserves 205 commits, `git blame`, `git log -- path`, `git bisect`.

```bash
pip install git-filter-repo

# 1. Clone repos into throwaway copies (filter-repo removes origin)
# 2. Rewrite each: git filter-repo --to-subdirectory-filter apps/<name>
#    Tag prefix: backend-0.0.1, etc.
# 3. Create fresh monorepo
# 4. Merge each with --allow-unrelated-histories
# 5. Remove temp remotes
# 6. Verify: blame, log, bisect spot-checks
```

### Post-Merge Cleanup

- [ ] Remove old per-repo CI workflows (`apps/backend/.github/`, etc.)
- [ ] Consolidate `.gitignore` files
- [ ] Normalize package names in `package.json`
- [ ] Archive original GitHub repos with pointer to monorepo
- [ ] Push: `git remote add origin <url> && git push -u origin main --tags`

---

## Scaffolding

### pnpm-workspace.yaml

```yaml
packages:
  - "apps/*"
```

### .npmrc

```ini
# NestJS requires hoisted singletons for dependency injection.
# Without this, pnpm's strict symlinks cause duplicate @nestjs/core
# instances, breaking DI resolution.
public-hoist-pattern[]=@nestjs/*
public-hoist-pattern[]=@prisma/*
public-hoist-pattern[]=reflect-metadata
public-hoist-pattern[]=rxjs
```

### Root package.json

```jsonc
{
  "name": "cryptoli",
  "private": true,
  "packageManager": "pnpm@10.x",
  "scripts": {
    "dev": "pnpm db:generate && pnpm -r --parallel run dev",
    "dev:backend": "pnpm --filter backend run dev",
    "dev:frontend": "pnpm --filter frontend run dev",
    "dev:admin": "pnpm --filter admin run dev",
    "build": "pnpm db:generate && pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "pnpm -r run lint",
    "typecheck": "pnpm -r run typecheck",
    "format": "pnpm -r run format",
    "db:generate": "pnpm --filter backend exec prisma generate",
    "db:migrate": "pnpm --filter backend exec prisma migrate dev",
    "db:migrate:deploy": "pnpm --filter backend exec prisma migrate deploy",
    "db:reset": "pnpm --filter backend exec prisma migrate reset",
    "db:studio": "pnpm --filter backend exec prisma studio",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "infra:reset": "docker compose down -v && docker compose up -d",
    "setup": "pnpm install && pnpm infra:up && pnpm db:generate && pnpm db:migrate"
  }
}
```

Backend needs a `"dev": "nest start --watch"` alias alongside existing `start:dev`.

No shared `tsconfig.base.json`. Each app keeps its own tsconfig -- NestJS and Next.js have different TS realities.

### .node-version

```
24
```

---

## Deployment

### ecosystem.config.js

```js
module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'apps/backend/dist/main.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
    },
    {
      name: 'frontend',
      script: 'apps/frontend/.next/standalone/apps/frontend/server.js',
      env: { NODE_ENV: 'production', PORT: 3000, HOSTNAME: '0.0.0.0' },
      max_memory_restart: '512M',
    },
    {
      name: 'admin',
      script: 'apps/admin/.next/standalone/apps/admin/server.js',
      env: { NODE_ENV: 'production', PORT: 3001, HOSTNAME: '0.0.0.0' },
      max_memory_restart: '384M',
    },
  ],
};
```

Next.js standalone requires copying static assets after build:

```bash
cp -r apps/frontend/.next/static apps/frontend/.next/standalone/apps/frontend/.next/static
cp -r apps/frontend/public apps/frontend/.next/standalone/apps/frontend/public
cp -r apps/admin/.next/static apps/admin/.next/standalone/apps/admin/.next/static
cp -r apps/admin/public apps/admin/.next/standalone/apps/admin/public
```

### Caddyfile

```
api.{$DOMAIN} {
    reverse_proxy localhost:8000
}

admin.{$DOMAIN} {
    reverse_proxy localhost:3001
}

{$DOMAIN} {
    reverse_proxy localhost:3000
}

www.{$DOMAIN} {
    redir https://{$DOMAIN}{uri} permanent
}
```

Auto-SSL, HTTP-to-HTTPS, WebSocket proxying -- all automatic with Caddy.

### docker-compose.yml

Postgres + Redis only. Apps run via PM2.

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: cryptoli
      POSTGRES_USER: cryptoli
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cryptoli"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redisdata:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

### Deploy Flow

CI validates. On main push, SSH to server and reload:

```bash
cd /opt/cryptoli
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate:deploy
# Copy Next.js static assets alongside standalone output
cp -r apps/frontend/.next/static apps/frontend/.next/standalone/apps/frontend/.next/static
cp -r apps/frontend/public apps/frontend/.next/standalone/apps/frontend/public
cp -r apps/admin/.next/static apps/admin/.next/standalone/apps/admin/.next/static
cp -r apps/admin/public apps/admin/.next/standalone/apps/admin/public
pm2 reload ecosystem.config.js
```

Upgrade path: build on CI + rsync artifacts when you want to stop building on the production server.

### Server Setup (one-time)

```bash
# Install: Node.js 24, pnpm, PM2 (npm i -g pm2), Caddy, Docker
git clone <repo> /opt/cryptoli && cd /opt/cryptoli
cp apps/backend/.env.example apps/backend/.env   # edit with production values
cp apps/frontend/.env.example apps/frontend/.env.local
cp apps/admin/.env.example apps/admin/.env.local
docker compose up -d                              # Postgres + Redis
pnpm install && pnpm build
pnpm db:migrate:deploy
# Copy static assets (same as deploy flow)
pm2 start ecosystem.config.js
pm2 startup systemd && pm2 save                   # auto-restart on boot
# Copy Caddyfile to /etc/caddy/Caddyfile, set DOMAIN env, systemctl reload caddy
```

---

## CI Workflow

6 unconditional parallel jobs. No change detection, no gate pattern. Total wall-clock: ~70s.

```
ci.yml
+-- backend-unit          pnpm --filter backend run test:cov
+-- backend-integration   prisma generate -> test:integration (TestContainers)
+-- backend-e2e           prisma generate -> test:e2e (TestContainers)
+-- backend-quality       prisma generate -> tsc --noEmit -> eslint
+-- frontend-quality      lint -> typecheck -> test
+-- admin-quality         lint -> typecheck -> test
+-- smoke                 (main only, needs: all 6)
+-- notify-failure        (main only, on failure, Slack webhook)
+-- deploy                (main only, needs: all 6, SSH deploy flow)
```

All jobs: Node 24, pnpm, `actions/setup-node` with `cache: pnpm`.

Deploy job: SSH to server, execute deploy flow from Deployment section.

---

## Harness Migration

### AGENTS.md (~130 lines)

The existing backend AGENTS.md (171 lines) becomes the monorepo AGENTS.md:

| Section | Change |
|---------|--------|
| Identity | Full product description, not just backend |
| Commands | Replace npm scripts with pnpm workspace scripts |
| Boundaries | Add "Ask first: changes affecting multiple apps" |
| Architecture | Replace 17-module NestJS tree with 3-app overview + key backend modules |
| Conventions | Keep all backend conventions. Add frontend/admin only if non-inferable |
| Specs Index | Same 6 specs, expanded scope descriptions |
| Testing | Keep 3-tier backend table. Add: "Frontend/Admin: Vitest (`pnpm --filter <app> test`)" |
| Environment | Cut (inferable from per-app `.env.example`) |

### Spec Expansion

Existing 6 specs move from backend to root. Expand scope where applicable:

| Spec | Add to scope |
|------|-------------|
| `auth-system.md` | Frontend NextAuth v4, admin custom JWT proxy |
| `data-model.md` | How frontends consume schema (API response types) |
| `voting-system.md` | Frontend VoteRail UI pattern |
| `socket-architecture.md` | Frontend socket.io-client integration |
| `analytics-system.md` | Admin analytics dashboard consumption |
| `testing-strategy.md` | Frontend/admin Vitest strategy |

### ralph/ Updates

**`PROMPT_build.md`:**
- Replace absolute sibling paths (`/home/scrip/Code/cryptoi-admin/`, `/home/scrip/Code/cryptoli-frontend/`) with relative `apps/admin/`, `apps/frontend/`
- Update scope constraint: `src/` -> `apps/backend/src/`; add `apps/frontend/` and `apps/admin/` patterns
- Update source reference: `src/*` -> list all three app source dirs
- Remove separate `git -C` commands (one repo, one git)
- Update test commands to `pnpm --filter <app> run test`

**`loop_streamed.sh`:**
- Delete lines 63-67 (sibling repo push block). Single `git push` on line 58 covers all apps.

**Global skills:** Zero changes needed. All 4 skills (`/consult`, `/verify`, `/convert`, `/specs`) use relative paths exclusively.

---

## Local Development

### Onboarding

```bash
git clone <repo> cryptoli && cd cryptoli
pnpm install
docker compose up -d                    # Postgres + Redis
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
cp apps/admin/.env.example apps/admin/.env.local
pnpm db:generate && pnpm db:migrate
pnpm dev                                # all 3 apps
```

### Common Tasks

```bash
pnpm dev                              # all 3 apps (parallel)
pnpm dev:backend                      # backend only
pnpm --filter backend run test        # test one app
pnpm test                             # all unit tests
pnpm --filter backend add ioredis     # add dep to one app
pnpm add -D -w prettier              # add root dev dep
pnpm db:reset                         # nuke + re-migrate
pnpm db:studio                        # visual DB browser
pnpm infra:reset                      # destroy + recreate Postgres/Redis
```

### Environment Variables

Per-app `.env` files. Each app has a committed `.env.example`.

| App | File | Key vars |
|-----|------|----------|
| backend | `apps/backend/.env` | DATABASE_URL, REDIS_URL, JWT_SECRET, PORT, CORS_ORIGIN |
| frontend | `apps/frontend/.env.local` | NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SOCKET_URL, NEXTAUTH_SECRET |
| admin | `apps/admin/.env.local` | BACKEND_URL, ADMIN_API_KEY, ANALYTICS_API_KEY |

---

## Known Gotchas

| # | Gotcha | Detail |
|---|--------|--------|
| 1 | **NestJS + pnpm** | Needs `.npmrc` with `public-hoist-pattern` for `@nestjs/*` to avoid DI failures from duplicate package instances |
| 2 | **Prisma + pnpm** | Issue #28581: generated types reference `@prisma/client-runtime-utils` that pnpm symlinks can't resolve. Workaround: hoist `@prisma/*` |
| 3 | **Next.js standalone + monorepo** | Standalone output nests under monorepo paths. Static assets (`public/`, `.next/static/`) must be copied alongside standalone output |
| 4 | **Next.js HOSTNAME** | Must set `HOSTNAME=0.0.0.0` for non-localhost access. Default `localhost` is unreachable from Caddy |
| 5 | **git filter-repo** | Removes origin remote from clones by design. Always work on throwaway copies, never originals |
| 6 | **PM2 + env vars** | PM2 does not load `.env` files. Apps must load their own env (NestJS ConfigModule, Next.js built-in `.env.local` support) |
