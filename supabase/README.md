# GQ Sounds Supabase Foundation

This folder prepares private artist intake and review. The public GitHub Pages form remains on FormSubmit until a Supabase project is created and this foundation is deployed.

## Included

- Migration for staff roles, artists, submissions, audit timeline, RLS, and a private storage bucket.
- A create-submission Edge Function that creates one-time private upload sessions and validates completion.
- Public function configuration and a secret variable template with no usable credentials.

## Deployment order

1. Create a private Supabase project owned by GQ Sounds or Nyendwana Techworks.
2. Link the Supabase CLI. Never put the service-role key into GitHub Pages.
3. Generate a high-entropy UPLOAD_TOKEN_PEPPER.
4. Create a Cloudflare Turnstile widget before wide public launch.
5. Apply the migration, set secrets, and deploy the Edge Function.

Commands: supabase link --project-ref YOUR_PROJECT_REF; supabase db push; supabase functions deploy create-submission --no-verify-jwt.

## Intake protocol

1. Public form calls create-submission with action create.
2. The function returns short-lived signed upload URLs for submissions-private.
3. Browser uploads media, then calls action complete with its one-time token.
4. The function verifies MIME type and size before moving the record from uploading to submitted.

## Security

- Submitted media has no public bucket or browser storage policy.
- The database stores only a digest of the temporary completion token.
- RLS limits review data to authenticated staff.
- Only an admin role can set status to published.
- Database triggers record creation, status, and assignment changes.
- Dashboard previews must use short-lived signed read URLs created server-side.

## First administrator

After the review user signs in, add the real UUID from Supabase Authentication Users: insert into public.staff_profiles with the user UUID, display name Sihle Nyendwana, and admin role.

## Before switching the live form

Use a non-sensitive test MP3 and confirm: private media has no public URL; a completed submission is submitted; an audit event exists; anonymous users cannot read contact data; and only an admin can publish.
