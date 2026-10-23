-- READ ONLY. May be used for production metadata review or isolated validation.
-- Do not run migrations based solely on this report. Review missing prerequisites.
select name, to_regclass('public.'||name) is not null as present
from unnest(array['guards','sites','supervisors','field_officers','services','events',
 'notifications','profile_docs','contact_submissions','job_applications','complaints',
 'employee_compensation','guard_site_assignments','supervisor_site_assignments',
 'field_officer_site_assignments','supervisor_reporting','advances','advance_adjustments',
 'advance_recoveries','salary_adjustments','operations_audit_log','advance_sheet_sync_outbox','admin_users']) name;
select current_setting('server_version') as postgres_version,
 to_regclass('auth.users') is not null as auth_users_present,
 to_regclass('storage.objects') is not null as storage_objects_present;
select c.relname,c.relrowsecurity,pg_total_relation_size(c.oid) as bytes
from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r';
with required(table_name,column_name) as (values
 ('admin_users','user_id'),('guards','photo_storage_path'),('guards','site_id'),
 ('guards','employment_end_date'),('guards','phone_normalized'),
 ('supervisors','photo_storage_path'),('supervisors','employment_end_date'),
 ('field_officers','photo_storage_path'),('field_officers','employment_end_date'),
 ('sites','status'),('profile_docs','storage_path'),('profile_docs','file_url'),
 ('profile_docs','category'),('profile_docs','is_public'),
 ('notifications','is_published'),('notifications','is_active'),
 ('notifications','starts_at'),('notifications','expires_at'),
 ('operations_audit_log','before_data'),('operations_audit_log','after_data'),
 ('operations_audit_log','record_id'),('complaints','resolved_at'))
select r.*,c.data_type,c.is_nullable,c.column_name is not null as present
from required r left join information_schema.columns c on c.table_schema='public'
and c.table_name=r.table_name and c.column_name=r.column_name;
select table_name,grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and grantee in ('PUBLIC','anon','authenticated','service_role')
order by table_name,grantee,privilege_type;
-- Aggregate-only prerequisite check; no employee names or phone numbers returned.
select 'guards' as table_name,count(*) as duplicate_phone_groups from
 (select phone_normalized from public.guards where phone_normalized<>'' group by phone_normalized having count(*)>1) q
union all select 'supervisors',count(*) from
 (select phone_normalized from public.supervisors where phone_normalized<>'' group by phone_normalized having count(*)>1) q
union all select 'field_officers',count(*) from
 (select phone_normalized from public.field_officers where phone_normalized<>'' group by phone_normalized having count(*)>1) q;
select 'audit trigger helper' as prerequisite,
 to_regprocedure('operations_private.audit_operations_change()') is not null as present;
select table_name,column_name,data_type from information_schema.columns
where table_schema='public' and
 ((column_name in ('status','site_id','storage_path','photo_storage_path','archived_at','archived_by','is_active','is_public','admin_notes'))
 or table_name='operations_audit_log')
order by table_name,column_name;
select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies where schemaname in ('public','storage') order by schemaname,tablename,policyname;
select conrelid::regclass as child,confrelid::regclass as parent,pg_get_constraintdef(oid)
from pg_constraint where contype='f' and connamespace='public'::regnamespace;
select proname,prosecdef,proconfig,proacl from pg_proc
where pronamespace in ('public'::regnamespace,to_regnamespace('operations_private'))
and proname in ('save_employee_profile','save_guard_profile','save_site_with_assignments',
 'sync_guard_legacy_assignment','sync_guard_legacy_site_pointer','audit_operations_change',
 'manage_admin_record','queue_media_cleanup','claim_media_cleanup','complete_media_cleanup');
select id,public,file_size_limit,allowed_mime_types from storage.buckets
where id in ('employee-private','company-profile');
select version,name from supabase_migrations.schema_migrations order by version;
