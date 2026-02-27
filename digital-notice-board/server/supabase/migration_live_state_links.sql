alter table live_state add column if not exists links jsonb null;

update live_state
set links = '[]'::jsonb
where links is null;

alter table live_state alter column links set default '[]'::jsonb;
alter table live_state alter column links set not null;

alter table live_state drop constraint if exists live_state_links_chk;
alter table live_state
  add constraint live_state_links_chk
  check (
    links is not null
    and jsonb_typeof(links) = 'array'
    and jsonb_array_length(links) between 0 and 24
  )
  not valid;
