import { checkAccess } from "../../cloudflare/access";
import { error } from "../../cloudflare/http";

import type { Handler } from "../../cloudflare/types";

export const onRequest: Handler = async (context) => {
  const accessError = await checkAccess(context.request, context.env);
  if (accessError) {
    return error(401, accessError);
  }
  try {
    return await context.next();
  } catch (err: any) {
    console.error(err);
    return error(500, err?.message || "internal error");
  }
};
