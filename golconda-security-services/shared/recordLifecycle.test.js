import test from "node:test";
import assert from "node:assert/strict";
import { recordModules, recordActions, recordState, matchesRecordState, confirmationPhrase, recordLabel } from "./recordLifecycle.js";
test("every managed module supports archive/restore and consistent visibility filters",()=>{
  for(const module of Object.keys(recordModules)){
    assert.ok(recordActions(module,{id:1,status:"active"}).includes("archive"));
    assert.ok(recordActions(module,{id:1,archived_at:"2026-10-22"}).includes("restore"));
    assert.equal(recordState(module,{archived_at:"2026-10-22"}),"archived");
    assert.equal(matchesRecordState(module,{archived_at:"2026-10-22"},"active"),false);
    assert.equal(matchesRecordState(module,{archived_at:"2026-10-22"},"all"),true);
  }
});
test("retained submissions never offer permanent deletion or modify original intake evidence",()=>{
  for(const module of ["complaints","contactSubmissions","jobApplications"]){
    assert.equal(recordActions(module,{archived_at:"2026-10-22"}).includes("delete"),false);
    assert.ok(recordActions(module,{status:"new"}).includes("close"));
    assert.ok(recordActions(module,{status:"closed"}).includes("reopen"));
  }
  assert.deepEqual(recordActions("advances",{}),[]);
});
test("public visibility, operational inactivity and strong delete confirmation remain distinct",()=>{
  assert.equal(recordState("guards",{status:"relieved"}),"inactive");
  assert.equal(recordState("profileDocs",{is_public:false}),"inactive");
  assert.equal(recordState("services",{is_active:false}),"inactive");
  assert.ok(recordActions("guards",{status:"inactive"}).includes("activate"));
  assert.ok(recordActions("profileDocs",{is_public:true}).includes("hide"));
  assert.equal(confirmationPhrase("delete",42),"DELETE 42");
  assert.equal(confirmationPhrase("cleanup",42),"DELETE FILE 42");
});

test("employee record identity never collides across Guard, Supervisor and Field Officer tables",async()=>{
 const {employeeRecordKey}=await import("./recordLifecycle.js");
 assert.equal(new Set(["guard","supervisor","field_officer"].map(employee_type=>employeeRecordKey({employee_type,id:1}))).size,3);
});

test('all record naming fields include complaint identities rather than an untitled fallback',()=>{
 for(const field of ['title','full_name','name','complainant_name','file_title','subject'])assert.equal(recordLabel({[field]:'QA label'}),'QA label');
 assert.equal(recordLabel({complainant_name:'QA complainant',subject:'QA subject'}),'QA complainant');
 assert.equal(recordLabel({}),'Record');
});
