-- =====================================================================
--  PageSync — Supabase setup
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--  It is safe to run again (e.g. after updating PageSync).
-- =====================================================================

-- ---------------------------------------------------------------- tables

create table if not exists public.documents (
  id               text primary key check (id ~ '^[A-Za-z0-9_-]{6,32}$'),
  owner            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 200),
  size             bigint not null default 0,
  page_count       integer,
  position         jsonb,          -- { page, offset, device, clientId, at }
  thumb            text check (thumb is null or octet_length(thumb) < 150000),  -- small JPEG data URL
  annotation_count integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_opened_at   timestamptz
);
create index if not exists documents_owner_idx on public.documents (owner);

-- One row per highlight / drawing / text box / note.
-- Deleted marks are kept as "tombstones" (deleted = true) so a device that was
-- offline can't bring them back by accident.
create table if not exists public.annotations (
  doc_id     text not null references public.documents (id) on delete cascade,
  id         text not null check (id ~ '^[A-Za-z0-9_-]{4,64}$'),
  owner      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint not null,      -- milliseconds, set by the device that made the edit
  primary key (doc_id, id)
);
create index if not exists annotations_owner_idx on public.annotations (owner);

-- ------------------------------------------- big files + multi-user (v3)
-- Where each PDF lives: 'supabase' (Supabase Storage, 50 MB max on free plan)
-- or 'r2' (Cloudflare R2 / any S3-compatible storage, via the pdf-storage function).

alter table public.documents add column if not exists storage text not null default 'supabase';
alter table public.documents drop constraint if exists documents_storage_check;
alter table public.documents add constraint documents_storage_check check (storage in ('supabase', 'r2'));
alter table public.documents drop constraint if exists documents_size_check;
alter table public.documents add constraint documents_size_check check (size >= 0);

-- Uploads in progress (counted toward the user's quota). Only the server function touches this.
create table if not exists public.upload_reservations (
  doc_id     text primary key check (doc_id ~ '^[A-Za-z0-9_-]{6,32}$'),
  owner      uuid not null references auth.users (id) on delete cascade,
  size       bigint not null check (size > 0),
  name       text,
  upload_id  text,
  created_at timestamptz not null default now()
);
alter table public.upload_reservations enable row level security;
revoke all on public.upload_reservations from anon, authenticated;
grant all on public.upload_reservations to service_role;

-- Bytes a user is using (finished files + uploads started in the last 6 hours).
create or replace function public.storage_used(p_owner uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce((select sum(size) from documents where owner = p_owner), 0)
       + coalesce((select sum(size) from upload_reservations
                    where owner = p_owner and created_at > now() - interval '6 hours'), 0);
$$;
revoke execute on function public.storage_used(uuid) from public, anon, authenticated;
grant  execute on function public.storage_used(uuid) to service_role;

-- Users can rename their documents and save their reading position, but they can't
-- fake a file's size or where it is stored (that would let them dodge their quota).
create or replace function public.protect_document_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.storage <> 'supabase' then
        raise exception 'Cloud uploads must go through the pdf-storage function' using errcode = '42501';
      end if;
    elsif new.size is distinct from old.size
       or new.storage is distinct from old.storage
       or new.owner is distinct from old.owner
       or new.id is distinct from old.id then
      raise exception 'These document fields cannot be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_document_fields on public.documents;
create trigger protect_document_fields
  before insert or update on public.documents
  for each row execute function public.protect_document_fields();

-- ------------------------------------------------ AI "Explain" usage (v4)
-- Counts explanations per person per day, so the free AI quota is shared fairly.
create table if not exists public.ai_usage (
  owner uuid not null references auth.users (id) on delete cascade,
  day   date not null default (now() at time zone 'utc')::date,
  count integer not null default 0,
  primary key (owner, day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
grant all on public.ai_usage to service_role;

-- Adds one to today's count and returns it, or returns -1 if the daily limit is already reached.
create or replace function public.bump_ai_usage(p_owner uuid, p_limit integer)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into ai_usage as u (owner, day, count)
  values (p_owner, (now() at time zone 'utc')::date, 1)
  on conflict (owner, day) do update set count = u.count + 1
    where u.count < p_limit
  returning count into v_count;
  return coalesce(v_count, -1);
end;
$$;
revoke execute on function public.bump_ai_usage(uuid, integer) from public, anon, authenticated;
grant  execute on function public.bump_ai_usage(uuid, integer) to service_role;

-- ------------------------------------------------------- row level security
-- Every row belongs to the signed-in user who created it. Nobody else can
-- read or change it, even with the public key.

alter table public.documents   enable row level security;
alter table public.annotations enable row level security;

drop policy if exists "Own documents" on public.documents;
create policy "Own documents" on public.documents
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

drop policy if exists "Own annotations" on public.annotations;
create policy "Own annotations" on public.annotations
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

revoke all on public.documents, public.annotations from anon;

-- --------------------------------------------- saving changes (sync logic)
-- Applies a batch of edits from one device in a single request.
--   {"type":"upsert","ann":{...},"restore":false}   add / change a mark
--   {"type":"delete","id":"...","at":1700000000000} remove a mark
-- Rules: the newest edit wins; a deleted mark stays deleted unless it is
-- restored on purpose (undo).

create or replace function public.apply_annotation_ops(p_doc text, p_ops jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  op      jsonb;
  v_ann   jsonb;
  v_id    text;
  v_ts    bigint;
  v_rows  integer;
  v_total integer := 0;
begin
  if not exists (select 1 from documents where id = p_doc) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) > 500 then
    raise exception 'Expected an array of at most 500 operations' using errcode = '22023';
  end if;

  for op in select value from jsonb_array_elements(p_ops) loop
    v_rows := 0;

    if op->>'type' = 'upsert' then
      v_ann := op->'ann';
      v_id  := v_ann->>'id';
      continue when v_id is null or v_id !~ '^[A-Za-z0-9_-]{4,64}$';
      continue when octet_length(v_ann::text) > 200000;
      v_ts := coalesce(nullif(v_ann->>'updatedAt', '')::bigint, 0);

      insert into annotations as a (doc_id, id, data, deleted, updated_at)
      values (p_doc, v_id, v_ann, false, v_ts)
      on conflict (doc_id, id) do update
        set data = excluded.data, deleted = false, updated_at = excluded.updated_at
        where a.updated_at <= excluded.updated_at
          and (not a.deleted or coalesce((op->>'restore')::boolean, false));
      get diagnostics v_rows = row_count;

    elsif op->>'type' = 'delete' then
      v_id := op->>'id';
      continue when v_id is null or v_id !~ '^[A-Za-z0-9_-]{4,64}$';
      v_ts := coalesce(nullif(op->>'at', '')::bigint, (extract(epoch from clock_timestamp()) * 1000)::bigint);

      insert into annotations as a (doc_id, id, data, deleted, updated_at)
      values (p_doc, v_id, null, true, v_ts)
      on conflict (doc_id, id) do update
        set data = null, deleted = true, updated_at = greatest(a.updated_at, excluded.updated_at)
        where not a.deleted;
      get diagnostics v_rows = row_count;
    end if;

    v_total := v_total + v_rows;
  end loop;

  if v_total > 0 then
    update documents
       set annotation_count = (select count(*) from annotations where doc_id = p_doc and not deleted),
           updated_at = now()
     where id = p_doc;
  end if;
  return v_total;
end;
$$;

revoke execute on function public.apply_annotation_ops(text, jsonb) from public, anon;
grant  execute on function public.apply_annotation_ops(text, jsonb) to authenticated;

-- -------------------------------------------------------- file storage
-- Private bucket. Files live at  <your user id>/<document id>.pdf
-- 50 MB is the largest single file the free plan allows.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 52428800, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 52428800, allowed_mime_types = array['application/pdf'];

drop policy if exists "PageSync read own files"   on storage.objects;
drop policy if exists "PageSync upload own files" on storage.objects;
drop policy if exists "PageSync update own files" on storage.objects;
drop policy if exists "PageSync delete own files" on storage.objects;

create policy "PageSync read own files" on storage.objects
  for select to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "PageSync upload own files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "PageSync update own files" on storage.objects
  for update to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "PageSync delete own files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------- live updates
-- Lets open devices hear about changes instantly.

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents') then
    alter publication supabase_realtime add table public.documents;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'annotations') then
    alter publication supabase_realtime add table public.annotations;
  end if;
end $$;

-- Done! Next: deploy the pdf-storage function (see README) for files up to 300 MB.
