// GQ Sounds public intake endpoint.
// Deploy with JWT verification disabled: public intake is protected here by origin,
// honeypot, optional Turnstile, strict metadata checks and one-time upload tokens.
// Required secrets: UPLOAD_TOKEN_PEPPER. Optional production secret: TURNSTILE_SECRET_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "https://sihlenye.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const BUCKET = "submissions-private";
const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_COVER = 2 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const AUDIO = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a"]);
const COVER = new Set(["image/jpeg", "image/png", "image/webp"]);

type FileInput = { filename: string; contentType: string; size: number };
type CreateInput = {
  action: "create"; artistName: string; contactName: string; email: string; whatsappNumber: string;
  area: string; genre: string; artistLink?: string; trackTitle: string; languages?: string; trackNotes?: string;
  rightsOriginalWork: boolean; reviewPermission: boolean; contactPermission: boolean; honeypot?: string;
  turnstileToken?: string; audio: FileInput; cover?: FileInput;
};
type CompleteInput = { action: "complete"; submissionId: string; uploadToken: string };

const send = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers });
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().replace(/\s+/g, " " ).slice(0, max) : "";
const emailOk = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
const nameOk = (value: string) => value.length > 0 && value.length <= 180 && !/[\\/\x00]/.test(value);
const extension = (type: string) => ({"audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/m4a":"m4a","image/jpeg":"jpg","image/png":"png","image/webp":"webp"} as Record<string,string>)[type] ?? "bin";
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
async function hash(value: string) {
  const bytes = new TextEncoder().encode(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

async function turnstileOk(value?: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return true; // Permitted only while the private build is being tested.
  if (!value) return false;
  const form = new FormData(); form.set("secret", secret); form.set("response", value);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return response.ok && (await response.json()).success === true;
}

function validate(input: CreateInput) {
  const required = [[clean(input.artistName,160),"Artist name is required."],[clean(input.contactName,160),"Contact name is required."],[clean(input.email,320),"Email is required."],[clean(input.whatsappNumber,40),"WhatsApp number is required."],[clean(input.area,160),"Area is required."],[clean(input.genre,80),"Genre is required."],[clean(input.trackTitle,200),"Track title is required."]] as const;
  for (const [value, message] of required) if (!value) return message;
  if (!emailOk(clean(input.email,320))) return "Enter a valid email address.";
  if (!input.rightsOriginalWork || !input.reviewPermission || !input.contactPermission) return "All rights and review confirmations are required.";
  if (!input.audio || !AUDIO.has(input.audio.contentType) || !Number.isInteger(input.audio.size) || input.audio.size < 1 || input.audio.size > MAX_AUDIO || !nameOk(input.audio.filename)) return "Use an MP3, WAV, or M4A file up to 8 MB.";
  if (input.cover && (!COVER.has(input.cover.contentType) || !Number.isInteger(input.cover.size) || input.cover.size < 1 || input.cover.size > MAX_COVER || !nameOk(input.cover.filename))) return "Use a JPG, PNG, or WebP cover image up to 2 MB.";
  const link = clean(input.artistLink,500);
  if (link && !/^https?:\/\//i.test(link)) return "Artist link must begin with https:// or http://.";
  return null;
}

async function objectInfo(supabase: ReturnType<typeof createClient>, path: string) {
  const cut = path.lastIndexOf("/"); const folder = path.slice(0, cut); const file = path.slice(cut + 1);
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 10, search: file });
  const item = data?.find(entry => entry.name === file);
  if (error || !item) return null;
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  return { contentType: typeof meta.mimetype === "string" ? meta.mimetype : "", size: typeof meta.size === "number" ? meta.size : Number(meta.size ?? 0) };
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return send({ error: "Method not allowed." }, 405);
  try {
    const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "https://sihlenye.github.io";
    const origin = request.headers.get("origin");
    if (origin && origin !== allowedOrigin) return send({ error: "Origin not allowed." }, 403);
    const input = await request.json();
    const url = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); const pepper = Deno.env.get("UPLOAD_TOKEN_PEPPER");
    if (!url || !key || !pepper) return send({ error: "Intake is not configured." }, 503);
    const supabase = createClient(url, key, { auth: { persistSession: false } });

    if (input.action === "create") {
      const data = input as CreateInput;
      if (clean(data.honeypot,200)) return send({ accepted: true }); // No useful response for bots.
      if (!(await turnstileOk(data.turnstileToken))) return send({ error: "Human verification failed. Please try again." }, 400);
      const invalid = validate(data); if (invalid) return send({ error: invalid }, 400);
      const id = crypto.randomUUID(); const rawToken = token(); const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString();
      const audioPath = `${id}/audio.${extension(data.audio.contentType)}`;
      const coverPath = data.cover ? `${id}/cover.${extension(data.cover.contentType)}` : null;
      const { data: artist, error: artistError } = await supabase.from("artists").insert({ stage_name: clean(data.artistName,160), contact_name: clean(data.contactName,160), email: clean(data.email,320).toLowerCase(), whatsapp_number: clean(data.whatsappNumber,40), area: clean(data.area,160), artist_link: clean(data.artistLink,500) || null }).select("id").single();
      if (artistError || !artist) throw artistError ?? new Error("Artist record was not created.");
      const { error: rowError } = await supabase.from("submissions").insert({ id, artist_id: artist.id, track_title: clean(data.trackTitle,200), genre: clean(data.genre,80), languages: clean(data.languages,250) || null, notes: clean(data.trackNotes,4000) || null, audio_path: audioPath, audio_mime_type: data.audio.contentType, cover_path: coverPath, cover_mime_type: data.cover?.contentType ?? null, rights_original_work: true, review_permission: true, contact_permission: true, upload_token_digest: await hash(`${rawToken}:${pepper}`), upload_token_expires_at: expiresAt, source: "gq-sounds-web" });
      if (rowError) throw rowError;
      const { data: audio, error: audioError } = await supabase.storage.from(BUCKET).createSignedUploadUrl(audioPath, { upsert: false });
      if (audioError || !audio) throw audioError ?? new Error("Audio upload could not be prepared.");
      let cover = null;
      if (coverPath) { const made = await supabase.storage.from(BUCKET).createSignedUploadUrl(coverPath, { upsert: false }); if (made.error || !made.data) throw made.error ?? new Error("Cover upload could not be prepared."); cover = made.data; }
      return send({ submissionId: id, uploadToken: rawToken, expiresAt, uploads: { audio: { path: audioPath, token: audio.token, signedUrl: audio.signedUrl }, cover: cover ? { path: coverPath, token: cover.token, signedUrl: cover.signedUrl } : null } }, 201);
    }

    if (input.action === "complete") {
      const data = input as CompleteInput;
      if (!/^[0-9a-f-]{36}$/i.test(data.submissionId ?? "") || !/^[0-9a-f]{64}$/i.test(data.uploadToken ?? "")) return send({ error: "Invalid upload session." }, 400);
      const { data: submission, error } = await supabase.from("submissions").select("id,audio_path,audio_mime_type,cover_path,cover_mime_type,upload_token_expires_at").eq("id", data.submissionId).eq("upload_token_digest", await hash(`${data.uploadToken}:${pepper}`)).eq("status", "uploading").maybeSingle();
      if (error) throw error;
      if (!submission || new Date(submission.upload_token_expires_at).getTime() < Date.now()) return send({ error: "This upload session has expired. Please start again." }, 410);
      const audio = await objectInfo(supabase, submission.audio_path);
      if (!audio || !AUDIO.has(audio.contentType) || audio.contentType !== submission.audio_mime_type || !Number.isFinite(audio.size) || audio.size < 1 || audio.size > MAX_AUDIO) return send({ error: "Audio upload is missing or did not pass validation." }, 400);
      let cover: { contentType: string; size: number } | null = null;
      if (submission.cover_path) { cover = await objectInfo(supabase, submission.cover_path); if (!cover || !COVER.has(cover.contentType) || cover.contentType !== submission.cover_mime_type || !Number.isFinite(cover.size) || cover.size < 1 || cover.size > MAX_COVER) return send({ error: "Cover upload is missing or did not pass validation." }, 400); }
      const { error: updateError } = await supabase.from("submissions").update({ audio_size_bytes: audio.size, cover_size_bytes: cover?.size ?? null, status: "submitted", submitted_at: new Date().toISOString(), upload_token_digest: await hash(`${token()}:${pepper}`), upload_token_expires_at: new Date().toISOString() }).eq("id", submission.id);
      if (updateError) throw updateError;
      return send({ accepted: true, submissionId: submission.id }, 201);
    }
    return send({ error: "Unknown action." }, 400);
  } catch (error) {
    console.error("create-submission error", error instanceof Error ? error.message : "unknown");
    return send({ error: "We could not process the submission. Please try again." }, 500);
  }
});
