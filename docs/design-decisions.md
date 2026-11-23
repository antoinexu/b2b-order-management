# Design decisions

The README's [Design decisions](../README.md#design-decisions) section says *what* the system does. This document
records *why*: the problem behind each decision, the alternatives that were considered, and the costs that were
accepted. Each entry is short enough to explain in a couple of minutes.

## 1. Tenant isolation in the application layer

**Context.** Every organization's customers, products, quotes and orders share the same tables. A single query
that forgets the tenant filter leaks another company's data.

**Decision.** The organization is never taken from the client. It comes from the authenticated user, which
`src/middleware/auth.ts` loads from the database on every request, and every query adds `organization_id`.
A record in another tenant answers `404`, not `403`, so callers can't tell whether it exists.

**Alternatives.**

- *Postgres row-level security.* This is enforced by the database even when application code is wrong. However,
  it needs a per-request session variable (`SET app.org_id`) on pooled connections, which is easy to get subtly
  wrong, and it makes tests and migrations harder to reason about.
- *Schema or database per tenant.* This gives the strongest isolation, but migrations run N times, connection
  counts grow with tenants, and cross-tenant operations such as global email uniqueness become awkward.

**Trade-off.** Isolation depends on code discipline, so it is backed by tests: `tests/rbac.test.ts` and
`tests/regressions.test.ts` try to read and write across tenants. RLS remains a good second layer if the data
becomes more sensitive.

## 2. Money as integers: cents and basis points

**Context.** `0.1 + 0.2 !== 0.3` in JavaScript. With floats, a quote's total can drift by a cent from the sum of
its lines, and the drift can differ between the browser and the server.

**Decision.** Amounts are stored as integer cents and rates as basis points (`825` = 8.25%). Intermediate
products use `BigInt` (`src/lib/pricing.ts`), and rounding happens exactly once per line and once for tax.
Results are checked against Postgres's 32-bit integer limit before writing. The web app's live preview uses the
same algorithm, so the total on screen is the total saved.

**Alternatives.**

- *`numeric` columns plus a decimal library* such as decimal.js. This is exact and supports any precision, but
  every layer needs the library, JSON carries strings, and it is easy to drop back into floats by accident.
- *Floats with rounding at display time.* This is the source of the bug, not a fix.

**Trade-off.** Only currencies with two decimal places are accepted. JPY (0 decimals) and KWD (3 decimals) would
need a per-currency minor-unit exponent. The 32-bit limit (about 21 million in a currency) is a deliberate cap,
and widening to `bigint` columns is a migration.

## 3. Line items copy their prices

**Context.** Catalog prices change. A quote sent last month must still show what the customer was offered.

**Decision.** Each line item stores its own description, unit price and discount at the time it was written.
The product reference is kept only for linking.

**Alternative.** Join to the live catalog and keep a price history table. This is more normalized, but every read
becomes a temporal query, and a bug in it silently changes signed documents.

**Trade-off.** Data is duplicated on purpose. The discount limit (see 7) still needs the catalog price, so it is
re-checked whenever a line, the customer or the currency changes.

## 4. Explicit state machines with row locks

**Context.** Two people can act on the same quote at once: one converts it to an order while another rejects it,
or two people convert it simultaneously.

**Decision.** The allowed transitions are declared in code (for example `ORDER_TRANSITIONS` in
`src/modules/orders.ts`). Each transition runs in a transaction that first takes the row with `SELECT … FOR UPDATE`,
re-checks the current status, then writes the new status and a history row. Invalid moves return
`409 INVALID_STATE`. Converting a quote is limited to once per quote, and the database enforces this as well.

**Alternatives.**

- *Optimistic concurrency* (a `version` column with `UPDATE … WHERE version = ?`). This avoids holding locks but
  pushes retries to the client. Contention per quote is tiny, so a short pessimistic lock is simpler.
- *Serializable isolation everywhere.* This is correct but produces serialization failures that every endpoint
  would have to retry.

**Trade-off.** Locks are held only for the length of one small transaction. `tests/concurrency.test.ts` races
real requests against a real Postgres server in CI, because PGlite is single-connection and cannot reproduce
races.

## 5. Document numbers from a per-tenant counter

**Context.** Businesses expect gap-free, human-friendly numbers (`Q-000001`, `SO-000001`) that count separately
for each organization.

**Decision.** `organizations.quote_seq` and `order_seq` are incremented with
`UPDATE … SET seq = seq + 1 RETURNING seq` inside the same transaction that creates the document
(`nextDocumentNumber` in `src/modules/line-items.ts`). The row lock serializes allocation per tenant, and a
rollback releases the number.

**Alternatives.**

- *A Postgres `SEQUENCE` per tenant.* This creates many database objects, and sequences are non-transactional, so
  rolled-back inserts leave gaps.
- *`MAX(number) + 1`.* This races without a lock.

**Trade-off.** Document creation is serialized within one organization, which is fine at B2B volumes.

## 6. Quote expiry is derived on read, not scheduled

**Context.** A sent quote stops being valid after its `validUntil` date. Something has to make it "expired".

**Decision.** Nothing writes the change on a schedule. Reads compute the effective status (`effectiveStatus` in
`src/modules/quotes.ts`), and the list filters use the same rule in SQL, so a stale "sent" quote never appears
anywhere. The stored status changes only when someone acts on the quote, for example when an acceptance fails
because the quote has expired. `validUntil` is a calendar date compared with today's date in the organization's
IANA time zone, so a quote is valid through the end of that day where the business operates.

**Alternatives.**

- *A cron job that flips statuses.* This needs a worker, a schedule and monitoring. Between runs the data is
  wrong, and changing an organization's time zone would require a rescan.
- *A database trigger.* Triggers fire on writes, but expiry happens when time passes with no write at all.

**Trade-off.** Lazy expiry is not written to the status history, because no event happened. The rule must live in
both the TypeScript function and the SQL filter, and tests keep the two in agreement.

## 7. Pricing policy enforced on the server

**Context.** Sales reps should not be able to give away margin. The UI can hide controls, but the API is public.

**Decision.** Users without the `pricing:override` permission may take at most `max_discount_bps` (20% by
default) off the catalog price. Price cuts and discounts count together, so lowering the unit price is not a way
around the limit. Sales reps may only use catalog lines and the organization's base currency, because a custom
line or a foreign currency has no catalog price to measure against. A manager-approved price is re-checked if the
quote later moves to another customer or currency.

**Alternative.** Approval workflows, where a rep requests a bigger discount and a manager approves it. This is
more flexible but adds states, notifications and UI. A hard limit with manager override covers the common case
first.

**Trade-off.** Reps who need an exception must ask a manager to edit the quote.

## 8. Quote emails: durable records, idempotency and versioned links

**Context.** Emailing a quote calls an external provider that can time out, fail, or succeed after the process
dies. The customer must receive exactly the quote the system says it sent, and must never act on an outdated
version.

**Decision.**

- A `quote_deliveries` row is written in `sending` state *before* the provider is called. It stores snapshots of
  the recipient, message, email body and PDF. Only the provider's acceptance marks the row `sent` (and a draft
  quote `sent`). An error marks it `failed` with the reason.
- `POST /quotes/{id}/deliveries` requires an `Idempotency-Key`. A unique index makes a repeated key return the
  original delivery, even for simultaneous requests.
- While a delivery is `sending`, the quote cannot be edited. An attempt stuck in `sending` longer than a lease
  (5 minutes) can be retried, and an attempt that outlived its lease cannot overwrite a newer attempt's outcome.
- Each attempt gets a new link token. A link only works for the version of the quote its email described. Older
  links answer `410 QUOTE_CHANGED` without revealing the new version.

**Alternatives.**

- *Send inline and hope.* Retries can double-send, and a crash leaves no record.
- *Transactional outbox with a background worker.* This retries automatically and is the standard answer at
  scale. It needs a worker process, a queue or a polling loop, and monitoring, and the project deploys as a single
  free-tier web service.

**Trade-off.** Retries are manual. If the process crashes after the provider accepted a message but before the
outcome was saved, a later retry can send it twice. Avoiding that needs the provider's own idempotency key.
Moving to an outbox worker is the next step if volume grows.

## 9. JWTs that can be revoked

**Context.** Plain JWTs are valid until they expire. Changing a password, changing a user's role or removing a
user must take effect immediately.

**Decision.** Each token carries the user's `token_version`, and the auth middleware loads the user on every
request. Changing or resetting a password increments the version, which revokes every earlier token. Because the
role and the deleted flag are read fresh each time, role changes and removals also apply on the next request. The
algorithm is pinned to HS256 on both sign and verify.

**Alternatives.**

- *Stateless JWTs with short lifetimes plus refresh tokens.* This saves a database read per request, but a role
  change waits for the access token to expire, and refresh-token rotation is its own subsystem.
- *Server-side sessions.* This is equally revocable, but it needs a session store, and it gives up the stateless
  bearer token that API clients expect.

**Trade-off.** Every request costs one primary-key lookup. Refresh tokens are on the roadmap.

## 10. Contract-first types: Zod → OpenAPI → client

**Context.** In a split frontend and backend, the usual failure is that the API changes and the UI breaks in
production.

**Decision.** The Zod schemas that validate requests also generate `docs/openapi.json`. The web app generates its
types from that document (`openapi-typescript` + `openapi-fetch`). CI fails if the committed OpenAPI document or
the generated types are out of date.

**Alternatives.**

- *Hand-written OpenAPI.* It drifts from the code.
- *tRPC or a shared TypeScript package.* This gives tight types, but there is no language-neutral contract for
  other clients, mocks or documentation.

**Trade-off.** Some schema code exists purely to describe responses for the documentation.

## 11. Tests on PGlite, races on real Postgres

**Context.** Mocked repositories don't catch real constraint, enum or transaction behaviour, but requiring Docker
for every test run slows everyone down.

**Decision.** Integration tests run the real migrations on PGlite, an in-process Postgres engine, so `npm test`
needs no setup. Concurrency tests need multiple connections, so they run against a real Postgres service in CI,
or locally when `TEST_DATABASE_URL` is set.

**Trade-off.** Two database targets exist. PGlite can differ from server Postgres at the edges, which is why
anything that involves concurrency is tested on the real server.

## Known limitations

These are deliberate scope cuts, not oversights:

- The login rate limiter counts attempts in memory. Running several instances would need a shared store such as
  Redis.
- Quote PDFs use the standard PDF fonts. Chinese and other non-Latin scripts show as `?` until a font that covers
  them is embedded.
- Each email address belongs to exactly one organization (`users_email_uq`). One person working for several
  tenants would need a membership table.
- There is no general audit log yet. Quote and order status changes are recorded.
