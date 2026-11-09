# Supabase setup

This project shares the existing Color-balls Supabase project, but uses a separate set of `rf_*` tables.

## 1. Apply the database foundation

1. Open the Supabase dashboard for the **Color-balls** project.
2. Open **SQL Editor** and create a new query.
3. Open `supabase/migrations/001_random_friends.sql` in this repository.
4. Copy the complete SQL into the SQL Editor and run it once.

The migration creates only `rf_sessions`, `rf_queue`, `rf_rooms`, and `rf_messages`. It does not modify `cb_*` tables.

## 2. Important security boundary

The migration intentionally denies direct table access to browser roles (`anon` and `authenticated`). Do not add permissive RLS policies or put a `service_role` key in the website.

The next implementation step is a server-side Supabase Edge Function. It will validate short-lived test sessions and mediate queue, room, and message operations. Until that function is deployed and tested, the app must not claim that live matching or messaging works.

## 3. Realtime and calls

Realtime should be enabled only for the room/message flow after server authorization is in place. WebRTC signaling and any relay configuration are a separate step; a publishable key alone does not provide a media relay.

## 4. Free-tier note

Sharing the project avoids creating a third Supabase project, but database, storage, bandwidth, and project usage are still shared with Color-balls.
