-- One line per fact about a database; a faithful restore yields the same lines
-- (scripts/restore-drill.ts, and the data chart's restore drill). Each table's hash is the
-- sum of its rows' 64-bit hashes, so row order doesn't matter and Postgres streams it
-- without holding the table in memory. It still reads every table in full, which bounds
-- how large a database it suits.
select format('table %s rows=%s hash=%s rls=%s forced=%s', c.oid::regclass,
    (xpath('/row/n/text()', t))[1], (xpath('/row/h/text()', t))[1],
    c.relrowsecurity, c.relforcerowsecurity)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral query_to_xml(format(
    'select count(*) as n, coalesce(sum(hashtextextended(r::text, 0)::numeric), 0) as h from %s r',
    c.oid::regclass), false, true, '') as t
  where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
union all
select format('policy %I.%I %s %s %s roles=%s using=%s check=%s', schemaname, tablename,
    policyname, permissive, cmd, roles, qual, with_check)
  from pg_policies
union all
select format('grant %s %s on %I.%I', grantee, privilege_type, table_schema, table_name)
  from information_schema.role_table_grants
  where table_schema not in ('pg_catalog', 'information_schema')
union all
select format('schema %I owner=%s acl=%s', nspname, nspowner::regrole, nspacl)
  from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema'
union all
select format('default-acl %s in %s: %s', defaclrole::regrole, defaclnamespace::regnamespace, defaclacl)
  from pg_default_acl
union all
select format('function %s owner=%s definer=%s acl=%s', p.oid::regprocedure,
    p.proowner::regrole, p.prosecdef, p.proacl)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e')
union all
select format('trigger %s on %s', tgname, tgrelid::regclass) from pg_trigger where not tgisinternal
union all
select format('extension %s %s', extname, extversion) from pg_extension
union all
select format('sequence %I.%I last=%s', schemaname, sequencename, last_value) from pg_sequences
order by 1;
