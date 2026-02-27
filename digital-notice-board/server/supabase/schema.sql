-- Digital Notice Board schema for Supabase
-- Run this in Supabase SQL Editor before starting the server.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password text not null,
  role text not null default 'admin',
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  priority integer not null default 1,
  duration integer not null default 7,
  is_active boolean not null default true,
  -- null category means global visibility across all display categories
  category uuid null,
  image text null,
  type text not null default 'text',
  file_name text null,
  file_mime_type text null,
  file_size_bytes bigint null,
  media_width integer null,
  media_height integer null,
  live_stream_links jsonb not null default '[]'::jsonb,
  display_batch_id text null,
  display_batch_slot integer null,
  created_at timestamptz not null default timezone('utc', now()),
  start_at timestamptz not null,
  end_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz null
);

create index if not exists announcements_created_at_idx
  on announcements (created_at desc);

create index if not exists announcements_public_sort_idx
  on announcements (priority desc, created_at desc);

create index if not exists announcements_emergency_sort_idx
  on announcements (priority asc, created_at desc);

create index if not exists announcements_category_idx
  on announcements (category);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists categories_name_lower_uidx
  on categories (lower(name));

create table if not exists history (
  row_id bigint generated always as identity primary key,
  id uuid not null,
  title text not null,
  content text not null default '',
  priority integer not null default 1,
  duration integer not null default 7,
  is_active boolean not null default true,
  category uuid null,
  image text null,
  type text not null default 'text',
  file_name text null,
  file_mime_type text null,
  file_size_bytes bigint null,
  media_width integer null,
  media_height integer null,
  live_stream_links jsonb not null default '[]'::jsonb,
  display_batch_id text null,
  display_batch_slot integer null,
  created_at timestamptz not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz null,
  action text not null,
  action_at timestamptz not null default timezone('utc', now()),
  user_email text null
);

create unique index if not exists history_id_action_action_at_uidx
  on history (id, action, action_at);

alter table history add column if not exists row_id bigint;

create index if not exists history_action_at_idx
  on history (action_at desc, row_id desc);

create table if not exists live_state (
  id integer primary key,
  status text not null default 'OFF',
  link text null,
  category uuid null,
  started_at timestamptz null,
  stopped_at timestamptz null,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table live_state add column if not exists category uuid null;

create index if not exists live_state_category_idx
  on live_state (category);

insert into live_state (id, status, link, category)
values (1, 'OFF', null, null)
on conflict (id) do nothing;

alter table announcements add column if not exists file_name text null;
alter table announcements add column if not exists file_mime_type text null;
alter table announcements add column if not exists file_size_bytes bigint null;
alter table announcements add column if not exists media_width integer null;
alter table announcements add column if not exists media_height integer null;
alter table announcements add column if not exists live_stream_links jsonb null;
alter table announcements add column if not exists display_batch_id text null;
alter table announcements add column if not exists display_batch_slot integer null;
update announcements
set live_stream_links = '[]'::jsonb
where live_stream_links is null;
alter table announcements alter column live_stream_links set default '[]'::jsonb;
alter table announcements alter column live_stream_links set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'announcements_priority_non_negative_chk'
      and conrelid = 'announcements'::regclass
  ) then
    alter table announcements
      add constraint announcements_priority_non_negative_chk
      check (priority >= 0)
      not valid;
  end if;
end
$$;

alter table history add column if not exists file_name text null;
alter table history add column if not exists file_mime_type text null;
alter table history add column if not exists file_size_bytes bigint null;
alter table history add column if not exists media_width integer null;
alter table history add column if not exists media_height integer null;
alter table history add column if not exists live_stream_links jsonb null;
alter table history add column if not exists display_batch_id text null;
alter table history add column if not exists display_batch_slot integer null;
update history
set live_stream_links = '[]'::jsonb
where live_stream_links is null;
alter table history alter column live_stream_links set default '[]'::jsonb;
alter table history alter column live_stream_links set not null;

alter table announcements drop constraint if exists announcements_display_batch_slot_chk;
alter table announcements
  add constraint announcements_display_batch_slot_chk
  check (display_batch_slot is null or display_batch_slot between 1 and 24)
  not valid;

alter table announcements drop constraint if exists announcements_live_stream_links_chk;
alter table announcements
  add constraint announcements_live_stream_links_chk
  check (
    live_stream_links is not null
    and jsonb_typeof(live_stream_links) = 'array'
    and jsonb_array_length(live_stream_links) between 0 and 4
  )
  not valid;

create index if not exists announcements_display_batch_id_idx
  on announcements (display_batch_id);

alter table announcements drop constraint if exists announcements_display_batch_pair_chk;
alter table announcements
  add constraint announcements_display_batch_pair_chk
  check (
    (display_batch_id is null and display_batch_slot is null)
    or (display_batch_id is not null and display_batch_slot between 1 and 24)
  )
  not valid;

alter table history drop constraint if exists history_display_batch_slot_chk;
alter table history
  add constraint history_display_batch_slot_chk
  check (display_batch_slot is null or display_batch_slot between 1 and 24)
  not valid;

alter table history drop constraint if exists history_live_stream_links_chk;
alter table history
  add constraint history_live_stream_links_chk
  check (
    live_stream_links is not null
    and jsonb_typeof(live_stream_links) = 'array'
    and jsonb_array_length(live_stream_links) between 0 and 4
  )
  not valid;

alter table history drop constraint if exists history_display_batch_pair_chk;
alter table history
  add constraint history_display_batch_pair_chk
  check (
    (display_batch_id is null and display_batch_slot is null)
    or (display_batch_id is not null and display_batch_slot between 1 and 24)
  )
  not valid;
