# Self-hosting on Cloudflare with multiple canvases

This fork can keep any number of canvases on the server instead of excalidraw.com's single canvas per browser. It runs entirely on Cloudflare:

| Part | Cloudflare product | Where |
| --- | --- | --- |
| App (static build) | Pages | `excalidraw-app/build` |
| Canvas API | Pages Functions | `functions/api`, helpers in `cloudflare/` |
| Canvas list | D1 database `excalidraw` | `cloudflare/schema.sql` |
| Scenes and images | R2 bucket `excalidraw-canvases` | `canvases/<id>.excalidraw`, `files/<fileId>` |
| Login | Zero Trust Access | dashboard |

The app turns multiple canvases on when it's built with `VITE_APP_CANVAS_API_URL` set (the deploy workflow sets it to `/api`). Without it the app behaves like excalidraw.com.

## API

All routes need a valid Cloudflare Access token (or `ALLOW_UNAUTHENTICATED` for local development).

| Route | Does |
| --- | --- |
| `GET /api/canvases` | list canvases, most recently edited first |
| `POST /api/canvases` `{ id, name }` | create a canvas |
| `GET /api/canvases/:id` | the scene JSON; the name is in `x-canvas-name` |
| `PUT /api/canvases/:id` | save the scene JSON |
| `PATCH /api/canvases/:id` `{ name }` | rename |
| `DELETE /api/canvases/:id` | soft delete (row keeps `deleted_at`, scene stays in R2) |
| `GET`, `HEAD`, `PUT /api/files/:fileId` | image files as Excalidraw `BinaryFileData` JSON |

## One-time setup

1. The R2 bucket and D1 database are already referenced in `wrangler.toml`.
2. Create an API token (My Profile > API Tokens > Create Token > Custom) with **Account > Cloudflare Pages > Edit** and **Account > D1 > Edit**.
3. In GitHub, add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings > Secrets and variables > Actions).
4. Push to `master` (or run the "Deploy to Cloudflare Pages" workflow). The first run creates the Pages project `excalidraw`, served at `https://excalidraw-<suffix>.pages.dev`.
5. Protect it with Access: Zero Trust > Access > Applications > Add an application > Self-hosted. Add the `*.pages.dev` hostname of the project (and your custom domain, if any), and a policy "Allow" with your email.
6. Copy the application's **AUD tag** and your **team domain** (`<team>.cloudflareaccess.com`) into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, and push. Until then the API refuses all requests.

## Local development

```sh
VITE_APP_CANVAS_API_URL=/api yarn build:app:docker
npx wrangler d1 execute excalidraw --local --file=cloudflare/schema.sql
npx wrangler pages dev --binding ALLOW_UNAUTHENTICATED=true
```
