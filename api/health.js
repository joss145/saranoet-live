// Environment and Supabase connectivity diagnostic for the SaraNoet chat bridge.
import { supabase } from "./_lib/supabase.js";

export default async function handler(req, res) {
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

  if (missing.length) {
    return res.status(503).json({
      ok: false,
      service: "saranoet-chat-bridge",
      configuration: "missing_environment_variables",
      missing
    });
  }

  const { error } = await supabase
    .from("platform_tokens")
    .select("platform")
    .limit(1);

  if (error) {
    return res.status(503).json({
      ok: false,
      service: "saranoet-chat-bridge",
      configuration: "ready",
      database: "error",
      database_error: error.message
    });
  }

  return res.status(200).json({
    ok: true,
    service: "saranoet-chat-bridge",
    configuration: "ready",
    database: "connected"
  });
}
