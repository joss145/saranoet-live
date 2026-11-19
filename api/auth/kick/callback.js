import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const REDIRECT_URI = "https://live.saranoet.stream/api/auth/kick/callback";
const EXPECTED_KICK_CHANNEL = "saranoet";
const REQUIRED_SCOPES = ["user:read", "channel:read", "chat:write", "events:subscribe"];

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

function clearCookies(res) {
  res.setHeader("Set-Cookie", [
    "kick_oauth_state=; Path=/api/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "kick_oauth_verifier=; Path=/api/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);
}

async function readJson(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { message: raw.slice(0, 300) };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const cookies = parseCookies(req.headers.cookie);
  const params = new URL(req.url, "https://live.saranoet.stream").searchParams;
  const returnedState = params.get("state");
  const code = params.get("code");

  clearCookies(res);

  if (params.get("error")) {
    return page(res, 400, "Autorización cancelada", "No se autorizó el acceso a Kick. Puedes volver a intentarlo.");
  }

  if (!safeEqual(cookies.kick_oauth_state, returnedState) || !cookies.kick_oauth_verifier) {
    return page(res, 400, "No se pudo verificar la solicitud", "La comprobación de seguridad PKCE no pasó. Inicia la conexión de Kick otra vez.");
  }

  if (!code) {
    return page(res, 400, "Falta el código de Kick", "No recibimos el código de autorización. Vuelve a iniciar la conexión.");
  }

  const requiredEnv = [
    "KICK_CLIENT_ID",
    "KICK_CLIENT_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ];
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length) {
    return page(res, 503, "Falta configuración del servidor", "No se pudo completar la conexión con Kick.", missing.join(", "));
  }

  try {
    const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.KICK_CLIENT_ID,
        client_secret: process.env.KICK_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: cookies.kick_oauth_verifier
      })
    });
    const tokenData = await readJson(tokenResponse);

    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.refresh_token) {
      return page(
        res,
        502,
        "Kick no entregó el token",
        "No se pudo completar el intercambio de autorización. Revisa la URL de retorno de la aplicación Kick y vuelve a intentarlo.",
        tokenData.message || tokenData.error_description || tokenData.error || "Error de autorización de Kick"
      );
    }

    const introspectResponse = await fetch("https://id.kick.com/oauth/token/introspect", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const introspection = await readJson(introspectResponse);
    const tokenInfo = introspection.data || introspection;

    if (!introspectResponse.ok || tokenInfo.active !== true || tokenInfo.client_id !== process.env.KICK_CLIENT_ID) {
      return page(res, 502, "No se pudo validar Kick", "Kick no confirmó que el token pertenece a esta aplicación.");
    }

    const grantedScopeValue = tokenInfo.scope || tokenData.scope || "";
    const grantedScopes = Array.isArray(grantedScopeValue)
      ? grantedScopeValue
      : String(grantedScopeValue).split(/\s+/).filter(Boolean);
    const missingScopes = REQUIRED_SCOPES.filter((scope) => !grantedScopes.includes(scope));

    if (missingScopes.length) {
      return page(
        res,
        403,
        "Faltan permisos de Kick",
        "Kick no concedió todos los permisos necesarios. Vuelve a autorizar y acepta lectura de usuario y canal, escritura de chat y suscripción a eventos.",
        missingScopes.join(", ")
      );
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    const [userResponse, channelResponse] = await Promise.all([
      fetch("https://api.kick.com/public/v1/users", { headers }),
      fetch("https://api.kick.com/public/v1/channels", { headers })
    ]);

    const userPayload = await readJson(userResponse);
    const channelPayload = await readJson(channelResponse);
    const user = Array.isArray(userPayload.data) ? userPayload.data[0] : null;
    const channel = Array.isArray(channelPayload.data) ? channelPayload.data[0] : channelPayload.data;

    if (!userResponse.ok || !user || !channelResponse.ok || !channel || !channel.slug) {
      return page(
        res,
        502,
        "No se pudo verificar el canal",
        "Kick autorizó la aplicación, pero no pudimos confirmar la cuenta y el canal. No guardamos el token.",
        userPayload.message || channelPayload.message || "Comprueba los permisos user:read y channel:read."
      );
    }

    const channelSlug = String(channel.slug).toLowerCase();
    if (channelSlug !== EXPECTED_KICK_CHANNEL) {
      return page(
        res,
        403,
        "Se conectó otro canal de Kick",
        `Autorizaste el canal @${channel.slug}, pero el canal configurado es @${EXPECTED_KICK_CHANNEL}. No guardamos el token.`,
        "Cierra sesión en Kick o cambia a la cuenta correcta y vuelve a iniciar la conexión."
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

    const expiresAt = new Date(Date.now() + Number(tokenData.expires_in || 0) * 1000).toISOString();
    const userId = user.user_id || channel.broadcaster_user_id;

    const { error: saveError } = await supabase
      .from("platform_tokens")
      .upsert({
        platform: "kick",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        user_id: userId ? String(userId) : null,
        username: channel.slug
      }, { onConflict: "platform" });

    if (saveError) {
      return page(res, 503, "Kick autorizado, pero no guardado", "La autorización funcionó, pero Supabase no pudo guardar el token.", saveError.message);
    }

    const subscriptionResponse = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        method: "webhook",
        events: [{ name: "chat.message.sent", version: 1 }]
      })
    });
    const subscriptionData = await readJson(subscriptionResponse);
    const subscription = Array.isArray(subscriptionData.data) ? subscriptionData.data[0] : null;

    if (!subscriptionResponse.ok || !subscription || subscription.error) {
      const reason = subscription?.error || subscriptionData.message || "Kick no confirmó la suscripción al evento de chat.";
      return page(
        res,
        200,
        "¡Kick conectado, falta activar la recepción!",
        `El canal @${channel.slug} quedó autorizado y guardado.`,
        reason
      );
    }

    return page(
      res,
      200,
      "¡Kick conectado y recepción activada!",
      `El canal @${channel.slug} quedó conectado y suscrito a los mensajes del chat.`,
      "La suscripción chat.message.sent fue creada correctamente."
    );
  } catch (error) {
    return page(
      res,
      500,
      "No se pudo completar la conexión",
      "Ocurrió un error en el servidor mientras se conectaba Kick.",
      error instanceof Error ? error.message : "Error desconocido"
    );
  }
}
