import { randomBytes } from "node:crypto";

const REDIRECT_URI = "https://live.saranoet.stream/api/auth/twitch/callback";
const REQUIRED_ENV = ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"];

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    return res.status(503).json({
      ok: false,
      error: "Missing Twitch environment variables",
      missing
    });
  }

  const state = randomBytes(32).toString("hex");
  const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "user:read:chat user:write:chat user:bot channel:bot",
    state,
    force_verify: "true"
  }).toString();

  res.setHeader(
    "Set-Cookie",
    `twitch_oauth_state=${state}; Path=/api/auth/twitch; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", authorizeUrl.toString());
  res.statusCode = 302;
  return res.end();
}
