-- Supabase setup for tidal_scrobbler_cli
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> paste -> Run.
-- Afterwards set in .env:
--   DB_BACKEND='supabase'
--   SUPABASE_URL='https://<project-ref>.supabase.co'
--   SUPABASE_SERVICE_ROLE_KEY='<your-service-role-key>'   (Settings -> API)

-- Tracks, unique by normalized artist + title so re-imports never duplicate.
create table if not exists public.tracks (
  id bigint generated always as identity primary key,
  artist text not null,
  album text not null default '',
  name text not null,
  date timestamptz not null default now(),
  artist_normalized text,
  name_normalized text,
  unique (artist_normalized, name_normalized)
);

-- Per-source import cursor (lastfm / listenbrainz), keyed like 'import_<source>'.
create table if not exists public.meta (
  key text primary key,
  value text
);

-- Efficient lookups by listening date and by normalized pair.
create index if not exists tracks_date_idx on public.tracks (date);

-- Lock everyone out except the service role key (which bypasses RLS anyway).
-- This keeps the anonymous/anon key from reading or writing your scrobbles.
alter table public.tracks enable row level security;
alter table public.meta enable row level security;