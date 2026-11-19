import { createHash, randomBytes } from "node:crypto";

const REDIRECT_URI = "https://live.saranoet.stream/api/auth/kick/callback";
const REQUIRED_ENV = ["KICK_CLIENT_ID", "KICK_CLIENT_SECRET"];

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    return res.status(503).json({
      ok: false,
      error: "Missing Kick environment variables",
      missing
    });
  }

  // Kick requires OAuth 2.1 PKCE with S256.
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorizeUrl = new URL("https://id.kick.com/oauth/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: process.env.KICK_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "user:read channel:read chat:write events:subscribe",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();

  res.setHeader("Set-Cookie", [
    `kick_oauth_state=${state}; Path=/api/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    `kick_oauth_verifier=${verifier}; Path=/api/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  ]);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", authorizeUrl.toString());
  res.statusCode = 302;
  return res.end();
}
