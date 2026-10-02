-- GQ Sounds: private artist-submission and review foundation
-- Apply with: supabase db push
-- Do not put service-role credentials in the browser or in this repository.

create extension if not exists pgcrypto;

create type public.staff_role as enum ('admin', 'reviewer', 'editor');
create type public.submission_status as enum (
  'uploading',
  'submitted',
  'triage',
  'needs_info',
  'rights_check',
  'listening',
  'approved_pending_artist',
  'scheduled',
  'published',
  'rejected',
  'withdrawn'
);

create table public.staff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 2 and 120),
  role public.staff_role not null default 'reviewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.artists (
  id uuid primary key default gen_random_uuid(),
  stage_name text not null check (char_length(trim(stage_name)) between 1 and 160),
  contact_name text not null check (char_length(trim(contact_name)) between 1 and 160),
  email text not null check (char_length(trim(email)) between 3 and 320),
  whatsapp_number text not null check (char_length(trim(whatsapp_number)) between 7 and 40),
  area text not null check (char_length(trim(area)) between 1 and 160),
  artist_link text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete restrict,
  track_title text not null check (char_length(trim(track_title)) between 1 and 200),
  genre text not null check (char_length(trim(genre)) between 1 and 80),
  languages text,
  notes text check (char_length(notes) <= 4000),
  audio_path text not null unique,
  audio_mime_type text not null check (audio_mime_type in ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a')),
  audio_size_bytes bigint,
  audio_checksum text,
  cover_path text unique,
  cover_mime_type text check (cover_mime_type is null or cover_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  cover_size_bytes bigint,
  rights_original_work boolean not null default false,
  review_permission boolean not null default false,
  contact_permission boolean not null default false,
  source text not null default 'gq-sounds-web' check (char_length(source) <= 100),
  -- A short-lived digest proves that the browser completing an upload owns this intake session.
  -- Never store or log the raw upload token.
  upload_token_digest text not null unique,
  upload_token_expires_at timestamptz not null,
  status public.submission_status not null default 'uploading',
  assigned_to uuid references public.staff_profiles(id) on delete set null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint submission_permissions_required check (
    rights_original_work and review_permission and contact_permission
  ),
  constraint submitted_submission_has_timestamp check (
    (status = 'uploading' and submitted_at is null)
    or (status <> 'uploading' and submitted_at is not null)
  )
);

create table public.submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  actor_id uuid references public.staff_profiles(id) on delete set null,
  event_type text not null check (char_length(event_type) between 1 and 80),
  body text check (body is null or char_length(body) <= 5000),
  from_status public.submission_status,
  to_status public.submission_status,
  created_at timestamptz not null default now()
);

create index submissions_queue_idx on public.submissions (status, submitted_at asc nulls last);
create index submissions_artist_idx on public.submissions (artist_id, created_at desc);
create index submissions_assignee_idx on public.submissions (assigned_to, status, submitted_at asc nulls last);
create index submission_events_timeline_idx on public.submission_events (submission_id, created_at asc);
create index artists_lookup_idx on public.artists (lower(stage_name), lower(email));

-- Helper functions execute with controlled access so RLS policies do not recurse.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.staff_profiles where id = auth.uid());
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.write_submission_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
begin
  actor := auth.uid();

  if tg_op = 'INSERT' then
    insert into public.submission_events (submission_id, actor_id, event_type, to_status)
    values (new.id, actor, 'created', new.status);
  elsif old.status is distinct from new.status then
    insert into public.submission_events (submission_id, actor_id, event_type, from_status, to_status)
    values (new.id, actor, 'status_changed', old.status, new.status);
  elsif old.assigned_to is distinct from new.assigned_to then
    insert into public.submission_events (submission_id, actor_id, event_type, body)
    values (new.id, actor, 'assignment_changed', coalesce(new.assigned_to::text, 'unassigned'));
  end if;

  return new;
end;
$$;

create trigger staff_profiles_set_updated_at
before update on public.staff_profiles
for each row execute procedure public.set_updated_at();

create trigger artists_set_updated_at
before update on public.artists
for each row execute procedure public.set_updated_at();

create trigger submissions_set_updated_at
before update on public.submissions
for each row execute procedure public.set_updated_at();

create trigger submissions_write_event
after insert or update on public.submissions
for each row execute procedure public.write_submission_event();

alter table public.staff_profiles enable row level security;
alter table public.artists enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_events enable row level security;

-- The service role used only inside the Edge Function bypasses RLS.
-- Staff access is deliberately narrow. Artist contact information never has a public policy.
create policy "staff view own profile"
on public.staff_profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

create policy "admins manage staff"
on public.staff_profiles for all to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "staff read artists"
on public.artists for select to authenticated
using (public.is_staff());

create policy "staff update artists"
on public.artists for update to authenticated
using (public.is_staff())
with check (public.is_staff());

create policy "staff read submissions"
on public.submissions for select to authenticated
using (public.is_staff());

-- A reviewer cannot directly publish or alter an already-published record.
create policy "staff review submissions"
on public.submissions for update to authenticated
using (public.is_staff() and (status <> 'published' or public.is_admin()))
with check (public.is_staff() and (status <> 'published' or public.is_admin()));

create policy "staff read audit timeline"
on public.submission_events for select to authenticated
using (public.is_staff());

-- Events are created by the database trigger or service role; the client cannot rewrite history.

-- Intake is private by default. No storage.objects policy grants public or browser access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'submissions-private',
  'submissions-private',
  false,
  10485760,
  array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- There is intentionally no browser storage.objects policy for this bucket.
-- The future review dashboard obtains short-lived preview URLs from a trusted server route.

comment on table public.submissions is 'Private artist intake. Only approved releases belong in a separate public catalogue.';
comment on table public.submission_events is 'Append-only review timeline created by database triggers and trusted server actions.';
