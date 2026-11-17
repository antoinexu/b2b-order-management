# B2B Order Management API

[![CI](https://github.com/antoinexu/b2b-order-management/actions/workflows/ci.yml/badge.svg)](https://github.com/antoinexu/b2b-order-management/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-tenant B2B order management backend: customer management, product catalog, quotes with a full
approval lifecycle, quote-to-order conversion, order fulfilment tracking and role-based access control.

**Stack:** TypeScript · Node.js · Express 5 · PostgreSQL · Drizzle ORM · Zod · JWT · OpenAPI 3 (Swagger UI) · Vitest · Docker

## Features

- **Multi-tenancy:** each organization's data is fully isolated; cross-tenant access returns `404`.
- **Authentication:** register an organization, log in with email/password (scrypt hashes), JWT bearer tokens.
- **RBAC:** four roles with a permission matrix. Role changes and user removal take effect immediately, without waiting for the token to expire.
- **Customers & products:** CRUD, search, pagination, per-tenant unique SKUs.
- **Quotes:** draft → sent → accepted / rejected / expired, line-item discounts, tax, sequential numbers (`Q-000001`).
- **Orders:** created directly or converted from an accepted quote (at most once per quote), with lifecycle
  pending → confirmed → shipped → delivered (or cancelled) and a full status history.
- **Correct money math:** integer cents and basis points, so totals have no floating-point drift. Prices are copied onto
  each line item, so later catalog changes never alter existing quotes or orders.
- **Concurrency-safe:** status transitions lock their rows inside transactions; document numbers are allocated atomically.
- **API contract:** OpenAPI 3 generated from the same Zod schemas that validate requests, so the docs can't drift from the code.
- **Tests:** unit and integration tests cover business flows, security boundaries and database upgrades using PGlite (an in-process Postgres engine).
  You don't need Docker to run them.

## Quick start

### With Docker (API + PostgreSQL)

Copy `.env.example` to `.env` and replace `JWT_SECRET` with a unique random secret of at least 32 characters.
Generate one with `openssl rand -hex 48`, or the Node command in `.env.example`.
Compose requires the variable; the production API also rejects the repository's example secrets.

```bash
docker compose up --build
```

- API: http://localhost:3000/api/v1
- Swagger UI: http://localhost:3000/docs
- Health: http://localhost:3000/health

Database migrations run automatically on startup.

### Local development

```bash
npm install
cp .env.example .env          # then point DATABASE_URL at a Postgres instance
docker compose up -d db       # or use any local PostgreSQL
npm run dev                   # http://localhost:3000, auto-reload
npm run db:seed               # optional demo data
```

Local commands load `.env` automatically; variables already set in the shell or container take priority.
The application requires Node.js 22 or later.

Demo users created by the seed script (password `Password123!`):
`admin@acme.example`, `manager@acme.example`, `sales@acme.example`, `viewer@acme.example`.

## Deployment

The live demo runs on [Render](https://render.com) (Docker web service) with a [Neon](https://neon.tech) serverless Postgres database, both on free tiers.

1. Create a Neon project and copy its connection string.
2. In Render, choose **New → Blueprint** and select this repository. [`render.yaml`](render.yaml) defines the service.
3. Paste the Neon connection string as `DATABASE_URL`. Render generates `JWT_SECRET` automatically.

Migrations run on startup. Render redeploys after CI passes on `main`.
The free instance sleeps when idle, so the first request after a while can take about a minute.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the API with auto-reload |
| `npm test` | Run the full test suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run db:generate` | Generate a SQL migration after editing `src/db/schema.ts` |
| `npm run db:seed` | Insert demo data |
| `npm run openapi:export` | Write the API contract to `docs/openapi.json` |

## Roles & permissions

| Permission | admin | manager | sales | viewer |
| --- | :-: | :-: | :-: | :-: |
| Read customers, products, quotes, orders | ✅ | ✅ | ✅ | ✅ |
| Create / edit customers | ✅ | ✅ | ✅ | |
| Delete customers | ✅ | ✅ | | |
| Manage product catalog & pricing | ✅ | ✅ | | |
| Create / send / accept quotes | ✅ | ✅ | ✅ | |
| Create orders, convert quotes | ✅ | ✅ | ✅ | |
| Change order status (fulfilment) | ✅ | ✅ | | |
| View users | ✅ | ✅ | | |
| Manage users & roles | ✅ | | | |

The matrix lives in [`src/lib/permissions.ts`](src/lib/permissions.ts).

## API overview

All endpoints are under `/api/v1`. Full request and response schemas are in Swagger UI at `/docs`, or in `docs/openapi.json`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Users | `GET/POST /users`, `PATCH/DELETE /users/{id}` |
| Customers | `GET/POST /customers`, `GET/PATCH/DELETE /customers/{id}` |
| Products | `GET/POST /products`, `GET/PATCH/DELETE /products/{id}` |
| Quotes | `GET/POST /quotes`, `GET/PATCH/DELETE /quotes/{id}`, `POST /quotes/{id}/send`, `/accept`, `/reject`, `/convert` |
| Orders | `GET/POST /orders`, `GET /orders/{id}`, `POST /orders/{id}/status` |

Errors share one shape:

```json
{ "error": { "code": "INVALID_STATE", "message": "Cannot change order status from 'pending' to 'delivered'" } }
```

Customer, product and user PATCH requests must contain at least one recognized update field; empty or
unknown-only objects return `400 VALIDATION_ERROR`.

`DELETE /users/{id}` deactivates the account: old tokens and password login stop working, and the user
is hidden from user lists. Quotes, orders and status history keep their author references. Deactivated
users cannot be edited through this API, and their email remains reserved to the original account.

Prices, line totals, subtotals, tax and document totals must each fit in `0..2147483647` cents.
Inputs or calculated amounts outside this range return `400`; failed writes leave existing documents unchanged.

### Example flow

```bash
API=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"organizationName":"Acme","name":"Ada","email":"ada@acme.example","password":"Password123!"}' | jq -r .token)
AUTH="Authorization: Bearer $TOKEN"

CUSTOMER=$(curl -s -X POST $API/customers -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"companyName":"Summit Manufacturing"}' | jq -r .id)

QUOTE=$(curl -s -X POST $API/quotes -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUSTOMER\",\"taxRateBps\":825,\"items\":[{\"description\":\"Hex bolts (box)\",\"quantity\":10,\"unitPriceCents\":2450,\"discountBps\":1000}]}" | jq -r .id)

curl -s -X POST $API/quotes/$QUOTE/send    -H "$AUTH"
curl -s -X POST $API/quotes/$QUOTE/accept  -H "$AUTH"
curl -s -X POST $API/quotes/$QUOTE/convert -H "$AUTH" -H 'Content-Type: application/json' -d '{"poNumber":"PO-1001"}'
```

## Project structure

```
src/
  app.ts               Express app factory (dependency-injected DB, used by server and tests)
  server.ts            Entry point: migrate, listen, graceful shutdown
  config.ts            Environment validation (Zod)
  db/                  Drizzle schema, client, seed script
  lib/                 Errors, pricing math, permissions, password hashing, OpenAPI registry
  middleware/          Authentication, RBAC, error handling
  modules/             auth, users, customers, products, quotes, orders, shared line-item logic
drizzle/               SQL migrations (generated, committed)
tests/                 Vitest + Supertest suites on PGlite (in-process Postgres)
```

## Design decisions

- **Integer money.** Amounts are stored in cents and rates in basis points (`825` = 8.25%), with rounding done once per line and once for tax.
- **Exact calculation and storage limits.** BigInt intermediates preserve integer precision before rounding; values are checked against the database's 32-bit money limit before writes.
- **Account removal preserves history.** A nullable `deleted_at` timestamp disables access without deleting users referenced by business records. Startup applies the additive migration to existing databases.
- **Credential-safe logging.** Request logs remove authorization and cookie headers, including response cookies.
- **Brute-force protection.** Login and registration are rate limited per IP (`429 RATE_LIMITED`). Only failed logins count toward the limit. Unknown emails still go through scrypt, so response time doesn't reveal which accounts exist. The limiter keeps its counts in memory; with several instances it would need a shared store such as Redis.
- **Honest health checks.** `/health` returns `503` when the database is unreachable, so container orchestrators and load balancers take the instance out of rotation.
- **Prices copied onto line items.** Each line item stores its own description and unit price, so a quote or order reads the same forever.
- **The tenant comes from the server, never the client.** The organization is resolved from the authenticated user on every request and added to every query.
- **Explicit state machines.** Quote and order transitions are declared in code, run inside a transaction with a row lock, and invalid moves return `409 INVALID_STATE`.
- **Testing against real Postgres semantics.** PGlite runs the real migrations, so constraints, enums and transactions behave the same in tests as in production.

## Roadmap

- [ ] **AI RFQ parsing:** `POST /rfqs/parse` accepts a free-text or emailed Request for Quote, uses an LLM with
      structured output to extract the customer, items and quantities, matches them to catalog SKUs, and returns a
      draft quote for a person to review before sending.
- [ ] Audit log of all write operations
- [ ] PDF export for quotes and orders
- [ ] Refresh tokens and password reset
- [ ] Frontend dashboard

## License

[MIT](LICENSE)
