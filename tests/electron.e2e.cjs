'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { once } = require('node:events');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = resolve(__dirname, '..');
const ELECTRON = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = () => crypto.randomUUID();
async function port() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
async function ready(url) { for (let i=0;i<100;i++) { try { if ((await fetch(`${url}/api/session`)).ok) return; } catch {} await pause(100); } throw Error('server did not become ready'); }

test('two independent Electron profiles complete shared UI workflow', { timeout: 120000 }, async t => {
  await mkdir(join(ROOT, 'work'), { recursive: true });
  const temp = await mkdtemp(join(ROOT, 'work', 'qa-electron-'));
  const appPort = await port();
  const origin = `http://127.0.0.1:${appPort}`;
  let providerCalls = 0;
  const provider = createServer(async (request, response) => {
    for await (const _ of request) {}
    providerCalls++;
    response.writeHead(200, {'content-type':'text/event-stream'});
    const draft = `Local test draft ${providerCalls}`;
    response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:draft})}\n\n`);
    response.write(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{status:'completed'}})}\n\n`);
    response.end();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1/responses`;
  const server = spawn(process.execPath, ['server.cjs'], {cwd:ROOT,env:{...process.env,RENDEZ_PORT:String(appPort),RENDEZ_DATA_DIR:temp,RENDEZ_OPENAI_RESPONSES_URL:providerUrl},stdio:['ignore','pipe','pipe']});
  let logs=''; for(const stream of [server.stdout,server.stderr]) stream.on('data',x=>logs+=x);
  let left, right;
  t.after(async()=>{
    await Promise.allSettled([left?.close(),right?.close()]);
    if (server.exitCode === null) { const exited=once(server,'exit'); server.kill(); await exited; }
    provider.closeAllConnections(); await new Promise(r=>provider.close(r));
    for(let i=0;i<5;i++){try{await rm(temp,{recursive:true,force:true});break;}catch(error){if(i===4)throw error;await pause(200);}}
  });
  await ready(origin);
  const token=uuid().slice(0,8);
  const environment={...process.env,RENDEZ_SERVER_URL:origin,APPDATA:join(temp,'appdata')};
  left=await electron.launch({executablePath:ELECTRON,args:[ROOT,`--profile=qa-left-${token}`],env:environment,timeout:30000});
  right=await electron.launch({executablePath:ELECTRON,args:[ROOT,`--profile=qa-right-${token}`],env:environment,timeout:30000});
  const a=await left.firstWindow(),b=await right.firstWindow();
  await Promise.all([a.waitForURL(origin+'/'),b.waitForURL(origin+'/')]);
  for (const page of [a,b]) {
    try { await page.locator('[data-action="auth-switch"]').waitFor({timeout:5000}); }
    catch { throw new Error(`Electron startup at ${page.url()}: ${await page.locator('body').innerText()}`); }
  }
  const register=async(page,name)=>{
    await page.locator('[data-action="auth-switch"]').click();
    await page.locator('#auth-form [name="name"]').fill(name);
    await page.locator('#auth-form [name="email"]').fill(`${name.toLowerCase()}-${token}@example.test`);
    await page.locator('#auth-form [name="password"]').fill('Strong-pass-12345!');
    await page.locator('#auth-form button[type="submit"]').click();
    await page.locator('.sidebar-foot strong').getByText(name).waitFor();
  };
  await register(a,'Alice');
  await register(b,'Bob');
  const aSession=await a.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  const bSession=await b.evaluate(()=>fetch('/api/session').then(r=>r.json()));
  assert.notEqual(aSession.user.id,bSession.user.id,'profiles have separate authenticated sessions');
  await a.locator('[data-action="create-workspace"]').click();
  await a.locator('#create-workspace-form [name="name"]').fill('Desktop shared space');
  await a.locator('#create-workspace-form button[type="submit"],#create-workspace-form button:not([type])').last().click();
  await a.locator('.invite-code').waitFor();
  const invite=(await a.locator('.invite-code').textContent()).trim();
  await b.locator('[data-action="join-workspace"]').click();
  await b.locator('#join-workspace-form [name="inviteCode"]').fill(invite);
  await b.locator('#join-workspace-form button[type="submit"],#join-workspace-form button:not([type])').last().click();
  await b.locator('.mini-member strong').getByText('Alice').waitFor();
  await a.locator('[data-tab="conversation"]').click();
  await b.locator('[data-tab="conversation"]').click();
  await a.locator('#message-text').fill('Alice desktop message');
  await a.locator('#message-form button').click();
  await b.locator('.message-copy p').getByText('Alice desktop message').waitFor();
  await b.locator('#message-text').fill('Bob desktop message');
  await b.locator('#message-form button').click();
  await a.locator('.message-copy p').getByText('Bob desktop message').waitFor();
  await a.locator('[data-tab="documents"]').click();
  await a.locator('[data-action="create-doc"]').click();
  await a.locator('#create-doc-form [name="title"]').fill('Desktop document');
  await a.locator('#create-doc-form [name="body"]').fill('First human version');
  await a.locator('#create-doc-form button').last().click();
  await b.locator('[data-tab="documents"]').click();
  await b.locator('.doc-list strong').getByText('Desktop document').waitFor();
  await b.locator('#doc-body').fill('Bob human revision');
  await b.locator('[data-action="save-doc"]').click();
  await a.locator('.history-item strong').getByText('Version 2 · Current').waitFor();
  await a.locator('[data-tab="agents"]').click();
  await b.locator('[data-tab="agents"]').click();
  const configure=async(page,name)=>{
    await page.locator('#credential-form [name="apiKey"]').fill(`test-${name}-${token}`);
    await page.locator('#credential-form button[type="submit"],#credential-form button:not([type])').first().click();
    await page.getByText('Key configured',{exact:true}).waitFor();
    await page.locator('#connection-result').getByText('API key saved for your account.').waitFor();
    await page.locator('[data-action="go-agent-step"]').getByText('Continue to register an agent').waitFor();
    assert.equal(await page.locator('#credential-form [name="apiKey"]').inputValue(),'');
    await page.locator('#agent-form [name="name"]').fill(`${name} agent`);
    await page.locator('#agent-form [name="instructions"]').fill('Write a concise draft.');
    await page.locator('#agent-form button').click();
    await page.locator('.mini-member strong').getByText(`${name} agent`).waitFor();
  };
  await configure(a,'Alice');
  await configure(b,'Bob');
  const run=async(page,owner)=>{
    const agentValue=await page.locator('#run-form [name="agentId"] option').filter({hasText:`${owner} agent`}).getAttribute('value');
    await page.locator('#run-form [name="agentId"]').selectOption(agentValue);
    await page.locator('#run-prompt').fill(`${owner} draft`);
    await page.locator('#run-form [name="documentId"]').selectOption({label:'Desktop document'});
    await page.locator('#run-form button').click();
    await page.locator('.run-item').filter({hasText:`${owner} draft`}).getByText('completed',{exact:true}).waitFor();
  };
  await run(a,'Alice');
  await run(b,'Bob');
  await a.locator('[data-tab="documents"]').click();
  await a.locator('#doc-body').fill('Final human revision');
  await a.locator('[data-action="save-doc"]').click();
  await b.locator('[data-tab="documents"]').click();
  await b.locator('.history-item strong').getByText('Version 5 · Current').waitFor();
  await b.locator('#doc-body').fill('Unsaved, not reviewed');
  assert.equal(await b.locator('[data-action="review-doc"]').isDisabled(),true,'dirty draft cannot be approved');
  await b.locator('[data-action="reload-doc"]').waitFor({timeout:3000});
  await b.locator('[data-action="reload-doc"]').click();
  await b.locator('[data-action="review-doc"]').click();
  assert.match(await b.locator('#modal-scrim').innerText(),/Final human revision/,'review shows exact current text');
  await b.locator('[data-action="confirm-approve"]').click();
  await a.getByText('Approved by 1',{exact:true}).waitFor();
  await mkdir(join(ROOT,'docs','screenshots'),{recursive:true});
  await a.screenshot({path:join(ROOT,'docs','screenshots','desktop-light.png'),fullPage:true});
  await a.locator('[data-action="theme"]').click();
  assert.equal(await a.locator('html').getAttribute('data-theme'),'dark');
  await a.screenshot({path:join(ROOT,'docs','screenshots','desktop-dark.png'),fullPage:true});
  const finalA=await a.evaluate(()=>fetch('/api/workspaces').then(r=>r.json()).then(async x=>fetch(`/api/workspaces/${x.workspaces[0].id}/state`).then(r=>r.json())));
  const finalB=await b.evaluate(()=>fetch('/api/workspaces').then(r=>r.json()).then(async x=>fetch(`/api/workspaces/${x.workspaces[0].id}/state`).then(r=>r.json())));
  assert.equal(finalA.documents[0].currentVersionId,finalB.documents[0].currentVersionId);
  assert.equal(finalA.documents[0].versions.length,5);
  assert.equal(finalA.documents[0].approvals.at(-1).versionId,finalA.documents[0].currentVersionId);
  assert.equal(providerCalls,2);
  assert.equal(logs.includes('test-Alice'),false);
  assert.equal(logs.includes('test-Bob'),false);
});
