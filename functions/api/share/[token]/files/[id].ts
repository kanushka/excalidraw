import {
  getFileResponse,
  headFileResponse,
  putFile,
} from "../../../../../cloudflare/files";
import { error, isValidId } from "../../../../../cloudflare/http";
import {
  getShareLink,
  isValidToken,
  roomHasFile,
} from "../../../../../cloudflare/shares";

import type { Env, Handler } from "../../../../../cloudflare/types";

// Image files are stored once for all canvases, so a link only reads the
// images its canvas shows, and only edit links upload.

const getLink = async (env: Env, params: { token: string; id: string }) =>
  isValidToken(params.token) && isValidId(params.id)
    ? getShareLink(env, params.token)
    : null;

/** GET /api/share/:token/files/:id */
export const onRequestGet: Handler<"token" | "id"> = async ({
  env,
  params,
}) => {
  const link = await getLink(env, params);
  if (!link || !(await roomHasFile(env, link.canvas_id, params.id))) {
    return error(404, "file not found");
  }
  return getFileResponse(env, params.id);
};

/** HEAD /api/share/:token/files/:id — whether an edit link needs to upload */
export const onRequestHead: Handler<"token" | "id"> = async ({
  env,
  params,
}) => {
  const link = await getLink(env, params);
  if (!link || link.mode !== "edit") {
    return new Response(null, { status: 404 });
  }
  return headFileResponse(env, params.id);
};

/** PUT /api/share/:token/files/:id — edit links only */
export const onRequestPut: Handler<"token" | "id"> = async ({
  request,
  env,
  params,
}) => {
  const link = await getLink(env, params);
  if (!link) {
    return error(404, "link not found");
  }
  if (link.mode !== "edit") {
    return error(403, "this link is read-only");
  }
  return putFile(env, params.id, request);
};
