# Supabase setup

Random Friends shares the existing Color-balls Supabase project, but uses only its own `rf_*` tables and Edge Function. The Risk game project is not used.

## 1. Database migrations

Run these files in order in the **Color-balls** project's SQL Editor:

1. `supabase/migrations/001_random_friends.sql`
2. `supabase/migrations/002_test_matching_backend.sql`

The migrations create or update only `rf_*` objects. They do not modify `cb_*` tables. Browser roles have no direct table access.

## 2. Deploy the Edge Function

Deploy the function named `random-friends` using the source at:

`supabase/functions/random-friends/index.ts`

The repository also contains `supabase/config.toml`, which disables gateway JWT verification for this function because the app uses a publishable key and its own short-lived test-session tokens. The function itself checks the test access code when creating a session and checks a random session token on every later request.

## 3. Function secrets

In the Supabase dashboard for the Color-balls project, open the Edge Functions secrets/settings area and ensure these server-side environment variables are available:

- `SUPABASE_URL`: the Color-balls project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the project's service-role/secret key. Keep this only in Supabase server secrets. Never put it in GitHub, the app, or a message.
- `RF_TEST_ACCESS_CODE`: a long, random test-only access code that you choose. It must not be committed to this repository or shared publicly.

Supabase may provide its project URL and service-role key to Edge Functions automatically. If they are already present, do not create duplicate values. Only add the missing variables and the private `RF_TEST_ACCESS_CODE`.

## 4. Testing boundary

This is a closed test backend, not a public random-chat service. Share the test access code only with people you personally know and have approved for testing. Do not publish the app or distribute the code publicly. The access code is a shared test gate, not a full identity or age-verification system.

## 5. Current implementation limits

The Edge Function supports test-session creation, separate chat/call queues, room matching, chat messages, next, and end. The website client still needs to be connected to this function and tested. Real audio/video transport (WebRTC signaling and media connection) is a separate unfinished step; a call-mode match alone does not mean a call is connected.

## 6. Free-tier note

Sharing the project avoids creating a third Supabase project, but database and function usage still count against the same Color-balls project's free-tier limits.
