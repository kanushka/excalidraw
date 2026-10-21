// Share links and live collaboration rooms.
//
// A share link is a random token in D1 (`share_links`) that opens one canvas,
// read-only ("view") or editable ("edit"). The `/api/share/:token/*` routes
// skip Cloudflare Access and accept only the token, so a link never reaches
// any other canvas. Every canvas has one live room (a Durable Object in
// cloudflare/collab) that the owner and the link holders join.

import { error } from "./http";

import type { Env } from "./types";

export type ShareMode = "view" | "edit";
export type RoomRole = "owner" | ShareMode;

export type ShareLinkRow = {
  token: string;
  canvas_id: string;
  mode: ShareMode;
  created_at: number;
};

const TOKEN_RE = /^[a-zA-Z0-9_-]{32,64}$/;

export const isValidToken = (token: unknown): token is string =>
  typeof token === "string" && TOKEN_RE.test(token);

export const isShareMode = (mode: unknown): mode is ShareMode =>
  mode === "view" || mode === "edit";

/** 24 random bytes, base64url (32 characters) */
export const generateToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** the active link with its canvas, or `null` if revoked or the canvas is gone */
export const getShareLink = (env: Env, token: string) =>
  env.DB.prepare(
    `SELECT l.token, l.canvas_id, l.mode, l.created_at, c.name
     FROM share_links l JOIN canvases c ON c.id = l.canvas_id
     WHERE l.token = ? AND l.revoked_at IS NULL AND c.deleted_at IS NULL`,
  )
    .bind(token)
    .first<ShareLinkRow & { name: string }>();

export const getShareUrl = (env: Env, request: Request, token: string) => {
  const origin = (env.SHARE_ORIGIN || new URL(request.url).origin).replace(
    /\/+$/,
    "",
  );
  return `${origin}/#share=${token}`;
};

export const toShareLinkMeta = (
  env: Env,
  request: Request,
  row: ShareLinkRow,
) => ({
  token: row.token,
  mode: row.mode,
  createdAt: row.created_at,
  url: getShareUrl(env, request, row.token),
});

const getRoom = (env: Env, canvasId: string) =>
  env.ROOMS ? env.ROOMS.get(env.ROOMS.idFromName(canvasId)) : null;

/** passes a WebSocket upgrade on to the canvas's room */
export const connectToRoom = (
  env: Env,
  request: Request,
  room: { canvasId: string; role: RoomRole; token: string | null },
) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return error(426, "expected a WebSocket upgrade");
  }
  const stub = getRoom(env, room.canvasId);
  if (!stub) {
    return error(503, "live collaboration is not deployed");
  }
  const headers = new Headers(request.headers);
  headers.set("x-canvas-id", room.canvasId);
  headers.set("x-room-role", room.role);
  headers.set("x-room-token", room.token || "");
  return stub.fetch(new Request("https://room/connect", { headers }));
};

/** whether the canvas (as its room currently has it) shows this image */
export const roomHasFile = async (
  env: Env,
  canvasId: string,
  fileId: string,
) => {
  const stub = getRoom(env, canvasId);
  if (!stub) {
    return false;
  }
  const res = await stub.fetch(
    `https://room/has-file?id=${encodeURIComponent(fileId)}`,
    { headers: { "x-canvas-id": canvasId } },
  );
  return res.ok;
};

/**
 * disconnects the room's guests: those using `token`, or all link holders
 * when no token is given (the canvas was deleted)
 */
export const disconnectGuests = async (
  env: Env,
  canvasId: string,
  token?: string,
) => {
  const stub = getRoom(env, canvasId);
  if (!stub) {
    return;
  }
  try {
    await stub.fetch("https://room/disconnect", {
      method: "POST",
      headers: { "x-canvas-id": canvasId, "content-type": "application/json" },
      body: JSON.stringify({ token: token ?? null }),
    });
  } catch (err) {
    // the D1 row already blocks the link; open sockets close on reconnect
    console.error("failed to disconnect guests", err);
  }
};
