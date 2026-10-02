# GQ Sounds — Artist Submission Review Dashboard Plan

## Goal

Give GQ Sounds a **private, staff-only review workspace** for artist submissions. It replaces the current email-only handoff once the first live submissions start arriving.

**Principle:** artists retain their rights; nothing is public until it passes review and the artist approves publication.

---

## Current state and the gap

The live submission page currently:

- collects artist and track details;
- accepts audio and optional cover artwork;
- requires rights, review and contact consent;
- forwards the submission to the GQ Sounds inbox through FormSubmit.

That is suitable for an initial queue, but it is **not a dashboard**: it has no searchable pipeline, assignment, notes, audit trail, or secure in-browser streaming for reviewers.

### Decision

Keep the existing form live for early intake. Build the dashboard around **Supabase** and migrate the submission form to a secure Supabase submission endpoint before relying on it for production-scale uploads.

---

## Review workflow

```text
submitted
  → triage
  → rights_check
  → listening
  → approved_pending_artist ─→ scheduled → published
  ↘ needs_info
  ↘ rejected
  ↘ withdrawn
```

| Status | Meaning | Artist sees |
|---|---|---|
| `submitted` | File arrived; no staff member has touched it. | “Received — in review” |
| `triage` | Staff checks completeness and file safety. | “In review” |
| `needs_info` | Track needs missing rights, metadata, or a replacement file. | “We need more information” |
| `rights_check` | Ownership, samples and release permission are being checked. | “Rights check in progress” |
| `listening` | Reviewers are listening and adding notes. | “In review” |
| `approved_pending_artist` | Curator wants the track, awaiting the artist’s publication approval. | “Approval requested” |
| `scheduled` | Artist approved; release has a future publication date. | “Scheduled” |
| `published` | Track and approved profile are visible on GQ Sounds. | “Live” |
| `rejected` | Not selected at this time; keep a respectful template response. | “Decision sent” |
| `withdrawn` | Artist withdrew the track or revoked permission. | “Withdrawn” |

Only the server can transition a submission to `published`.

---

## Dashboard scope — first release

### 1. Secure sign-in

- `/review/login` uses Supabase Auth magic link or Google sign-in.
- First staff account: **Sihle / GQ Sounds administrator**.
- Roles: `admin`, `reviewer`, and later `editor`.
- No dashboard link is shown in public navigation.

### 2. Review queue

- Default view: `submitted`, oldest first.
- Filters: status, genre, area, submitted date, assigned reviewer, rights flag.
- Search: artist name, contact name, track title, and WhatsApp number.
- Queue rows show: artist, title, genre, upload date, current status, assignee, and priority.

### 3. Submission detail view

- Secure audio player using a short-lived signed URL.
- Cover-art preview, metadata, social link, contact detail, and rights confirmations.
- File details: upload time, MIME type, size, duration (when available), and checksum.
- Internal notes, star rating, decision checklist, and assignment.
- Buttons: `Request info`, `Move to rights check`, `Approve`, `Reject`, `Withdraw`.

### 4. Decision communications

- Saved response templates for acknowledgement, missing information, approval request, respectful decline, and publication confirmation.
- Sending a message stores a copy on the submission timeline.
- First release can generate email drafts; delivery can be added through Resend later.

### 5. Publication handoff

- An approved, artist-confirmed submission becomes a `release` record.
- Staff selects artist name, artwork, genres, release date, and featured placement.
- Audio is copied from private intake storage to the public/restricted release bucket only at publication.
- The public catalogue reads **only** `published` releases.

---

## Technical architecture

| Layer | Choice | Why |
|---|---|---|
| Dashboard | Next.js + TypeScript | Protected routes and maintainable staff UI |
| Database | Supabase PostgreSQL | Submission pipeline, search, relations, audit data |
| Staff access | Supabase Auth | Magic links / OAuth and role-based access |
| Intake files | Supabase Storage `submissions-private` bucket | Private by default; no public file URLs |
| Published media | Supabase Storage `releases` bucket | Deliberate public streaming only after approval |
| Submission API | Supabase Edge Function | Server-side validation, abuse controls, secure storage paths |
| Transactional email | Resend (phase 2) | Templates and delivery records |

### Why not use FormSubmit as the dashboard source?

FormSubmit delivers emails and file attachments, but it does not provide a reliable database record, staff roles, secure playback links, review status history, or publication controls. It remains useful temporarily; it should not become the catalogue database.

---

## Data model

```sql
create type submission_status as enum (
  submitted, triage, needs_info, rights_check, listening,
  approved_pending_artist, scheduled, published, rejected, withdrawn
);

create table staff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in (admin, reviewer, editor)),
  created_at timestamptz not null default now()
);

create table artists (
  id uuid primary key default gen_random_uuid(),
  stage_name text not null,
  contact_name text not null,
  email text not null,
  whatsapp_number text not null,
  area text,
  artist_link text,
  created_at timestamptz not null default now()
);

create table submissions (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists(id),
  track_title text not null,
  genre text not null,
  languages text,
  notes text,
  audio_path text not null,
  audio_mime_type text not null,
  audio_size_bytes bigint not null,
  audio_checksum text,
  cover_path text,
  rights_original_work boolean not null,
  review_permission boolean not null,
  contact_permission boolean not null,
  status submission_status not null default submitted,
  assigned_to uuid references staff_profiles(id),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  actor_id uuid references staff_profiles(id),
  event_type text not null,
  body text,
  from_status submission_status,
  to_status submission_status,
  created_at timestamptz not null default now()
);

create table releases (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid unique references submissions(id),
  public_audio_path text not null,
  public_cover_path text,
  published_at timestamptz,
  featured_rank integer,
  is_published boolean not null default false
);
```

The production schema also needs `updated_at` triggers, indexes on status/submitted date, and a database function that records every status change in `submission_events`.

---

## Security rules (non-negotiable)

1. **Private intake bucket:** `submissions-private` has no public URL.
2. **Public page never talks directly to the database with staff credentials.** It calls an Edge Function.
3. **Input checks on the server:** MIME sniffing, allowed extensions, size limits, generated storage filenames, and rate limiting.
4. **RLS is on everywhere:** only authenticated staff can read submissions; reviewers only see permitted queue data; only admins publish.
5. **Short-lived signed URLs:** audio and cover previews expire quickly and are created only for authenticated reviewers.
6. **No public contact information:** email, phone and rights confirmations never enter the public catalogue.
7. **Audit trail:** status, assignments, notes, decisions, and communications are append-only events.
8. **Deletion/withdrawal:** withdrawal revokes any public URL, unpublishes the release, then queues media deletion according to the retention policy.
9. **File scanning:** add malware scanning before expanding beyond trusted initial artists; do not serve arbitrary uploaded files as public downloads.
10. **Secrets:** Supabase service-role key and email-provider key stay in deployment secrets, never in GitHub Pages or browser JavaScript.

---

## Migration from the current live form

### Phase A — now

- Keep FormSubmit working.
- Add a `submission_source = formsubmit` record manually to the dashboard for each genuine early submission.
- Review in the dashboard; keep the email as the original evidence.

### Phase B — secure intake endpoint

- Replace FormSubmit `action` with a Next.js/Supabase upload flow.
- Browser requests a one-time upload session.
- Edge Function validates metadata, creates private upload paths, records the pending submission, and returns signed upload URLs.
- Browser uploads files directly to the private bucket, then calls a completion endpoint.
- The API marks the submission `submitted` only after both metadata and audio are present.
- Send the artist receipt email and display the existing confirmation screen.

### Phase C — public catalogue

- Replace placeholder cards/tracks with a query for `releases.is_published = true`.
- Public player uses published audio only.
- Create a separate artist-facing “confirm publication” link/token before a selected track is moved to `scheduled`.

---

## Build order

### Milestone 1 — foundation

1. Create a private Supabase project and environments.
2. Apply schema, status enum, indexes, and row-level security policies.
3. Create `admin` profile for Sihle.
4. Build protected `/review` sign-in and queue with sample submissions.

**Done when:** unauthenticated visitors cannot load submissions, and the queue filters/searches seeded records.

### Milestone 2 — review tools

1. Build submission detail page and signed audio preview.
2. Add status transitions, assignment, notes, rating, and immutable event timeline.
3. Add rights checklist and “request information” decision.
4. Add dashboard summary counts: new, waiting on artist, ready to publish, published.

**Done when:** a reviewer can process a track from `submitted` to `approved_pending_artist` without email spreadsheets.

### Milestone 3 — secure public intake

1. Build Edge Function and signed private uploads.
2. Move the public form off FormSubmit.
3. Add server-side validation, abuse protection, confirmation email, and error recovery.
4. Test mobile uploads on a typical Android connection in Ibhayi/Gqeberha.

**Done when:** a valid test submission appears in the dashboard with working private playback, while direct URLs remain inaccessible.

### Milestone 4 — approval and publishing

1. Create artist approval link and record explicit approval timestamp.
2. Build release editor and scheduled publication action.
3. Copy approved media into release storage and surface it in GQ Sounds.
4. Add withdrawal/unpublish routine.

**Done when:** only artist-approved, rights-checked tracks can become visible to listeners.

---

## Dashboard layout

```text
/review
  ├─ Overview              counts, recently submitted, work assigned to me
  ├─ Submissions           searchable queue + filters
  ├─ Submission / :id      player, metadata, rights, timeline, decisions
  ├─ Releases              scheduled and published catalogue
  ├─ Artists               repeat-submitter/contact history
  └─ Settings              staff users, templates, retention rules
```

Mobile first matters: the initial reviewer may be working from a phone between other work, so every decision must be usable in one column without drag-and-drop.

---

## Success measures for the first 30 submissions

- Every submission has a status and assigned owner within 48 hours.
- Zero unpublished audio has a public URL.
- Every publish decision has a rights confirmation, reviewer decision, and artist approval timestamp.
- A reviewer can find any submission by artist or track in under 10 seconds.
- Artists receive a clear response whether selected, awaiting information, or not selected.

---

## Before implementation

1. Create a Supabase project owned by GQ Sounds / Nyendwana Techworks.
2. Choose the review team (start with one administrator; add reviewers only when needed).
3. Confirm a retention rule for rejected files (recommended: delete after 90 days unless the artist agrees otherwise).
4. Replace the placeholder GQ Sounds contact email with the production inbox/domain when ready.
