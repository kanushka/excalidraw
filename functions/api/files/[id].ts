import { error, fileKey, isValidId } from "../../../cloudflare/http";

import type { Handler } from "../../../cloudflare/types";

// image files are stored as Excalidraw's `BinaryFileData` JSON
// ({ id, mimeType, dataURL, created }), keyed by file id. File ids are
// content hashes, so a stored file never changes and can be cached.
const MAX_FILE_SIZE = 30 * 1024 * 1024;

/** GET /api/files/:id */
export const onRequestGet: Handler<"id"> = async ({ env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid file id");
  }
  const object = await env.BUCKET.get(fileKey(params.id));
  if (!object) {
    return error(404, "file not found");
  }
  return new Response(object.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
};

/** HEAD /api/files/:id — whether the file is already stored */
export const onRequestHead: Handler<"id"> = async ({ env, params }) => {
  if (!isValidId(params.id)) {
    return new Response(null, { status: 400 });
  }
  const object = await env.BUCKET.head(fileKey(params.id));
  return new Response(null, { status: object ? 200 : 404 });
};

/** PUT /api/files/:id */
export const onRequestPut: Handler<"id"> = async ({ request, env, params }) => {
  if (!isValidId(params.id)) {
    return error(400, "invalid file id");
  }
  const body = await request.text();
  if (body.length > MAX_FILE_SIZE) {
    return error(413, "file too large");
  }
  let data: { id?: unknown; dataURL?: unknown; mimeType?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    return error(400, "file must be valid JSON");
  }
  if (
    data.id !== params.id ||
    typeof data.dataURL !== "string" ||
    typeof data.mimeType !== "string"
  ) {
    return error(400, "invalid file data");
  }
  await env.BUCKET.put(fileKey(params.id), body, {
    httpMetadata: { contentType: "application/json" },
  });
  return new Response(null, { status: 204 });
};
