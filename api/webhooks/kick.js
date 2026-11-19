import { verify } from "node:crypto";
import { supabase } from "../_lib/supabase.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function getKickPublicKey() {
  const response = await fetch("https://api.kick.com/public/v1/public-key");
  if (!response.ok) throw new Error("Could not retrieve Kick public key");
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed.public_key || parsed.data?.public_key || parsed.data || raw;
  } catch {
    return raw;
  }
}

async function validSignature(req, body) {
  const messageId = req.headers["kick-event-message-id"];
  const timestamp = req.headers["kick-event-message-timestamp"];
  const signature = req.headers["kick-event-signature"];
  if (!messageId || !timestamp || !signature) return false;

  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 10 * 60 * 1000) return false;

  const publicKey = await getKickPublicKey();
  const signedMessage = Buffer.concat([
    Buffer.from(String(messageId) + "." + String(timestamp) + "."),
    body
  ]);
  return verify("RSA-SHA256", signedMessage, publicKey, Buffer.from(String(signature), "base64"));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const body = await rawBody(req);
  let signatureOk = false;
  try {
    signatureOk = await validSignature(req, body);
  } catch (error) {
    console.error("Kick signature verification error:", error.message);
  }
  if (!signatureOk) return res.status(403).send("Invalid signature");

  if (req.headers["kick-event-type"] !== "chat.message.sent") {
    return res.status(204).end();
  }

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  const messageId = payload.message_id || req.headers["kick-event-message-id"];
  const username = payload.sender?.username;
  const content = payload.content;
  if (!messageId || !username || typeof content !== "string") return res.status(204).end();

  const { error } = await supabase.from("chat_messages").upsert({
    platform: "kick",
    external_message_id: String(messageId),
    username: String(username),
    content,
    sent_at: payload.created_at || new Date().toISOString()
  }, { onConflict: "platform,external_message_id", ignoreDuplicates: true });

  if (error) {
    console.error("Kick webhook database error:", error.message);
    return res.status(500).send("Database error");
  }

  return res.status(204).end();
}
