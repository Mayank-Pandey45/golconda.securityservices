import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { readFile } from "node:fs/promises";

test("record controls render appropriate actions, filters and accessible destructive confirmation",async()=>{
  const server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:{server:createHttpServer()}},appType:"custom"});
  try{
    const {default:Actions,RecordFilter,RecordDialog}=await server.ssrLoadModule("/src/admin/RecordActions.jsx");
    const active=renderToStaticMarkup(React.createElement(Actions,{module:"guards",item:{id:1,status:"active",full_name:"Synthetic"}}));
    assert.match(active,/Deactivate/);assert.match(active,/Archive/);assert.doesNotMatch(active,/Permanently delete/);
    const archived=renderToStaticMarkup(React.createElement(Actions,{module:"services",item:{id:1,archived_at:"2026-10-22"}}));
    assert.match(archived,/Restore/);assert.match(archived,/Permanently delete/);
    const intake=renderToStaticMarkup(React.createElement(Actions,{module:"complaints",item:{id:1,status:"pending"}}));
    assert.match(intake,/Edit review notes/);assert.match(intake,/retention policy/);assert.doesNotMatch(intake,/Permanently delete/);
    const filter=renderToStaticMarkup(React.createElement(RecordFilter,{value:"all",onChange(){}}));
    for(const state of ["all","active","inactive","archived"])assert.ok(filter.includes('value="'+state+'"'));
    const dialog=renderToStaticMarkup(React.createElement(RecordDialog,{title:"Confirm removal",onClose(){}},React.createElement("input",{"aria-label":"Type DELETE 1"})));
    assert.match(dialog,/role="dialog"/);assert.match(dialog,/aria-modal="true"/);
    const {default:History}=await server.ssrLoadModule("/src/admin/RetainedHistory.jsx");
    const history=renderToStaticMarkup(React.createElement(History));
    assert.match(history,/Read-only history/);assert.doesNotMatch(history,/Permanently delete/);
    const {default:People}=await server.ssrLoadModule("/src/admin/PeopleManagement.jsx");
    for(const employeeType of ['supervisor','field_officer']){
      const html=renderToStaticMarkup(React.createElement(People,{employeeType,sites:[{id:1,title:'QA named site',site_code:'QA-SITE',status:'active'},{id:2,title:'QA archived site',status:'active',archived_at:'2026-10-23'}]}));
      assert.match(html,/QA named site/);assert.match(html,/QA-SITE/);assert.doesNotMatch(html,/QA archived site/);
    }
    const {default:Sites}=await server.ssrLoadModule('/src/admin/SiteManagement.jsx');
    const siteHtml=renderToStaticMarkup(React.createElement(Sites));
    assert.match(siteHtml,/maximum 3\.5 MB/);assert.doesNotMatch(siteHtml,/maximum 5 MB/);
  } finally {await server.close();}
});

test('catalogue editor is restricted to catalogue modules; public forms isolate feedback and block in-flight repeats',async()=>{
  const main=await readFile(new URL('./main.jsx',import.meta.url),'utf8');
  assert.match(main,/\["events", "notifications", "services"\]\.includes\(adminTab\) && \(/);
  assert.doesNotMatch(main,/\bsetNotice\b|\{notice &&/);
  for(const endpoint of ['contact','applications','complaints']){
    assert.ok(main.includes('formNotices.'+endpoint));
    assert.ok(main.includes('disabled={Boolean(submitting.'+endpoint+')}'));
  }
  assert.match(main,/pendingSubmissions\.current\.has\(endpoint\).*return/);
  assert.match(main,/pendingSubmissions\.current\.add\(endpoint\)/);
  assert.match(main,/finally\s*\{\s*pendingSubmissions\.current\.delete\(endpoint\)/);
  assert.match(main,/loadPublicContent\(\);[\s\S]*?\}, \[adminMode\]\)/);
  const people=await readFile(new URL('./admin/PeopleManagement.jsx',import.meta.url),'utf8');
  assert.match(people,/\[employeeType, items, guards\]/);
  assert.doesNotMatch(people,/\[employeeType, items\.length\]/);
  const advances=await readFile(new URL('./admin/AdvancesManagement.jsx',import.meta.url),'utf8');
  assert.match(advances,/external_reference: advanceRequest\.current\.reference/);
  assert.match(advances,/advanceRequest\.current\?\.fingerprint !== fingerprint/);
  assert.match(advances,/if \(advancePending\.current\) return/);
  const css=await readFile(new URL('./admin/recordManagement.css',import.meta.url),'utf8');
  assert.match(css,/@media\(max-width:600px\)/);
  assert.match(css,/\.gss-admin-account>span\{min-width:0;overflow-wrap:anywhere\}/);
});
