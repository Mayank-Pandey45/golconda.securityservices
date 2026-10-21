-- READ-ONLY staging preflight. Run in the SQL editor of the explicitly
-- identified, isolated staging project only. This script performs no DDL/DML.
-- It requires the two baseline migration versions and reports remaining ones.
do $preflight$
declare
  missing_tables text[];
  missing_columns text[];
  missing_baseline text[];
  pending_migrations text[];
  public_buckets text[];
  missing_buckets text[];
  migration_versions text[] := array[
    '20261007160814',
    '20261007160935',
    '20261008164000',
    '20261021151502',
    '20261021191500'
  ];
  target_table text;
  duplicate_groups bigint;
  id_type text;
begin
  select array_agg(format('%I.%I', required.schema_name, required.table_name) order by required.schema_name, required.table_name)
  into missing_tables
  from (values
    ('public', 'services'),
    ('public', 'events'),
    ('public', 'notifications'),
    ('public', 'complaints'),
    ('public', 'sites'),
    ('public', 'guards'),
    ('public', 'contact_submissions'),
    ('public', 'job_applications'),
    ('public', 'profile_docs'),
    ('public', 'admin_users'),
    ('auth', 'users'),
    ('storage', 'buckets'),
    ('storage', 'objects'),
    ('supabase_migrations', 'schema_migrations')
  ) as required(schema_name, table_name)
  where to_regclass(format('%I.%I', required.schema_name, required.table_name)) is null;

  if missing_tables is not null then
    raise exception 'Preflight failed: missing required tables/schemas: %', array_to_string(missing_tables, ', ');
  end if;

  select array_agg(format('public.%I.%I', required.table_name, required.column_name) order by required.table_name, required.column_name)
  into missing_columns
  from (values
    ('services', 'id'), ('services', 'title'), ('services', 'description'),
    ('events', 'id'), ('events', 'title'), ('events', 'description'),
    ('notifications', 'id'), ('notifications', 'title'), ('notifications', 'message'),
    ('complaints', 'id'), ('complaints', 'created_at'),
    ('sites', 'id'), ('sites', 'title'), ('sites', 'phone_numbers'), ('sites', 'total_salary'), ('sites', 'service_taken'), ('sites', 'given_emails'),
    ('guards', 'id'), ('guards', 'full_name'), ('guards', 'phone'), ('guards', 'email'), ('guards', 'designation'), ('guards', 'status'), ('guards', 'joining_date'), ('guards', 'site_id'), ('guards', 'created_at'), ('guards', 'updated_at'),
    ('contact_submissions', 'id'), ('contact_submissions', 'name'), ('contact_submissions', 'email'), ('contact_submissions', 'message'), ('contact_submissions', 'created_at'),
    ('job_applications', 'id'), ('job_applications', 'full_name'), ('job_applications', 'email'), ('job_applications', 'created_at'),
    ('profile_docs', 'id'), ('profile_docs', 'title'), ('profile_docs', 'description'), ('profile_docs', 'file_url'), ('profile_docs', 'created_at'),
    ('admin_users', 'user_id')
  ) as required(table_name, column_name)
  where not exists (
    select 1 from information_schema.columns actual
    where actual.table_schema = 'public'
      and actual.table_name = required.table_name
      and actual.column_name = required.column_name
  );

  if missing_columns is not null then
    raise exception 'Preflight failed: missing required columns: %', array_to_string(missing_columns, ', ');
  end if;

  foreach target_table in array array['sites', 'guards'] loop
    id_type := null;
    select data_type into id_type
    from information_schema.columns actual
    where actual.table_schema = 'public' and actual.table_name = target_table and actual.column_name = 'id';
    if id_type not in ('bigint', 'integer') then
      raise exception 'Preflight failed: public.%.id must be an integer type compatible with the new foreign keys.', target_table;
    end if;
  end loop;

  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'Preflight failed: Supabase migration history is unavailable.';
  end if;

  execute $history$
    select coalesce(array_agg(required.version), array[]::text[])
    from unnest($1::text[]) as required(version)
    where not exists (
      select 1 from supabase_migrations.schema_migrations applied
      where applied.version::text = required.version
    )
  $history$ into missing_baseline using migration_versions[1:2];

  if cardinality(missing_baseline) > 0 then
    raise exception 'Preflight failed: baseline migration history is missing versions %. Reconcile schema history before applying anything.', array_to_string(missing_baseline, ', ');
  end if;

  execute $history$
    select coalesce(array_agg(required.version), array[]::text[])
    from unnest($1::text[]) as required(version)
    where not exists (
      select 1 from supabase_migrations.schema_migrations applied
      where applied.version::text = required.version
    )
  $history$ into pending_migrations using migration_versions;

  -- The migrations create these buckets if absent. If either is already
  -- public, stop for review because the migration will make it private.
  select array_agg(bucket.id order by bucket.id)
  into public_buckets
  from storage.buckets bucket
  where bucket.id in ('company-profile', 'employee-private') and bucket.public;

  if public_buckets is not null then
    raise exception 'Preflight failed: buckets currently marked public must be reviewed before migration: %', array_to_string(public_buckets, ', ');
  end if;

  select array_agg(required.bucket_id order by required.bucket_id)
  into missing_buckets
  from (values ('company-profile'), ('employee-private')) as required(bucket_id)
  where not exists (select 1 from storage.buckets bucket where bucket.id = required.bucket_id);

  -- Match the normalization expression used by the generated phone columns.
  -- Check existing people before creating the unique indexes; do not print
  -- phone values into SQL editor output.
  foreach target_table in array array['guards', 'supervisors', 'field_officers'] loop
    if to_regclass(format('public.%I', target_table)) is not null
       and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = target_table and c.column_name = 'phone') then
      execute format($duplicates$
        select count(*) from (
          select normalized_phone
          from (
            select case
              when length(digits) = 12 and left(digits, 2) = '91' then substring(digits from 3)
              when length(digits) = 11 and left(digits, 1) = '0' then substring(digits from 2)
              else digits
            end as normalized_phone
            from (
              select regexp_replace(coalesce(phone, ''), '\D', '', 'g') as digits
              from public.%I
            ) phone_digits
          ) normalized
          where normalized_phone <> ''
          group by normalized_phone
          having count(*) > 1
        ) duplicates
      $duplicates$, target_table) into duplicate_groups;

      if duplicate_groups > 0 then
        raise exception 'Preflight failed: public.% has % duplicate normalized phone groups. Resolve them without deleting legitimate people before applying the unique index.', target_table, duplicate_groups;
      end if;
    end if;
  end loop;

  raise notice 'Preflight passed: prerequisites and storage privacy checks are satisfied.';
  raise notice 'Pending repository migrations: %', coalesce(array_to_string(pending_migrations, ', '), 'none');
  raise notice 'Required private buckets already present: %', coalesce((select string_agg(bucket.id, ', ' order by bucket.id) from storage.buckets bucket where bucket.id in ('company-profile', 'employee-private')), 'none');
  raise notice 'Buckets to be created by the pending migrations: %', coalesce(array_to_string(missing_buckets, ', '), 'none');
  raise notice 'This script made no changes.';
end;
$preflight$;
