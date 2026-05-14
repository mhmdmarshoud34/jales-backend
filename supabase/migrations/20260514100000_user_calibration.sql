-- Per-user baseline + alert-style thresholds (one row per user).
-- App averages ~5s of samples then PUTs here; readings/evaluate prefer this over posture_calibration.

create table if not exists public.user_calibration (
  user_id uuid primary key references public.users (id) on delete cascade,
  back_baseline_pitch double precision,
  left_shoulder_baseline double precision,
  right_shoulder_baseline double precision,
  back_threshold double precision not null default 20,
  shoulder_threshold double precision not null default 10,
  updated_at timestamptz not null default now()
);

comment on table public.user_calibration is
  'User-level posture baselines (back + shoulders) and deviation thresholds. Readings prefer this over posture_calibration.';
