import { error, json } from "../../../../cloudflare/http";
import { getShareLink, isValidToken } from "../../../../cloudflare/shares";

import type { Handler } from "../../../../cloudflare/types";

// Public (no Cloudflare Access, see ../../_middleware.ts): everything under
// /api/share/:token is authorized by the token alone and reaches only the
// link's canvas.

/** GET /api/share/:token — the shared canvas's name and the link's mode */
export const onRequestGet: Handler<"token"> = async ({ env, params }) => {
  if (!isValidToken(params.token)) {
    return error(404, "link not found");
  }
  const link = await getShareLink(env, params.token);
  if (!link) {
    return error(404, "link not found");
  }
  return json({ name: link.name, mode: link.mode });
};
