alter table if exists announcements add column if not exists media_width integer null;
alter table if exists announcements add column if not exists media_height integer null;

alter table if exists history add column if not exists media_width integer null;
alter table if exists history add column if not exists media_height integer null;
