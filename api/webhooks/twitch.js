import { createHmac, timingSafeEqual } from "node:crypto";
import { supabase } from "../_lib/supabase.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validSignature(req, body) {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  const id = req.headers["twitch-eventsub-message-id"];
  const timestamp = req.headers["twitch-eventsub-message-timestamp"];
  const received = req.headers["twitch-eventsub-message-signature"];
  if (!secret || !id || !timestamp || !received) return false;

  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 10 * 60 * 1000) return false;

  const message = Buffer.concat([Buffer.from(String(id) + String(timestamp)), body]);
  const expected = "sha256=" + createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(received));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const body = await rawBody(req);
  if (!validSignature(req, body)) return res.status(403).send("Invalid signature");

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  const messageType = req.headers["twitch-eventsub-message-type"];
  if (messageType === "webhook_callback_verification") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(payload.challenge || "");
  }

  if (messageType === "revocation") return res.status(204).end();
  if (messageType !== "notification" || payload.subscription?.type !== "channel.chat.message") {
    return res.status(204).end();
  }

  const event = payload.event || {};
  const messageId = event.message_id;
  const username = event.chatter_user_name;
  const content = event.message?.text;
  if (!messageId || !username || typeof content !== "string") return res.status(204).end();

  const emotes = (event.message?.fragments || []).map((fragment) => {
    if (fragment.type === "emote" && fragment.emote?.id) {
      return { type: "emote", text: fragment.text || "", id: String(fragment.emote.id), format: fragment.emote.format || ["static"] };
    }
    return { type: "text", text: fragment.text || "" };
  });

  const { error } = await supabase.from("chat_messages").upsert({
    platform: "twitch",
    external_message_id: String(messageId),
    username: String(username),
    content,
    emotes,
    sent_at: event.message?.sent_at || new Date().toISOString()
  }, { onConflict: "platform,external_message_id", ignoreDuplicates: true });

  if (error) {
    console.error("Twitch webhook database error:", error.message);
    return res.status(500).send("Database error");
  }

  return res.status(204).end();
}
