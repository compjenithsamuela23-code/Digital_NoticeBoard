-- Add read/performance indexes used by public display, workspace listing, and history timelines.

create index if not exists announcements_end_at_idx
  on announcements (end_at);

create index if not exists announcements_public_active_window_idx
  on announcements (start_at, end_at, created_at desc)
  where is_active = true;

create index if not exists announcements_public_category_window_idx
  on announcements (category, start_at, end_at, created_at desc)
  where is_active = true;

create index if not exists history_action_action_at_idx
  on history (action, action_at desc, row_id desc);
