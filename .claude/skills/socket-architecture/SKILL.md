---
name: socket-architecture
description: "Socket.IO room structure, event catalog, globalThis pattern, connection auth"
---

> Source of truth: `src/socket/socket.service.ts` and `src/main.ts`. Run `grep -rn 'emit(' src/socket/` to see the current event catalog.

## Architecture

Socket.IO is NOT a NestJS `@WebSocketGateway`. It is created manually in `main.ts` after `app.listen()` and stored on `globalThis.__socketIO`. SocketService (global module) reads from this global. If undefined (tests, pre-bootstrap), all emit methods are no-ops.

## Room Structure

On connection, every socket auto-joins:
- `'reviews'` — broadcast room for all review-related updates
- `'user:{id}'` — per-user private room (only if session cookie validates)

Connection auth reads `session` cookie from `socket.handshake.headers.cookie`, calls `authService.getSessionFromToken()`.

## Event Patterns

All events are server → client only (push architecture). No client → server events are defined.

Events are emitted from SocketService methods, called by feature services. The pattern: complete the database transaction first, then emit the socket event, then create notifications. Check `src/socket/socket.service.ts` for all available emit methods.
