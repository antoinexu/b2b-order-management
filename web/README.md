# B2B Order Management — Web

React + Vite frontend for the [B2B Order Management API](../README.md).

```bash
npm install
npm run dev:memory --prefix ..   # API with demo data on :3000 (no database needed)
npm run dev                      # http://localhost:5173
```

## How it talks to the API

- `src/api/schema.d.ts` is generated from `../docs/openapi.json` (`npm run gen:api`); never edit it by hand.
- `src/api/client.ts` creates a typed client for each session. Requests use the token belonging to the rendered account; requests and responses from superseded sessions are discarded.
- Account changes synchronize across tabs, abort old requests, and reset the page, forms and query cache. An old `401` cannot sign out a newly logged-in account.
- If the current-account lookup fails, the page offers retry and sign-out instead of staying on a loading skeleton.
- In development, Vite proxies `/api` to `http://localhost:3000`. For production builds set `VITE_API_URL`
  (see `.env.example`) and allow the web origin in the API's `CORS_ORIGIN`.

## Editing documents

- Customer and product pickers search through the API and offer **Load more** for additional pages. Existing selections are loaded by ID, including records outside the first page.
- Money inputs and calculated totals use the API's limit of `2147483647` cents. Quantities must be whole numbers between `1` and `1000000`; invalid values show errors and disable saving.
- Editing a quote preserves its currency in the preview and saved document.
- Customer and product lists automatically return to a valid page after deletion.

## Checks

```bash
npm test
npm run lint
npm run build
npm run e2e
```

End-to-end tests use dedicated local API and Vite ports (`43001` and `45173`) and an in-memory database.
Set `E2E_API_PORT` and `E2E_WEB_PORT` to override them. The test API allows enough registrations for
isolated test organizations; application rate-limit defaults remain unchanged.

## Structure

```
src/
  api/          generated types, typed client, shared type aliases
  auth/         session state, current user and permissions
  components/   app components (layout, editor, tables) and shadcn/ui primitives in ui/
  lib/          money/date formatting and client-side price preview
  pages/        route screens
  router.tsx    routes, auth and permission guards, lazy loading
e2e/            Playwright end-to-end tests
```
