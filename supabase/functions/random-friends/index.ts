import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hash(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    // Current Supabase projects expose secret keys as a JSON map.
    // Keep the legacy variable as a fallback for older project runtimes.
    let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
    if (!serviceKey && secretKeysJson) {
      try {
        const secretKeys = JSON.parse(secretKeysJson);
        serviceKey = secretKeys.default || "";
      } catch (_) {
        // Fall through to the configuration check below.
      }
    }
    const accessCode = Deno.env.get("RF_TEST_ACCESS_CODE");
    if (!url || !serviceKey || !accessCode) return json({ error: "SERVER_NOT_CONFIGURED" }, 503);

    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json();
    const action = String(body.action || "");

    async function getSession() {
      const rawToken = String(body.sessionToken || "");
      if (rawToken.length < 40) throw new Error("INVALID_SESSION");
      const tokenHash = await hash(rawToken);
      const { data, error } = await db.from("rf_sessions")
        .select("id,mode,scope,country_code,expires_at")
        .eq("token_hash", tokenHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (error || !data) throw new Error("INVALID_SESSION");
      await db.from("rf_sessions").update({
        last_seen_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }).eq("id", data.id);
      return data;
    }

    async function enqueue(session: any, excludedSessionId: string | null = null) {
      const { error } = await db.from("rf_queue").upsert({
        session_id: session.id,
        mode: session.mode,
        scope: session.scope,
        country_code: session.country_code,
        excluded_session_id: excludedSessionId,
        queued_at: new Date().toISOString(),
      });
      if (error) throw error;
      await db.rpc("rf_match_session", { p_session_id: session.id });
    }

    async function activeRoom(sessionId: string) {
      const { data, error } = await db.from("rf_rooms")
        .select("id,mode,participant_a,participant_b,created_at")
        .eq("status", "active")
        .or(`participant_a.eq.${sessionId},participant_b.eq.${sessionId}`)
        .maybeSingle();
      if (error) throw error;
      return data;
    }

    if (action === "start") {
      const supplied = String(body.accessCode || "");
      if (!constantTimeEqual(supplied, accessCode)) return json({ error: "ACCESS_DENIED" }, 403);
      const mode = body.mode === "call" ? "call" : "chat";
      const scope = body.scope === "country" ? "country" : "world";
      const countryCode = scope === "country" ? String(body.countryCode || "").toUpperCase() : null;
      if (scope === "country" && !/^[A-Z]{2}$/.test(countryCode || "")) {
        return json({ error: "INVALID_COUNTRY" }, 400);
      }

      const sessionId = crypto.randomUUID();
      const sessionToken = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
      const tokenHash = await hash(sessionToken);
      const { error } = await db.from("rf_sessions").insert({
        id: sessionId,
        mode,
        scope,
        country_code: countryCode,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
      if (error) throw error;

      const session = { id: sessionId, mode, scope, country_code: countryCode };
      await enqueue(session);
      const room = await activeRoom(sessionId);
      return json({ sessionId, sessionToken, status: room ? "matched" : "waiting", room });
    }

    const session = await getSession();

    if (action === "poll") {
      let room = await activeRoom(session.id);
      if (!room) {
        const { data: queued, error } = await db.from("rf_queue")
          .select("session_id").eq("session_id", session.id).maybeSingle();
        if (error) throw error;
        if (!queued) await enqueue(session);
        room = await activeRoom(session.id);
      }
      if (!room) return json({ status: "waiting" });
      const partnerId = room.participant_a === session.id ? room.participant_b : room.participant_a;
      const { data: messages, error } = await db.from("rf_messages")
        .select("id,sender_session_id,body,created_at")
        .eq("room_id", room.id).order("created_at", { ascending: true }).limit(100);
      if (error) throw error;
      return json({
        status: "matched",
        sessionId: session.id,
        room: { id: room.id, mode: room.mode },
        partnerId,
        messages: messages || [],
      });
    }

    if (action === "send") {
      const message = String(body.message || "").trim();
      if (!message || message.length > 1000) return json({ error: "INVALID_MESSAGE" }, 400);
      const room = await activeRoom(session.id);
      if (!room || room.mode !== "chat") return json({ error: "NO_ACTIVE_CHAT" }, 409);
      const { data, error } = await db.from("rf_messages").insert({
        room_id: room.id, sender_session_id: session.id, body: message,
      }).select("id,sender_session_id,body,created_at").single();
      if (error) throw error;
      return json({ message: data });
    }

    if (action === "next") {
      const room = await activeRoom(session.id);
      let partnerId: string | null = null;
      if (room) {
        partnerId = room.participant_a === session.id ? room.participant_b : room.participant_a;
        await db.from("rf_rooms").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", room.id);
        const { data: partner, error } = await db.from("rf_sessions")
          .select("id,mode,scope,country_code").eq("id", partnerId)
          .gt("expires_at", new Date().toISOString()).maybeSingle();
        if (error) throw error;
        if (partner) await enqueue(partner, session.id);
      }
      await enqueue(session, partnerId);
      const nextRoom = await activeRoom(session.id);
      return json({ status: nextRoom ? "matched" : "waiting", room: nextRoom });
    }

    if (action === "end") {
      const room = await activeRoom(session.id);
      if (room) {
        const partnerId = room.participant_a === session.id ? room.participant_b : room.participant_a;
        await db.from("rf_rooms").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", room.id);
        const { data: partner, error } = await db.from("rf_sessions")
          .select("id,mode,scope,country_code").eq("id", partnerId)
          .gt("expires_at", new Date().toISOString()).maybeSingle();
        if (error) throw error;
        if (partner) await enqueue(partner, session.id);
      }
      await db.from("rf_queue").delete().eq("session_id", session.id);
      await db.from("rf_sessions").update({ expires_at: new Date().toISOString() }).eq("id", session.id);
      return json({ status: "ended" });
    }

    if (action === "signal-send") {
      const room = await activeRoom(session.id);
      if (!room || room.mode !== "call") return json({ error: "NO_ACTIVE_CALL" }, 409);
      const kind = String(body.kind || "");
      if (!["offer", "answer", "ice-candidate"].includes(kind)) {
        return json({ error: "INVALID_SIGNAL_KIND" }, 400);
      }
      const payload = body.payload;
      if (!payload || typeof payload !== "object" || JSON.stringify(payload).length > 20000) {
        return json({ error: "INVALID_SIGNAL_PAYLOAD" }, 400);
      }
      const { error } = await db.from("rf_signals").insert({
        room_id: room.id,
        sender_session_id: session.id,
        kind,
        payload,
      });
      if (error) throw error;
      return json({ status: "sent" });
    }

    if (action === "signal-poll") {
      const room = await activeRoom(session.id);
      if (!room || room.mode !== "call") return json({ error: "NO_ACTIVE_CALL" }, 409);
      const afterId = Math.max(0, Number(body.afterId) || 0);
      const { data: signals, error } = await db.from("rf_signals")
        .select("id,sender_session_id,kind,payload,created_at")
        .eq("room_id", room.id)
        .neq("sender_session_id", session.id)
        .gt("id", afterId)
        .order("id", { ascending: true })
        .limit(100);
      if (error) throw error;
      return json({ signals: signals || [] });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    if (message === "INVALID_SESSION") return json({ error: message }, 401);
    return json({ error: "SERVER_ERROR", detail: message }, 500);
  }
});
