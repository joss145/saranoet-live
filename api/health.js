export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const configured = Boolean(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.TWITCH_CLIENT_ID &&
    process.env.TWITCH_CLIENT_SECRET &&
    process.env.KICK_CLIENT_ID &&
    process.env.KICK_CLIENT_SECRET
  );

  return res.status(configured ? 200 : 503).json({
    ok: configured,
    service: "saranoet-chat-bridge",
    configuration: configured ? "ready" : "missing_environment_variables"
  });
}
