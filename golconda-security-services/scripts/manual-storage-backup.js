// Read-only production export. No upload/remove/update/RPC/migration operations.
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, realpath, stat, access } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import { pathToFileURL } from "node:url";
export const projectRef="ntcvrxdyukfpobjvxxiz";
export const projectUrl=`https://${projectRef}.supabase.co`;

function decodeCopy(value) {
  if(value==='\\N')return null;
  const bytes=value.split(/(\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[^\r\n]))/g).filter(Boolean).map(part=>{
    if(!part.startsWith('\\'))return Buffer.from(part,'utf8');
    const escaped=part.slice(1), codes={b:8,f:12,n:10,r:13,t:9,v:11,'\\':92};
    if(Object.hasOwn(codes,escaped))return Buffer.from([codes[escaped]]);
    if(/^[0-7]{1,3}$/.test(escaped))return Buffer.from([parseInt(escaped,8)]);
    if(/^x[0-9a-fA-F]{1,2}$/.test(escaped))return Buffer.from([parseInt(escaped.slice(1),16)]);
    return Buffer.from(escaped,'utf8');
  });
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(bytes));
}
export function readCopyTable(text,table) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  const header=new RegExp('^COPY (?:storage|"storage")\\.(?:'+table+'|"'+table+'") \\(([^)]+)\\) FROM stdin;$');
  const index=lines.findIndex(line=>header.test(line));
  if(index<0)throw new Error('Database archive is missing expected Storage COPY metadata.');
  const columns=lines[index].match(header)[1].split(',').map(x=>x.trim().replace(/^"|"$/g,''));
  const rows=[];let ended=false;
  for(const line of lines.slice(index+1)){
    if(line==='\\.'){ended=true;break;}
    const values=line.split('\t');
    if(values.length!==columns.length)throw new Error('Storage COPY metadata is malformed.');
    rows.push(Object.fromEntries(columns.map((col,i)=>[col,decodeCopy(values[i])])));
  }
  if(!ended)throw new Error('Storage COPY metadata is incomplete.');
  return rows;
}
export async function readText(file) {
  const bytes=await readFile(file);
  return (bytes[0]===255&&bytes[1]===254?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8')).replace(/^\uFEFF/,'');
}
export function archiveInventory(rows) {
  return rows.map(row=>{
    let metadata;try{metadata=JSON.parse(row.metadata);}catch{throw new Error('An archived object has invalid metadata.');}
    const size=Number(metadata?.size), modified=Date.parse(row.updated_at);
    if(!row.id||!row.bucket_id||!row.name||metadata?.size==null||!Number.isSafeInteger(size)||size<0||!Number.isFinite(modified))throw new Error('Archived Storage metadata cannot establish file completeness.');
    return {id:row.id,bucket:row.bucket_id,path:row.name,size,modified,etag:metadata.eTag??metadata.etag??null};
  });
}
const keyOf=item=>JSON.stringify([item.bucket,item.path]);
export function assertSameInventory(expected,actual) {
  const normalize=items=>items.map(x=>({key:keyOf(x),id:x.id,size:x.size,modified:x.modified,etag:x.etag??null})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const left=normalize(expected),right=normalize(actual);
  if(new Set(left.map(x=>x.key)).size!==left.length||new Set(right.map(x=>x.key)).size!==right.length||JSON.stringify(left)!==JSON.stringify(right))throw new Error('Storage inventory differs from the database archive or changed during export. Stop and retry a fresh backup.');
}
export async function inventory(storage,buckets) {
  const files=[];
  for(const bucket of buckets){
    const prefixes=[''],visited=new Set();
    while(prefixes.length){
      const prefix=prefixes.pop();
      if(visited.has(prefix)||prefix.length>10000)throw new Error('Storage listing repeated a folder or exceeded a safe path limit.');
      visited.add(prefix);
      for(let offset=0; ;offset+=100){
        if(offset>10000000)throw new Error('Storage listing exceeded the verification limit.');
        const {data,error}=await storage.from(bucket.id).list(prefix,{limit:100,offset,sortBy:{column:'name',order:'asc'}});
        if(error||!Array.isArray(data))throw new Error('Authenticated Storage listing failed.');
        for(const item of data){
          if(typeof item.name!=='string'||!item.name||item.name.includes('/'))throw new Error('Storage listing returned an invalid path segment.');
          const objectPath=prefix?prefix+'/'+item.name:item.name;
          if(item.id===null){prefixes.push(objectPath);continue;}
          const size=Number(item.metadata?.size),modified=Date.parse(item.updated_at);
          if(!item.id||item.metadata?.size==null||!Number.isSafeInteger(size)||size<0||!Number.isFinite(modified))throw new Error('Storage listing returned unverifiable file metadata.');
          files.push({id:item.id,bucket:bucket.id,path:objectPath,size,modified,etag:item.metadata.eTag??item.metadata.etag??null});
        }
        if(data.length<100)break;
      }
    }
  }
  return files;
}
async function hashFile(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function backupStorage(storage,expected,bucketRows,folder){
  const {data:buckets,error}=await storage.listBuckets();
  if(error||!Array.isArray(buckets))throw new Error('Authenticated bucket listing failed.');
  const ids=items=>items.map(x=>x.id).sort();
  if(JSON.stringify(ids(buckets))!==JSON.stringify(ids(bucketRows)))throw new Error('Bucket inventory differs from the database archive.');
  if(expected.some(x=>!buckets.some(b=>b.id===x.bucket)))throw new Error('Archived objects refer to a missing bucket.');
  assertSameInventory(expected,await inventory(storage,buckets));
  await mkdir(path.join(folder,'objects'),{recursive:true});
  const manifest=[];
  for(const item of expected){
    const filename=createHash('sha256').update(keyOf(item)).digest('hex')+'.bin';
    const relative='objects/'+filename,output=path.join(folder,'objects',filename);
    const {data,error:downloadError}=await storage.from(item.bucket).download(item.path);
    if(downloadError||!data?.stream)throw new Error('A Storage file download failed.');
    const hash=createHash('sha256'),md5=createHash('md5');let bytes=0;
    const counter=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);md5.update(chunk);bytes+=chunk.length;callback(null,chunk);}});
    await pipeline(Readable.fromWeb(data.stream()),counter,createWriteStream(output,{flags:'wx',mode:0o600}));
    const sha256=hash.digest('hex');
    const contentMd5=md5.digest('hex'),etag=String(item.etag??'').replaceAll('"','');
    if(/^[a-fA-F0-9]{32}$/.test(etag)&&contentMd5!==etag.toLowerCase())throw new Error('Downloaded bytes do not match the source object ETag.');
    if(bytes!==item.size||(await stat(output)).size!==item.size||await hashFile(output)!==sha256)throw new Error('Downloaded file integrity or size verification failed.');
    manifest.push({...item,file:relative,sha256});
  }
  const finalBuckets=await storage.listBuckets();
  if(finalBuckets.error||!Array.isArray(finalBuckets.data)||JSON.stringify(ids(finalBuckets.data))!==JSON.stringify(ids(buckets)))throw new Error('Buckets changed during export.');
  assertSameInventory(expected,await inventory(storage,buckets));
  const result={projectRef,exportedUtc:new Date().toISOString(),comparedToDatabaseArchive:true,buckets:bucketRows,files:manifest};
  await writeFile(path.join(folder,'storage-manifest.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  return result;
}
export async function assertOutsideGit(folder){
  let cursor=await realpath(folder);
  while(true){
    try{await access(path.join(cursor,'.git'));throw new Error('Backup destination is inside a Git repository.');}catch(error){if(error.code!=='ENOENT')throw error;}
    const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
}
export function assertArchiveTables(toc){
  const required={public:['admin_users','guards','supervisors','field_officers','sites','guard_site_assignments','supervisor_site_assignments','field_officer_site_assignments','supervisor_reporting','employee_compensation','salary_adjustments','advances','advance_adjustments','advance_recoveries','operations_audit_log','advance_sheet_sync_outbox','services','events','notifications','profile_docs','contact_submissions','job_applications','complaints'],auth:['users'],storage:['objects','buckets'],supabase_migrations:['schema_migrations']};
  for(const [schema,tables]of Object.entries(required))for(const table of tables)if(!new RegExp('TABLE DATA '+schema+' '+table+'(?:\\s|$)').test(toc))throw new Error('Database archive is missing a required table data entry.');
}
async function main(){
  const folder=process.argv[2];if(!folder||!process.env.GSS_BACKUP_SECRET_KEY)throw new Error('Run the secure PowerShell backup wrapper with local credentials.');
  const client=createClient(projectUrl,process.env.GSS_BACKUP_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  if(folder==='--check-access'){
    assertServerStorageKey(process.env.GSS_BACKUP_SECRET_KEY);
    await validateStorageAccess(client.storage);
    console.log('Read-only Storage access validation passed.');return;
  }
  await assertOutsideGit(folder);
  assertArchiveTables(await readText(path.join(folder,'database.toc')));
  const expected=archiveInventory(readCopyTable(await readText(path.join(folder,'storage-objects.sql')),'objects'));
  const buckets=readCopyTable(await readText(path.join(folder,'storage-buckets.sql')),'buckets');
  const result=await backupStorage(client.storage,expected,buckets,folder);
  console.log(`Storage verified: ${result.buckets.length} buckets, ${result.files.length} files. No production files were changed.`);
}
export function assertServerStorageKey(key){
  if(typeof key!=='string')throw new Error('A server Storage key is required.');
  if(/^sb_secret_[A-Za-z0-9_-]+$/.test(key))return;
  try{if(key.split('.').length===3&&JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8')).role==='service_role')return;}catch{}
  throw new Error('Use a server secret/service_role key, not a publishable or user key.');
}
export async function validateStorageAccess(storage){
  const {data,error}=await storage.listBuckets();
  if(error||!Array.isArray(data)||!['company-profile','employee-private'].every(id=>data.some(bucket=>bucket.id===id&&bucket.public===false)))throw new Error('Private production bucket access could not be validated.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('Storage backup NOT verified. Check authenticated access, complete archive metadata and stable inventories. Secret values are not logged.');process.exitCode=1;});
