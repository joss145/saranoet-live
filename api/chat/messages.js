import { supabase } from "../_lib/supabase.js";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method === "POST") return sendVisitorMessage(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, platform, username, content, emotes, sent_at")
    .order("sent_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("Chat messages read error:", error.message);
    return res.status(500).json({ error: "Could not load chat messages" });
  }

  let connection = null;
  let pickerEmotes = { twitch: [], kick: [] };
  let db = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  const sessionId = parseCookies(req.headers.cookie).visitor_session || "";
  if (db && /^[a-f0-9]{64}$/i.test(sessionId)) {
    const { data: visitor } = await db.from("visitor_platform_tokens")
      .select("platform,username,expires_at")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (visitor && (!visitor.expires_at || new Date(visitor.expires_at).getTime() > Date.now())) {
      connection = { platform: visitor.platform, username: visitor.username };
    }
  }
  if (db) {
    try { pickerEmotes = await loadPickerEmotes(db); }
    catch (error) { console.error("Emote picker load failed:", error?.message || "unknown error"); }
  }

  return res.status(200).json({ messages: data || [], connection, emotes: pickerEmotes });
}


const recentSends = new Map();
const WINDOW_MS = 2000;

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const i = part.indexOf("=");
    return i < 0 ? ["", ""] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([key]) => key));
}

async function readJson(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

async function sendVisitorMessage(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Método no permitido." });
  }

  const origin = req.headers.origin;
  if (origin && origin !== "https://live.saranoet.stream") {
    return res.status(403).json({ ok: false, error: "Origen no permitido." });
  }

  const sessionId = parseCookies(req.headers.cookie).visitor_session || "";
  if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
    return res.status(401).json({ ok: false, error: "Conecta Twitch o Kick antes de escribir." });
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 500) {
    return res.status(400).json({ ok: false, error: "El mensaje debe tener entre 1 y 500 caracteres." });
  }

  const now = Date.now();
  const previous = recentSends.get(sessionId) || 0;
  if (now - previous < WINDOW_MS) {
    return res.status(429).json({ ok: false, error: "Espera un momento antes de enviar otro mensaje." });
  }
  recentSends.set(sessionId, now);

  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  if (required.some((key) => !process.env[key])) {
    return res.status(503).json({ ok: false, error: "El servicio no está configurado." });
  }

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: visitor, error: visitorError } = await db
      .from("visitor_platform_tokens")
      .select("platform,user_id,username,access_token,refresh_token,expires_at")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (visitorError || !visitor?.access_token) {
      return res.status(401).json({ ok: false, error: "No hay una cuenta conectada. Vuelve a conectarla." });
    }
    if (visitor.expires_at && new Date(visitor.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ ok: false, error: "La conexión caducó. Vuelve a conectar tu cuenta." });
    }

    if (visitor.platform === "twitch") {
      const { data: broadcaster, error: broadcasterError } = await db
        .from("platform_tokens").select("user_id").eq("platform", "twitch").maybeSingle();
      if (broadcasterError || !broadcaster?.user_id) {
        return res.status(503).json({ ok: false, error: "No se encontró la configuración de Twitch del canal." });
      }

      const upstream = await fetch("https://api.twitch.tv/helix/chat/messages", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + visitor.access_token,
          "Client-Id": process.env.TWITCH_CLIENT_ID,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          broadcaster_id: String(broadcaster.user_id),
          sender_id: String(visitor.user_id),
          message
        })
      });
      const result = await readJson(upstream);
      if (!upstream.ok || result.data?.[0]?.is_sent !== true) {
        return res.status(upstream.status === 401 ? 401 : 502).json({
          ok: false,
          error: upstream.status === 403
            ? "Twitch no permitió enviar el mensaje. Revisa si tu cuenta puede participar en ese chat."
            : "Twitch no pudo enviar el mensaje. Puede que debas reconectar tu cuenta."
        });
      }
      return res.status(200).json({ ok: true, platform: "twitch", username: visitor.username });
    }

    if (visitor.platform === "kick") {
      const { data: broadcaster, error: broadcasterError } = await db
        .from("platform_tokens").select("user_id").eq("platform", "kick").maybeSingle();
      if (broadcasterError || !broadcaster?.user_id) {
        return res.status(503).json({ ok: false, error: "No se encontró la configuración de Kick del canal." });
      }

      const upstream = await fetch("https://api.kick.com/public/v1/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + visitor.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          broadcaster_user_id: Number(broadcaster.user_id),
          content: message,
          type: "user"
        })
      });
      const result = await readJson(upstream);
      if (!upstream.ok || result.data?.is_sent !== true) {
        return res.status(upstream.status === 401 ? 401 : 502).json({
          ok: false,
          error: "Kick no pudo enviar el mensaje. Puede que debas reconectar tu cuenta."
        });
      }
      return res.status(200).json({ ok: true, platform: "kick", username: visitor.username });
    }

    return res.status(400).json({ ok: false, error: "Plataforma no reconocida." });
  } catch (error) {
    console.error("Visitor chat send failed:", error?.message || "unknown error");
    return res.status(500).json({ ok: false, error: "No se pudo enviar el mensaje. Inténtalo de nuevo." });
  }
}


let cachedTwitchAppToken = "";
let twitchTokenExpiresAt = 0;

async function getTwitchAppToken() {
  if (cachedTwitchAppToken && twitchTokenExpiresAt > Date.now() + 60000) return cachedTwitchAppToken;
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return "";
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials"
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const result = await readJson(response);
  if (!response.ok || !result.access_token) throw new Error("No se pudo obtener token de Twitch para emotes");
  cachedTwitchAppToken = result.access_token;
  twitchTokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  return cachedTwitchAppToken;
}

function normalize7tvEmotes(payload) {
  const set = payload?.emote_set || payload?.data?.emote_set || payload?.emoteSet || payload;
  const emotes = Array.isArray(set?.emotes) ? set.emotes : [];
  return emotes.map((emote) => {
    const host = emote.data?.host || emote.host;
    const files = host?.files || [];
    const preferred = files.find((file) => file.name === "2x.webp") ||
      files.find((file) => file.name === "1x.webp") || files[0];
    let image = "";
    if (host?.url) {
      const base = host.url.startsWith("//") ? "https:" + host.url : host.url;
      image = base.replace(/\/$/, "") + "/" + (preferred?.name || "2x.webp");
    }
    return { name: emote.name || emote.data?.name || "", url: image, platform: "7tv" };
  }).filter((emote) => emote.name && emote.url);
}

let pickerEmoteCache = null;
let pickerEmoteCacheExpiresAt = 0;

async function loadPickerEmotes(db) {
  if (pickerEmoteCache && pickerEmoteCacheExpiresAt > Date.now()) return pickerEmoteCache;
  const result = { twitch: [], kick: [] };
  const { data: twitchChannel } = await db.from("platform_tokens")
    .select("user_id").eq("platform", "twitch").maybeSingle();
  const { data: kickChannel } = await db.from("platform_tokens")
    .select("user_id").eq("platform", "kick").maybeSingle();

  const twitchToken = await getTwitchAppToken();
  if (twitchToken) {
    const headers = {
      "Authorization": "Bearer " + twitchToken,
      "Client-Id": process.env.TWITCH_CLIENT_ID
    };
    const requests = [
      fetch("https://api.twitch.tv/helix/chat/emotes/global", { headers }),
      twitchChannel?.user_id
        ? fetch("https://api.twitch.tv/helix/chat/emotes?broadcaster_id=" + encodeURIComponent(twitchChannel.user_id), { headers })
        : Promise.resolve(null)
    ];
    const [globalResponse, channelResponse] = await Promise.all(requests);
    for (const response of [globalResponse, channelResponse]) {
      if (!response?.ok) continue;
      const body = await readJson(response);
      for (const emote of body.data || []) {
        const url = emote.images?.url_2x || emote.images?.url_1x;
        if (emote.name && url) result.twitch.push({ name: emote.name, url, platform: "twitch" });
      }
    }
    result.twitch = Array.from(new Map(result.twitch.map((item) => [item.name, item])).values());
  }

  const kickSets = [];
  const global7tv = await fetch("https://7tv.io/v3/emote-sets/global");
  if (global7tv.ok) kickSets.push(...normalize7tvEmotes(await readJson(global7tv)));
  if (kickChannel?.user_id) {
    const user7tv = await fetch("https://7tv.io/v3/users/kick/" + encodeURIComponent(kickChannel.user_id));
    if (user7tv.ok) kickSets.push(...normalize7tvEmotes(await readJson(user7tv)));
  }
  result.kick = Array.from(new Map(kickSets.map((item) => [item.name, item])).values());
  pickerEmoteCache = result;
  pickerEmoteCacheExpiresAt = Date.now() + 10 * 60 * 1000;
  return result;
}
