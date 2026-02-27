-- Adds safety constraints for announcement display batch integrity.
-- Run this after schema.sql if upgrading an existing project.

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

alter table history drop constraint if exists history_display_batch_pair_chk;
alter table history
  add constraint history_display_batch_pair_chk
  check (
    (display_batch_id is null and display_batch_slot is null)
    or (display_batch_id is not null and display_batch_slot between 1 and 24)
  )
  not valid;
