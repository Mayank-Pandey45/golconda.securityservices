// Local synthetic QA only. No environment database URL, production key or rows are read.
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { isolatedDatabase, migration, lifecycleMigration, metadata } from '../supabase/tests/isolatedDatabase.js';
import { createApp } from '../server/index.js';
import { pathToFileURL } from 'node:url';

export const QA_ADMIN='00000000-0000-4000-8000-000000000001';
export const QA_OUTSIDER='00000000-0000-4000-8000-000000000002';
const jwt=(role,sub)=>[Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),Buffer.from(JSON.stringify({role,sub,exp:4102444800,aud:'authenticated'})).toString('base64url'),'synthetic-local-only'].join('.');
export const QA_TOKEN=jwt('authenticated',QA_ADMIN);
export const QA_OTHER_TOKEN=jwt('authenticated',QA_OUTSIDER);
const serviceKey=jwt('service_role',QA_ADMIN),anonKey=jwt('anon','');
const ident=s=>{if(!/^[a-z_][a-z_0-9]*$/i.test(s))throw Error('Unsupported fixture identifier');return '"'+s+'"';};
function uploadBytes(req){
 const type=req.headers['content-type']||'application/octet-stream';
 if(!type.startsWith('multipart/form-data'))return {bytes:req.body,type};
 const boundary=/boundary=(?:"([^"]+)"|([^;]+))/.exec(type);if(!boundary)throw Error('Missing synthetic upload boundary');
 const marker=Buffer.from('--'+(boundary[1]||boundary[2]));let position=0;
 while((position=req.body.indexOf(marker,position))>=0){const start=req.body.indexOf('\r\n\r\n',position);if(start<0)break;const end=req.body.indexOf(marker,start+4);if(end<0)break;const headers=req.body.subarray(position,start).toString('utf8');if(/filename=/.test(headers))return {bytes:req.body.subarray(start+4,end-2),type:/Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1]||'application/octet-stream'};position=end;}
 throw Error('Synthetic multipart request has no file');
}
export async function createQaFixture({port=0}={}){
 const db=await isolatedDatabase();
 await db.exec(`insert into auth.users values ('${QA_ADMIN}'),('${QA_OUTSIDER}');insert into public.admin_users(user_id) values('${QA_ADMIN}');`);
 await db.exec(migration);
 await db.exec(lifecycleMigration);
 const app=express(),files=new Map(),failures=[];let server;let tail=Promise.resolve();
 // PGlite is one connection: serialize whole transactions, including parallel UI reads.
 const transaction=(role,uid,fn)=>{const run=tail.then(async()=>{await db.exec('begin');try{await db.exec('set local role '+ident(role));await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);const r=await fn();await db.exec('commit');return r;}catch(e){await db.exec('rollback');throw e;}});tail=run.catch(()=>{});return run;};
 const identity=req=>req.headers.authorization==='Bearer '+serviceKey?{role:'service_role',uid:QA_ADMIN}:req.headers.authorization==='Bearer '+QA_TOKEN?{role:'authenticated',uid:QA_ADMIN}:req.headers.authorization==='Bearer '+QA_OTHER_TOKEN?{role:'authenticated',uid:QA_OUTSIDER}:{role:'anon',uid:''};
 app.use((req,res,next)=>{const origin=req.headers.origin;if(origin&&/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)){res.set('Access-Control-Allow-Origin',origin);res.set('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info,prefer,range,x-upsert');res.set('Access-Control-Allow-Methods','GET,HEAD,POST,PATCH,DELETE,OPTIONS');res.set('Access-Control-Expose-Headers','content-range');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
 app.use('/storage',express.raw({type:()=>true,limit:'20mb'}));
 app.use(express.json({limit:'5mb'}));
 const user={id:QA_ADMIN,email:'qa-admin@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:'2026-10-01T00:00:00Z'};
 app.post('/auth/v1/token',(req,res)=>{if(req.body.email!=='qa-admin@example.invalid'||req.body.password!=='Synthetic-local-only-123!')return res.status(400).json({error:'invalid_grant',error_description:'Invalid test credentials'});res.json({access_token:QA_TOKEN,token_type:'bearer',expires_in:86400,expires_at:Math.floor(Date.now()/1000)+86400,refresh_token:'synthetic-local-only',user});});
 app.get('/auth/v1/user',(req,res)=>{const i=identity(req);return i.role==='authenticated'?res.json({...user,id:i.uid}):res.status(401).json({msg:'Invalid synthetic session'});});
 app.post('/auth/v1/logout',(_req,res)=>res.sendStatus(204));
 app.all('/rest/v1/:table',async(req,res)=>{const i=identity(req);try{const result=await transaction(i.role,i.uid,async()=>{
   const table='public.'+ident(req.params.table),params=[],where=[];
   for(const [key,raw]of Object.entries(req.query)){if(['select','order','offset','limit'].includes(key))continue;const value=String(raw),dot=value.indexOf('.'),op=value.slice(0,dot),v=value.slice(dot+1);const col=ident(key);
    if(op==='is'&&v==='null')where.push(col+' is null');
    else if(op==='in'){const list=v.slice(1,-1).split(',');where.push(col+' in ('+list.map(x=>{params.push(x);return '$'+params.length;}).join(',')+')');}
    else{const sqlOp={eq:'=',neq:'<>',gte:'>=',gt:'>',lte:'<=',lt:'<'}[op];if(!sqlOp)throw Error('Unsupported fixture filter '+op);params.push(['true','false'].includes(v)&&(['is_active','is_public','is_published','is_approved','dismissible'].includes(key)||metadata.columns.some(c=>c.tbl===req.params.table&&c.col===key&&c.typ==='boolean'))?v==='true':v);where.push(col+sqlOp+'$'+params.length);}
   }
   const condition=where.length?' where '+where.join(' and '):'';
   const select=String(req.query.select||'*').split(',').map(x=>x==='*'?'*':ident(x)).join(',');
   if(req.method==='GET'||req.method==='HEAD'){
    const count=(await db.query('select count(*)::int as n from '+table+condition,params)).rows[0].n;
    const order=req.query.order?' order by '+String(req.query.order).split(',').map(x=>{const [col,dir]=x.split('.');return ident(col)+(dir==='desc'?' desc':' asc');}).join(','):'';
    const offset=Math.max(0,Number(req.query.offset)||0),limit=Math.min(1000,Math.max(0,Number(req.query.limit)||1000));
    return {count,offset,rows:(await db.query('select '+select+' from '+table+condition+order+' limit '+limit+' offset '+offset,params)).rows};
   }
   if(req.method==='POST'){
    const data=Array.isArray(req.body)?req.body:[req.body],rows=[];
    for(const row of data){const keys=Object.keys(row);rows.push(...(await db.query('insert into '+table+'('+keys.map(ident).join(',')+') values('+keys.map((_,n)=>'$'+(n+1)).join(',')+') returning '+select,keys.map(k=>row[k]))).rows);}return {rows,count:rows.length,offset:0};
   }
   if(req.method==='PATCH'){const keys=Object.keys(req.body);const args=keys.map(k=>req.body[k]);const shifted=condition.replace(/\$(\d+)/g,(_,n)=>'$'+(Number(n)+args.length));return {rows:(await db.query('update '+table+' set '+keys.map((k,n)=>ident(k)+'=$'+(n+1)).join(',')+shifted+' returning '+select,[...args,...params])).rows};}
   if(req.method==='DELETE')return {rows:(await db.query('delete from '+table+condition+' returning '+select,params)).rows};
   throw Error('Unsupported fixture method');
  });result.rows=result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date&&metadata.columns.some(c=>c.tbl===req.params.table&&c.col===key&&c.typ==='date')?value.toISOString().slice(0,10):value])));res.set('Content-Range',`${result.offset||0}-${(result.offset||0)+result.rows.length-1}/${result.count??result.rows.length}`);
  const object=req.headers.accept?.includes('application/vnd.pgrst.object+json');if(object&&result.rows.length!==1)return res.status(406).json({code:'PGRST116',details:`The result contains ${result.rows.length} rows`,message:'Expected one row'});return res.status(req.method==='POST'?201:200).json(object?result.rows[0]:result.rows);
 }catch(e){failures.push({route:req.path,message:e.message});return res.status(e.code==='42501'?403:e.code?.startsWith('23')?409:400).json({code:e.code||'QA_ERROR',message:e.message});}});
 app.post('/rest/v1/rpc/:name',async(req,res)=>{const i=identity(req);try{const data=await transaction(i.role,i.uid,async()=>{const args=Object.entries(req.body||{});const values=args.map(([,v])=>v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(v):v);return (await db.query('select public.'+ident(req.params.name)+'('+args.map(([key],n)=>ident(key)+'=> $'+(n+1)).join(',')+') as value',values)).rows[0].value;});res.json(data);}catch(e){res.status(400).json({code:e.code||'QA_ERROR',message:e.message,hint:e.hint});}});
 app.all('/storage/v1/*',async(req,res)=>{const i=identity(req);const suffix=req.path.slice('/storage/v1/'.length);try{
  if(suffix.startsWith('object/sign/')&&req.method==='POST') {if(i.uid!==QA_ADMIN)return res.status(403).json({error:'Private fixture object'});const key=decodeURIComponent(suffix.slice('object/sign/'.length));return files.has(key)?res.json({signedURL:'/object/sign/'+key+'?token=synthetic-local-only'}):res.status(404).json({error:'Not found'});}
  if(suffix.startsWith('object/sign/')&&req.method==='GET'){if(req.query.token!=='synthetic-local-only')return res.sendStatus(403);const f=files.get(decodeURIComponent(suffix.slice('object/sign/'.length)));return f?res.type(f.type).send(f.bytes):res.sendStatus(404);}
  if(suffix.startsWith('object/')&&req.method==='POST'){if(i.uid!==QA_ADMIN)return res.sendStatus(403);const key=decodeURIComponent(suffix.slice('object/'.length));if(files.has(key))return res.status(409).json({error:'No overwrite'});files.set(key,uploadBytes(req));const slash=key.indexOf('/');await transaction('service_role',QA_ADMIN,()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',[key.slice(0,slash),key.slice(slash+1)]));return res.json({Key:key,Id:'synthetic'});}
  if(suffix.startsWith('object/')&&req.method==='DELETE'){if(i.role!=='service_role')return res.sendStatus(403);const bucket=suffix.slice('object/'.length),body=JSON.parse(req.body.toString());for(const name of body.prefixes||[]){files.delete(bucket+'/'+name);await transaction('service_role',QA_ADMIN,()=>db.query('delete from storage.objects where bucket_id=$1 and name=$2',[bucket,name]));}return res.json([]);}
  return res.sendStatus(403);
 }catch(e){res.status(400).json({error:e.message});}});
 server=await new Promise((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
 const url='http://127.0.0.1:'+server.address().port;
 const database=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
 const noLimit=(_req,_res,next)=>next();
 app.use(createApp({database,env:{NODE_ENV:'test'},staticFiles:false,intakeLimiter:noLimit,guardImportLimiter:noLimit,operationsLimiter:noLimit}));
 return {db,url,anonKey,database,transaction,files,failures,close:async()=>{await new Promise(r=>server.close(r));await tail;await db.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const fixture=await createQaFixture();
 if(process.env.GSS_QA_VISUAL_FIXTURE==='1'){
  // Explicit opt-in test data for the browser smoke suite. This database exists
  // only in memory and is never connected to Supabase or production records.
  const admin=QA_ADMIN,db=fixture.db;
  const north=(await db.query("insert into public.sites(title,status) values($1,'active') returning id",['QA Synthetic Site North'])).rows[0];
  const south=(await db.query("insert into public.sites(title,status) values($1,'active') returning id",['QA Synthetic Site South'])).rows[0];
  const guard=(await db.query("insert into public.guards(full_name,phone,email,designation,status,joining_date,salary_amount,salary_frequency,salary_effective_date) values($1,$2,$3,'Security Guard','active','2025-10-01',22000,'monthly','2025-10-01') returning id",['QA Synthetic Guard','9999900001','qa-guard@example.invalid'])).rows[0];
  await db.query("insert into public.guard_site_assignments(guard_id,site_id,valid_from,valid_to,assignment_notes,created_by) values($1,$2,'2025-10-01','2026-09-30','Synthetic prior assignment',$3),($1,$4,'2026-10-01',null,'Synthetic current assignment',$3)",[guard.id,north.id,admin,south.id]);
  await db.query("insert into public.employee_compensation(employee_type,guard_id,gross_monthly_salary,effective_from,notes,created_by) values('guard',$1,22000,'2025-10-01','Synthetic estimate only',$2)",[guard.id,admin]);
  const first=(await db.query("insert into public.advances(employee_type,guard_id,site_id,amount,occurred_at,payment_mode,description,source,recorded_by) values('guard',$1,$2,2000,'2026-10-05T09:00:00Z','cash','Synthetic advance North','dashboard',$3) returning id",[guard.id,north.id,admin])).rows[0];
  await db.query("insert into public.advances(employee_type,guard_id,site_id,amount,occurred_at,payment_mode,description,source,recorded_by) values('guard',$1,$2,1500,'2026-10-12T09:00:00Z','online','Synthetic advance South','dashboard',$3),('guard',$1,$4,1000,'2026-10-20T09:00:00Z','cash','Synthetic advance North','dashboard',$3)",[guard.id,south.id,admin,north.id]);
  await db.query("insert into public.advance_recoveries(advance_id,salary_period,amount,notes,created_by) values($1,'2026-10-01',500,'Synthetic test recovery',$2)",[first.id,admin]);
  console.log(`Synthetic visual fixture seeded: Guard #${guard.id}; Sites #${north.id}, #${south.id}`);
 }
 // Vite inherits ONLY synthetic public configuration; never uses the production .env.
 process.env.VITE_SUPABASE_URL='http://127.0.0.1:5187';process.env.VITE_SUPABASE_PUBLISHABLE_KEY=fixture.anonKey;process.env.VITE_API_URL='';
 const {createServer}=await import('vite');const vite=await createServer({server:{host:'127.0.0.1',port:5187,strictPort:true,proxy:Object.fromEntries(['/api','/rest','/auth','/storage'].map(prefix=>[prefix,{target:fixture.url,changeOrigin:true}]))}});await vite.listen();
 console.log('Synthetic QA website: http://127.0.0.1:5187 (no production connection)');
 const stop=async()=>{await vite.close();await fixture.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
