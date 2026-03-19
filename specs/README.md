# Cryptoli Specifications

NestJS 11 backend for a cryptocurrency/fintech review platform.

## Authentication & Authorization

| Spec | Code | Purpose |
|------|------|---------|
| [auth-system.md](./auth-system.md) | [src/auth/](../src/auth/) | Auth flow, guards, CSRF, sessions, rate limiting |

## Data & Storage

| Spec | Code | Purpose |
|------|------|---------|
| [data-model.md](./data-model.md) | [prisma/](../prisma/) | Schema relationships, cascade rules, polymorphic models |
| [voting-system.md](./voting-system.md) | [src/reviews/](../src/reviews/) | Transaction-recount pattern, vote and reaction systems |

## Real-Time & Infrastructure

| Spec | Code | Purpose |
|------|------|---------|
| [socket-architecture.md](./socket-architecture.md) | [src/socket/](../src/socket/) | Socket.IO rooms, event catalog, globalThis pattern |

## Agent Protocol

| Spec | Code | Purpose |
|------|------|---------|
| [scrip-protocol.md](./scrip-protocol.md) | — | DONE/STUCK/LEARNING markers for autonomous agent loops |
