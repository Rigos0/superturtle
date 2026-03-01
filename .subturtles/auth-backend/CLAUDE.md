## Current Task
All listed auth backend tasks are complete for this loop.

## End Goal with Specs
Convex Auth fully configured with:
- Anonymous auth as working default (no OAuth credentials needed)
- GitHub + Google OAuth providers pre-wired (activate by setting env vars)
- Schema updated with authTables spread
- HTTP routes registered for auth callbacks
- All existing queries/mutations still work (users, posts, likes, comments)
- `npx convex dev --once` succeeds with no errors

## Backlog
- [x] Create `linkedin-demo/src/convex/auth.config.ts` with content:
  ```typescript
  export default {
    providers: [
      {
        domain: process.env.CONVEX_SITE_URL,
        applicationID: "convex",
      },
    ],
  };
  ```
- [x] Create `linkedin-demo/src/convex/auth.ts` with GitHub, Google, and Anonymous providers:
  ```typescript
  import { convexAuth } from "@convex-dev/auth/server";
  import GitHub from "@auth/core/providers/github";
  import Google from "@auth/core/providers/google";
  import { Anonymous } from "@convex-dev/auth/providers/Anonymous";

  export const { auth, signIn, signOut, store } = convexAuth({
    providers: [GitHub, Google, Anonymous],
  });
  ```
- [x] Create `linkedin-demo/src/convex/http.ts`:
  ```typescript
  import { httpRouter } from "convex/server";
  import { auth } from "./auth";
  const http = httpRouter();
  auth.addHttpRoutes(http);
  export default http;
  ```
- [x] Update `linkedin-demo/src/convex/schema.ts`: add `import { authTables } from "@convex-dev/auth/server";` and spread `...authTables` into the defineSchema call (keep all existing tables: users, posts, likes, comments)
- [x] Run `npx convex dev --once` to push functions and verify no errors
- [x] Commit with message "Add Convex Auth backend: anonymous + GitHub + Google providers"

## Notes
- All paths are absolute from repo root: `/Users/Richard.Mladek/Documents/projects/agentic/`
- Convex functions live at `linkedin-demo/src/convex/` (NOT `linkedin-demo/convex/` — this is a CRA app)
- tsconfig at `linkedin-demo/src/convex/tsconfig.json` already has `"moduleResolution": "Bundler"` and `"skipLibCheck": true`
- Packages already installed: `@convex-dev/auth`, `@auth/core@0.37.0`
- Env vars already set on Convex: `SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`
- GitHub/Google OAuth credentials NOT set yet (AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET) — the Anonymous provider works without them
- Run npm commands from `linkedin-demo/` directory
- The convex CLI reads `linkedin-demo/.env.local` for CONVEX_DEPLOYMENT

## Loop Control
STOP
