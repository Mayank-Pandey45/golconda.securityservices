-- READ ONLY. Run after an approved migration; every row should have passed=true.
with managed(name) as (select unnest(array['guards','supervisors','field_officers','sites',
 'services','events','notifications','profile_docs','contact_submissions','job_applications','complaints'])),
required_columns(tbl,col,typ) as (
 select name,'archived_at','timestamp with time zone' from managed
 union all select name,'archived_by','uuid' from managed
 union all select 'services','is_active','boolean'
 union all select 'events','is_active','boolean'
 union all select unnest(array['contact_submissions','job_applications','complaints']),'admin_notes','text'
),
rpc(signature) as (values
 ('public.manage_admin_record(text,bigint,text,jsonb,text,uuid)'),
 ('public.queue_media_cleanup(text,text,uuid)'),
 ('public.claim_media_cleanup(bigint,uuid)'),
 ('public.complete_media_cleanup(bigint,uuid,boolean,uuid)')),
checks as (
 select 'column:'||r.tbl||'.'||r.col as check_name,
 exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=r.tbl and c.column_name=r.col and c.data_type=r.typ) as passed
 from required_columns r
 union all
 select 'archive-index:'||name,to_regclass('public.'||name||'_archive_idx') is not null from managed
 union all
 select 'RLS:'||name,coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.'||name)),false) from managed
 union all
 select 'browser-write-revoked:'||name,
 not has_table_privilege('authenticated','public.'||name,'INSERT')
 and not has_table_privilege('authenticated','public.'||name,'UPDATE')
 and not has_table_privilege('authenticated','public.'||name,'DELETE') from managed
 union all
 select 'lifecycle-trigger:'||name,exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||name) and tgname='record_lifecycle_guard' and tgenabled='O') from managed
 union all
 select 'RPC-present:'||signature,to_regprocedure(signature) is not null from rpc
 union all
 select 'RPC-admin-browser-denied:'||signature,not has_function_privilege('authenticated',to_regprocedure(signature),'EXECUTE') from rpc
 union all
 select 'RPC-anon-denied:'||signature,not has_function_privilege('anon',to_regprocedure(signature),'EXECUTE') from rpc
 union all
 select 'RPC-service-allowed:'||signature,has_function_privilege('service_role',to_regprocedure(signature),'EXECUTE') from rpc
 union all
 select 'queue-RLS',coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.media_cleanup_queue')),false)
 union all
 select 'queue-browser-write-denied',not has_table_privilege('authenticated','public.media_cleanup_queue','INSERT') and not has_table_privilege('authenticated','public.media_cleanup_queue','UPDATE') and not has_table_privilege('authenticated','public.media_cleanup_queue','DELETE')
 union all
 select 'compensation-delete-guard',exists(select 1 from pg_trigger where tgrelid='public.employee_compensation'::regclass and tgname='retain_compensation_history' and tgenabled='O')
 union all
 select 'no-client-truncate:'||rol,not exists(select 1 from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and has_table_privilege(rol,c.oid,'TRUNCATE')) from (values('anon'),('authenticated'))r(rol)
 union all
 select 'public-content-restrictive:'||name,exists(select 1 from pg_policies where schemaname='public' and tablename=name and permissive='RESTRICTIVE' and cmd='SELECT') from managed where name in('services','events','notifications','profile_docs')
 union all
 select 'storage-restrictive:'||cmd,exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and permissive='RESTRICTIVE' and pg_policies.cmd=expected.cmd) from (values('DELETE'),('UPDATE'))expected(cmd)
)
select check_name,coalesce(passed,false) as passed from checks order by check_name;
