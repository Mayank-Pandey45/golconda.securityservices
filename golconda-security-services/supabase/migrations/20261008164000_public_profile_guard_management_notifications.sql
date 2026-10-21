-- Add public profile publishing, private guard employment data, and scheduled
-- notifications without replacing existing records or weakening admin RLS.

alter table public.guards
  add column if not exists salary_amount numeric(12, 2),
  add column if not exists salary_frequency text,
  add column if not exists salary_effective_date date,
  add column if not exists salary_notes text,
  add column if not exists phone_normalized text generated always as (
    case
      when length(regexp_replace(phone, '\D', '', 'g')) = 12 and left(regexp_replace(phone, '\D', '', 'g'), 2) = '91'
        then substring(regexp_replace(phone, '\D', '', 'g') from 3)
      when length(regexp_replace(phone, '\D', '', 'g')) = 11 and left(regexp_replace(phone, '\D', '', 'g'), 1) = '0'
        then substring(regexp_replace(phone, '\D', '', 'g') from 2)
      else regexp_replace(phone, '\D', '', 'g')
    end
  ) stored;

alter table public.guards
  drop constraint if exists guards_status_check;
alter table public.guards
  add constraint guards_status_check check (status in ('active', 'inactive', 'on_leave', 'relieved'));

alter table public.guards
  drop constraint if exists guards_salary_amount_check,
  drop constraint if exists guards_salary_frequency_check;
alter table public.guards
  add constraint guards_salary_amount_check check (salary_amount is null or salary_amount >= 0),
  add constraint guards_salary_frequency_check check (salary_frequency is null or salary_frequency in ('monthly', 'daily'));

-- Repeated imports are idempotent by a phone number normalized to digits.
-- If legacy rows contain duplicate phone numbers, this index intentionally
-- fails instead of deleting or changing any records.
create unique index if not exists guards_phone_normalized_unique_idx
  on public.guards (phone_normalized)
  where phone_normalized <> '';
create index if not exists guards_site_status_idx on public.guards(site_id, status);

alter table public.profile_docs
  alter column file_url drop not null,
  add column if not exists storage_path text,
  add column if not exists category text not null default 'Other',
  add column if not exists mime_type text not null default '',
  add column if not exists media_type text not null default 'document',
  add column if not exists is_public boolean not null default false,
  add column if not exists sort_order integer not null default 0;

alter table public.notifications
  add column if not exists notification_severity text not null default 'announcement',
  add column if not exists starts_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists is_active boolean not null default true,
  add column if not exists is_published boolean not null default true,
  add column if not exists dismissible boolean not null default true,
  add column if not exists button_label text,
  add column if not exists button_url text;

alter table public.notifications
  drop constraint if exists notifications_notification_severity_check,
  drop constraint if exists notifications_schedule_check;
alter table public.notifications
  add constraint notifications_notification_severity_check
    check (notification_severity in ('information', 'announcement', 'warning', 'urgent')),
  add constraint notifications_schedule_check
    check (starts_at is null or expires_at is null or expires_at > starts_at);

create index if not exists notifications_public_schedule_idx
  on public.notifications(is_published, is_active, starts_at, expires_at);

-- Public visitors may read only published, active, unexpired notifications.
-- Scheduled future notices are readable so the browser can display them when
-- their start time arrives; unpublished and inactive records remain private.
drop policy if exists "Public can read notifications" on public.notifications;
create policy "Public can read notifications" on public.notifications
  for select to anon, authenticated
  using (is_published and is_active and (expires_at is null or expires_at > now()));

drop policy if exists "Admins read all notifications" on public.notifications;
create policy "Admins read all notifications" on public.notifications
  for select to authenticated
  using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

-- Profile file objects stay private. The public profile API issues short-lived
-- signed URLs only for profile_docs rows explicitly approved with is_public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-profile',
  'company-profile',
  false,
  20971520,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'video/mp4',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Admins manage company profile files" on storage.objects;
create policy "Admins manage company profile files" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'company-profile'
    and exists (select 1 from public.admin_users where user_id = (select auth.uid()))
  )
  with check (
    bucket_id = 'company-profile'
    and exists (select 1 from public.admin_users where user_id = (select auth.uid()))
  );
