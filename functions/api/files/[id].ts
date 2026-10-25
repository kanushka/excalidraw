import {
  getFileResponse,
  headFileResponse,
  putFile,
} from "../../../cloudflare/files";
import { error, isValidId } from "../../../cloudflare/http";

import type { Handler } from "../../../cloudflare/types";

/** GET /api/files/:id */
export const onRequestGet: Handler<"id"> = async ({ env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid file id");
  }
  return getFileResponse(env, params.id);
};

/** HEAD /api/files/:id — whether the file is already stored */
export const onRequestHead: Handler<"id"> = async ({ env, params }) => {
  if (!isValidId(params.id)) {
    return new Response(null, { status: 400 });
  }
  return headFileResponse(env, params.id);
};

/** PUT /api/files/:id */
export const onRequestPut: Handler<"id"> = async ({ request, env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid file id");
  }
  return putFile(env, params.id, request);
};
