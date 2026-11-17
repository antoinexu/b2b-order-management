# B2B Order Management — Web

React + Vite frontend for the [B2B Order Management API](../README.md).

```bash
npm install
npm run dev:memory --prefix ..   # API with demo data on :3000 (no database needed)
npm run dev                      # http://localhost:5173
```

## How it talks to the API

- `src/api/schema.d.ts` is generated from `../docs/openapi.json` (`npm run gen:api`); never edit it by hand.
- `src/api/client.ts` wraps `openapi-fetch` with bearer-token auth, sign-out on `401`, and a typed `ApiError`.
- In development, Vite proxies `/api` to `http://localhost:3000`. For production builds set `VITE_API_URL`
  (see `.env.example`) and allow the web origin in the API's `CORS_ORIGIN`.

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
