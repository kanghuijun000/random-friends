# Supabase setup

Random Friends shares the existing Color-balls Supabase project, but uses only its own `rf_*` tables and Edge Function. The Risk game project is not used.

## 1. Database migrations

The first migration (`001_random_friends.sql`) creates the isolated database tables. If it has already been run, do not run it again.

Run these migrations in order in the **Color-balls** project SQL Editor. Skip any migration already applied:

- `supabase/migrations/002_test_matching_backend.sql`
- `supabase/migrations/003_webrtc_signaling.sql`

Migration 002 adds short-lived test-session token storage and the server-only atomic matching function. Migration 003 creates the call-signaling table with server-only access. Both change only `rf_*` objects.

## 2. Deploy the Edge Function

Deploy a function named `random-friends` using:

- `supabase/functions/random-friends/index.ts`
- `supabase/config.toml`

The function supports session creation without a shared test password, separate chat/call queues, room matching, chat messages, next/end, and WebRTC offer/answer/ICE signaling. The website polls for room, message, and call-signaling updates.

## 3. Function secrets

In the Supabase dashboard for the Color-balls project, open the Edge Functions secrets/settings area and ensure these server-side environment variables are available:

- `SUPABASE_URL`: the Color-balls project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the project's service-role/secret key. Keep this only in Supabase server secrets. Never put it in GitHub, the app, or a message.

Supabase may provide its project URL and service-role key to Edge Functions automatically. If they are already present, do not create duplicate values. No test-code secret is required.

The app no longer asks users for a shared test code. Do not send the service-role key in this chat.

## 4. Access and safety

There is no shared test-code gate. Anyone who can reach the published site and function endpoint may attempt to create a session. Before promoting the app or sharing its URL, add and verify appropriate access controls, reporting/blocking, moderation, and age-appropriate safety measures. The public publishable key is not an access-control mechanism.

## 5. Current implementation limits

- Chat: server-side matching and message send/receive polling are implemented, but still require deployment and real-device testing.
- Call: WebRTC signaling and browser media capture are implemented in code. The app uses a public STUN server only; there is no TURN relay, so some network combinations may fail to connect. Actual audio/video transport must still be verified with two approved devices.
- Country: country selection is manual; automatic country detection is not implemented.
- Matching uses short-lived sessions. If a browser is closed without ending a session, it may remain in the queue until its 15-minute expiry is cleaned up.

Do not treat matching or messaging as verified until two test devices have completed a real test.

## 6. Free-tier note

Sharing the project avoids creating a third Supabase project, but database and function usage still count against the same Color-balls project's free-tier limits.
