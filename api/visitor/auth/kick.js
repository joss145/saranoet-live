import { createHash, randomBytes } from "node:crypto";

const REDIRECT_URI = "https://live.saranoet.stream/api/visitor/auth/kick/callback";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!process.env.KICK_CLIENT_ID) {
    return res.status(503).json({ ok: false, error: "Missing KICK_CLIENT_ID" });
  }

  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorizeUrl = new URL("https://id.kick.com/oauth/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: process.env.KICK_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "user:read chat:write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();

  res.setHeader("Set-Cookie", [
    `visitor_kick_state=${state}; Path=/api/visitor/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    `visitor_kick_verifier=${verifier}; Path=/api/visitor/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  ]);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", authorizeUrl.toString());
  res.statusCode = 302;
  return res.end();
}
