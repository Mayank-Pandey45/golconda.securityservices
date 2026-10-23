import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createApp } from "./index.js";
import { validateRecordRequest, manageRecord, cleanupMedia, enqueueMediaCleanup } from "./recordManagement.js";

function database({ admin=true, rpcError=null, result={ id:1 }, failRemove=false }={}) {
  const calls=[];
  return {
    calls, auth: { async getUser(token) { return token==="valid" ? { data:{ user:{id:"admin",user_metadata:{admin:true}} } } : {error:{message:"expired"}}; } },
    from(table) {
      assert.equal(table,"admin_users");
      return { select(){return this;},eq(){return this;},async maybeSingle(){return {data:admin?{user_id:"admin"}:null};} };
    },
    async rpc(name,args){calls.push({name,args});return {data:result,error:rpcError};},
    storage:{from(bucket){return {async remove(paths){calls.push({remove:paths,bucket});return {error:failRemove?{message:"private error"}:null};}};}},
  };
}
async function api(db,run) {
  const server=createServer(createApp({database:db,staticFiles:false,operationsLimiter:(_req,_res,next)=>next()}));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try { await run("http://127.0.0.1:"+server.address().port); } finally { await new Promise(resolve=>server.close(resolve)); }
}
const post=(url,body,token="valid")=>fetch(url+"/api/operations/records",{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});

test("all record mutations and storage cleanup require a verified user and admin membership",async()=>{
  for(const admin of [false,true]){
    const db=database({admin});
    await api(db,async url=>{
      for(const action of ["save","archive","restore","delete","queue_media","cleanup_media"]){
        for(const token of ["","expired",...(admin?[]:["valid"])]){
          const response=await post(url,{module:"guards",action,id:1},token);
          assert.equal(response.status,token==="valid"?403:401);
        }
      }
    });
    assert.equal(db.calls.length,0);
  }
});
test("editing content and triage notes delegates only whitelisted fields with authenticated actor",async()=>{
  const db=database();
  for(const [module,patch] of [["services",{title:"Revised service"}],["events",{title:"Revised event"}],["notifications",{message:"Revised"}],["profileDocs",{title:"Brochure"}],["complaints",{status:"resolved",admin_notes:"Reviewed"}],["contactSubmissions",{status:"closed"}],["jobApplications",{admin_notes:"Reviewed"}]]){
    assert.equal((await manageRecord(db,"Bearer valid",{module,id:1,action:"save",patch})).ok,true);
    const call=db.calls.at(-1);assert.equal(call.name,"manage_admin_record");assert.equal(call.args.p_actor_id,"admin");assert.deepEqual(call.args.p_patch,patch);
  }
});
test("archive, restore, deactivate and close share one atomic database command",async()=>{
  const db=database();
  for(const module of ["guards","supervisors","fieldOfficers","sites","services","events","notifications","profileDocs","complaints","contactSubmissions","jobApplications"]){
    for(const action of ["archive","restore"]){
      await manageRecord(db,"Bearer valid",{module,id:3,action});
      assert.equal(db.calls.at(-1).args.p_action,action);
    }
  }
  for(const action of ["deactivate","activate"])await manageRecord(db,"Bearer valid",{module:"guards",id:3,action});
  for(const action of ["close","reopen"])await manageRecord(db,"Bearer valid",{module:"complaints",id:3,action});
});
test("permanent deletion requires exact typed confirmation and blocks unspecified intake retention",async()=>{
  const db=database();
  await assert.rejects(()=>manageRecord(db,"Bearer valid",{module:"services",id:1,action:"delete",confirmation:"DELETE 2"}),/exact record ID/);
  for(const module of ["complaints","contactSubmissions","jobApplications"])await assert.rejects(()=>manageRecord(db,"Bearer valid",{module,id:1,action:"delete",confirmation:"DELETE 1"}),error=>error.status===409);
  assert.equal(db.calls.length,0);
  await manageRecord(db,"Bearer valid",{module:"services",id:1,action:"delete",confirmation:"DELETE 1"});
  assert.equal(db.calls[0].args.p_confirmation,"DELETE 1");
});
test("dangerous fields, history edits, unknown modules and malformed input fail before RPC",()=>{
  for(const input of [
    {module:"__proto__",action:"archive",id:1},{module:"constructor",action:"archive",id:1},
    {module:"advances",action:"delete",id:1},{module:"operations_audit_log",action:"save",id:1,patch:{action:"DELETE"}},
    {module:"guards",action:"save",id:1,patch:{salary_amount:0}},
    {module:"complaints",action:"save",id:1,patch:{details:"rewrite evidence"}},
    {module:"services",action:"save",id:1,patch:{archived_at:null}},
    {module:"services",action:"save",patch:{title:"",id:2}},
    {module:"profileDocs",action:"save",patch:{file_url:"javascript:alert(1)"}},
    {module:"notifications",action:"save",patch:{starts_at:"2026-01-01",expires_at:"2025-01-01"}},
    {module:"sites",action:"archive",id:-1},
  ])assert.throws(()=>validateRecordRequest(input));
});
test("400,403,404,409,500 and missing migration errors return safe HTTP status/details",async()=>{
  for(const [code,status] of [["22023",400],["42501",403],["P0002",404],["23503",409],["55000",409],["23505",409],["unavailable",500],["PGRST202",503]]){
    const db=database({rpcError:{code,message:"DO NOT LEAK DATABASE INTERNALS"}});
    await api(db,async url=>{
      const res=await post(url,{module:"sites",id:1,action:"archive"});
      assert.equal(res.status,status);assert.ok(!(await res.text()).includes("DO NOT LEAK"));
    });
  }
});
test("retained or invalid media can never reach Storage removal",async()=>{
  for(const result of [{blocked:true},{bucket:"public",path:"file"},{bucket:"employee-private",path:"../private"}]){
    const db=database({result});
    await assert.rejects(()=>cleanupMedia(db,"Bearer valid",{id:1,confirmation:"DELETE FILE 1"}),error=>error.status===409);
    assert.equal(db.calls.filter(c=>c.remove).length,0);
  }
  const db=database();
  await assert.rejects(()=>enqueueMediaCleanup(db,"Bearer valid",{bucket:"company-profile",path:"../private"}));
  await assert.rejects(()=>cleanupMedia(db,"Bearer valid",{id:1,confirmation:"DELETE FILE 2"}));
  assert.equal(db.calls.length,0);
});
test("physical orphan removal uses a database reservation, explicit confirmation and completion token",async()=>{
  const db=database({result:{bucket:"company-profile",path:"old/brochure.pdf",claim:"claim-id"}});
  await cleanupMedia(db,"Bearer valid",{id:1,confirmation:"DELETE FILE 1"});
  assert.deepEqual(db.calls.map(c=>c.name||"remove"),["claim_media_cleanup","remove","complete_media_cleanup"]);
  assert.equal(db.calls.at(-1).args.p_claim,"claim-id");assert.equal(db.calls.at(-1).args.p_failed,false);
  const fail=database({result:{bucket:"company-profile",path:"old/file",claim:"claim-id"},failRemove:true});
  await assert.rejects(()=>cleanupMedia(fail,"Bearer valid",{id:1,confirmation:"DELETE FILE 1"}),error=>error.status===500);
  assert.equal(fail.calls.at(-1).args.p_failed,true);
});
test("legacy delete endpoints cannot bypass lifecycle confirmation or retention checks",async()=>{
  const db=database();
  await api(db,async url=>{
    for(const [route,body] of [["guards",{guard_id:1}],["sites",{site_id:1}],["people",{employee_type:"field_officer",employee_id:1}]]){
      const res=await fetch(url+"/api/operations/"+route,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer valid"},body:JSON.stringify({action:"delete",...body})});
      assert.equal(res.status,400);
    }
  });
  assert.equal(db.calls.length,0);
});

test("operational editors never report success when the database confirms no saved record",async()=>{
  const db=database({result:null});
  await api(db,async url=>{
    const person={full_name:"Synthetic person",phone:"9876543210"};
    for(const [route,body] of [
      ["sites",{action:"save",site_id:1,site:{site_code:"S-1",title:"Synthetic site"}}],
      ["guards",{action:"save",guard_id:1,person}],
      ["people",{action:"save",employee_type:"field_officer",employee_id:1,person}],
    ]){
      const response=await fetch(url+"/api/operations/"+route,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer valid"},body:JSON.stringify(body)});
      assert.equal(response.status,404);
      const result=await response.json();assert.ok(result.error);assert.notEqual(result.ok,true);
    }
  });
});
test("content edits accept safe existing same-site links and reject credentials or invalid scalar types",()=>{
  assert.doesNotThrow(()=>validateRecordRequest({module:"services",id:1,action:"save",patch:{image_url:"/gss-logo.png"}}));
  assert.doesNotThrow(()=>validateRecordRequest({module:"notifications",id:1,action:"save",patch:{button_url:"#contact"}}));
  assert.throws(()=>validateRecordRequest({module:"services",id:1,action:"save",patch:{image_url:"https://user:credential@example.com/image"}}));
  assert.throws(()=>validateRecordRequest({module:"complaints",id:1,action:"save",patch:{admin_notes:false}}));
});

test("retained same-effective-date compensation conflict has a safe actionable HTTP 409",async()=>{
  const db=database({rpcError:{code:"55000",message:"Compensation history must be retained."}});
  await api(db,async url=>{
    const response=await fetch(url+"/api/operations/guards",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer valid"},body:JSON.stringify({action:"save",guard_id:201,person:{full_name:"Synthetic guard",phone:"9999900001",salary_frequency:"daily",salary_amount:1000,salary_effective_date:"2026-10-01"},site_ids:[]})});
    assert.equal(response.status,409);
    const body=await response.json();
    assert.match(body.error,/same effective date/);
    assert.match(body.error,/not saved/);
    assert.notEqual(body.ok,true);
  });
});
