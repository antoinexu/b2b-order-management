# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-25

First public release.

### Added

- Multi-tenant REST API (Express 5, PostgreSQL, Drizzle ORM) with organization registration, JWT authentication and
  per-user token revocation on password change.
- Role-based access control with admin, manager, sales and viewer roles; role changes and user removal take effect
  immediately.
- Team invitations and password reset by email through single-use links, with only token hashes stored.
- Customers and product catalog with search, pagination and per-tenant unique SKUs.
- Quotes with line-item discounts, tax, sequential numbers and a draft → sent → accepted / rejected / expired
  lifecycle, with expiry evaluated in the organization's time zone and a full status history.
- Sales discount limit and base-currency pricing policy; custom line items restricted to managers and admins.
- Quote PDF download with multi-page layout and status watermarks.
- Emailing quotes to customers with online acceptance or rejection, durable and idempotent delivery records, and
  `410 QUOTE_CHANGED` for outdated links.
- Orders created directly or converted from accepted quotes, with a fulfilment lifecycle and status history.
- Integer money math (cents and basis points) with range checks, and row locking for concurrent status changes.
- OpenAPI 3 contract generated from the Zod validation schemas, with Swagger UI.
- React web app with typed API client generated from the contract and a role-aware UI.
- Vitest suites on PGlite, Postgres concurrency tests, Playwright end-to-end tests, CI, Docker image and Render
  deployment blueprint.
- Design decisions document describing the alternatives considered and trade-offs.
- Contributing guide, security policy, code of conduct, and issue and pull request templates.

[Unreleased]: https://github.com/antoinexu/b2b-order-management/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/antoinexu/b2b-order-management/releases/tag/v1.0.0
