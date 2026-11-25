## What and why

<!-- What does this change do, and why is it needed? -->

Closes #

## How it was tested

<!-- Tests added or updated, and any manual checks. -->

## Checklist

- [ ] Tests cover the change (bug fixes include a test that fails without the fix)
- [ ] `npm run typecheck` and `npm test` pass
- [ ] If the API contract changed: `docs/openapi.json` and `web/src/api/schema.d.ts` are regenerated
- [ ] If the schema changed: a migration is generated in `drizzle/`
- [ ] New queries are scoped to the organization, and new actions have a permission
- [ ] User-visible changes are noted under `Unreleased` in `CHANGELOG.md`
