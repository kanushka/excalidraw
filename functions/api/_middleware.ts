import { checkAccess } from "../../cloudflare/access";
import { error } from "../../cloudflare/http";

import type { Handler } from "../../cloudflare/types";

// share link routes are opened by people without an Access login; they
// authorize the link's token instead (functions/api/share)
const PUBLIC_PREFIX = "/api/share/";

export const onRequest: Handler = async (context) => {
  const { pathname } = new URL(context.request.url);
  if (!pathname.startsWith(PUBLIC_PREFIX)) {
    const accessError = await checkAccess(context.request, context.env);
    if (accessError) {
      return error(401, accessError);
    }
  }
  try {
    return await context.next();
  } catch (err: any) {
    console.error(err);
    return error(500, err?.message || "internal error");
  }
};
