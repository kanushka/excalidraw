// Verifies the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header) so the
// API can't be reached around Access (e.g. through a `*.pages.dev` alias).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import type { Env } from "./types";

type JWK = JsonWebKey & { kid: string };

let cachedKeys: { teamDomain: string; keys: JWK[]; fetchedAt: number } | null =
  null;

const KEYS_TTL = 60 * 60 * 1000;

const base64UrlDecode = (input: string) => {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const getKeys = async (teamDomain: string, forceRefresh = false) => {
  if (
    !forceRefresh &&
    cachedKeys &&
    cachedKeys.teamDomain === teamDomain &&
    Date.now() - cachedKeys.fetchedAt < KEYS_TTL
  ) {
    return cachedKeys.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new Error(`failed to fetch Access certs (${res.status})`);
  }
  const { keys } = (await res.json()) as { keys: JWK[] };
  cachedKeys = { teamDomain, keys, fetchedAt: Date.now() };
  return keys;
};

const verifyAccessJwt = async (
  token: string,
  teamDomain: string,
  allowedAuds: string[],
) => {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return false;
  }
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
  const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));

  if (header.alg !== "RS256") {
    return false;
  }

  let jwk = (await getKeys(teamDomain)).find((key) => key.kid === header.kid);
  if (!jwk) {
    // keys may have been rotated
    jwk = (await getKeys(teamDomain, true)).find(
      (key) => key.kid === header.kid,
    );
  }
  if (!jwk) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const isValidSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!isValidSignature) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const auds: string[] = Array.isArray(payload.aud)
    ? payload.aud
    : [payload.aud];

  return (
    auds.some((aud) => allowedAuds.includes(aud)) &&
    payload.iss === `https://${teamDomain}` &&
    typeof payload.exp === "number" &&
    payload.exp > now
  );
};

/** returns `null` when the request is allowed, or an error message */
export const checkAccess = async (
  request: Request,
  env: Env,
): Promise<string | null> => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  // comma-separated: Pages creates separate Access applications for the
  // production `*.pages.dev` domain and for preview deployments
  const auds = (env.ACCESS_AUD || "")
    .split(",")
    .map((aud) => aud.trim())
    .filter(Boolean);

  if (!teamDomain || !auds.length) {
    return env.ALLOW_UNAUTHENTICATED === "true"
      ? null
      : "Cloudflare Access is not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)";
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return "missing Cloudflare Access token";
  }
  try {
    return (await verifyAccessJwt(token, teamDomain, auds))
      ? null
      : "invalid Cloudflare Access token";
  } catch (error: any) {
    return `failed to verify Cloudflare Access token: ${error.message}`;
  }
};
