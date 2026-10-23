// Synthetic, local-only browser verification over the supported Edge DevTools Protocol.
// Start scripts/qa-fixture.js first, then launch Edge headless with --remote-debugging-port=0
// and pass the port written to DevToolsActivePort as GSS_CDP_PORT.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.GSS_CDP_PORT || 0);
const outputDir = process.env.GSS_VISUAL_DIR;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set GSS_CDP_PORT to the local Edge DevTools port.');
if (!outputDir) throw new Error('Set GSS_VISUAL_DIR to a writable screenshot directory.');
await mkdir(outputDir, { recursive: true });

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
if (!String(version.Browser || '').startsWith('Edg/')) throw new Error('The DevTools endpoint is not Microsoft Edge.');
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const runtimeErrors = [];
const failedRequests = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails?.text || 'Runtime exception');
  if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') runtimeErrors.push(message.params.entry.text);
  if (message.method === 'Network.loadingFailed' && !message.params.canceled) failedRequests.push({ requestId: message.params.requestId, error: message.params.errorText });
  if (message.id && pending.has(message.id)) {
    const item = pending.get(message.id);
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const target = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const session = attached.sessionId;
for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await send(domain, {}, session);
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'Page evaluation failed');
  return result.result?.value;
};
const waitFor = async (expression, description, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${description}`);
};
const failures = [];
const screenshots = [];
const record = (name, value) => {
  const row = { name, ...value };
  results.push(row);
  if (value.ok === false) failures.push(name);
  return row;
};
const results = [];
async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
  const file = path.join(outputDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  screenshots.push(file);
  return file;
}
async function setViewport(width) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 768 }, session);
  await new Promise(resolve => setTimeout(resolve, 100));
}
async function layout(name) {
  const metrics = await evaluate(`(() => {
    const root=document.documentElement, body=document.body;
    const overflowing=[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>innerWidth+2&&getComputedStyle(el).position!=='fixed'&&getComputedStyle(el).position!=='absolute'}).slice(0,8).map(el=>({tag:el.tagName,className:typeof el.className==='string'?el.className:'',right:Math.round(el.getBoundingClientRect().right)}));
    return {url:location.href,width:innerWidth,clientWidth:root.clientWidth,scrollWidth:Math.max(root.scrollWidth,body.scrollWidth),horizontalOverflow:Math.max(root.scrollWidth,body.scrollWidth)>innerWidth+1,overflowing};
  })()`);
  await screenshot(name);
  return record(name, { ...metrics, ok: !metrics.horizontalOverflow });
}
async function setField(selector, value) {
  const exp = `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set; setter?.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
  if (!await evaluate(exp)) throw new Error(`Missing form field ${selector}`);
}
async function textSnapshot() {
  return evaluate(`({text:document.body.innerText,url:location.href})`);
}
async function auditActiveDialog() {
  return evaluate(`(() => {
    const dialog=document.querySelector('[role="dialog"]'); if(!dialog)return {ok:false,reason:'dialog missing'};
    const rgba=s=>{const m=String(s).match(/[\\d.]+/g);return m?m.slice(0,4).map(Number):null};
    const luminance=c=>{const v=c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]};
    const contrast=(fg,bg)=>{const a=rgba(fg),b=rgba(bg);if(!a||!b)return null;const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
    const bgFor=el=>{for(let n=el;n&&n!==document.documentElement;n=n.parentElement){const value=rgba(getComputedStyle(n).backgroundColor);if(value&&(value.length<4||value[3]>.01))return getComputedStyle(n).backgroundColor}return getComputedStyle(document.body).backgroundColor};
    const backgroundsFor=el=>{const image=getComputedStyle(el).backgroundImage;const stops=[...image.matchAll(/rgba?\([^)]+\)/gi)].map(match=>match[0]);return image!=='none'&&stops.length?stops:[bgFor(el)]};
    const minimumContrast=(fg,backgrounds)=>Math.min(...backgrounds.map(bg=>contrast(fg,bg)).filter(value=>value!=null));
    const rows=[...dialog.querySelectorAll('h1,h2,h3,p,label,button,input,textarea,select,option,[role="alert"]')].map(el=>{const style=getComputedStyle(el),backgrounds=backgroundsFor(el),bg=backgrounds.join(' / '),large=parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.67&&Number(style.fontWeight)>=700),row={tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||el.placeholder||'').trim().slice(0,80),ratio:minimumContrast(style.color,backgrounds),fg:style.color,bg,fontSize:style.fontSize,disabled:!!el.disabled};if(el.matches('input,textarea')&&el.placeholder){const p=getComputedStyle(el,'::placeholder');row.placeholder=p.color;row.placeholderRatio=minimumContrast(p.color,[bgFor(el)])}row.threshold=large?3:4.5;return row});
    const problems=rows.filter(row=>(row.ratio!=null&&row.ratio<row.threshold)||(row.placeholderRatio!=null&&row.placeholderRatio<4.5));
    const r=dialog.getBoundingClientRect();const bounds={left:r.left>=0,right:r.right<=innerWidth+1,top:r.top>=0,bottom:r.bottom<=innerHeight+1,scrollable:dialog.scrollHeight>dialog.clientHeight||getComputedStyle(dialog).overflowY==='auto'};
    return {ok:problems.length===0&&bounds.left&&bounds.right,rows,problems,bounds};
  })()`);
}

try {
  await send('Page.navigate', { url: 'http://127.0.0.1:5187/' }, session);
  await waitFor(`document.readyState==='complete' && location.origin==='http://127.0.0.1:5187'`, 'the exact synthetic localhost URL');
  const initial = await textSnapshot();
  if (initial.url !== 'http://127.0.0.1:5187/') throw new Error(`Unexpected browser URL: ${initial.url}`);
  record('direct localhost navigation', { url: initial.url, ok: true });
  // Reuse of this isolated browser profile across runs must not skip the login
  // dialog. Clear only this synthetic localhost origin, then reload.
  await evaluate('localStorage.clear(); sessionStorage.clear()');
  await send('Page.reload', {}, session);
  await waitFor(`!!document.querySelector('button.login-nav') && !document.querySelector('.gss-admin-shell')`, 'fresh synthetic public session');

  for (const width of [360, 390, 768, 1366, 1920]) {
    await setViewport(width);
    await layout(`public-${width}`);
  }

  await setViewport(360);
  await evaluate(`(() => [...document.querySelectorAll('button')].find(el=>el.innerText.trim()==='Team Login')?.click())()`);
  await waitFor(`!!document.querySelector('.login-modal[role="dialog"]')`, 'the login dialog');
  await screenshot('login-dialog-360');
  const contrastAudit = await evaluate(`(() => {
    const dialog=document.querySelector('[role="dialog"]'); if(!dialog) return {ok:false,reason:'dialog missing'};
    const rgba=s=>{const m=String(s).match(/[\\d.]+/g);return m?m.slice(0,4).map(Number):null};
    const luminance=c=>{const v=c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]};
    const contrast=(fg,bg)=>{const a=rgba(fg),b=rgba(bg);if(!a||!b)return null;const l1=luminance(a),l2=luminance(b);return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)};
    const bgFor=el=>{for(let n=el;n&&n!==document.documentElement;n=n.parentElement){const c=getComputedStyle(n).backgroundColor;const rgbaValue=rgba(c);if(rgbaValue&&(rgbaValue.length<4||rgbaValue[3]>.01))return c}return getComputedStyle(document.body).backgroundColor};
    const backgroundsFor=el=>{const image=getComputedStyle(el).backgroundImage;const stops=[...image.matchAll(/rgba?\([^)]+\)/gi)].map(match=>match[0]);return image!=='none'&&stops.length?stops:[bgFor(el)]};
    const minimumContrast=(fg,backgrounds)=>Math.min(...backgrounds.map(bg=>contrast(fg,bg)).filter(value=>value!=null));
    const nodes=[...dialog.querySelectorAll('h1,h2,h3,p,label,button,input,textarea,select,option,[role="alert"]')];
    const rows=nodes.map(el=>{const st=getComputedStyle(el),backgrounds=backgroundsFor(el),bg=backgrounds.join(' / '),size=parseFloat(st.fontSize)||14,large=size>=24||(size>=18.67&&Number(st.fontWeight)>=700);const value={tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||el.placeholder||'').trim().slice(0,80),ratio:minimumContrast(st.color,backgrounds),fg:st.color,bg,fontSize:st.fontSize,disabled:!!el.disabled};if(el.matches('input,textarea')&&el.placeholder){const p=getComputedStyle(el,'::placeholder');value.placeholderRatio=minimumContrast(p.color,[bgFor(el)]);value.placeholder=p.color}return value});
    const problems=rows.filter(x=>(x.ratio!=null&&x.ratio<(x.fontSize&&parseFloat(x.fontSize)>=24?3:4.5))||(x.placeholderRatio!=null&&x.placeholderRatio<4.5));
    const dialogBox=dialog.getBoundingClientRect(),modalOverflow={top:dialogBox.top<0,bottom:dialogBox.bottom>innerHeight+1,left:dialogBox.left<0,right:dialogBox.right>innerWidth+1,scrollable:dialog.scrollHeight>dialog.clientHeight||getComputedStyle(dialog).overflowY==='auto'};
    return {ok:problems.length===0&&!modalOverflow.left&&!modalOverflow.right,rows,problems,modalOverflow};
  })()`);
  record('login dialog contrast and bounds', { ok: contrastAudit.ok, ...contrastAudit });
  await evaluate(`document.querySelector('.login-modal input')?.focus()`);
  const loginFocus = await evaluate(`(()=>{const x=document.querySelector('.login-modal input');const s=getComputedStyle(x);return {outline:s.outline,outlineColor:s.outlineColor,outlineWidth:s.outlineWidth}})()`);
  record('login input keyboard focus', { ...loginFocus, ok: parseFloat(loginFocus.outlineWidth) >= 1 });
  await evaluate(`document.querySelector('.modal-close')?.click()`);
  await waitFor(`!document.querySelector('.login-modal[role="dialog"]')`, 'login dialog close');

  await evaluate(`([...document.querySelectorAll('button')].find(el=>el.innerText.trim()==='Team Login')||{}).click?.()`);
  await waitFor(`!!document.querySelector('.login-modal form')`, 'synthetic sign-in form');
  const loginButtonPoint = await evaluate(`(()=>{const b=document.querySelector('.login-modal form button[type="submit"]');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (loginButtonPoint) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...loginButtonPoint }, session);
  const loginHover = await evaluate(`(()=>{const b=document.querySelector('.login-modal form button[type="submit"]');if(!b)return {ok:false,reason:'submit button missing'};const rgba=s=>{const m=String(s).match(/[\\d.]+/g);return m?m.slice(0,4).map(Number):null};const lum=c=>{const v=c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]};const ratio=(a,b)=>{a=lum(rgba(a));b=lum(rgba(b));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};const s=getComputedStyle(b),stops=[...s.backgroundImage.matchAll(/rgba?\\([^)]+\\)/gi)].map(x=>x[0]),backgrounds=stops.length?stops:[s.backgroundColor];return {color:s.color,background:s.backgroundImage,ratios:backgrounds.map(bg=>ratio(s.color,bg)),ok:backgrounds.every(bg=>ratio(s.color,bg)>=4.5)}})()`);
  record('Login button hover contrast', loginHover);
  await setField('.login-modal input[type="email"]', 'qa-admin@example.invalid');
  await setField('.login-modal input[type="password"]', 'Synthetic-local-only-123!');
  await evaluate(`document.querySelector('.login-modal form')?.requestSubmit()`);
  await waitFor(`!!document.querySelector('.gss-admin-shell')`, 'synthetic admin dashboard');
  record('synthetic admin authentication', { ok: true });

  const anonKey = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'anon', sub: '', exp: 4102444800, aud: 'authenticated' })).toString('base64url')}.synthetic-local-only`;
  const seeded = await evaluate(`(async()=>{
    const entry=Object.keys(localStorage).map(key=>{try{return JSON.parse(localStorage.getItem(key))}catch{return null}}).find(value=>value?.access_token);
    if(!entry)throw new Error('Synthetic session token was not stored');
    const token=entry.access_token, anon=${JSON.stringify(anonKey)};
    async function find(table,column,value){const url=new URL('/rest/v1/'+table,location.origin);url.searchParams.set('select','id');url.searchParams.set(column,'eq.'+value);const response=await fetch(url,{headers:{apikey:anon,Authorization:'Bearer '+token}});const rows=await response.json();if(!response.ok||!rows.length)throw new Error('Synthetic '+table+' fixture could not be read: '+JSON.stringify(rows));return rows[0]}
    const guard=await find('guards','full_name','QA Synthetic Guard'),siteA=await find('sites','title','QA Synthetic Site North'),siteB=await find('sites','title','QA Synthetic Site South');
    return {guardId:guard.id,siteAId:siteA.id,siteBId:siteB.id};
  })()`);
  record('synthetic profile fixture lookup', { ...seeded, ok: true });

  await send('Page.navigate', { url: `http://127.0.0.1:5187/?tab=guards` }, session);
  await waitFor(`location.origin==='http://127.0.0.1:5187' && !!document.querySelector('.gss-admin-shell') && [...document.querySelectorAll('.gss-admin-shell button')].some(b=>b.innerText.includes('Guards'))`, 'Guard Directory route');
  await waitFor(`document.body.innerText.includes('QA Synthetic Guard')`, 'synthetic Guard directory row');
  for (const width of [360, 390, 768, 1366, 1920]) { await setViewport(width); await layout(`guard-directory-${width}`); }
  await evaluate(`document.querySelector('a.guard-profile-link')?.click()`);
  await waitFor(`location.search.includes('guard=') && !!document.querySelector('.guard-profile-page')`, 'clickable Guard Profile navigation');
  const profileUrl = await evaluate(`location.href`);
  const id = Number(new URL(profileUrl).searchParams.get('guard'));
  if (id !== Number(seeded.guardId)) throw new Error('Guard link did not preserve the stable database ID.');
  await waitFor(`document.querySelector('.guard-profile-page')?.innerText.includes('₹4,500')`, 'calculated advance ledger totals');
  const profileMetrics = await evaluate(`(()=>{const text=document.querySelector('.guard-profile-page').innerText;return {guardName:text.includes('QA Synthetic Guard'),total:text.includes('₹4,500'),recovered:text.includes('₹500'),outstanding:text.includes('₹4,000'),north:text.includes('QA Synthetic Site North'),south:text.includes('QA Synthetic Site South'),priorAssignment:text.includes('Previous duty sites'),currentAssignment:text.includes('Current duty sites'),salaryUnavailable:text.includes('No completed salary-payment ledger is stored'),siteTotals:[...document.querySelectorAll('.guard-profile-site-totals tbody tr')].map(row=>row.innerText)}})()`);
  record('Guard Profile financial and assignment content', { ...profileMetrics, ok: profileMetrics.guardName&&profileMetrics.total&&profileMetrics.recovered&&profileMetrics.outstanding&&profileMetrics.north&&profileMetrics.south&&profileMetrics.salaryUnavailable });
  const siteFilter = 'section[aria-labelledby="guard-advances-heading"] .guard-profile-filters label:nth-of-type(5) select';
  const modeFilter = 'section[aria-labelledby="guard-advances-heading"] .guard-profile-filters label:nth-of-type(6) select';
  await setField(siteFilter, String(seeded.siteAId));
  await waitFor(`document.querySelector('.guard-profile-ledger-summary strong')?.innerText.includes('₹3,000')`, 'Site-filtered advance total');
  const siteFiltered = await evaluate(`(()=>({total:document.querySelector('.guard-profile-ledger-summary strong')?.innerText,entries:document.querySelector('.guard-profile-ledger-summary')?.innerText,sites:[...document.querySelectorAll('.guard-profile-table tbody tr')].map(x=>x.innerText)}))()`);
  record('Site-filtered advance reconciliation', { ...siteFiltered, ok: siteFiltered.total?.includes('₹3,000')&&siteFiltered.entries?.includes('2 entries') });
  await setField(siteFilter, '');
  await setField(modeFilter, 'online');
  await waitFor(`document.querySelector('.guard-profile-ledger-summary strong')?.innerText.includes('₹1,500')`, 'Online-filtered advance total');
  const modeFiltered = await evaluate(`(()=>({total:document.querySelector('.guard-profile-ledger-summary strong')?.innerText,entries:document.querySelector('.guard-profile-ledger-summary')?.innerText}))()`);
  record('Payment-mode advance filtering', { ...modeFiltered, ok: modeFiltered.total?.includes('₹1,500')&&modeFiltered.entries?.includes('1 entries') });
  await setField(modeFilter, '');
  for (const width of [360, 390, 768, 1366, 1920]) {
    await setViewport(width);
    await evaluate(`(()=>{const profile=document.querySelector('.guard-profile-page');if(profile){document.documentElement.style.scrollBehavior='auto';profile.scrollIntoView({block:'start',behavior:'instant'})}})()`);
    await layout(`guard-profile-${width}`);
  }
  await send('Page.reload', {}, session);
  await waitFor(`!!document.querySelector('.guard-profile-page') && location.search.includes('guard=')`, 'Guard Profile direct refresh');
  record('Guard Profile refresh / direct route', { url: await evaluate('location.href'), ok: true });

  await send('Page.navigate', { url: `http://127.0.0.1:5187/?tab=sites` }, session);
  await waitFor(`!!document.querySelector('.gss-admin-shell')`, 'Site Management route');
  await waitFor(`document.body.innerText.includes('QA Synthetic Site South')`, 'synthetic Site row');
  await evaluate(`document.querySelector('a.site-guard-profile-link[href*="guard="]')?.click()`);
  await waitFor(`location.search.includes('guard=') && !!document.querySelector('.guard-profile-page')`, 'Guard Profile from Site Management list');
  record('Site Management clickable Guard', { url: await evaluate('location.href'), ok: Number(new URL(await evaluate('location.href')).searchParams.get('guard'))===Number(seeded.guardId) });
  await send('Page.navigate', { url: `http://127.0.0.1:5187/?tab=sites` }, session);
  await waitFor(`!!document.querySelector('.gss-admin-shell') && document.body.innerText.includes('QA Synthetic Site South')`, 'Site Management after Guard Profile navigation');
  await evaluate(`document.querySelector('a.site-profile-link')?.click()`);
  await waitFor(`location.search.includes('site=') && !!document.querySelector('.site-profile-page')`, 'Site Profile navigation');
  const siteProfile = await evaluate(`(()=>{const text=document.querySelector('.site-profile-page').innerText;return {siteName:text.includes('QA Synthetic Site North')||text.includes('QA Synthetic Site South'),guardLink:!!document.querySelector('.site-profile-page a[href*="guard="]'),url:location.href}})()`);
  record('Site Profile clickable Guard', { ...siteProfile, ok: siteProfile.siteName&&siteProfile.guardLink });
  await evaluate(`document.querySelector('.site-profile-page a[href*="guard="]')?.click()`);
  await waitFor(`!!document.querySelector('.guard-profile-page')`, 'Guard Profile navigation from Site');
  record('Site to Guard profile navigation', { url: await evaluate('location.href'), ok: true });

  await send('Page.navigate', { url: `http://127.0.0.1:5187/?tab=guards` }, session);
  await waitFor(`!!document.querySelector('.gss-admin-shell')`, 'Guard Directory for employee exit');
  await waitFor(`document.body.innerText.includes('QA Synthetic Guard')`, 'active QA Guard row');
  await evaluate(`([...document.querySelectorAll('.gss-admin-item')].find(x=>x.innerText.includes('QA Synthetic Guard'))?.querySelector('button')&&[...document.querySelectorAll('.gss-admin-item button')].find(x=>x.innerText.trim()==='Remove Employee')?.click())`);
  await waitFor(`!!document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('Remove Employee')`, 'employee-exit dialog');
  await setViewport(360);
  const exitDialog = await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');const r=d.getBoundingClientRect();return {text:d.innerText,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,overflow:getComputedStyle(d).overflowY}})()`);
  await screenshot('employee-exit-dialog-360');
  record('Employee Exit dialog viewport', { ...exitDialog, ok: exitDialog.rect.left>=0&&exitDialog.rect.right<=361 });
  const exitContrast=await auditActiveDialog();
  record('Employee Exit dialog contrast',exitContrast);
  const exitFocus=await evaluate(`(()=>{const el=document.querySelector('[role="dialog"] select');el?.focus();const s=el&&getComputedStyle(el);return {outlineWidth:s?.outlineWidth,outlineColor:s?.outlineColor}})()`);
  record('Employee Exit dialog focus', {...exitFocus,ok:parseFloat(exitFocus.outlineWidth)>=1});
  const cancelPoint=await evaluate(`(()=>{const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>x.innerText.trim()==='Cancel');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if(cancelPoint) await send('Input.dispatchMouseEvent',{type:'mouseMoved',...cancelPoint},session);
  const cancelHover=await evaluate(`(()=>{const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>x.innerText.trim()==='Cancel');if(!b)return {ok:false};const s=getComputedStyle(b),bg=s.backgroundColor,fg=s.color,rgba=x=>String(x).match(/[\\d.]+/g)?.map(Number),lum=x=>{const c=rgba(x).slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*c[0]+.7152*c[1]+.0722*c[2]},a=lum(fg),c=lum(bg),ratio=(Math.max(a,c)+.05)/(Math.min(a,c)+.05);return {color:fg,background:bg,ratio,ok:ratio>=4.5}})()`);
  record('Employee Exit cancel hover contrast',cancelHover);
  await setField('[role="dialog"] select', 'Left Company');
  await setField('[role="dialog"] input[type="date"]', '2026-10-23');
  await setField('[role="dialog"] textarea', 'Synthetic browser QA only.');
  await evaluate(`([...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='Confirm Removal'))?.click()`);
  await waitFor(`!document.querySelector('[role="dialog"]') && document.body.innerText.includes('QA Synthetic Guard')`, 'synthetic employee exit completion', 15000);
  record('Employee Exit UI action', { ok: true });

  await send('Page.navigate', { url: `http://127.0.0.1:5187/?tab=guards` }, session);
  await waitFor(`!!document.querySelector('.gss-admin-shell')`, 'Former Employees route');
  const statusFilter = await evaluate(`(()=>[...document.querySelectorAll('select')].find(x=>x.getAttribute('aria-label')==='Filter by guard status')?.outerHTML)()`);
  if (!statusFilter) throw new Error('Former Employees filter is missing.');
  await setField('select[aria-label="Filter by guard status"]', 'relieved');
  await waitFor(`document.body.innerText.includes('Relieved') && document.body.innerText.includes('QA Synthetic Guard')`, 'Former Employees filter');
  record('Former Employees filter', { ok: true });

  await send('Page.navigate', { url: `http://127.0.0.1:5187/?tab=sites` }, session);
  await waitFor(`!!document.querySelector('.gss-admin-shell') && document.body.innerText.includes('QA Synthetic Site South')`, 'Site Management for closure');
  await evaluate(`(()=>{const card=[...document.querySelectorAll('.gss-admin-item')].find(x=>x.querySelector('a.site-profile-link')?.innerText.trim()==='QA Synthetic Site South');[...card?.querySelectorAll('button')||[]].find(b=>b.innerText.trim()==='Close Site')?.click()})()`);
  await waitFor(`!!document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('Close Site')`, 'site-closure dialog');
  await setViewport(390);
  const closeDialog = await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');const r=d.getBoundingClientRect();const controls=[...d.querySelectorAll('input,select,textarea,button')].map(el=>({tag:el.tagName,text:(el.innerText||el.placeholder||el.value||'').slice(0,60),disabled:!!el.disabled,color:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));return {text:d.innerText,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height},scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,overflow:getComputedStyle(d).overflowY,controls}})()`);
  await screenshot('site-closure-dialog-390');
  record('Site Closure dialog viewport and controls', { ...closeDialog, ok: closeDialog.rect.left>=0&&closeDialog.rect.right<=391 });
  const closeContrast=await auditActiveDialog();
  record('Site Closure dialog contrast',closeContrast);
  await setField('[role="dialog"] input[placeholder^="Contract expired"]', 'Synthetic contract closure');
  await setField('[role="dialog"] input[type="date"]', '2026-10-23');
  await setField('[role="dialog"] textarea', 'Synthetic browser QA only.');
  await waitFor(`document.querySelector('[role="dialog"] input[placeholder^="Contract expired"]')?.value==='Synthetic contract closure' && document.querySelector('[role="dialog"] textarea')?.value==='Synthetic browser QA only.' && ![...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='Confirm Site Closure')?.disabled`, 'complete Site closure form validation');
  const filledClosure=await evaluate(`(()=>({reason:document.querySelector('[role="dialog"] input[placeholder^="Contract expired"]')?.value,date:document.querySelector('[role="dialog"] input[type="date"]')?.value,remarks:document.querySelector('[role="dialog"] textarea')?.value,disabled:[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='Confirm Site Closure')?.disabled}))()`);
  record('Site Closure form values', {...filledClosure,ok:filledClosure.reason==='Synthetic contract closure'&&filledClosure.remarks==='Synthetic browser QA only.'&&!filledClosure.disabled});
  await screenshot('site-closure-dialog-filled-390');
  await evaluate(`([...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.trim()==='Confirm Site Closure'))?.click()`);
  await waitFor(`!document.querySelector('[role="dialog"]') && document.body.innerText.includes('Closed Sites')`, 'synthetic Site closure completion', 15000);
  record('Site Closure UI action', { ok: true });

  await evaluate(`document.querySelector('details.closed-sites summary')?.click()`);
  await waitFor(`document.querySelector('details.closed-sites')?.open`, 'Closed Sites expansion');
  await screenshot('closed-sites-390');
  const closedSiteText = await evaluate(`document.querySelector('details.closed-sites')?.innerText || ''`);
  record('Closed Sites history access', { ok: closedSiteText.includes('QA Synthetic Site South') });

  const networkSummary = await send('Network.getAllCookies', {}, session).catch(() => ({}));
  const summary = { browser: version.Browser, localUrl: await evaluate('location.href'), results, failures, runtimeErrors, failedRequests, screenshots, syntheticCookieCount: networkSummary.cookies?.length ?? 0 };
  await writeFile(path.join(outputDir, 'browser-smoke-report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length || runtimeErrors.length || failedRequests.length) process.exitCode = 1;
} finally {
  socket.close();
}
