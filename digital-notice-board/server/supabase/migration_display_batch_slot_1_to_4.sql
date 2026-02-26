-- Upgrades display batch slot constraints from legacy 1..3 to 1..4.
-- Safe to run multiple times.

alter table if exists announcements drop constraint if exists announcements_display_batch_slot_chk;
alter table if exists announcements
  add constraint announcements_display_batch_slot_chk
  check (display_batch_slot is null or display_batch_slot between 1 and 4)
  not valid;

alter table if exists history drop constraint if exists history_display_batch_slot_chk;
alter table if exists history
  add constraint history_display_batch_slot_chk
  check (display_batch_slot is null or display_batch_slot between 1 and 4)
  not valid;

