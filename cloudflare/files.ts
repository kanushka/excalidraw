import { error, fileKey } from "./http";

import type { Env } from "./types";

// image files are stored as Excalidraw's `BinaryFileData` JSON
// ({ id, mimeType, dataURL, created }), keyed by file id. File ids are
// content hashes, so a stored file never changes and can be cached.
const MAX_FILE_SIZE = 30 * 1024 * 1024;

export const getFileResponse = async (env: Env, id: string) => {
  const object = await env.BUCKET.get(fileKey(id));
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

export const headFileResponse = async (env: Env, id: string) => {
  const object = await env.BUCKET.head(fileKey(id));
  return new Response(null, { status: object ? 200 : 404 });
};

export const putFile = async (env: Env, id: string, request: Request) => {
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
    data.id !== id ||
    typeof data.dataURL !== "string" ||
    typeof data.mimeType !== "string"
  ) {
    return error(400, "invalid file data");
  }
  await env.BUCKET.put(fileKey(id), body, {
    httpMetadata: { contentType: "application/json" },
  });
  return new Response(null, { status: 204 });
};
