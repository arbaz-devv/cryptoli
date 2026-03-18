---
paths:
  - "src/socket/**"
  - "src/**/services/**"
---
Socket.IO is push-only (server -> client). No client -> server events are defined.

Emit socket events AFTER the database transaction completes, never inside it. Create notifications AFTER socket emissions.

All SocketService methods no-op when `globalThis.__socketIO` is undefined (tests, pre-bootstrap). Do not add null checks in calling code — SocketService handles this internally.
