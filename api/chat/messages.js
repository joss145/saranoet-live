import { supabase } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, platform, username, content, sent_at")
    .order("sent_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("Chat messages read error:", error.message);
    return res.status(500).json({ error: "Could not load chat messages" });
  }

  return res.status(200).json({ messages: data || [] });
}
