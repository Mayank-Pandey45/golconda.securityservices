import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

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
  } finally {await server.close();}
});
