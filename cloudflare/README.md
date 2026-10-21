# Self-hosting on Cloudflare with multiple canvases

This fork can keep any number of canvases on the server instead of excalidraw.com's single canvas per browser. It runs entirely on Cloudflare:

| Part | Cloudflare product | Where |
| --- | --- | --- |
| App (static build) | Pages | `excalidraw-app/build` |
| Canvas API | Pages Functions | `functions/api`, helpers in `cloudflare/` |
| Canvas list | D1 database `excalidraw` | `cloudflare/schema.sql` |
| Scenes and images | R2 bucket `excalidraw-canvases` | `canvases/<id>.excalidraw`, `files/<fileId>` |
| Share links | D1 table `share_links` | `cloudflare/schema.sql` |
| Live collaboration | Durable Object `CanvasRoom` in the Worker `excalidraw-collab` | `cloudflare/collab` |
| Login | Zero Trust Access | dashboard |

The app turns multiple canvases on when it's built with `VITE_APP_CANVAS_API_URL` set; `.env.production` sets it to `/api`. Without it the app behaves like excalidraw.com.

## Share links and live collaboration

Every canvas is live: everyone who has it open (you in several tabs or devices, and the people you share it with) is in the canvas's room and sees changes as they happen. The room is a Durable Object per canvas; it relays changes and cursors and saves the canvas to R2 about a second after each change, so while a canvas is live the app doesn't save it itself.

The share button creates links for the open canvas, either **Can view** or **Can edit**, and lists and turns off existing ones. A link is a random token (`#share=<token>`) stored in D1. It works without an Access login and only for its canvas: it opens that canvas, its images, and its room, and nothing else. Read-only links are enforced by the room, which drops scene changes from viewers. Turning a link off, or deleting the canvas, disconnects the people using it.

This replaces excalidraw.com's live collaboration (its socket server and Firebase) and its "shareable link" snapshots, which don't work for a self-hosted copy. Messages to the room aren't end-to-end encrypted, unlike excalidraw.com's rooms, since the room has to read them to enforce read-only links and save the canvas; they're sent over TLS to your own Cloudflare account, like the canvases themselves.

## API

All routes except `/api/share/*` need a valid Cloudflare Access token (or `ALLOW_UNAUTHENTICATED` for local development).

| Route | Does |
| --- | --- |
| `GET /api/canvases` | list canvases, most recently edited first |
| `POST /api/canvases` `{ id, name }` | create a canvas |
| `GET /api/canvases/:id` | the scene JSON; the name is in `x-canvas-name` |
| `PUT /api/canvases/:id` | save the scene JSON |
| `PATCH /api/canvases/:id` `{ name }` | rename |
| `DELETE /api/canvases/:id` | soft delete (row keeps `deleted_at`, scene stays in R2) |
| `GET`, `HEAD`, `PUT /api/files/:fileId` | image files as Excalidraw `BinaryFileData` JSON |
| `GET /api/canvases/:id/room` | WebSocket: the canvas's live room |
| `GET /api/canvases/:id/links` | the canvas's share links |
| `POST /api/canvases/:id/links` `{ mode: "view" \| "edit" }` | create a share link |
| `DELETE /api/links/:token` | turn a share link off |

Share link routes are authorized by the token alone:

| Route | Does |
| --- | --- |
| `GET /api/share/:token` | the canvas's name and the link's mode |
| `GET /api/share/:token/room` | WebSocket: the canvas's live room, read-only for view links |
| `GET /api/share/:token/files/:fileId` | an image shown on the canvas |
| `HEAD`, `PUT /api/share/:token/files/:fileId` | upload an image (edit links) |

## One-time setup

1. The R2 bucket and D1 database are already referenced in `wrangler.toml`.
2. Create an API token (My Profile > API Tokens > Create Token > Custom) with **Account > Cloudflare Pages > Edit**, **Account > D1 > Edit** and **Account > Workers Scripts > Edit** (for the live collaboration Worker).
3. In GitHub, add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings > Secrets and variables > Actions).
4. Push to `master` (or run the "Deploy to Cloudflare Pages" workflow). The first run creates the Pages project `excalidraw`, served at `https://excalidraw-<suffix>.pages.dev`.
5. Protect it with Access: Zero Trust > Access > Applications > Add an application > Self-hosted. Add the `*.pages.dev` hostname of the project (and your custom domain, if any), and a policy "Allow" with your email.
6. Copy the application's **AUD tag** and your **team domain** (`<team>.cloudflareaccess.com`) into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, and push. Until then the API refuses all requests.
7. For share links, pick a hostname for the people you share with that Access doesn't cover, since they can't log in: add a custom domain to the Pages project (Workers & Pages > excalidraw > Custom domains), e.g. `share-excalidraw.example.com`, and leave it out of the Access application (if an Access application covers a wildcard such as `*.example.com`, add one for this hostname with a **Bypass** policy for Everyone). Set `SHARE_ORIGIN` in `wrangler.toml` to it, e.g. `https://share-excalidraw.example.com`, and push. On that hostname anyone can load the app itself, but the canvas API still needs your Access login for everything except the share link routes, which only reach the link's canvas.

The deploy workflow deploys the live collaboration Worker (`cloudflare/collab/wrangler.toml`) before the Pages project, which binds to its Durable Object. If the room can't be reached, canvases still load and save, just not live.

## Local development

```sh
VITE_APP_CANVAS_API_URL=/api yarn build:app:docker
npx wrangler d1 execute excalidraw --local --file=cloudflare/schema.sql
# live collaboration rooms, in a second terminal
npx wrangler dev -c cloudflare/collab/wrangler.toml --port 8790
npx wrangler pages dev --binding ALLOW_UNAUTHENTICATED=true
```

`ALLOW_UNAUTHENTICATED` only applies while `ACCESS_AUD` is empty, so clear it in a local copy of `wrangler.toml`.
