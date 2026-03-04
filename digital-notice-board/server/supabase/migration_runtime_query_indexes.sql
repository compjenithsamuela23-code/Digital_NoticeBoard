-- Runtime read optimization for workspace/public announcement feeds.
-- Safe to run multiple times.

create index if not exists announcements_end_at_created_at_idx
  on announcements (end_at, created_at desc);
