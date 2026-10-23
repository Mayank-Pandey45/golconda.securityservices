import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readCopyTable,archiveInventory,assertSameInventory,inventory,backupStorage,assertOutsideGit,assertArchiveTables,readText,assertServerStorageKey,validateStorageAccess} from './manual-storage-backup.js';

const modified='2026-10-22T00:00:00Z';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function temporary(run){
 const root=await mkdtemp(path.join(tmpdir(),'golconda-backup-fixture-'));
 try{return await run(root);}finally{
   // Delete only this test's directly allocated, explicitly checked temp folder.
   assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
   assert.ok(path.basename(root).startsWith('golconda-backup-fixture-'));
   await rm(root,{recursive:true,force:true});
 }
}
function fakeStorage(files,{failDownload=false,mutate=false}={}){
 let rounds=0;
 const buckets=[{id:'private',public:false},{id:'empty',public:false}];
 return {async listBuckets(){rounds++;return {data:buckets};},from(bucket){return {
   async list(prefix,{offset,limit}){
     const rows=[],folders=new Set();
     for(const file of files.filter(f=>f.bucket===bucket)){
       const start=prefix?prefix+'/':'';if(!file.path.startsWith(start))continue;
       const rest=file.path.slice(start.length);
       if(rest.includes('/'))folders.add(rest.split('/')[0]);
       else rows.push({id:file.id,name:rest,metadata:{size:file.bytes.length},updated_at:mutate&&rounds>1?'2026-10-23T00:00:00Z':modified});
     }
     rows.push(...[...folders].map(name=>({id:null,name})));
     rows.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
     return {data:rows.slice(offset,offset+limit)};
   },
   async download(name){if(failDownload)return {error:{message:'untrusted provider error'}};return {data:new Blob([files.find(f=>f.bucket===bucket&&f.path===name).bytes])};}
 };}};
}
const expected=files=>files.map(f=>({bucket:f.bucket,path:f.path,id:f.id,size:f.bytes.length,modified:Date.parse(modified)}));

test('backup parser preserves PostgreSQL COPY escapes, nulls, Unicode and empty tables',()=>{
 const text='COPY storage.objects (id, bucket_id, name, metadata, updated_at, owner) FROM stdin;\n1\tprivate\tfolder/na\\tme-é.txt\t{"size":0}\t'+modified+'\t\\N\n\\.\n';
 const rows=readCopyTable(text,'objects');assert.equal(rows[0].name,'folder/na\tme-é.txt');assert.equal(rows[0].owner,null);
 assert.equal(archiveInventory(rows)[0].size,0);
 assert.deepEqual(readCopyTable('COPY storage.buckets (id) FROM stdin;\n\\.\n','buckets'),[]);
 assert.deepEqual(readCopyTable('COPY "storage"."buckets" ("id", "name") FROM stdin;\nprivate\tPrivate\n\\.\n','buckets'),[{id:'private',name:'Private'}]);
 assert.throws(()=>readCopyTable(text.replace('\\.',''),'objects'));
 assert.throws(()=>archiveInventory([{id:'1',bucket_id:'b',name:'x',metadata:null,updated_at:modified}]));
});
test('Storage backup lists beyond 100 rows and traverses nested private folders',async()=>{
 const files=Array.from({length:205},(_,i)=>({id:String(i),bucket:'private',path:'item-'+String(i).padStart(3,'0'),bytes:Buffer.from('synthetic '+i)}));
 files.push({id:'nested',bucket:'private',path:'nested/deeper/é.txt',bytes:Buffer.alloc(0)});
 const result=await inventory(fakeStorage(files),[{id:'private'},{id:'empty'}]);
 assert.equal(result.length,206);assertSameInventory(expected(files),result);
});
test('file export verifies every byte and represents Windows-reserved/case-sensitive names without collisions',async()=>temporary(async root=>{
 const files=['CON','a.txt','A.txt','nested/é.txt'].map((name,i)=>({id:String(i),bucket:'private',path:name,bytes:Buffer.from('synthetic '+i)}));
 const result=await backupStorage(fakeStorage(files),expected(files),[{id:'private'},{id:'empty'}],root);
 assert.equal(result.files.length,4);assert.equal(new Set(result.files.map(f=>f.file)).size,4);
 for(const entry of result.files){const bytes=await readFile(path.join(root,entry.file));assert.equal(digest(bytes),entry.sha256);assert.equal(bytes.length,entry.size);}
 const manifest=JSON.parse(await readFile(path.join(root,'storage-manifest.json')));assert.equal(manifest.comparedToDatabaseArchive,true);
}));
test('missing files, duplicate paths, download failures and concurrent mutations cannot produce a success manifest',async()=>{
 const files=[{id:'1',bucket:'private',path:'x',bytes:Buffer.from('synthetic')}];
 assert.throws(()=>assertSameInventory(expected(files),[]));
 assert.throws(()=>assertSameInventory([...expected(files),...expected(files)],expected(files)));
 for(const options of [{failDownload:true},{mutate:true}])await temporary(async root=>{
   await assert.rejects(backupStorage(fakeStorage(files,options),expected(files),[{id:'private'},{id:'empty'}],root));
   await assert.rejects(readFile(path.join(root,'storage-manifest.json')),e=>e.code==='ENOENT');
 });
});
test('backup destination must be outside Git; UTF-16 PowerShell TOCs are readable',async()=>temporary(async root=>{
 await assertOutsideGit(root);await mkdir(path.join(root,'.git'));await mkdir(path.join(root,'nested'));
 await assert.rejects(assertOutsideGit(path.join(root,'nested')));
 const toc=path.join(root,'toc.txt');await writeFile(toc,Buffer.concat([Buffer.from([255,254]),Buffer.from('archive metadata','utf16le')]));
 assert.equal(await readText(toc),'archive metadata');
}));
test('a partial or schema-only database dump cannot pass the required data-entry gate',()=>{
 assert.throws(()=>assertArchiveTables('TABLE public guards postgres'));
});
test('PowerShell workflow keeps secrets local and has no release or restore-to-database operation',async()=>{
 const script=await readFile(new URL('./manual-backup.ps1',import.meta.url),'utf8');
 assert.match(script,/-AsSecureString/);assert.match(script,/Export-Clixml/);assert.match(script,/SetAccessRuleProtection\(\$true, \$false\)/);
 assert.match(script,/AccessControlSections\]::Access/);
 assert.match(script,/\$verified = Get-AccessOnlyDirectoryAcl/);
 assert.match(script,/encrypted credentials will not be overwritten/);
 assert.match(script,/\[switch\]\$Reconfigure/);
 assert.match(script,/\[IO\.File\]::Replace\(\$Candidate,\$Active,\$Previous\)/);
 assert.match(script,/\$Arguments = Get-PgArguments \$Tool \$Arguments \$config.user/);
 assert.match(script,/Invoke-PrivateCredentialProbe/);
 assert.doesNotMatch(script,/Set-Content -LiteralPath \$configFile|Export-Clixml -LiteralPath \$(?:databaseCredential|storageCredential)/);
 assert.match(script,/default_transaction_read_only=on/);assert.match(script,/--file=NUL/);
 assert.match(script,/--quote-all-identifiers/);
 assert.match(script,/Remove-Item -LiteralPath/);
 assert.match(script,/\$serverMajorText -ne '17'/);
 const commands=script.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n');
 assert.doesNotMatch(commands,/\bSet-Acl\b|\.SetOwner\(|\.SetGroup\(|\.SetAudit|AccessControlSections\]::(?:Audit|All)/i);
 assert.doesNotMatch(commands,/--exclude|--schema-only|--dbname|db push|apply_migration|git push|vercel --prod/);
});

test('reconfiguration Storage validation requires a server key and authenticated private bucket access',async()=>{
 assert.doesNotThrow(()=>assertServerStorageKey('sb_secret_synthetic_test_only'));
 assert.throws(()=>assertServerStorageKey('sb_publishable_synthetic_test_only'));
 const jwt=role=>'e30.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.synthetic';
 assert.doesNotThrow(()=>assertServerStorageKey(jwt('service_role')));
 assert.throws(()=>assertServerStorageKey(jwt('authenticated')));
 await validateStorageAccess({async listBuckets(){return {data:[{id:'company-profile',public:false},{id:'employee-private',public:false}]};}});
 for(const result of [{error:{message:'untrusted provider content'}},{data:[]},{data:[{id:'company-profile',public:true},{id:'employee-private',public:false}]}]){
  await assert.rejects(validateStorageAccess({async listBuckets(){return result;}}),e=>e.message==='Private production bucket access could not be validated.');
 }
});
