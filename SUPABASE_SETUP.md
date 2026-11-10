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

The function supports test-session creation, separate chat/call queues, room matching, chat messages, next/end, and WebRTC offer/answer/ICE signaling. The website polls for room, message, and call-signaling updates.

## 3. Function secrets

In the Supabase dashboard for the Color-balls project, open the Edge Functions secrets/settings area and ensure these server-side environment variables are available:

- `SUPABASE_URL`: the Color-balls project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the project's service-role/secret key. Keep this only in Supabase server secrets. Never put it in GitHub, the app, or a message.
- `RF_TEST_ACCESS_CODE`: a long, random test-only access code that you choose. It must not be committed to this repository or shared publicly.

Supabase may provide its project URL and service-role key to Edge Functions automatically. If they are already present, do not create duplicate values. Only add missing variables and the private `RF_TEST_ACCESS_CODE`.

The app has a test-code field on its home screen. Enter the same code that you saved as `RF_TEST_ACCESS_CODE`. Do not send the code or service-role key in this chat.

## 4. Testing boundary

This is a closed test backend, not a public random-chat service. Share the test access code only with people you personally know and have approved for testing. Do not publish the app or distribute the code publicly. The access code is a shared test gate, not a full identity or age-verification system.

## 5. Current implementation limits

- Chat: server-side matching and message send/receive polling are implemented, but still require deployment and real-device testing.
- Call: WebRTC signaling and browser media capture are implemented in code. The app uses a public STUN server only; there is no TURN relay, so some network combinations may fail to connect. Actual audio/video transport must still be verified with two approved devices.
- Country: country selection is manual; automatic country detection is not implemented.
- Matching uses short-lived sessions. If a browser is closed without ending a session, it may remain in the queue until its 15-minute expiry is cleaned up.

Do not treat matching or messaging as verified until two approved test devices have completed a real test.

## 6. Free-tier note

Sharing the project avoids creating a third Supabase project, but database and function usage still count against the same Color-balls project's free-tier limits.
