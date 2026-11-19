import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const REDIRECT_URI = "https://live.saranoet.stream/api/visitor/auth/kick/callback";
function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => { const i = part.indexOf("="); return i < 0 ? ["", ""] : [part.slice(0, i).trim(), part.slice(i + 1).trim()]; }).filter(([k]) => k));
}
function same(a, b) { if (!a || !b) return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function page(res, status, title, message) {
  res.statusCode = status; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  return res.end("<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title><body style=\"background:#111;color:#fff;font:16px system-ui;padding:32px\"><main style=\"max-width:520px;margin:auto;background:#222;padding:24px;border-radius:16px\"><h2>" + title + "</h2><p>" + message + "</p><a style=\"color:#b9a1ff\" href=\"https://live.saranoet.stream/\">Volver a SaraNoet Live</a></main></body></html>");
}
async function readJson(response) { const raw = await response.text(); try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const c = parseCookies(req.headers.cookie);
  const p = new URL(req.url, "https://live.saranoet.stream").searchParams;
  res.setHeader("Set-Cookie", [
    "visitor_kick_state=; Path=/api/visitor/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "visitor_kick_verifier=; Path=/api/visitor/auth/kick; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);
  if (p.get("error")) return page(res, 400, "Conexión cancelada", "No autorizaste Kick.");
  if (!same(c.visitor_kick_state, p.get("state")) || !c.visitor_kick_verifier) return page(res, 400, "Verificación fallida", "Vuelve a iniciar la conexión con Kick.");
  const required = ["KICK_CLIENT_ID", "KICK_CLIENT_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) return page(res, 503, "Falta configuración", "Faltan variables del servidor: " + missing.join(", "));
  try {
    const tokenResponse = await fetch("https://id.kick.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: p.get("code") || "", client_id: process.env.KICK_CLIENT_ID, client_secret: process.env.KICK_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code", code_verifier: c.visitor_kick_verifier }) });
    const token = await readJson(tokenResponse);
    if (!tokenResponse.ok || !token.access_token) return page(res, 502, "Kick rechazó la conexión", "No se pudo obtener el permiso. Inténtalo de nuevo.");
    const introspectResponse = await fetch("https://id.kick.com/oauth/token/introspect", { method: "POST", headers: { Authorization: "Bearer " + token.access_token } });
    const introspection = await readJson(introspectResponse);
    const info = introspection.data || introspection;
    const scopeValue = info.scope || token.scope || "";
    const scopes = Array.isArray(scopeValue) ? scopeValue : String(scopeValue).split(/\s+/).filter(Boolean);
    if (!introspectResponse.ok || info.active !== true || info.client_id !== process.env.KICK_CLIENT_ID || !scopes.includes("chat:write")) return page(res, 403, "Permiso insuficiente", "Kick no confirmó el permiso para escribir en el chat.");
    const userResponse = await fetch("https://api.kick.com/public/v1/users", { headers: { Authorization: "Bearer " + token.access_token } });
    const userPayload = await readJson(userResponse);
    const user = Array.isArray(userPayload.data) ? userPayload.data[0] : userPayload.data;
    const userId = user && (user.user_id || user.id);
    const username = user && (user.name || user.username);
    if (!userResponse.ok || !userId || !username) return page(res, 502, "No se pudo verificar Kick", "Kick no devolvió los datos de la cuenta autorizada.");
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const expiresAt = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null;
    const { error } = await db.from("visitor_platform_tokens").upsert({ platform: "kick", user_id: String(userId), username: String(username), access_token: token.access_token, refresh_token: token.refresh_token || null, expires_at: expiresAt }, { onConflict: "platform,user_id" });
    if (error) return page(res, 503, "No se pudo guardar", "Kick autorizó la cuenta, pero no se pudo guardar la conexión.");
    return page(res, 200, "¡Kick conectado!", "Tu cuenta @" + username + " quedó vinculada. Ya puedes volver a la página.");
  } catch (error) { return page(res, 500, "Error del servidor", "No se pudo completar la conexión. Inténtalo otra vez."); }
}