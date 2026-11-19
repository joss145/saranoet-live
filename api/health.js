// Environment diagnostic endpoint for the SaraNoet chat bridge.
export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "KICK_CLIENT_ID",
    "KICK_CLIENT_SECRET"
  ];

  const missing = required.filter((name) => !process.env[name]);

  return res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    service: "saranoet-chat-bridge",
    configuration: missing.length === 0 ? "ready" : "missing_environment_variables",
    missing
  });
}
