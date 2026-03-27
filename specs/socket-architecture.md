---
Status: Implemented
Last verified: 2026-03-27
---

# Socket Architecture

> Source of truth: `src/socket/socket.service.ts` and `src/main.ts`.
> If this spec contradicts the code, the code is correct — update this spec.

<!-- Review when src/socket/ changes -->

## Overview

Cryptoli uses Socket.IO for real-time server-to-client push notifications.
The server is created manually in `main.ts` (NOT via `@WebSocketGateway`)
and stored on `globalThis.__socketIO`. SocketService reads from this global
and no-ops gracefully when it is undefined.

## Non-Goals

- Client-to-server events (architecture is push-only)
- NestJS `@WebSocketGateway` or `@SubscribeMessage` decorators
- Socket-based authentication beyond the initial connection handshake
- Horizontal scaling / Redis adapter for multi-instance Socket.IO

## Key Patterns

### globalThis Pattern

Socket.IO is created manually in `main.ts` after `app.listen()` and stored
on `globalThis.__socketIO`. SocketService (global module) reads from this
global. If undefined (tests, pre-bootstrap), all emit methods are no-ops.

Do NOT add null checks in calling code — SocketService handles this internally.

### Room Structure

On connection, every socket auto-joins:

- `'reviews'` — broadcast room for all review-related updates
- `'user:{id}'` — per-user private room (only if session cookie validates)

Connection auth reads `session` cookie from `socket.handshake.headers.cookie`,
extracts the token via `authService.getSessionTokenFromRequest()`, then
validates via `authService.getSessionFromToken(token)`.

### Event Catalog

All events are server-to-client only. No client-to-server events are defined.

| Event | Room | Emitted by |
|-------|------|------------|
| `review:created` | `reviews` | ReviewsService.create() |
| `review:updated` | `reviews` | (defined but not called in production) |
| `review:vote:updated` | `reviews` | ReviewsService.vote(), helpful() |
| `review:comment:count` | `reviews` | CommentsService.create(), update(), remove() |
| `notification:created` | `user:{id}` | NotificationsService.create() |
| `notification:read` | `user:{id}` | NotificationsService.markAsRead() |
| `notification:all-read` | `user:{id}` | NotificationsService.markAllAsRead() |

### Emit Ordering

The ordering invariant for any operation that touches DB and emits events:

1. Complete the database transaction
2. Emit the socket event
3. Create notifications

Emit AFTER the DB transaction completes, never inside it. Create notifications
AFTER socket emissions.

## Verification

```
grep -rn 'globalThis.__socketIO' src/
grep -rn 'emit(' src/socket/
grep -rn "join(" src/socket/
grep -rn 'getSessionFromToken' src/main.ts
```
