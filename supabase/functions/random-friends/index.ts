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
    if (!url || !serviceKey) return json({ error: "SERVER_NOT_CONFIGURED" }, 503);

    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json();
    const action = String(body.action || "");

    async function getSession() {
      const rawToken = String(body.sessionToken || "");
      if (rawToken.length < 40) throw new Error("INVALID_SESSION");
      const tokenHash = await hash(rawToken);
      const { data, error } = await db.from("rf_sessions")
        .select("id,mode,scope,country_code,actual_country_code,expires_at")
        .eq("token_hash", tokenHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (error || !data) throw new Error("INVALID_SESSION");
      const requestCountry = String(req.headers.get("cf-ipcountry") || "").trim().toUpperCase();
      const validRequestCountry = /^[A-Z]{2}$/.test(requestCountry) &&
        requestCountry !== "XX" && requestCountry !== "T1";
      const updatedCountry = validRequestCountry ? requestCountry : data.actual_country_code;
      await db.from("rf_sessions").update({
        last_seen_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ...(updatedCountry ? { actual_country_code: updatedCountry } : {}),
      }).eq("id", data.id);
      return { ...data, actual_country_code: updatedCountry || null };
    }

    async function enqueue(session: any, excludedSessionId: string | null = null) {
      const { error } = await db.from("rf_queue").upsert({
        session_id: session.id,
        mode: session.mode,
        scope: session.scope,
        country_code: session.country_code,
        actual_country_code: session.actual_country_code,
        excluded_session_id: excludedSessionId,
        queued_at: new Date().toISOString(),
      });
      if (error) throw error;
      const { error: matchError } = await db.rpc("rf_match_session", { p_session_id: session.id });
      if (matchError) throw matchError;
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

    if (action === "get-profile") {
      const deviceId = String(body.deviceId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) return json({ error: "INVALID_DEVICE_ID" }, 400);
      const { data, error } = await db.from("rf_profiles").select("gender,initial_age,registered_year,created_at").eq("device_id", deviceId).maybeSingle();
      if (error) throw error;
      if (!data) return json({ profile: null });
      const currentYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
      return json({ profile: { gender: data.gender, currentAge: data.initial_age + currentYear - data.registered_year, createdAt: data.created_at } });
    }

    if (action === "start") {
      const mode = body.mode === "call" ? "call" : "chat";
      const scope = body.scope === "country" ? "country" : "world";
      const countryCode = scope === "country" ? String(body.countryCode || "").toUpperCase() : null;
      if (scope === "country" && !/^[A-Z]{2}$/.test(countryCode || "")) {
        return json({ error: "INVALID_COUNTRY" }, 400);
      }

      // Cloudflare adds this country code at the Supabase edge. Never trust a
      // country supplied by the browser for the user's physical location.
      const actualCountryCode = String(req.headers.get("cf-ipcountry") || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(actualCountryCode) || actualCountryCode === "XX" || actualCountryCode === "T1") {
        return json({ error: "COUNTRY_DETECTION_FAILED" }, 503);
      }

      const deviceId = String(body.deviceId || "");
      const profile = body.profile || {};
      const filter = body.filter || {};
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) return json({ error: "INVALID_DEVICE_ID" }, 400);
      if (!["male", "female"].includes(profile.gender) || !Number.isInteger(profile.initialAge) || profile.initialAge < 13 || profile.initialAge > 99) return json({ error: "INVALID_PROFILE" }, 400);
      const filterActive = filter.active === true;
      const minAge = Number.isInteger(filter.minAge) ? filter.minAge : 13;
      const maxAge = Number.isInteger(filter.maxAge) ? filter.maxAge : 99;
      const desiredGender = ["any", "male", "female"].includes(filter.gender) ? filter.gender : "any";
      const exclude20Plus = body.exclude20Plus === true;
      if (minAge < 13 || maxAge > 99 || minAge > maxAge) return json({ error: "INVALID_FILTER" }, 400);
      const { error: profileInsertError } = await db.from("rf_profiles").upsert({
        device_id: deviceId,
        gender: profile.gender,
        initial_age: profile.initialAge,
        registered_year: Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date())),
        filter_active: filterActive,
        min_age: minAge,
        max_age: maxAge,
        desired_gender: desiredGender,
        exclude_20_plus: exclude20Plus,
      }, { onConflict: "device_id", ignoreDuplicates: true });
      if (profileInsertError) throw profileInsertError;
      const { error: filterUpdateError } = await db.from("rf_profiles").update({
        filter_active: filterActive, min_age: minAge, max_age: maxAge, desired_gender: desiredGender,
        exclude_20_plus: exclude20Plus,
      }).eq("device_id", deviceId);
      if (filterUpdateError) throw filterUpdateError;

      const sessionId = crypto.randomUUID();
      const sessionToken = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
      const tokenHash = await hash(sessionToken);
      const { error } = await db.from("rf_sessions").insert({
        id: sessionId,
        mode,
        scope,
        country_code: countryCode,
        actual_country_code: actualCountryCode,
        device_id: deviceId,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
      if (error) throw error;

      const session = { id: sessionId, mode, scope, country_code: countryCode, actual_country_code: actualCountryCode };
      await enqueue(session);
      const room = await activeRoom(sessionId);
      return json({ sessionId, sessionToken, status: room ? "matched" : "waiting", room });
    }

    const session = await getSession();

    if (action === "poll") {
      let previousRoomEnded = false;
      const lastRoomId = String(body.lastRoomId || "");
      if (lastRoomId) {
        const { data: previousRoom, error: previousRoomError } = await db.from("rf_rooms")
          .select("id,status,participant_a,participant_b")
          .eq("id", lastRoomId)
          .maybeSingle();
        if (previousRoomError) throw previousRoomError;
        previousRoomEnded = Boolean(previousRoom && previousRoom.status === "ended" &&
          (previousRoom.participant_a === session.id || previousRoom.participant_b === session.id));
      }
      let room = await activeRoom(session.id);
      if (!room) {
        const { data: queued, error } = await db.from("rf_queue")
          .select("session_id,actual_country_code").eq("session_id", session.id).maybeSingle();
        if (error) throw error;
        if (!queued || queued.actual_country_code !== session.actual_country_code) {
          await enqueue(session);
        }
        room = await activeRoom(session.id);
      }
      if (!room) return json({ status: "waiting", partnerLeft: previousRoomEnded });
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
        partnerLeft: previousRoomEnded,
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
          .select("id,mode,scope,country_code,actual_country_code").eq("id", partnerId)
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
          .select("id,mode,scope,country_code,actual_country_code").eq("id", partnerId)
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
