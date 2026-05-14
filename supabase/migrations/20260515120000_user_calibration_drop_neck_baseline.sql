-- Remove neck baseline column if table was created from an older migration.
alter table public.user_calibration
  drop column if exists neck_baseline_pitch;
