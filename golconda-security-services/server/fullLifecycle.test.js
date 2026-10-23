import test from 'node:test';
import assert from 'node:assert/strict';
import {createQaFixture,QA_TOKEN,QA_OTHER_TOKEN} from '../scripts/qa-fixture.js';
import {parseGuardImportFile,guardRecordsToCsv,guardRecordsToXlsx} from '../src/guardSpreadsheet.js';

test('real HTTP API -> synthetic PostgreSQL: all module lifecycles, finance and permissions',async t=>{
 const f=await createQaFixture();
 const request=async(path,body,token=QA_TOKEN)=>{const r=await fetch(f.url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 const ok=async(path,body,status=200)=>{const r=await request(path,body);assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const rows=async(table)=>{const {data,error}=await f.database.from(table).select('*').order(table==='advance_sheet_sync_outbox'?'advance_id':'id');assert.equal(error,null,JSON.stringify(error));return data;};
 const action=(module,id,action,patch,confirmation)=>ok('/api/operations/records',{module,id,action,...(patch?{patch}:{}),...(confirmation?{confirmation}:{})});
 const employees=[];let siteA,siteB;
 try{
  await t.test('every protected route rejects missing, expired and non-admin sessions',async()=>{
   for(const path of ['/api/operations/guards','/api/operations/people','/api/operations/sites','/api/operations/records','/api/guards/import','/api/operations/site-import','/api/operations/advances','/api/integrations/telegram/admin']){
    assert.equal((await request(path,{},null)).status,401,path);
    assert.equal((await request(path,{},'expired-synthetic')).status,401,path);
    assert.equal((await request(path,{},QA_OTHER_TOKEN)).status,403,path);
   }
  });
  await t.test('Site create/read/update, uniqueness, validation and ISO date persistence',async()=>{
   siteA=(await ok('/api/operations/sites',{action:'save',site:{title:'QA site A',site_code:'QA-A',payroll_effective_date:'10-04-2026'}})).site_id;
   siteB=(await ok('/api/operations/sites',{action:'save',site:{title:'QA site B',site_code:'QA-B',payroll_effective_date:'01/04/26'}})).site_id;
   await ok('/api/operations/sites',{action:'save',site_id:siteA,site:{title:'QA site A edited',site_code:'QA-A'}});
   assert.equal((await rows('sites')).length,2);
   assert.equal((await rows('sites')).find(x=>x.id===siteB).payroll_effective_date,'2026-04-01');
   assert.equal((await request('/api/operations/sites',{action:'save',site:{title:'',site_code:'BAD CODE'}})).status,400);
   assert.equal((await request('/api/operations/sites',{action:'save',site:{title:'Duplicate',site_code:'QA-A'}})).status,409);
  });
  for(const [type,module,table,phone]of [['guard','guards','guards','9999800001'],['supervisor','supervisors','supervisors','9999800002'],['field_officer','fieldOfficers','field_officers','9999800003']])await t.test(module+' create/read/edit, multi-site, duplicate and invalid input through real HTTP',async()=>{
   const path=type==='guard'?'/api/operations/guards':'/api/operations/people';
   const person={employee_code:'QA-'+type.toUpperCase(),full_name:'QA '+type,phone,email:type+'@example.invalid',designation:'QA role',status:'active',joining_date:'10/04/26',...(type==='guard'?{salary_amount:30000,salary_frequency:'monthly',salary_effective_date:'2026-10-01'}:{gross_monthly_salary:30000,salary_effective_from:'2026-10-01'})};
   const body={action:'save',...(type==='guard'?{}:{employee_type:type}),person,site_ids:[siteA,siteB],reporting_ids:[]};
   const saved=await ok(path,body);const id=saved.guard_id||saved.employee_id;
   assert.ok(id,JSON.stringify(saved));employees.push({type,module,table,id,person});
   assert.equal((await rows(table)).find(x=>x.id===id).joining_date,'2026-04-10');
   await ok(path,{...body,[type==='guard'?'guard_id':'employee_id']:id,person:{...person,full_name:'QA '+type+' edited',email:'edited-'+type+'@example.invalid'},site_ids:[siteB]});
   const data=await rows(table);assert.equal(data.length,1);assert.equal(data[0].full_name,'QA '+type+' edited');
   const assignmentTable=type==='guard'?'guard_site_assignments':type+'_site_assignments';
   const active=(await rows(assignmentTable)).filter(x=>x.valid_to===null);assert.equal(active.length,1);assert.equal(active[0].site_id,siteB);
   assert.equal((await request(path,body)).status,409);
   assert.equal((await request(path,{...body,person:{...person,phone:'invalid',email:'invalid'}})).status,400);
   for(const other of employees.filter(x=>x.type!==type))assert.match((await rows(other.table))[0].full_name,new RegExp(other.type+' edited'));
  });
  await t.test('CSV aliases and both day-first dates import, skip duplicates and preserve existing rows',async()=>{
   const batch={rows:[{'Full Name':'QA imported one',Phone:'9999800011','Joining Date':'10-04-2026'},{'Guard Name':'QA imported two',Mobile:'9999800012','Joining Date':'01/04/26'},{'Full Name':'Broken',Phone:'x'}]};
   const imported=await ok('/api/guards/import',batch);assert.equal(imported.inserted,2);assert.equal(imported.failed,1);
   const again=await ok('/api/guards/import',batch);assert.equal(again.inserted,0);assert.equal(again.skipped,2);
   const data=await rows('guards');assert.equal(data.find(x=>x.phone==='9999800011').joining_date,'2026-04-10');assert.equal(data.find(x=>x.phone==='9999800012').joining_date,'2026-04-01');
  });
  await t.test('advance recording, recovery, payroll, invalid money and retained financial rows',async()=>{
   for(const e of employees){const b={action:'record',employee_type:e.type,employee_id:e.id,site_id:siteB,amount:'1000.25',payment_mode:'cash',occurred_at:'2026-10-15T04:30:00Z',description:'Synthetic advance',external_reference:'QA-ADVANCE-'+e.type};const [a,retry]=await Promise.all([ok('/api/operations/advances',b,201),ok('/api/operations/advances',b,201)]);assert.ok(a.advance_id);assert.equal(retry.advance_id,a.advance_id);assert.equal((await request('/api/operations/advances',{...b,amount:'1001.25'})).status,409);await ok('/api/operations/advances',{action:'recover',advance_id:a.advance_id,amount:'100.25',salary_period:'2026-10',notes:'Synthetic recovery'},201);assert.equal((await request('/api/operations/advances',{...b,amount:'-1'})).status,400);}
   const existing=(await rows('advances'))[0];assert.equal((await request('/api/operations/advances',{action:'recover',advance_id:existing.id,amount:1,salary_period:'2026-10',notes:'Duplicate synthetic allocation'})).status,409);assert.equal((await rows('advances')).length,3);assert.equal((await rows('advance_recoveries')).length,3);assert.equal((await rows('advance_sheet_sync_outbox')).length,0);
   const payroll=await ok('/api/operations/payroll?period=2026-10');assert.equal(payroll.period,'2026-10');assert.ok(payroll.employees.length>=3);
   for(const employee of employees){const row=payroll.employees.find(item=>item.employee_type===employee.type&&item.employee_id===employee.id);assert.equal(row.gross_for_period,30000);assert.equal(row.finalized_recovery_amount,100.25);assert.equal(row.proposed_advance_recovery,900);assert.equal(row.net_payable_after_proposed_recovery,28999.75);}
   const guard=employees.find(employee=>employee.type==='guard');
   const second=await ok('/api/operations/advances',{action:'record',employee_type:'guard',employee_id:guard.id,site_id:siteB,amount:50000,payment_mode:'online',occurred_at:'2026-10-15T05:00:00Z',description:'Synthetic cross-site recovery-cap test',external_reference:'QA-ADVANCE-GUARD-SECOND'},201);
   const beforeRecoveries=(await rows('advance_recoveries')).length;
   assert.equal((await request('/api/operations/advances',{action:'recover',advance_id:second.advance_id,amount:30000,salary_period:'2026-10',notes:'Synthetic over-cap recovery'})).status,409);
   assert.equal((await rows('advance_recoveries')).length,beforeRecoveries);
   await ok('/api/operations/advances',{action:'recover',advance_id:second.advance_id,amount:29899.75,salary_period:'2026-10',notes:'Synthetic recovery at salary cap'},201);
   const guardPayroll=(await ok('/api/operations/payroll?period=2026-10')).employees.find(item=>item.employee_type==='guard'&&item.employee_id===guard.id);
   assert.equal(guardPayroll.finalized_recovery_amount,30000);assert.equal(guardPayroll.proposed_advance_recovery,0);assert.equal(guardPayroll.net_payable_after_proposed_recovery,0);assert.equal(guardPayroll.advance_outstanding_after_proposed_recovery,21000.25);
   const list=await ok('/api/operations/advances');assert.equal(list.advances.length,4);assert.equal(list.advances.find(row=>row.id===second.advance_id).remaining_balance,20100.25);
   assert.equal((await rows('advance_sheet_sync_outbox')).length,0);
  });
  for(const e of employees)await t.test(e.module+' archive/restore/deactivate and linked deletion conflict retain history',async()=>{
   await action(e.module,e.id,'archive');let r=(await rows(e.table)).find(x=>x.id===e.id);assert.ok(r.archived_at);assert.equal(r.status,'inactive');
   assert.equal((await request('/api/operations/records',{module:e.module,id:e.id,action:'delete',confirmation:'DELETE '+e.id})).status,409);
   await action(e.module,e.id,'restore');await action(e.module,e.id,'activate');await action(e.module,e.id,'deactivate');
   r=(await rows(e.table)).find(x=>x.id===e.id);assert.equal(r.archived_at,null);assert.equal(r.status,'inactive');assert.equal(r.joining_date,'2026-04-10');
   assert.equal((await rows('advances')).length,4);assert.equal((await rows('employee_compensation')).length,3);
  });
  await t.test('Site closure ends assignments atomically without changing employment or deleting financial history',async()=>{
   const guard=employees.find(employee=>employee.type==='guard');
   await ok('/api/operations/guards',{action:'save',guard_id:guard.id,person:{...guard.person,status:'active',employment_end_date:null},site_ids:[siteA]});
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
   const closure={action:'close',site_id:siteA,closure_reason:'Contract expired',contract_end_date:today,remarks:'Synthetic QA closure'};
   const result=await ok('/api/operations/sites',closure);assert.equal(result.status,'inactive');
   const savedSite=(await rows('sites')).find(row=>row.id===siteA);assert.equal(savedSite.closure_reason,'Contract expired');assert.equal(String(savedSite.closure_date).slice(0,10),today);
   const assignments=(await rows('guard_site_assignments')).filter(row=>row.guard_id===guard.id&&row.site_id===siteA).sort((a,b)=>Number(b.id)-Number(a.id));const assignment=assignments[0];assert.equal(assignment.valid_to,today);
   assert.equal((await rows('guards')).find(row=>row.id===guard.id).status,'active');assert.equal((await rows('advances')).length,4);
   assert.equal((await ok('/api/operations/sites',closure)).already_applied,true);
   assert.equal((await request('/api/operations/sites',{...closure,closure_reason:''})).status,400);
  });
  await t.test('employee exit supports all roles, retains finance, ends active assignments, and retries safely',async()=>{
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
   for(const employee of employees){
    const isGuard=employee.type==='guard',path=isGuard?'/api/operations/guards':'/api/operations/people',idKey=isGuard?'guard_id':'employee_id';
    await ok(path,{action:'save',[idKey]:employee.id,...(isGuard?{}:{employee_type:employee.type}),person:{...employee.person,status:'active',employment_end_date:null},site_ids:[siteB],reporting_ids:[]});
    const body={action:'exit',[idKey]:employee.id,...(isGuard?{}:{employee_type:employee.type}),exit_reason:'Left Company',last_working_date:today,remarks:'Synthetic QA exit'};
    const saved=await ok(path,body);assert.equal(saved.status,'relieved');
    const person=(await rows(employee.table)).find(row=>row.id===employee.id);assert.equal(person.status,'relieved');assert.equal(person.employment_end_date,today);assert.equal(person.exit_reason,'Left Company');
    const assignmentTable=employee.type==='guard'?'guard_site_assignments':`${employee.type}_site_assignments`,fk=employee.type==='guard'?'guard_id':employee.type==='supervisor'?'supervisor_id':'field_officer_id';
    assert.equal((await rows(assignmentTable)).filter(row=>row[fk]===employee.id&&row.valid_to===null).length,0);
    assert.equal((await ok(path,body)).already_applied,true);
    assert.equal((await rows('advances')).length,4);
   }
   const guard=employees.find(employee=>employee.type==='guard');
   assert.equal((await request('/api/operations/guards',{action:'exit',guard_id:guard.id,exit_reason:'Other',last_working_date:today,remarks:''})).status,400);
   const [year,month]=today.split('-').map(Number),nextPeriod=new Date(Date.UTC(year,month,1)).toISOString().slice(0,7);
   const nextPayroll=await ok('/api/operations/payroll?period='+nextPeriod);for(const employee of employees){const row=nextPayroll.employees.find(item=>item.employee_type===employee.type&&item.employee_id===employee.id);assert.equal(row.gross_for_period,0);}
  });
  await t.test('Site archive/restore and delete conflict preserve employee and financial identities',async()=>{
   await action('sites',siteB,'archive');assert.equal((await request('/api/operations/records',{module:'sites',id:siteB,action:'delete',confirmation:'DELETE '+siteB})).status,409);await action('sites',siteB,'restore');
   assert.equal((await rows('sites')).find(x=>x.id===siteB).status,'inactive');for(const e of employees)assert.ok((await rows(e.table)).some(x=>x.id===e.id));assert.equal((await rows('advances')).length,4);
  });
  for(const module of ['services','events','notifications'])await t.test(module+' full create/read/edit/hide/publish/archive/restore/permanent-delete lifecycle',async()=>{
   const made=await action(module,null,'save',{title:'QA '+module,...(module==='notifications'?{message:'Synthetic message'}:{description:'Synthetic description'})});const id=made.id;
   await action(module,id,'save',{title:'QA edited '+module});await action(module,id,'deactivate');await action(module,id,'activate');await action(module,id,'archive');await action(module,id,'restore');
   assert.equal((await rows(module)).find(x=>x.id===id).is_active,false);await action(module,id,'archive');
   assert.equal((await request('/api/operations/records',{module,id,action:'delete',confirmation:'WRONG'})).status,400);
   await action(module,id,'delete',undefined,'DELETE '+id);assert.equal((await rows(module)).length,0);
  });
  for(const [endpoint,module,table,body]of [['contact','contactSubmissions','contact_submissions',{name:'QA contact',email:'qa@example.invalid',message:'Synthetic enquiry'}],['applications','jobApplications','job_applications',{name:'QA applicant',email:'qa@example.invalid',message:'Synthetic introduction'}],['complaints','complaints','complaints',{complainant_name:'QA complainant',phone:'9999800020',role:'Security Guard',subject:'Synthetic complaint',details:'Synthetic details'}]])await t.test(module+' public submit -> persistence -> admin review/close/reopen/archive/restore',async()=>{
   const made=await ok('/api/'+endpoint,body,201);assert.ok(made.id);assert.equal((await rows(table)).length,1);
   await action(module,made.id,'save',{admin_notes:'Synthetic internal note'});await action(module,made.id,'close');await action(module,made.id,'reopen');await action(module,made.id,'archive');await action(module,made.id,'restore');
   const saved=(await rows(table))[0];assert.equal(saved.admin_notes,'Synthetic internal note');assert.equal(saved.archived_at,null);
   assert.equal((await request('/api/operations/records',{module,id:made.id,action:'delete',confirmation:'DELETE '+made.id})).status,409);
   assert.equal((await request('/api/'+endpoint,{})).status,400);
  });
  await t.test('profile media upload, metadata lifecycle, private access and orphan cleanup',async()=>{
   const uploaded=await f.database.storage.from('company-profile').upload('qa/image.jpg',new File([new Uint8Array([255,216,255,217])],'qa.jpg',{type:'image/jpeg'}),{contentType:'image/jpeg'});assert.equal(uploaded.error,null,JSON.stringify(uploaded.error));
   const doc=await action('profileDocs',null,'save',{title:'QA photo',storage_path:'qa/image.jpg',mime_type:'image/jpeg',media_type:'image',category:'Gallery',is_public:true});
   const pub=await request('/api/profile',undefined,null);assert.equal(pub.status,200,JSON.stringify(f.failures));assert.equal(pub.body.documents.length,1);
   const file=await fetch(pub.body.documents[0].file_url);assert.equal(file.status,200);assert.deepEqual(new Uint8Array(await file.arrayBuffer()),new Uint8Array([255,216,255,217]));
   assert.equal((await fetch(f.url+'/storage/v1/object/public/company-profile/qa/image.jpg')).status,403);
   await action('profileDocs',doc.id,'hide');await action('profileDocs',doc.id,'archive');await action('profileDocs',doc.id,'restore');assert.equal((await rows('profile_docs'))[0].is_public,false);
   const blocked=await ok('/api/operations/records',{action:'queue_media',bucket:'company-profile',path:'qa/image.jpg'});assert.equal((await request('/api/operations/records',{action:'cleanup_media',id:blocked.cleanup_id,confirmation:'DELETE FILE '+blocked.cleanup_id})).status,409);
   await action('profileDocs',doc.id,'archive');await action('profileDocs',doc.id,'delete',undefined,'DELETE '+doc.id);const jobs=await rows('media_cleanup_queue');const job=jobs.find(x=>x.path==='qa/image.jpg');assert.ok(job);
   await ok('/api/operations/records',{action:'cleanup_media',id:job.id,confirmation:'DELETE FILE '+job.id});assert.equal(f.files.size,0);
  });
  await t.test('real XLSX parsing -> HTTP import -> persisted ISO dates and accurate export',async()=>{
   const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Synthetic');
   sheet.addRow(['Employee Full Name','Contact No','Joining Date']);sheet.addRow(['QA XLSX one','9999800031','10-04-2026']);sheet.addRow(['QA XLSX two','9999800032','01/04/26']);
   const bytes=await workbook.xlsx.writeBuffer();const parsed=await parseGuardImportFile(new File([bytes],'synthetic.xlsx'));
   const result=await ok('/api/guards/import',{rows:parsed});assert.equal(result.inserted,2);
   const imported=(await rows('guards')).filter(x=>x.phone==='9999800031'||x.phone==='9999800032');
   assert.deepEqual(imported.map(x=>x.joining_date),['2026-04-10','2026-04-01']);
   const exported=await guardRecordsToXlsx(imported);const roundtrip=await parseGuardImportFile(new File([exported],'export.xlsx'));assert.equal(roundtrip.length,2);
   assert.match(guardRecordsToCsv([{...imported[0],full_name:'=SYNTHETIC()'}]),/'=SYNTHETIC/);
  });
  await t.test('maximum 500-row import completes without corrupting pre-existing synthetic records',async()=>{
   const before=(await rows('guards')).length;
   const batch=Array.from({length:500},(_,n)=>({'Full Name':'QA batch '+n,Phone:String(9999700000+n),'Joining Date':'01/04/26'}));
   const result=await ok('/api/guards/import',{rows:batch});assert.equal(result.inserted,500);assert.equal(result.failed,0);assert.equal((await rows('guards')).length,before+500);
   assert.equal((await request('/api/guards/import',{rows:[...batch,batch[0]]})).status,400);
   assert.equal((await rows('advances')).length,4);assert.equal((await rows('advance_recoveries')).length,4);
  });
 }finally{await f.close();}
});
