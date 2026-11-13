-- Update 064: phone numbers from any country in the Google Sheets import.
-- Apply after 063. Safe to rerun.
--
-- The server now reads each Sheet row's number with its country's numbering
-- rules and sends it in E.164 (+, country code, digits), the form every lead
-- number is already stored in, so the same customer is found whichever way
-- the number was written. The database stores numbers as before; this update
-- lets it record more exactly why a row was refused:
-- * phone_missing: the phone cell is empty;
-- * phone_needs_country: a number without a country code that is not a
--   Pakistani number;
-- * phone_invalid now means "not a valid number for its country".
--
-- No row changes: existing numbers, leads and import history stay as they
-- are. Changed: the rejection reasons' check on
-- crm_private.sheet_row_rejections. Checked edit: sheet_sync_import's list
-- of reasons.
begin;
set local lock_timeout='5s';
do $$ begin
 if to_regprocedure('public.report_team(uuid,timestamptz,timestamptz)') is null
  or to_regprocedure('public.sheet_sync_import(text,uuid,jsonb,text)') is null
  or to_regclass('crm_private.sheet_row_rejections') is null then
  raise exception 'Apply CRM updates up to 063 before update 064.';
 end if;
end $$;

-- The reasons a Sheet row can be refused: update 056's and the two new
-- ones. The old check must list exactly 056's reasons.
do $$
declare def text;found text[];
begin
 select pg_get_constraintdef(oid) into def from pg_constraint
  where conrelid='crm_private.sheet_row_rejections'::regclass and conname='sheet_row_rejections_reason_check';
 select array_agg(m[1] order by m[1]) into found from regexp_matches(coalesce(def,''),'''([a-z_]+)''','g') m;
 if found=array['date_missing','id_invalid','lead_deleted','name_missing','name_too_long','phone_invalid',
   'phone_missing','phone_needs_country','value_too_long'] then return;end if;
 if found is distinct from array['date_missing','id_invalid','lead_deleted','name_missing','name_too_long','phone_invalid','value_too_long'] then
  raise exception 'Update 064 found an unexpected version of the Google Sheets rejection reasons: apply CRM updates up to 063 exactly.';
 end if;
 alter table crm_private.sheet_row_rejections drop constraint sheet_row_rejections_reason_check;
 alter table crm_private.sheet_row_rejections add constraint sheet_row_rejections_reason_check
  check(reason in ('id_invalid','phone_invalid','phone_missing','phone_needs_country','name_missing','name_too_long',
   'date_missing','lead_deleted','value_too_long'));
end $$;

-- A small, checked edit, as in updates 061 and 063: the text must appear
-- exactly once, or the update stops and changes nothing. On a rerun the
-- edited text is found and left alone.
do $patch$
declare body text;n integer;
 old_text text=$t$if r->>'error' not in ('id_invalid','phone_invalid','name_missing','name_too_long','date_missing','value_too_long') then$t$;
 new_text text=$t$if r->>'error' not in ('id_invalid','phone_invalid','phone_missing','phone_needs_country','name_missing','name_too_long','date_missing','value_too_long') then$t$;
begin
 body=pg_get_functiondef('public.sheet_sync_import(text,uuid,jsonb,text)'::regprocedure);
 if position(new_text in body)>0 then return;end if;
 n=(length(body)-length(replace(body,old_text,'')))/length(old_text);
 if n<>1 then
  raise exception 'Update 064 found an unexpected version of public.sheet_sync_import(text,uuid,jsonb,text): apply CRM updates up to 063 exactly.';
 end if;
 execute replace(body,old_text,new_text);
end $patch$;
commit;
