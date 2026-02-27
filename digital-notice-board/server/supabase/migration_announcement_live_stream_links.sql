-- Adds multi-stream live links support per announcement/history row.
-- Safe to run multiple times.

alter table if exists announcements add column if not exists live_stream_links jsonb null;
update announcements
set live_stream_links = '[]'::jsonb
where live_stream_links is null;
alter table if exists announcements alter column live_stream_links set default '[]'::jsonb;
alter table if exists announcements alter column live_stream_links set not null;

alter table if exists history add column if not exists live_stream_links jsonb null;
update history
set live_stream_links = '[]'::jsonb
where live_stream_links is null;
alter table if exists history alter column live_stream_links set default '[]'::jsonb;
alter table if exists history alter column live_stream_links set not null;

alter table if exists announcements drop constraint if exists announcements_live_stream_links_chk;
alter table if exists announcements
  add constraint announcements_live_stream_links_chk
  check (
    live_stream_links is not null
    and jsonb_typeof(live_stream_links) = 'array'
    and jsonb_array_length(live_stream_links) between 0 and 4
  )
  not valid;

alter table if exists history drop constraint if exists history_live_stream_links_chk;
alter table if exists history
  add constraint history_live_stream_links_chk
  check (
    live_stream_links is not null
    and jsonb_typeof(live_stream_links) = 'array'
    and jsonb_array_length(live_stream_links) between 0 and 4
  )
  not valid;
