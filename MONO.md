# Monorepo Migration Plan

> Merge 3 repos into one. Preserve harness + ralph workflow. Local dev, CI, deploy to one Linux server.

---

## Open Decisions

Resolve before starting migration.

| # | Decision | Options |
|---|----------|---------|
| 1 | **Production domains** | e.g., `api.cryptoli.com`, `admin.cryptoli.com`, `cryptoli.com` |
| 2 | **Server specs** | RAM, CPU, storage. Minimum 4GB RAM. Requires: Node.js 24, pnpm, PM2, Caddy, Docker (Postgres/Redis only) |
| 3 | **GitHub repo name** | `scripness/cryptoli` |
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
  AGENTS.md                    # ~150-160 lines, covers all 3 apps
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

  # -- Migration --
  scripts/
    verify-monorepo-merge.sh   # two-phase verification (committed, kept post-migration)

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

## Pre-Migration Checklist

Run before starting Phase 1. Every item must be resolved.

| # | Item | Command / Action |
|---|------|-----------------|
| 1 | **Install pnpm** | `corepack enable && corepack prepare pnpm@latest --activate` |
| 2 | **Verify git-filter-repo** | `git filter-repo --version` (already installed) |
| 3 | **Pull all 3 repos to latest** | `git pull` in each repo, verify `git status` is clean |
| 4 | **Freeze pushes** | Coordinate ~30 min window — no pushes to any of the 3 repos during migration |
| 5 | **Verify GitHub target repo** | `scripness/cryptoli` exists (private, empty) |

---

## Migration Steps

### Phase 1: Exact As-Is Migration

| # | Step |
|---|------|
| 1 | Clone all 3 repos into throwaway copies from **local paths** (filter-repo removes the origin remote by design — never run on originals) |
| 2 | Run `git filter-repo --to-subdirectory-filter apps/<name>` on each. Backend also gets `--tag-rename '':'backend-'` to prefix all 36 tags |
| 3 | Save `commit-map` files from each throwaway clone before they're discarded |
| 4 | Create a fresh empty monorepo (`git init`) |
| 5 | Merge each throwaway into the monorepo with `--allow-unrelated-histories` (order: backend, frontend, admin) |
| 6 | Run `scripts/verify-monorepo-merge.sh` — commit counts, file tree, blob SHAs, file modes, tags, blame samples, root cleanliness |
| 7 | Tag: `git tag -a migration/phase1-complete` + branch `phase1-checkpoint` |

### Phase 2: Monorepo Adaptations (8 commits)

| # | Commit | What |
|---|--------|------|
| 1 | `chore(mono): move harness to root and adapt for monorepo` | `git mv` AGENTS.md, CLAUDE.md (symlink), specs/, ralph/ to root. **Rewrite AGENTS.md** for 3-app scope (~150-160 lines). **Update ralph/PROMPT_build.md** (replace absolute sibling paths with relative `apps/` paths, update scope constraints). **Update ralph/loop_streamed.sh** (delete sibling repo push block, lines 63-67). |
| 2 | `chore(mono): remove old per-app CI workflows` | `git rm -r apps/backend/.github/ apps/frontend/.github/` |
| 3 | `chore(mono): add monorepo scaffolding` | pnpm-workspace.yaml, .npmrc, root package.json, .node-version, root .gitignore (see content below) |
| 4 | `chore(mono): adapt per-app configs` | **Rename packages:** `backend`, `frontend`, `admin`. **Backend:** add `dev`, `typecheck` scripts; fix `test:all` (`npm` → `pnpm`). **Admin:** update `dev` to `next dev --port 3001`, add `typecheck`. **Frontend:** drop `@prisma/client`, `prisma`, dead `db:*` scripts, `prisma.seed` block; create `.env.example`; add `!.env.example` to `.gitignore`. **Both frontends:** add `output: "standalone"` to next.config.ts. **All 3:** remove `package-lock.json`. **Frontend + admin:** remove per-app `.npmrc`. Fix backend `.env.example` PORT to `8000`. |
| 5 | `chore(mono): add deployment configs` | ecosystem.config.js, Caddyfile, docker-compose.yml. Add GeoIP update to deploy flow. |
| 6 | `ci(mono): add unified CI workflow` | .github/workflows/ci.yml (author from scratch per CI Workflow section) |
| 7 | `docs(mono): expand specs for monorepo scope` | Fix all path references (91 total) with `apps/backend/` prefix. Expand specs per Harness Migration section. |
| 8 | Phase 2 verification gate | Run `verify-monorepo-merge.sh --phase=2`, tag `migration/phase2-complete` |

**Commit dependency graph:**

```
1 (harness)    2 (rm .github)    3 (scaffolding)
     |                                 |
     |                            4 (per-app configs)
     |                               /    \
     |                         5 (deploy)  6 (CI)
     |                                      
     +------ 7 (specs) ------+
                              |
                         8 (verify + tag)
```

Commits 1, 2, 3 are independent. Commit 4 depends on 3 (pnpm workspace context). Commits 5 and 6 depend on 4. Commit 7 depends on 1 (edits specs/ which was moved to root in commit 1). Commit 8 is the gate (depends on all).

**After Phase 2:**

| # | Step |
|---|------|
| 9 | `git remote add origin git@github.com:scripness/cryptoli.git && git push -u origin main --tags` |
| 10 | Delete `phase1-checkpoint` branch |

---

## Git History Merge

Method: `git filter-repo --to-subdirectory-filter` + merge with `--allow-unrelated-histories`. Preserves commit metadata, `git blame`, `git log -- path`, `git bisect`.

### Filter and Merge Commands

```bash
pip install git-filter-repo

# Step 1: Clone throwaway copies
git clone /path/to/cryptoli          cryptoli-tmp
git clone /path/to/cryptoli-frontend frontend-tmp
git clone /path/to/cryptoi-admin     admin-tmp

# Step 2: Rewrite each repo into its apps/ subdirectory
git -C cryptoli-tmp  filter-repo --to-subdirectory-filter apps/backend  --tag-rename '':'backend-'
git -C frontend-tmp  filter-repo --to-subdirectory-filter apps/frontend
git -C admin-tmp     filter-repo --to-subdirectory-filter apps/admin

# Step 3: Save commit-map files before discarding throwaway clones
cp cryptoli-tmp/.git/filter-repo/commit-map  commit-map-backend.txt
cp frontend-tmp/.git/filter-repo/commit-map  commit-map-frontend.txt
cp admin-tmp/.git/filter-repo/commit-map     commit-map-admin.txt

# Step 4: Create fresh monorepo
mkdir cryptoli-mono && cd cryptoli-mono && git init

# Step 5: Merge each throwaway
git remote add backend  ../cryptoli-tmp
git remote add frontend ../frontend-tmp
git remote add admin    ../admin-tmp

git fetch backend  --tags
git fetch frontend
git fetch admin

git merge --allow-unrelated-histories backend/main  -m "chore: merge backend history into apps/backend"
git merge --allow-unrelated-histories frontend/main -m "chore: merge frontend history into apps/frontend"
git merge --allow-unrelated-histories admin/main    -m "chore: merge admin history into apps/admin"

# Step 6: Remove temp remotes
git remote remove backend
git remote remove frontend
git remote remove admin
```

### Resulting DAG

```
B1--B2--...--B51 (backend, 51 commits)
                \
                 M1 ← merge backend
                 |
F1--F2--...--F100 (frontend, 100 commits)
                \
                 M2 ← merge frontend
                 |
D1--D2--...--D57 (admin, 57 commits)
                \
                 M3 ← merge admin  (HEAD: main)
```

`git log` shows all 208 original commits + 3 merge commits, interleaved by date. `git log -- apps/backend/` shows only backend's commits + M1.

### Post-Merge Notes

**Commit-map files** — `filter-repo` writes `.git/filter-repo/commit-map` (old SHA → new SHA) into each throwaway clone. Copy these out before discarding the clones. They map original repo SHAs to monorepo SHAs — useful for cross-referencing old GitHub issue/PR links.

**Stale refs** — All 3 repos have stale remote-tracking refs (branches deleted on GitHub). These only exist as remote-tracking refs — no local branches. `git clone` from local paths only propagates local branches, so none carry through to throwaway clones.

| Repo | Stale Ref | Status |
|------|-----------|--------|
| Backend | `origin/add-missing-indexes` | Abandoned (2 unmerged commits) |
| Backend | `origin/api-optimize` | Fully merged |
| Backend | `origin/observability` | Fully merged |
| Frontend | `origin/api-optimize` | Fully merged |
| Frontend | `origin/scaling` | Fully merged |
| Frontend | `origin/security` | Fully merged |
| Admin | `origin/observability` | Fully merged |
| Admin | `origin/security` | Fully merged |

**Old `.github/` directories** are intentionally left in place after Phase 1. They are removed in Phase 2 commit 2 as an explicit, reviewable `git rm` commit — not as a silent filter-repo exclusion.

Original repos remain untouched. No archival, no modifications, no pointers.

---

## Verification

Two-gate model: Phase 1 verifies the history merge is lossless; Phase 2 re-runs history checks and adds structural checks for the monorepo adaptations.

### Phase 1 Verification (`scripts/verify-monorepo-merge.sh`)

Runs after the three merges, before tagging `migration/phase1-complete`.

| Check | Method |
|-------|--------|
| **Commit count** | Fingerprint each non-merge commit as `author_date\|email\|subject`. Count per app must match source repo. |
| **File tree** | `git ls-files apps/<name>/` in monorepo vs `git ls-files` in source. Strip `apps/<name>/` prefix; diff must be empty. |
| **Content** | Blob SHA-1 comparison for every tracked file. Byte-identical after prefix stripping. |
| **File modes** | Executable bits (`100755`) and symlinks (`120000`) preserved via `git ls-tree -r` comparison. |
| **Tags** | All 36 backend version tags present with `backend-` prefix. Frontend and admin: zero tags expected. |
| **Blame** | Sampled files (5 per app). All lines attributed to original authors. |
| **Root cleanliness** | No files outside `apps/` in the monorepo tree. |

Script exits non-zero on any failure. All checks must pass before tagging.

### Phase 2 Verification (`scripts/verify-monorepo-merge.sh --phase=2`)

Runs after all 8 adaptation commits, before tagging `migration/phase2-complete`.

| Check | Method |
|-------|--------|
| **History integrity** | Re-run Phase 1 commit count and tag checks — no history rewritten by Phase 2. |
| **Harness at root** | AGENTS.md, CLAUDE.md (symlink), specs/, ralph/ exist at repo root. Absent from apps/backend/. |
| **Old CI removed** | apps/backend/.github/ and apps/frontend/.github/ do not exist. |
| **Package names** | Each app's package.json `name` field matches its directory name (`backend`, `frontend`, `admin`). |
| **Dead artifacts removed** | No `package-lock.json` in any app. No `.npmrc` in apps/frontend/ or apps/admin/. |
| **Frontend .env.example** | apps/frontend/.env.example exists and is tracked. |
| **Standalone output** | `output: "standalone"` present in both `apps/frontend/next.config.ts` and `apps/admin/next.config.ts`. |
| **Backend PORT fixed** | `apps/backend/.env.example` contains `PORT=8000` (not 9000). |
| **Admin dev port** | `apps/admin/package.json` dev script contains `--port 3001`. |
| **Backend scripts added** | `apps/backend/package.json` has `dev` and `typecheck` scripts. `test:all` uses `pnpm` (not `npm`). |
| **Deploy/CI files exist** | `ecosystem.config.js`, `Caddyfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, root `.gitignore` all exist. |
| **Scaffolding parses** | pnpm-workspace.yaml: valid YAML. Root package.json: valid JSON. .node-version: contains `24`. |
| **Install succeeds** | `pnpm install` exits 0. |

### Phase Boundary

| Artifact | Purpose |
|----------|---------|
| `git tag -a migration/phase1-complete` | Annotated tag — permanent, immutable record of verified merge state |
| `git branch phase1-checkpoint` | Operational rollback point — `git reset --hard phase1-checkpoint` to undo Phase 2 |
| `git tag -a migration/phase2-complete` | Annotated tag — final verified monorepo state before push |

**Rollback** (safe because nothing is pushed until Phase 2 passes):

```bash
git reset --hard migration/phase1-complete
# Restores exact post-merge state. All Phase 2 commits discarded.
```

After Phase 2 verification passes and push is confirmed, delete the checkpoint branch:

```bash
git branch -d phase1-checkpoint
```

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

Scripts are grouped by lifecycle. Comments below explain each group — the actual `package.json` is pure JSON.

- **Daily dev** — `dev`, `dev:backend`, `dev:frontend`, `dev:admin`
- **First-time / after schema changes** — `setup`
- **Build + local production test** — `build`, `start`, `start:backend`, `start:frontend`, `start:admin`
- **Quality** — `test`, `lint`, `typecheck`, `format` (typecheck and format use `--if-present` since not all apps have these scripts)
- **Database** — `db:generate`, `db:migrate`, `db:migrate:deploy`, `db:reset`, `db:studio`
- **Infrastructure** — `infra:up`, `infra:down`, `infra:reset`

```json
{
  "name": "cryptoli",
  "private": true,
  "packageManager": "pnpm@10.x",
  "scripts": {
    "dev": "docker compose up -d && pnpm db:generate && pnpm -r --parallel run dev",
    "dev:backend": "docker compose up -d && pnpm db:generate && pnpm --filter backend run dev",
    "dev:frontend": "pnpm --filter frontend run dev",
    "dev:admin": "pnpm --filter admin run dev",
    "setup": "pnpm install && docker compose up -d && pnpm db:generate && pnpm db:migrate",
    "build": "pnpm db:generate && pnpm -r run build",
    "start": "pnpm -r --parallel run start",
    "start:backend": "pnpm --filter backend run start:prod",
    "start:frontend": "pnpm --filter frontend run start",
    "start:admin": "pnpm --filter admin run start",
    "test": "pnpm -r run test",
    "lint": "pnpm -r run lint",
    "typecheck": "pnpm -r --if-present run typecheck",
    "format": "pnpm -r --if-present run format",
    "db:generate": "pnpm --filter backend exec prisma generate",
    "db:migrate": "pnpm --filter backend exec prisma migrate dev",
    "db:migrate:deploy": "pnpm --filter backend exec prisma migrate deploy",
    "db:reset": "pnpm --filter backend exec prisma migrate reset",
    "db:studio": "pnpm --filter backend exec prisma studio",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "infra:reset": "docker compose down -v && docker compose up -d"
  }
}
```

### Script lifecycle

```
Fresh clone:     pnpm setup        → install deps, start infra, generate client, run migrations
Daily dev:       pnpm dev          → ensure infra, regenerate client (<1s), start 3 dev servers
Test:            pnpm test         → run all unit tests across all apps
Prod test:       pnpm build        → build all 3 apps (production artifacts)
                 pnpm start        → start all 3 in production mode locally
Deploy:          CI handles via SSH (see Deployment section)
Schema change:   pnpm db:migrate   → apply migration (dev/build auto-regenerate client)
Clean slate:     pnpm infra:reset  → destroy volumes + recreate containers
                 pnpm setup        → reinstall everything from scratch
```

### Design decisions

**`dev` includes `docker compose up -d`** — idempotent (<0.5s when already running). Prevents "connection refused" on first run.

**`db:generate` in both `dev` and `build`** — `prisma generate` is idempotent, ~0.9s, no network calls, no side effects. Safe to run always.

**`db:migrate` is NOT in `dev`** — migrations can be destructive (drop columns, rename tables). Only runs explicitly via `setup` or manual `pnpm db:migrate`.

**`setup` does NOT start dev servers** — gets you to a ready state. Then run `dev`.

**`start` for local production testing** — after `build`, run `start` to test all 3 apps in production mode at localhost before deploying.

### Per-app package.json changes (Phase 2 commit 4)

**All 3 apps:**
- Rename `name` field to match directory: `backend`, `frontend`, `admin` (pnpm `--filter` matches on name)
- Remove `package-lock.json` (pnpm generates `pnpm-lock.yaml` at root)

**Backend — add/fix:**
```json
"dev": "nest start --watch",
"typecheck": "tsc --noEmit"
```
- Fix `test:all`: change `npm test && npm run` → `pnpm test && pnpm run`
- Fix `.env.example`: change `PORT=9000` → `PORT=8000` (matches Caddyfile + deployment)

**Admin — update/add:**
```json
"dev": "next dev --port 3001",
"typecheck": "tsc --noEmit"
```
- Remove per-app `.npmrc` (`legacy-peer-deps=true` is npm-only, dead under pnpm)

**Frontend — drop + create:**
- Remove: `db:generate`, `db:push`, `db:migrate`, `db:studio` (reference nonexistent `scripts/setup-env.js`)
- Remove: `@prisma/client`, `prisma` from dependencies
- Remove: `"prisma": { "seed": ... }` config block
- Remove per-app `.npmrc` (`legacy-peer-deps=true` is npm-only, dead under pnpm)
- Create `.env.example` (does not exist; `.gitignore` blocks `.env*`):
  ```
  NEXT_PUBLIC_API_URL=http://localhost:8000
  NEXT_PUBLIC_APP_URL=http://localhost:3000
  NEXT_PUBLIC_SOCKET_URL=http://localhost:8000
  NEXTAUTH_SECRET=your-secret-here-min-32-chars
  # SENTRY_DSN=
  # NEXT_PUBLIC_SENTRY_DSN=
  # NEXT_PUBLIC_VAPID_PUBLIC_KEY=
  ```
- Add `!.env.example` to frontend `.gitignore` (matching admin's pattern)

**Frontend + Admin — add to next.config.ts:**
```ts
output: "standalone"
```

No shared `tsconfig.base.json`. Each app keeps its own tsconfig -- NestJS and Next.js have different TS realities.

### .node-version

```
24
```

### Root .gitignore

```gitignore
# Dependencies
node_modules/

# Build output
dist/
.next/
build/
out/

# Environment (per-app .env.example files ARE tracked)
.env
.env.local
.env.development.local
.env.test.local
.env.production.local
!.env.example

# Testing
coverage/
.nyc_output/

# GeoIP database (downloaded at runtime)
data/geoip/*.mmdb

# IDE
.idea/
.vscode/
*.sublime-workspace

# OS
.DS_Store

# Logs
*.log
pnpm-debug.log*

# Temp
.temp/
.tmp/

# TypeScript
*.tsbuildinfo

# Sentry
.env.sentry-build-plugin

# Runtime
pids/
*.pid
*.seed
*.pid.lock
```

Per-app `.gitignore` files remain in place — git respects nested `.gitignore` files and they handle app-specific paths with `/` prefixes.

---

## Deployment

### ecosystem.config.js

```js
module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: '/opt/cryptoli',
      script: 'apps/backend/dist/main.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
    },
    {
      name: 'frontend',
      cwd: '/opt/cryptoli',
      script: 'apps/frontend/.next/standalone/apps/frontend/server.js',
      env: { NODE_ENV: 'production', PORT: 3000, HOSTNAME: '0.0.0.0' },
      max_memory_restart: '512M',
    },
    {
      name: 'admin',
      cwd: '/opt/cryptoli',
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
# Update GeoIP database (PM2 bypasses prestart:prod lifecycle hook)
pnpm --filter backend exec sh scripts/geoip-update.sh
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
+-- frontend-quality      lint -> typecheck -> test -> check:security-config
+-- admin-quality         lint -> typecheck -> test
+-- smoke                 (main only, needs: all 6)
+-- notify-failure        (main only, on failure, Slack webhook)
+-- deploy                (main only, needs: all 6, SSH deploy flow)
```

All jobs: Node 24, pnpm, `actions/setup-node` with `cache: pnpm`.

Deploy job: SSH to server, execute deploy flow from Deployment section.

---

## Harness Migration

### AGENTS.md (~150-160 lines)

The existing backend AGENTS.md (171 lines) becomes the monorepo AGENTS.md. Target ~150-160 lines — 130 is too tight for 3 apps with protected sections (Specifications block, Testing section, Specs Index scaffolding must not be trimmed per harness.md).

| Section | Change |
|---------|--------|
| Identity | Full product description, not just backend |
| Commands | Replace npm scripts with pnpm workspace scripts |
| Boundaries | Add "Ask first: changes affecting multiple apps" |
| Architecture | Replace 17-module NestJS tree with 3-app overview + key backend modules |
| Conventions | Keep all backend conventions. Add 5 non-inferable frontend/admin conventions (see below) |
| Specs Index | Same 6 specs + new specs, expanded scope descriptions |
| Testing | Keep 3-tier backend table. Add: "Frontend/Admin: Vitest (`pnpm --filter <app> test`)" |
| Environment | Cut (inferable from per-app `.env.example`) |

**5 frontend/admin conventions to add:**

1. **Frontend API layers (two paths)** — Client components use `fetchApi` (from `lib/api/core.ts`) through the `/backend/api/*` rewrite proxy. Server Components use `getServer*` functions (from `lib/server-api.ts`) with `getBackendUrl()` (internal URL priority) and manual cookie forwarding. Never cross the boundary.

2. **Frontend auth context (dual system)** — Auth state merges NextAuth session + backend cookie fallback. `AuthContext` checks NextAuth first; on `unauthenticated`, lazily checks backend `/api/auth/me`. Always use `useAuth()` from `lib/contexts/AuthContext.tsx` — never `useSession()` directly.

3. **Frontend i18n routing** — Internal links in locale-routed pages must use `Link` from `@/i18n/routing`, not `next/link`. Exception: `global-error.tsx` and root layout (outside `[locale]` segment). New strings must be added to ALL 5 locale files (`messages/{en,de,nl,es,fr}.json`).

4. **Admin auth (custom JWT, not NextAuth)** — Admin uses custom JWT with `admin_token`/`admin_refresh_token` cookies and in-process session tracking (`lib/server/auth-security.ts`). New API routes MUST use `withAdminRoute()` from `lib/admin-api.ts`. Server Components read tokens directly from `cookies().get(ADMIN_TOKEN_COOKIE)`.

5. **Infinite feed hydration** — Server Components seed React Query infinite query caches using `createInfiniteFeedData()` + `queryClient.setQueryData(queryKeys.xxx(...))` + `<HydrationBoundary>`. Client hooks must use the **exact same query key** from `lib/queryKeys.ts`. Mismatched keys cause silent re-fetches and layout shift.

### Spec Path Fixes (commit 7, all specs)

All 6 specs + README.md contain path references that break when `specs/` moves from inside backend to monorepo root. 91 references total: 36 functional breaks (grep commands, markdown links), 49 misleading (source anchors, review-when comments), 6 no-break (relative imports within backend).

**What to fix per file:**
- **README.md** (9 refs) — Code column links: `../src/auth/` → `./apps/backend/src/auth/`, `../prisma/` → `./apps/backend/prisma/`, `../test/` → `./apps/backend/test/`
- **auth-system.md** (10 refs) — Source anchor, review-when comment, 3 code path refs, 4 grep commands
- **data-model.md** (10 refs) — Source anchor, review-when comment, 1 code path ref, 6 grep commands
- **voting-system.md** (9 refs) — Source anchor, 3 review-when comments, 5 grep commands
- **socket-architecture.md** (7 refs) — Source anchor, review-when comment, 4 grep commands
- **analytics-system.md** (10 refs) — Source anchor, review-when comment, 8 grep commands
- **testing-strategy.md** (36 refs) — Review-when comments, ~30 code path references in prose and directory trees. Import path examples (relative within backend) are fine — leave as-is.

All `src/` → `apps/backend/src/`, all `prisma/` → `apps/backend/prisma/`, all `test/` → `apps/backend/test/`.

### Spec Expansion Strategy

Existing 6 specs move from backend to root. Expansion uses a hybrid approach — horizontal for full-stack domains, vertical for independently complex domains, skip for consumer-only relationships.

| Spec | Strategy | What to add |
|------|----------|-------------|
| `auth-system.md` | **Horizontal expand** | Frontend: NextAuth credentials provider as proxy, dual-path AuthContext (NextAuth + backend cookie fallback), CSRF token extraction chain. Admin: separate JWT+refresh flow, in-memory session registry, `withAdminRoute()` pattern, lockout/rate limiting. Cross-cutting: cookie contract (names, SameSite, Secure, HttpOnly). |
| `data-model.md` | **Skip** | Frontends never touch Prisma — they consume API response types. Their type definitions are API contracts, not schema knowledge. |
| `voting-system.md` | **Horizontal expand** | Frontend: `useVote` hook with optimistic delta queue, rollback on error, rapid toggle handling. VoteResponse contract shape. Delta math parity note (frontend mirrors `buildVoteCounterDelta()`). |
| `socket-architecture.md` | **Horizontal expand** | Frontend: singleton client pattern, `useSocket` hook, reconnection config, `withCredentials: true`. Event consumption map (which hook listens to which event). Connection lifecycle (URL safety, transport preference). |
| `analytics-system.md` | **Horizontal expand** + **Vertical new** | Expand existing: frontend `AnalyticsTracker` component, consent gating via `analytics_consent_v2` cookie, track request contract. New `admin-analytics-dashboard.md`: 622-line analytics client, 20+ dashboard components, realtime polling, period-over-period comparison, rollup trigger. |
| `testing-strategy.md` | **Vertical new** | New `frontend-testing.md`: Vitest + jsdom stack, @testing-library/react patterns, vi.mock for Next.js modules. Admin testing appendix (node env, auth-security focused, minimal). Keep existing spec as backend-only (Jest/TestContainers). |

### ralph/ Updates

**`PROMPT_build.md`:**
- Replace absolute sibling paths (`/home/scrip/Code/cryptoi-admin/`, `/home/scrip/Code/cryptoli-frontend/`) with relative `apps/admin/`, `apps/frontend/`
- Remove entire SIBLING REPOS section (lines 21-31) — no longer needed, all apps are in one repo
- Update scope constraint: `src/` → `apps/backend/src/`; add frontend/admin patterns
- Update source reference (line 4): `src/*` → `apps/backend/src/*`, `apps/frontend/{app,features,lib,shared}/*`, `apps/admin/{app,lib,components}/*`
- Update step 2 test reference (line 36): `src/**/*.spec.ts` → `apps/backend/src/**/*.spec.ts`
- Remove separate `git -C` commands (one repo, one git)
- Update test commands to `pnpm --filter <app> run test`
- Replace the file allowlist (lines 10-18) with the monorepo version:
  ```
  # ── Backend ──
  - apps/backend/src/**/*.ts (application source code)
  - apps/backend/src/**/*.spec.ts (unit tests, co-located)
  - apps/backend/test/**/*.{spec.ts,e2e-spec.ts} (integration + e2e tests)
  - apps/backend/test/helpers/* (shared test infrastructure)
  - apps/backend/prisma/schema.prisma
  - apps/backend/package.json

  # ── Frontend ──
  - apps/frontend/app/**/*.{ts,tsx,css} (pages, layouts, API routes)
  - apps/frontend/features/**/*.{ts,tsx} (feature modules)
  - apps/frontend/lib/**/*.{ts,tsx} (API client, hooks, utilities)
  - apps/frontend/shared/**/*.{ts,tsx} (shared components, hooks)
  - apps/frontend/i18n/*.ts (i18n config)
  - apps/frontend/messages/*.json (locale strings)
  - apps/frontend/**/*.test.{ts,tsx} (co-located Vitest tests)
  - apps/frontend/auth.ts (NextAuth config)
  - apps/frontend/package.json
  - apps/frontend/next.config.ts

  # ── Admin ──
  - apps/admin/app/**/*.{ts,tsx,css} (pages, layouts, API routes)
  - apps/admin/components/**/*.{ts,tsx} (UI components)
  - apps/admin/lib/**/*.ts (API clients, utilities)
  - apps/admin/tests/**/*.test.ts (Vitest tests)
  - apps/admin/package.json
  - apps/admin/next.config.ts

  # ── Root ──
  - ralph/IMPLEMENTATION_PLAN.md (progress updates)
  - specs/*.md (only to fix inconsistencies)
  ```

**`loop_streamed.sh`:**
- Delete lines 63-67 (sibling repo push block). Single `git push` on line 58 covers all apps.

**Global skills:** Zero changes needed. All 4 skills (`/consult`, `/verify`, `/convert`, `/specs`) use relative paths exclusively (`specs/*`, `AGENTS.md`, `ralph/IMPLEMENTATION_PLAN.md`). `/convert` and `/specs` have `disable-model-invocation: true` (user-invoked only, not auto-triggered). All work from monorepo root.

---

## Local Development

### Onboarding

```bash
git clone <repo> cryptoli && cd cryptoli
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
cp apps/admin/.env.example apps/admin/.env.local
pnpm setup                              # install, start infra, generate, migrate
pnpm dev                                # all 3 apps + infra
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
| frontend | `apps/frontend/.env.local` | NEXT_PUBLIC_API_URL, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SOCKET_URL, NEXTAUTH_SECRET |
| admin | `apps/admin/.env.local` | BACKEND_URL, ADMIN_API_KEY, ANALYTICS_API_KEY |

---

## Known Gotchas

| # | Gotcha | Detail |
|---|--------|--------|
| 1 | **NestJS + pnpm** | Needs `.npmrc` with `public-hoist-pattern` for `@nestjs/*` to avoid DI failures from duplicate package instances |
| 2 | **Prisma + pnpm** | Issue #28581: generated types reference `@prisma/client-runtime-utils` that pnpm symlinks can't resolve. Workaround: hoist `@prisma/*` |
| 3 | **Next.js standalone + monorepo** | Standalone output nests under monorepo paths. Static assets (`public/`, `.next/static/`) must be copied alongside standalone output |
| 4 | **Next.js HOSTNAME** | Must set `HOSTNAME=0.0.0.0` for non-localhost access. Default `localhost` is unreachable from Caddy |
| 5 | **git filter-repo** | Removes origin remote from clones by design. Always work on throwaway copies, never originals. Save `.git/filter-repo/commit-map` from each clone before discarding — it's the only old-SHA → new-SHA mapping |
| 6 | **PM2 + env vars** | PM2 does not load `.env` files. Apps must load their own env (NestJS ConfigModule, Next.js built-in `.env.local` support) |
| 7 | **Dev port conflict** | Frontend and admin both default to Next.js port 3000. Admin must set `next dev --port 3001` to avoid collision |
| 8 | **NEXT_PUBLIC_ build-time baking** | `NEXT_PUBLIC_*` env vars are inlined at `next build` time, not read at runtime. Must be set before building, not just before starting |
| 9 | **pnpm --filter matches package name** | `pnpm --filter backend` matches the `name` field in package.json, NOT the directory name. Per-app package names must be `backend`, `frontend`, `admin` for root scripts to work |
| 10 | **PM2 bypasses npm lifecycle hooks** | `prestart:prod` in backend package.json never fires when PM2 runs `node dist/main.js` directly. GeoIP update must be explicit in deploy flow |
| 11 | **Frontend missing .env.example** | Frontend `.gitignore` blocks `.env*` with no exception. Must add `!.env.example` to gitignore AND create the file. Admin already has this pattern |
