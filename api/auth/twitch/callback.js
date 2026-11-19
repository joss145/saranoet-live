import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const REDIRECT_URI = "https://live.saranoet.stream/api/auth/twitch/callback";
const EXPECTED_TWITCH_LOGIN = "sarainoet";
const REQUIRED_SCOPES = ["user:read:chat", "user:write:chat", "user:bot", "channel:bot"];

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return ["", ""];
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }).filter(([key]) => key)
  );
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function page(res, status, title, message, detail = "") {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - SaraNoet Live</title>
<style>
body{margin:0;background:#111;color:#f5f5f5;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
main{max-width:560px;background:#1d1d1d;border:1px solid #333;border-radius:16px;padding:28px}
h1{font-size:24px;margin:0 0 12px}p{color:#ddd}a{color:#a78bfa}
.small{font-size:13px;color:#aaa}
</style>
</head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${detail ? `<p class="small">${escapeHtml(detail)}</p>` : ""}
<p><a href="https://live.saranoet.stream/">Volver a SaraNoet Live</a></p>
</main></body></html>`);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const cookies = parseCookies(req.headers.cookie);
  const savedState = cookies.twitch_oauth_state;
  const params = new URL(req.url, "https://live.saranoet.stream").searchParams;
  const returnedState = params.get("state");

  res.setHeader(
    "Set-Cookie",
    "twitch_oauth_state=; Path=/api/auth/twitch; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );

  if (params.get("error")) {
    return page(res, 400, "Autorización cancelada", "No se autorizó el acceso a Twitch. Puedes volver a intentarlo cuando quieras.");
  }

  if (!safeEqual(savedState, returnedState)) {
    return page(res, 400, "No se pudo verificar la solicitud", "La autorización no pasó la comprobación de seguridad. Inicia la conexión de Twitch otra vez.");
  }

  const code = params.get("code");
  if (!code) {
    return page(res, 400, "Falta el código de Twitch", "No recibimos el código de autorización. Vuelve a iniciar la conexión.");
  }

  const requiredEnv = [
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ];
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length) {
    return page(res, 503, "Falta configuración del servidor", "No se pudo completar la conexión con Twitch.", missing.join(", "));
  }

  try {
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.refresh_token) {
      return page(res, 502, "Twitch no entregó el token", "No se pudo completar el intercambio de autorización. Revisa la configuración de la aplicación Twitch e inténtalo otra vez.");
    }

    const validationResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${tokenData.access_token}` }
    });
    const validation = await validationResponse.json();

    if (!validationResponse.ok || validation.client_id !== process.env.TWITCH_CLIENT_ID) {
      return page(res, 502, "No se pudo validar Twitch", "Twitch no confirmó que el token pertenece a esta aplicación.");
    }

    const grantedScopes = Array.isArray(validation.scopes) ? validation.scopes : [];
    const missingScopes = REQUIRED_SCOPES.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length) {
      return page(
        res,
        403,
        "Faltan permisos de chat",
        "Twitch no concedió todos los permisos necesarios. Vuelve a autorizar y acepta los permisos de lectura, escritura y conexión del bot al chat.",
        missingScopes.join(", ")
      );
    }

    if ((validation.login || "").toLowerCase() !== EXPECTED_TWITCH_LOGIN) {
      return page(
        res,
        403,
        "Se conectó otra cuenta de Twitch",
        `Autorizaste la cuenta ${validation.login || "desconocida"}, pero el canal configurado es ${EXPECTED_TWITCH_LOGIN}. No guardamos el token.`,
        "Cierra sesión en Twitch o cambia de cuenta y vuelve a iniciar la conexión."
      );
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        }
      }
    );

    const expiresAt = new Date(Date.now() + Number(tokenData.expires_in || validation.expires_in || 0) * 1000).toISOString();
    const { error: saveError } = await supabase
      .from("platform_tokens")
      .upsert({
        platform: "twitch",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        user_id: validation.user_id,
        username: validation.login
      }, { onConflict: "platform" });

    if (saveError) {
      return page(res, 503, "Twitch autorizado, pero no guardado", "La autorización funcionó, pero Supabase no pudo guardar el token.", saveError.message);
    }

    return page(
      res,
      200,
      "¡Twitch conectado!",
      `La cuenta @${validation.login} quedó autorizada y sus tokens se guardaron en Supabase.`,
      "Todavía falta activar la recepción y el envío de mensajes."
    );
  } catch (error) {
    return page(
      res,
      500,
      "No se pudo completar la conexión",
      "Ocurrió un error en el servidor mientras se conectaba Twitch.",
      error instanceof Error ? error.message : "Error desconocido"
    );
  }
}
