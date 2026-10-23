import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isolatedDatabase, migration } from "../supabase/tests/isolatedDatabase.js";

const admin="00000000-0000-4000-8000-000000000001";
const outsider="00000000-0000-4000-8000-000000000002";
const seed=`
 insert into auth.users values ('${admin}'),('${outsider}');
 insert into public.admin_users(user_id) values ('${admin}');
 insert into public.sites(id,title) values(101,'Synthetic site A'),(102,'Synthetic site B');
 insert into public.guards(id,full_name,phone,joining_date,site_id) values(201,'Synthetic guard','9999900001','2026-10-01',101);
 insert into public.supervisors(id,full_name,phone,joining_date) values(301,'Synthetic supervisor','9999900002','2026-10-01');
 insert into public.field_officers(id,full_name,phone,joining_date) values(401,'Synthetic field officer','9999900003','2026-10-01');
 insert into public.guard_site_assignments(guard_id,site_id,valid_from) values(201,102,'2026-10-01');
 insert into public.supervisor_site_assignments(supervisor_id,site_id,valid_from) values(301,101,'2026-10-01');
 insert into public.field_officer_site_assignments(field_officer_id,site_id,valid_from) values(401,101,'2026-10-01');
 insert into public.supervisor_reporting(supervisor_id,field_officer_id,valid_from) values(301,401,'2026-10-01');
 insert into public.employee_compensation(employee_type,guard_id,gross_monthly_salary,effective_from) values('guard',201,31000,'2026-10-01');
 insert into public.employee_compensation(employee_type,supervisor_id,gross_monthly_salary,effective_from) values('supervisor',301,40000,'2026-10-01');
 insert into public.employee_compensation(employee_type,field_officer_id,gross_monthly_salary,effective_from) values('field_officer',401,50000,'2026-10-01');
 insert into public.advances(id,employee_type,guard_id,site_id,amount,occurred_at,recorded_by) values(501,'guard',201,101,1000,'2026-10-15T04:30:00Z','${admin}');
 insert into public.advance_adjustments(advance_id,adjustment_type,amount_delta,reason) values(501,'correction',100,'Synthetic correction');
 insert into public.advance_recoveries(advance_id,salary_period,amount) values(501,'2026-10-01',100);
 insert into public.salary_adjustments(employee_type,guard_id,salary_period,adjustment_type,amount,description) values('guard',201,'2026-10-01','addition',100,'Synthetic addition');
 insert into public.services(id,title) values(601,'Synthetic service');
 insert into public.events(id,title) values(701,'Synthetic event');
 insert into public.notifications(id,title,message) values(801,'Synthetic notice','Synthetic text');
 insert into storage.objects(bucket_id,name) values('company-profile','gallery/a.jpg'),('company-profile','licence.pdf'),('company-profile','orphan.jpg'),('company-profile','replacement.jpg');
 insert into public.profile_docs(id,title,storage_path,is_public,category) values(901,'Synthetic gallery','gallery/a.jpg',true,'Gallery'),(902,'Synthetic compliance','licence.pdf',false,'Registration & Compliance');
 insert into public.contact_submissions(id,name,email,message,service) values(1001,'Synthetic enquiry','synthetic@example.invalid','Original evidence','Synthetic service');
 insert into public.job_applications(id,full_name,email,message) values(1101,'Synthetic applicant','synthetic@example.invalid','Original evidence');
 insert into public.complaints(id,complainant_name,phone,subject,details) values(1201,'Synthetic complainant','9999900004','Synthetic subject','Original evidence');
`;

test("isolated PostgreSQL executes production-schema lifecycle, RLS, history and cleanup regressions",async t=>{
 const db=await isolatedDatabase();
 const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
 const action=async(table,id,kind,patch={},confirmation="")=>scalar("select public.manage_admin_record($1,$2,$3,$4::jsonb,$5,$6::uuid)",[table,id,kind,JSON.stringify(patch),confirmation,admin]);
 const denied=async(sql,params,code)=>{
   await db.exec("savepoint expected_failure");
   try{await assert.rejects(db.query(sql,params),e=>e.code===code);}finally{await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure");}
 };
 const run=async(name,role,uid,fn)=>t.test(name,async()=>{
   await db.exec(`begin;set local role ${role}`);
   await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||""]);
   try{await fn();}finally{await db.exec("rollback");}
 });
 try {
   const engine=await scalar("select current_setting('server_version_num')::int");
   assert.equal(Math.floor(engine/10000),17,"Use the PostgreSQL 17 validation engine matching production's major version");
   await db.exec(seed);
   const before=await scalar("select public.get_payroll_summary('2026-10-01',$1::uuid)",[admin]);
   await db.exec(migration);
   await t.test("read-only postflight checks pass for the migrated schema",async()=>{
     const sql=await readFile(new URL("../supabase/postflight_record_management.sql",import.meta.url),"utf8");
     const result=await db.query(sql);
     assert.ok(result.rows.length>60);
     assert.deepEqual(result.rows.filter(row=>!row.passed),[]);
   });
   await run("migration preserves existing payroll and all financial rows", "service_role",admin,async()=>{
     assert.deepEqual(await scalar("select public.get_payroll_summary('2026-10-01',$1::uuid)",[admin]),before);
     for(const [table,count] of [["employee_compensation",3],["advances",1],["advance_adjustments",1],["advance_recoveries",1],["salary_adjustments",1]])assert.equal(Number(await scalar(`select count(*) from public.${table}`)),count);
     assert.equal(Number(await scalar("select count(*) from public.advance_sheet_sync_outbox")),0);
   });
   await run("anonymous content filtering and private data denial", "anon",null,async()=>{
     assert.equal(Number(await scalar("select count(*) from public.services")),1);
     assert.equal(await scalar("select public.record_admin_access()"),false);
     for(const table of ["guards","employee_compensation","advances","operations_audit_log","advance_sheet_sync_outbox","media_cleanup_queue","complaints"]){
       // Existing deployments either revoke SELECT or permit SELECT with an empty RLS result.
       if(await scalar("select has_table_privilege(current_user,$1,'SELECT')",['public.'+table]))assert.equal(Number(await scalar(`select count(*) from public.${table}`)),0);
       else await denied(`select * from public.${table}`,[],"42501");
     }
     await denied("select public.manage_admin_record('services',601,'archive','{}','','"+admin+"')",[],"42501");
   });
   await run("non-admin cannot see private records, cleanup or invoke privileged RPC", "authenticated",outsider,async()=>{
     for(const table of ["guards","supervisors","field_officers","sites","employee_compensation","advances","operations_audit_log","advance_sheet_sync_outbox","media_cleanup_queue","contact_submissions","job_applications","complaints"])assert.equal(Number(await scalar(`select count(*) from public.${table}`)),0,table);
     await denied("select public.manage_admin_record('services',601,'archive','{}','','"+admin+"')",[],"42501");
   });
   await run("admin browser retains reads but direct metadata mutation is denied", "authenticated",admin,async()=>{
     assert.equal(Number(await scalar("select count(*) from public.guards")),1);
     assert.equal(await scalar("select public.record_admin_access()"),true);
     for(const table of ["guards","services","events","profile_docs","complaints"])await denied(`delete from public.${table}`,[],"42501");
     await denied("update public.employee_compensation set gross_monthly_salary=0",[],"42501");
     await denied("select public.queue_media_cleanup('company-profile','orphan.jpg',$1::uuid)",[admin],"42501");
     await denied("truncate public.advances cascade",[],"42501");
   });
   await run("production default grants cannot expose lifecycle RPCs or allow TRUNCATE", "postgres",admin,async()=>{
     for(const role of ["anon","authenticated"]){
       const grants=(await db.query("select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and has_table_privilege($1,c.oid,'TRUNCATE')",[role])).rows;
       assert.deepEqual(grants,[]);
       assert.equal(await scalar("select has_function_privilege($1,'public.manage_admin_record(text,bigint,text,jsonb,text,uuid)','EXECUTE')",[role]),false);
       assert.equal(await scalar("select has_sequence_privilege($1,'public.media_cleanup_queue_id_seq','USAGE')",[role]),false);
     }
   });
   await run("all operational types archive and restore without salary/history loss or reassignment", "service_role",admin,async()=>{
     for(const [table,id] of [["guards",201],["supervisors",301],["field_officers",401],["sites",101]]){
       await action(table,id,"archive");
       assert.equal(await scalar(`select status from public.${table} where id=$1`,[id]),"inactive");
       await denied("select public.manage_admin_record($1,$2,'delete','{}',$3,$4::uuid)",[table,id,"DELETE "+id,admin],"55000");
       await action(table,id,"restore");
       assert.equal(await scalar(`select archived_at from public.${table} where id=$1`,[id]),null);
     }
     assert.equal(Number(await scalar("select count(*) from public.guard_site_assignments where valid_to is null")),0);
     assert.equal(Number(await scalar("select count(*) from public.supervisor_reporting where valid_to is null")),0);
     assert.equal(Number(await scalar("select count(*) from public.employee_compensation")),3);
     assert.equal(await scalar("select joining_date::text from public.guards where id=201"),"2026-10-01");
     assert.equal(await scalar("select employment_end_date from public.guards where id=201"),null);
     const amounts=rows=>rows.map(({status,...row})=>row);
     assert.deepEqual(amounts(await scalar("select public.get_payroll_summary('2026-10-01',$1::uuid)",[admin])),amounts(before));
   });
   await run("site archive preserves a guard's other active site and legacy pointer", "service_role",admin,async()=>{
     await action("sites",101,"archive");
     assert.equal(Number(await scalar("select site_id from public.guards where id=201")),102);
     assert.equal(Number(await scalar("select count(*) from public.guard_site_assignments where guard_id=201 and site_id=102 and valid_to is null")),1);
     await denied("insert into public.guard_site_assignments(guard_id,site_id) values(201,101)",[],"55000");
     await denied("insert into public.advances(employee_type,guard_id,site_id,amount) values('guard',201,101,1)",[],"55000");
   });
   await run("future-dated assignment closure stays valid; archived employee blocks new links/advances", "service_role",admin,async()=>{
     await db.query("insert into public.supervisor_site_assignments(supervisor_id,site_id,valid_from) values(301,102,'2099-01-01')");
     await action("supervisors",301,"archive");
     assert.equal(await scalar("select valid_to::text from public.supervisor_site_assignments where supervisor_id=301 and site_id=102"),"2099-01-01");
     await denied("insert into public.supervisor_reporting(supervisor_id,field_officer_id) values(301,401)",[],"55000");
     await denied("insert into public.advances(employee_type,supervisor_id,amount) values('supervisor',301,1)",[],"55000");
   });
   await run("catalogue editing, archive, inactive restoration and confirmed deletion", "service_role",admin,async()=>{
     for(const [table,id] of [["services",601],["events",701],["notifications",801]]){
       await action(table,id,"save",{title:"Synthetic edited"});
       await action(table,id,"archive");
       assert.equal(Number(await scalar(`select count(*) from public.${table} where archived_at is not null and not is_active`)),1);
       await action(table,id,"restore");
       assert.equal(await scalar(`select is_active from public.${table} where id=$1`,[id]),false);
       await action(table,id,"archive");
       await denied("select public.manage_admin_record($1,$2,'delete','{}','WRONG',$3::uuid)",[table,id,admin],"22023");
       await action(table,id,"delete",{},"DELETE "+id);
       assert.equal(Number(await scalar(`select count(*) from public.${table}`)),0);
       assert.ok(Number(await scalar("select count(*) from public.operations_audit_log where table_name=$1",[table]))>0);
     }
   });
   await run("archived public content is invisible through real anon RLS and restored drafts stay hidden", "service_role",admin,async()=>{
     for(const [table,id] of [["services",601],["events",701],["notifications",801]]){
       await action(table,id,"archive");
       await db.exec("set local role anon");
       await db.query("select set_config('request.jwt.claim.sub','',true)");
       assert.equal(Number(await scalar(`select count(*) from public.${table}`)),0);
       await db.exec("set local role service_role");
       await db.query("select set_config('request.jwt.claim.sub',$1,true)",[admin]);
       await action(table,id,"restore");
       await db.exec("set local role anon");
       await db.query("select set_config('request.jwt.claim.sub','',true)");
       assert.equal(Number(await scalar(`select count(*) from public.${table}`)),0);
       await db.exec("set local role service_role");
       await db.query("select set_config('request.jwt.claim.sub',$1,true)",[admin]);
     }
   });
   await run("inbound RESTRICT, CASCADE and SET NULL references block permanent deletion", "postgres",admin,async()=>{
     for(const [name,rule] of [["restrict","restrict"],["cascade","cascade"],["setnull","set null"]]){
       await db.exec(`create table public.synthetic_fk_${name}(event_id bigint references public.events(id) on delete ${rule}); insert into public.synthetic_fk_${name} values(701); grant select on public.synthetic_fk_${name} to service_role; set local role service_role`);
       await action("events",701,"archive");
       await denied("select public.manage_admin_record('events',701,'delete','{}','DELETE 701',$1::uuid)",[admin],"55000");
       assert.equal(Number(await scalar(`select event_id from public.synthetic_fk_${name}`)),701);
       await db.exec(`set local role postgres; delete from public.synthetic_fk_${name}`);
     }
     await db.exec("set local role service_role");
     await action("events",701,"delete",{},"DELETE 701");
     assert.equal(Number(await scalar("select count(*) from public.events")),0);
   });
   await run("retained intake label blocks service removal and non-admin actor is rejected", "service_role",admin,async()=>{
     await action("services",601,"archive");
     await denied("select public.manage_admin_record('services',601,'delete','{}','DELETE 601',$1::uuid)",[admin],"55000");
     await denied("select public.manage_admin_record('events',701,'archive','{}','',$1::uuid)",[outsider],"42501");
   });
   await run("intake originals remain immutable; review, close, restore are retention-safe", "service_role",admin,async()=>{
     for(const [table,id] of [["contact_submissions",1001],["job_applications",1101],["complaints",1201]]){
       await action(table,id,"save",{admin_notes:"Synthetic reviewed"});
       await action(table,id,"close");
       assert.equal(await scalar(`select status from public.${table} where id=$1`,[id]),table==="complaints"?"resolved":"closed");
       const field=table==="complaints"?"details":"message";
       await denied(`update public.${table} set ${field}='tampered' where id=$1`,[id],"55000");
       await action(table,id,"archive");
       await denied("select public.manage_admin_record($1,$2,'delete','{}',$3,$4::uuid)",[table,id,"DELETE "+id,admin],"55000");
       await action(table,id,"restore");
       await action(table,id,"reopen");
       assert.equal(await scalar(`select ${field} from public.${table} where id=$1`,[id]),"Original evidence");
     }
     assert.equal(await scalar("select resolved_at from public.complaints where id=1201"),null);
   });
   await run("media reference retention, reservation, nonce, retry and metadata queue", "service_role",admin,async()=>{
     const job=await scalar("select public.queue_media_cleanup('company-profile','gallery/a.jpg',$1::uuid)",[admin]);
     assert.deepEqual(await scalar("select public.claim_media_cleanup($1,$2::uuid)",[job,admin]),{blocked:true});
     await action("profile_docs",901,"save",{storage_path:"replacement.jpg"});
     await action("profile_docs",901,"archive");
     await action("profile_docs",901,"restore");
     assert.equal(await scalar("select is_public from public.profile_docs where id=901"),false);
     const claim=await scalar("select public.claim_media_cleanup($1,$2::uuid)",[job,admin]);
     assert.ok(claim.claim);
     await denied("update public.profile_docs set storage_path='gallery/a.jpg' where id=901",[],"55000");
     await denied("select public.complete_media_cleanup($1,$2::uuid,false,$3::uuid)",[job,outsider,admin],"55000");
     await db.query("select public.complete_media_cleanup($1,$2::uuid,true,$3::uuid)",[job,claim.claim,admin]);
     assert.equal(await scalar("select status from public.media_cleanup_queue where id=$1",[job]),"retry");
     const next=await scalar("select public.claim_media_cleanup($1,$2::uuid)",[job,admin]);
     await db.query("select public.complete_media_cleanup($1,$2::uuid,false,$3::uuid)",[job,next.claim,admin]);
     // Storage removal is exercised by HTTP tests, not faked as an actual file removal here.
     assert.equal(await scalar("select status from public.media_cleanup_queue where id=$1",[job]),"deleted");
     await action("profile_docs",902,"archive");
     await denied("select public.manage_admin_record('profile_docs',902,'delete','{}','DELETE 902',$1::uuid)",[admin],"55000");
     await action("profile_docs",902,"restore");
     await action("profile_docs",902,"save",{category:"Other"});
     await action("profile_docs",902,"archive");
     await denied("select public.manage_admin_record('profile_docs',902,'delete','{}','DELETE 902',$1::uuid)",[admin],"55000");
     assert.equal(Number(await scalar("select count(*) from storage.objects")),4);
   });
   await run("browser Storage deletion and path overwrite affect zero protected objects", "authenticated",admin,async()=>{
     assert.equal((await db.query("delete from storage.objects where bucket_id='company-profile' returning id")).rows.length,0);
     assert.equal((await db.query("update storage.objects set name='overwritten.jpg' returning id")).rows.length,0);
     assert.equal(Number(await scalar("select count(*) from storage.objects")),4);
   });
   await run("failed operations leave original business values unchanged", "service_role",admin,async()=>{
     await denied("select public.manage_admin_record('guards',201,'delete','{}','DELETE 201',$1::uuid)",[admin],"55000");
     assert.equal(await scalar("select status from public.guards where id=201"),"active");
     assert.equal(Number(await scalar("select amount from public.advances where id=501")),1000);
   });
   await run("legacy same-day compensation removal fails atomically without financial loss", "service_role",admin,async()=>{
     await denied("select public.save_guard_profile(201,$1::jsonb,array[101,102]::bigint[],$2::uuid)",[
       JSON.stringify({full_name:"Synthetic guard",phone:"9999900001",joining_date:"2026-10-01",status:"active",salary_amount:1000,salary_frequency:"daily",salary_effective_date:"2026-10-01"}),admin
     ],"55000");
     assert.equal(Number(await scalar("select gross_monthly_salary from public.employee_compensation where guard_id=201")),31000);
     assert.equal(Number(await scalar("select count(*) from public.employee_compensation")),3);
   });
 } finally {await db.close();}
});

test("isolated migration rollback removes DDL and preserves pre-existing synthetic records",async()=>{
 const db=await isolatedDatabase();
 try{
   await db.exec(seed);
   const rehearsal=migration.replace(/commit;\s*$/i,"rollback;");
   await db.exec(rehearsal);
   assert.equal((await db.query("select to_regclass('public.media_cleanup_queue') as tbl")).rows[0].tbl,null);
   assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and column_name='archived_at'")).rows[0].n,0);
   assert.equal((await db.query("select count(*)::int as n from public.advances")).rows[0].n,1);
   assert.equal((await db.query("select has_table_privilege('authenticated','public.services','UPDATE') as allowed")).rows[0].allowed,true);
   // Also prove that an error before COMMIT rolls back the entire migration transaction.
   await assert.rejects(db.exec(migration.replace(/commit;\s*$/i,"select 1/0; commit;")),e=>e.code==="22012");
   await db.exec("rollback");
   assert.equal((await db.query("select to_regclass('public.media_cleanup_queue') as tbl")).rows[0].tbl,null);
 }finally{await db.close();}
});
