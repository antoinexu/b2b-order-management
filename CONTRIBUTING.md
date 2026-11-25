# Contributing

Thanks for your interest in improving B2B Order Management! Bug reports, documentation fixes, tests and features are
all welcome.

## Before you start

- **Bugs:** search [existing issues](https://github.com/antoinexu/b2b-order-management/issues) first, then open a
  bug report with steps to reproduce.
- **Features:** open a feature request before writing a large change, so we can agree on the approach. Small fixes
  can go straight to a pull request.
- **Security issues:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- New to the project? Look for issues labelled
  [`good first issue`](https://github.com/antoinexu/b2b-order-management/labels/good%20first%20issue).

## Development setup

You need Node.js 22 or later. No database or Docker is required for development or tests.

```bash
npm install && npm --prefix web install
npm run dev:memory          # API on :3000, in-memory Postgres with demo data
npm --prefix web run dev    # web app on http://localhost:5173
```

To work against a real PostgreSQL instance, see [Local development](README.md#local-development).

## Checks to run before opening a pull request

CI runs all of these, so running them locally saves a round trip.

API (repository root):

```bash
npm run typecheck
npm test
npm run openapi:export      # then commit docs/openapi.json if it changed
```

Web app (`web/`):

```bash
npm run gen:api             # then commit src/api/schema.d.ts if it changed
npm run lint
npm test
npm run build
npm run e2e                 # Playwright; starts the API and web app itself
```

Concurrency tests run only when `TEST_DATABASE_URL` points at an empty PostgreSQL test database; CI always runs them.

## Making changes

- **API contract:** request and response schemas are Zod schemas registered with the OpenAPI registry. If you change
  an endpoint, regenerate `docs/openapi.json` and the web types (see above), and document new error codes.
- **Database:** edit `src/db/schema.ts`, then run `npm run db:generate` and commit the generated migration in
  `drizzle/`. Never edit a migration that has already been released.
- **Money:** amounts are integer cents and rates are basis points. Do not introduce floating-point arithmetic for money.
- **Tenancy and permissions:** every query must be scoped to the authenticated user's organization, and every new
  action needs a permission in `src/lib/permissions.ts`. Add tests that prove cross-tenant access returns `404` and
  that roles without the permission get `403`.
- **Tests:** add or update tests for every behaviour change. Bug fixes should include a test that fails without the fix.
- **Design decisions:** if a change involves a real trade-off, add a short entry to
  [docs/design-decisions.md](docs/design-decisions.md).
- **Changelog:** add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Commits and pull requests

- Keep each pull request focused on one change.
- Write commit messages as one short line in the imperative mood, e.g. `Add PDF export for orders`.
- Fill in the pull request template, and link the issue it closes (`Closes #123`).
- Be ready for review comments; we aim to respond within a few days.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.
