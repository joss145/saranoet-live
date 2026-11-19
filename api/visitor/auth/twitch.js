import { randomBytes } from "node:crypto";

const REDIRECT_URI = "https://live.saranoet.stream/api/visitor/auth/twitch/callback";

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const item = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!process.env.TWITCH_CLIENT_ID) {
    return res.status(503).json({ ok: false, error: "Missing TWITCH_CLIENT_ID" });
  }

  const state = randomBytes(32).toString("hex");
  const existingSession = readCookie(req, "visitor_session");
  const sessionId = /^[a-f0-9]{64}$/i.test(existingSession)
    ? existingSession
    : randomBytes(32).toString("hex");

  const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "user:write:chat",
    state,
    force_verify: "true"
  }).toString();

  res.setHeader("Set-Cookie", [
    `visitor_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    `visitor_twitch_state=${state}; Path=/api/visitor/auth/twitch; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  ]);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", authorizeUrl.toString());
  res.statusCode = 302;
  return res.end();
}
