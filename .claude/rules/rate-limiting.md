---
paths:
  - "src/auth/**"
---
Auth endpoints override the global throttle to 5 req/60s for both tiers using `@Throttle({ short: { limit: 5, ttl: 60000 }, long: { limit: 5, ttl: 60000 } })`. This stricter limit mitigates credential stuffing and brute-force attacks. Maintain it on any new auth endpoints.
