'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { generateAgentText } = require('./agent-provider.cjs');

const PORT = Number(process.env.RENDEZ_PORT || 4317);
const HOST = process.env.RENDEZ_HOST || '127.0.0.1';
const PUBLIC_ORIGIN = process.env.RENDEZ_PUBLIC_ORIGIN || '';
const DATA_DIR = path.resolve(process.env.RENDEZ_DATA_DIR || path.join(__dirname, '.data'));
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 128 * 1024;
const streams = new Map();
const controllers = new Map();
const credentials = new Map();
const limits = new Map();
const scrypt = promisify(crypto.scrypt);
let db, lockFd;

function fail(status, code, message) { const error = new Error(message); Object.assign(error, { status, code }); throw error; }
function id() { return crypto.randomUUID(); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function now() { return new Date().toISOString(); }
function str(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(400, 'validation_error', `${name} must be ${min}–${max} characters`);
  return value.trim();
}
function optionalId(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return str(value, name, 1, 128);
}
function key(value) { return str(value, 'clientRequestId', 1, 128); }
function rateLimit(bucket,subject,max,windowMs) {
  const name=`${bucket}:${subject}`,time=Date.now();
  const entry=limits.get(name);
  if(!entry||entry.until<=time){limits.set(name,{count:1,until:time+windowMs});return;}
  if(++entry.count>max)fail(429,'rate_limited','Too many requests; try again later');
  if(limits.size>10000)for(const [k,v] of limits)if(v.until<=time)limits.delete(k);
}
function row(table, entityId) {
  const record = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(entityId);
  return record ? JSON.parse(record.data) : null;
}
function rows(table, workspaceId) {
  return db.prepare(`SELECT data FROM ${table} WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId).map(r => JSON.parse(r.data));
}
function put(table, entity) {
  db.prepare(`INSERT INTO ${table} (id, workspace_id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(entity.id, entity.workspaceId, entity.createdAt, JSON.stringify(entity));
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  const changes = [];
  try { const value = fn(changes); db.exec('COMMIT'); for (const event of changes) broadcast(event); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function event(changes, workspaceId, type, entityId, actorId, summary) {
  const createdAt = now();
  const result = db.prepare('INSERT INTO events (workspace_id,type,entity_id,actor_id,summary,created_at) VALUES (?,?,?,?,?,?)').run(workspaceId,type,entityId,actorId,summary,createdAt);
  changes.push({ id: Number(result.lastInsertRowid), workspaceId, type, entityId, actorId, summary, createdAt });
}
function broadcast(change) {
  for (const response of streams.get(change.workspaceId) || []) {
    const userId=response.rendezUserId;
    const active=getUser(response.rendezRequest)?.id===userId&&Boolean(db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').get(change.workspaceId,userId));
    if(!active){response.end();streams.get(change.workspaceId)?.delete(response);continue;}
    try { response.write(`id: ${change.id}\nevent: change\ndata: ${JSON.stringify({ id: change.id, type: change.type, entityId: change.entityId })}\n\n`); }
    catch { /* connection cleanup is handled by close */ }
  }
}
function idempotent(userId, scope, requestId, payload, fn) {
  const requestKey = key(requestId);
  const fingerprint=hash(JSON.stringify(payload));
  const existing = db.prepare('SELECT response,fingerprint FROM requests WHERE user_id=? AND scope=? AND request_id=?').get(userId,scope,requestKey);
  if (existing) {if(existing.fingerprint!==fingerprint)fail(409,'idempotency_conflict','Request key was used with different input');return JSON.parse(existing.response);}
  return transaction(changes => {
    const repeated = db.prepare('SELECT response,fingerprint FROM requests WHERE user_id=? AND scope=? AND request_id=?').get(userId,scope,requestKey);
    if (repeated) {if(repeated.fingerprint!==fingerprint)fail(409,'idempotency_conflict','Request key was used with different input');return JSON.parse(repeated.response);}
    const response = fn(changes);
    db.prepare('INSERT INTO requests (user_id,scope,request_id,fingerprint,response) VALUES (?,?,?,?,?)').run(userId,scope,requestKey,fingerprint,JSON.stringify(response));
    return response;
  });
}
function acquireLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const lockPath = path.join(DATA_DIR, 'server.lock');
  try { lockFd = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = Number(fs.readFileSync(lockPath, 'utf8'));
    try { process.kill(prior, 0); throw new Error(`Rendez data is already open by process ${prior}`); }
    catch (checkError) {
      if (checkError.code === 'EPERM') throw new Error(`Rendez data may be open by process ${prior}`);
      if (checkError.message.startsWith('Rendez data')) throw checkError;
      fs.unlinkSync(lockPath);
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
    }
  }
  fs.writeSync(lockFd, String(process.pid));
  process.once('exit', () => { try { fs.closeSync(lockFd); fs.unlinkSync(lockPath); } catch {} });
}
function setup() {
  acquireLock();
  db = new DatabaseSync(path.join(DATA_DIR, 'rendez.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,invite_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (user_id TEXT NOT NULL,scope TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,scope,request_id));
    CREATE INDEX IF NOT EXISTS events_workspace_cursor ON events(workspace_id,id);
    CREATE INDEX IF NOT EXISTS members_user ON members(user_id);`);
  if(!db.prepare('PRAGMA table_info(requests)').all().some(column=>column.name==='fingerprint')){
    db.exec("ALTER TABLE requests ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  }
  transaction(changes => {
    for (const run of db.prepare('SELECT data FROM runs').all().map(x => JSON.parse(x.data))) {
      if (run.status === 'running') {
        run.status = 'failed'; run.error = 'Run interrupted by server restart'; run.updatedAt = now(); put('runs',run);
        event(changes,run.workspaceId,'run',run.id,run.requestedBy,'Agent run interrupted');
      }
    }
  });
}
function publicUser(record) { return { id: record.id, name: record.name, email: record.email }; }
function getUser(request) {
  const cookie = (request.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('rendez_session='));
  if (!cookie) return null;
  const value = cookie.slice('rendez_session='.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const session = db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(hash(value));
  if (!session || session.expires_at <= Date.now()) return null;
  const user = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(session.user_id);
  return user || null;
}
function requireUser(request) { const user = getUser(request); if (!user) fail(401,'unauthorized','Sign in to continue'); return user; }
function requireWorkspace(workspaceId,userId) {
  const member = db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').get(workspaceId,userId);
  if (!member) fail(404,'not_found','Workspace not found');
  const raw = db.prepare('SELECT data FROM workspaces WHERE id=?').get(workspaceId);
  if (!raw) fail(404,'not_found','Workspace not found');
  return JSON.parse(raw.data);
}
function entityInWorkspace(table,entityId,workspaceId) {
  const entity = row(table,entityId);
  if (!entity || entity.workspaceId !== workspaceId) fail(404,'not_found','Resource not found');
  return entity;
}
function json(response,status,value,headers={}) {
  response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415,'unsupported_media_type','Expected JSON');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > MAX_BODY) fail(413,'payload_too_large','Request body is too large');
  }
  try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { fail(400,'invalid_json','Invalid JSON body'); }
}
function guardOrigin(request) {
  const host = request.headers.host || '';
  const accepted = PUBLIC_ORIGIN ? new URL(PUBLIC_ORIGIN).host : [`127.0.0.1:${PORT}`,`localhost:${PORT}`];
  if (Array.isArray(accepted) ? !accepted.includes(host) : host !== accepted) fail(403,'invalid_host','Invalid host');
  const origin = request.headers.origin;
  if (origin && origin !== (PUBLIC_ORIGIN || `http://${host}`)) fail(403,'invalid_origin','Invalid request origin');
  if (request.headers['sec-fetch-site'] && !['same-origin','none'].includes(request.headers['sec-fetch-site'])) fail(403,'invalid_origin','Cross-site request rejected');
}
function sessionCookie(value) { return `rendez_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${PUBLIC_ORIGIN.startsWith('https://') ? '; Secure' : ''}`; }
function newSession(userId,response) {
  const value = token();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hash(value),userId,Date.now()+SESSION_MS);
  response.setHeader('Set-Cookie',sessionCookie(value));
}
function makeWorkspace(name,ownerId) {
  const inviteCode = token();
  const workspace = { id:id(), name, ownerId, inviteCode, createdAt:now() };
  transaction(changes => {
    db.prepare('INSERT INTO workspaces(id,owner_id,invite_hash,created_at,data) VALUES (?,?,?,?,?)').run(workspace.id,ownerId,hash(inviteCode),workspace.createdAt,JSON.stringify(workspace));
    db.prepare('INSERT INTO members(workspace_id,user_id) VALUES (?,?)').run(workspace.id,ownerId);
    event(changes,workspace.id,'workspace',workspace.id,ownerId,'Workspace created');
  });
  return workspace;
}
function state(workspaceId,userId) {
  const workspace = requireWorkspace(workspaceId,userId);
  const members = db.prepare('SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.name').all(workspaceId);
  const events = db.prepare('SELECT id,workspace_id AS workspaceId,type,entity_id AS entityId,actor_id AS actorId,summary,created_at AS createdAt FROM events WHERE workspace_id=? ORDER BY id DESC LIMIT 100').all(workspaceId).reverse();
  const cursor = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events WHERE workspace_id=?').get(workspaceId).id;
  return { workspace,members,agents:rows('agents',workspaceId),messages:rows('messages',workspaceId),documents:rows('documents',workspaceId),runs:rows('runs',workspaceId),events,cursor };
}
function runtime(userId) {
  const credential = credentials.get(userId);
  return { provider:'openai',available:Boolean(credential),models:credential?[credential.model]:[],error:credential?null:'Add your API key to enable agents' };
}
function sse(request,response,workspaceId,userId,url) {
  requireWorkspace(workspaceId,userId);
  const afterRaw = url.searchParams.get('after') || request.headers['last-event-id'] || '0';
  if (!/^\d+$/.test(afterRaw)) fail(400,'validation_error','Invalid event cursor');
  const after = Number(afterRaw);
  if(!Number.isSafeInteger(after)) fail(400,'validation_error','Invalid event cursor');
  response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  response.write(': connected\n\n');
  response.rendezUserId=userId;
  response.rendezRequest=request;
  if (!streams.has(workspaceId)) streams.set(workspaceId,new Set());
  streams.get(workspaceId).add(response);
  const query=db.prepare('SELECT id,type,entity_id AS entityId FROM events WHERE workspace_id=? AND id>? ORDER BY id LIMIT 1000');
  let cursor=after;
  for(;;){
    const batch=query.all(workspaceId,cursor);
    for(const change of batch){response.write(`id: ${change.id}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`);cursor=change.id;}
    if(batch.length<1000)break;
  }
  const ping = setInterval(()=>{
    const stillSignedIn=getUser(request)?.id===userId;
    const stillMember=Boolean(db.prepare('SELECT 1 FROM members WHERE workspace_id=? AND user_id=?').get(workspaceId,userId));
    if(!stillSignedIn||!stillMember){response.end();clearInterval(ping);streams.get(workspaceId)?.delete(response);return;}
    try { response.write(': keepalive\n\n'); } catch {}
  },25000);
  request.on('close',()=>{clearInterval(ping);streams.get(workspaceId)?.delete(response)});
}
async function executeRun(run,agent) {
  const controller = new AbortController(); controllers.set(run.id,controller);
  if(row('runs',run.id)?.status!=='running'){controllers.delete(run.id);return;}
  let lastPersistAt=0,lastPersistLength=0;
  const snapshot = state(run.workspaceId,run.requestedBy);
  const selected=run.documentId?snapshot.documents.find(d=>d.id===run.documentId):null;
  const selectedDocument=selected?{id:selected.id,title:selected.title,baseVersionId:run.baseVersionId,body:selected.versions.find(v=>v.id===run.baseVersionId)?.body.slice(0,16000)}:null;
  const context = JSON.stringify({workspace:snapshot.workspace.name,selectedDocument,agentInstructions:agent.instructions,messages:snapshot.messages.slice(-12).map(m=>({author:m.authorType==='agent'?'Agent':'Member',text:m.text.slice(0,1000)})),otherDocuments:snapshot.documents.filter(d=>d.id!==run.documentId).slice(-5).map(d=>({id:d.id,title:d.title,body:d.versions.find(v=>v.id===d.currentVersionId)?.body.slice(0,1000)}))}).slice(0,32000);
  try {
    const credential = credentials.get(agent.ownerId);
    if (!credential) throw new Error('Agent owner API key is not configured');
    const output = await generateAgentText({ apiKey:credential.apiKey,model:agent.model||credential.model,prompt:run.prompt,context,signal:controller.signal,onChunk:async(_part,current)=>{
      if(Date.now()-lastPersistAt<250&&current.length-lastPersistLength<256)return;
      lastPersistAt=Date.now();lastPersistLength=current.length;
      transaction(changes=>{ const latest=row('runs',run.id); if(!latest||latest.status!=='running') return; latest.outputText=current;latest.updatedAt=now();put('runs',latest);event(changes,latest.workspaceId,'run',latest.id,agent.id,'Agent output updated'); });
    }});
    transaction(changes=>{
      const latest=row('runs',run.id); if(!latest||latest.status!=='running') return;
      latest.outputText=output;latest.updatedAt=now();
      if(latest.documentId){
        const document=entityInWorkspace('documents',latest.documentId,latest.workspaceId);
        if(document.currentVersionId!==latest.baseVersionId){latest.status='conflict';latest.error='Document changed during this run';}
        else{
          const version={id:id(),documentId:document.id,number:document.versions.length+1,body:output,baseVersionId:latest.baseVersionId,authorId:agent.id,authorType:'agent',runId:latest.id,createdAt:now()};
          document.versions.push(version);document.currentVersionId=version.id;put('documents',document);latest.status='completed';latest.error=null;
          event(changes,document.workspaceId,'document',document.id,agent.id,'Agent draft created');
        }
      } else {
        const message={id:id(),workspaceId:latest.workspaceId,authorId:agent.id,authorType:'agent',text:output,createdAt:now(),runId:latest.id};
        put('messages',message);latest.status='completed';latest.error=null;
        event(changes,message.workspaceId,'message',message.id,agent.id,'Agent replied');
      }
      put('runs',latest);event(changes,latest.workspaceId,'run',latest.id,agent.id,latest.status==='conflict'?'Agent draft conflicted':'Agent run completed');
    });
  } catch (error) {
    transaction(changes=>{ const latest=row('runs',run.id);if(!latest||latest.status!=='running')return;latest.status=controller.signal.aborted?'cancelled':'failed';latest.error=controller.signal.aborted?'Run cancelled':String(error.message||'Agent run failed').slice(0,300);latest.updatedAt=now();put('runs',latest);event(changes,latest.workspaceId,'run',latest.id,agent.id,'Agent run '+latest.status); });
  } finally { controllers.delete(run.id); }
}
async function api(request,response,url) {
  const route = url.pathname.slice(4);
  if(request.method==='GET'&&route==='/session') return json(response,200,{user:getUser(request)});
  if(request.method==='POST'&&route==='/auth/register'){
    rateLimit('auth',request.socket.remoteAddress||'local',10,15*60_000);
    const input=await body(request),name=str(input.name,'Name',1,100),email=str(input.email,'Email',3,254).toLowerCase(),password=input.password;
    if(typeof password!=='string'||password.length<10||password.length>1024)fail(400,'validation_error','Password must be 10–1024 characters');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'validation_error','Invalid email');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409,'email_exists','Email already registered');
    const salt=crypto.randomBytes(16).toString('hex'),user={id:id(),name,email};
    const passwordHash=(await scrypt(password,salt,64)).toString('hex');
    db.prepare('INSERT INTO users(id,name,email,salt,password_hash) VALUES (?,?,?,?,?)').run(user.id,name,email,salt,passwordHash);
    newSession(user.id,response);return json(response,201,{user});
  }
  if(request.method==='POST'&&route==='/auth/login'){
    rateLimit('auth',request.socket.remoteAddress||'local',10,15*60_000);
    const input=await body(request),email=str(input.email,'Email',3,254).toLowerCase(),password=input.password;
    if(typeof password!=='string'||password.length<1||password.length>1024)fail(400,'validation_error','Invalid credentials');
    const record=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!record) fail(401,'invalid_credentials','Invalid email or password');
    const candidate=await scrypt(password,record.salt,64);
    if(!crypto.timingSafeEqual(candidate,Buffer.from(record.password_hash,'hex'))) fail(401,'invalid_credentials','Invalid email or password');
    newSession(record.id,response);return json(response,200,{user:publicUser(record)});
  }
  if(request.method==='POST'&&route==='/auth/logout'){
    const activeUser=getUser(request);
    if(activeUser){
      credentials.delete(activeUser.id);
      for(const [runId,controller] of controllers){
        if(row('runs',runId)?.requestedBy===activeUser.id)controller.abort();
      }
    }
    const cookie=(request.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rendez_session='));
    if(cookie) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(cookie.slice('rendez_session='.length)));
    response.setHeader('Set-Cookie','rendez_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(response,200,{ok:true});
  }
  const user=requireUser(request);
  if(request.method==='GET'&&route==='/runtime') return json(response,200,runtime(user.id));
  if(request.method==='POST'&&route==='/runtime/credentials'){
    rateLimit('credentials',user.id,10,5*60_000);
    const input=await body(request);
    const apiKey=str(input.apiKey,'API key',8,512);
    const model=input.model===undefined?'gpt-4.1-mini':str(input.model,'Model',1,100);
    credentials.set(user.id,{apiKey,model});
    return json(response,200,runtime(user.id));
  }
  if(request.method==='DELETE'&&route==='/runtime/credentials'){
    credentials.delete(user.id);return json(response,200,{ok:true});
  }
  if(request.method==='GET'&&route==='/workspaces'){
    const workspaces=db.prepare('SELECT w.data FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at').all(user.id).map(x=>JSON.parse(x.data));
    return json(response,200,{workspaces});
  }
  if(request.method==='POST'&&route==='/workspaces'){
    const input=await body(request),workspace=makeWorkspace(str(input.name,'Workspace name',1,100),user.id);
    return json(response,201,{workspace,inviteCode:workspace.inviteCode});
  }
  if(request.method==='POST'&&route==='/workspaces/join'){
    const input=await body(request),inviteCode=str(input.inviteCode,'Invite code',20,128);
    const match=db.prepare('SELECT data FROM workspaces WHERE invite_hash=?').get(hash(inviteCode));
    if(!match) fail(404,'invalid_invite','Invite not found');
    const workspace=JSON.parse(match.data);
    transaction(changes=>{const result=db.prepare('INSERT OR IGNORE INTO members(workspace_id,user_id) VALUES (?,?)').run(workspace.id,user.id);if(result.changes)event(changes,workspace.id,'member',user.id,user.id,'Member joined');});
    return json(response,200,{workspace});
  }
  const match=route.match(/^\/workspaces\/([^/]+)(?:\/(.*))?$/);
  if(!match) fail(404,'not_found','Endpoint not found');
  const wid=match[1],tail=match[2]||'';
  requireWorkspace(wid,user.id);
  if(request.method==='GET'&&tail==='state') return json(response,200,state(wid,user.id));
  if(request.method==='GET'&&tail==='events') return sse(request,response,wid,user.id,url);
  if(request.method!=='POST') fail(404,'not_found','Endpoint not found');
  const input=await body(request);
  if(tail==='messages'){
    const text=str(input.text,'Message',1,8000);
    const result=idempotent(user.id,`${wid}:messages`,input.clientRequestId,{text},changes=>{
      const message={id:id(),workspaceId:wid,authorId:user.id,authorType:'user',text,createdAt:now(),runId:null};put('messages',message);event(changes,wid,'message',message.id,user.id,'Member sent a message');return {message};
    });return json(response,201,result);
  }
  if(tail==='agents'){
    const name=str(input.name,'Agent name',1,100),model=str(input.model,'Model',1,100),instructions=str(input.instructions,'Instructions',1,4000);
    const agent={id:id(),workspaceId:wid,ownerId:user.id,name,model,instructions,createdAt:now()};
    transaction(changes=>{put('agents',agent);event(changes,wid,'agent',agent.id,user.id,'Agent created');});return json(response,201,{agent});
  }
  if(tail==='documents'){
    const title=str(input.title,'Title',1,160),text=str(input.body,'Body',1,64000);
    const result=idempotent(user.id,`${wid}:documents`,input.clientRequestId,{title,body:text},changes=>{
      const docId=id(),version={id:id(),documentId:docId,number:1,body:text,baseVersionId:null,authorId:user.id,authorType:'user',runId:null,createdAt:now()};
      const document={id:docId,workspaceId:wid,title,currentVersionId:version.id,versions:[version],approvals:[],createdAt:now()};put('documents',document);event(changes,wid,'document',docId,user.id,'Document created');return {document};
    });return json(response,201,result);
  }
  const versionRoute=tail.match(/^documents\/([^/]+)\/versions$/);
  if(versionRoute){
    const did=versionRoute[1],text=str(input.body,'Body',1,64000),baseVersionId=str(input.baseVersionId,'baseVersionId',1,128);
    const result=idempotent(user.id,`${wid}:documents:${did}:versions`,input.clientRequestId,{body:text,baseVersionId},changes=>{
      const document=entityInWorkspace('documents',did,wid);
      if(document.currentVersionId!==baseVersionId) fail(409,'version_conflict','Document changed; reload before saving');
      const version={id:id(),documentId:did,number:document.versions.length+1,body:text,baseVersionId,authorId:user.id,authorType:'user',runId:null,createdAt:now()};
      document.versions.push(version);document.currentVersionId=version.id;put('documents',document);event(changes,wid,'document',did,user.id,'Document revised');return {document};
    });return json(response,201,result);
  }
  const approveRoute=tail.match(/^documents\/([^/]+)\/approve$/);
  if(approveRoute){
    const did=approveRoute[1],versionId=str(input.versionId,'versionId',1,128);
    const result=idempotent(user.id,`${wid}:documents:${did}:approve`,input.clientRequestId,{versionId},changes=>{
      const document=entityInWorkspace('documents',did,wid);
      if(document.currentVersionId!==versionId) fail(409,'version_conflict','Only the current document version can be approved');
      if(!document.approvals.some(a=>a.versionId===versionId&&a.userId===user.id)){
        document.approvals.push({id:id(),documentId:did,versionId,userId:user.id,createdAt:now()});put('documents',document);event(changes,wid,'document',did,user.id,'Current version approved');
      }
      return {document};
    });return json(response,200,result);
  }
  if(tail==='runs'){
    const agentId=str(input.agentId,'agentId',1,128),prompt=str(input.prompt,'Prompt',1,8000),agent=entityInWorkspace('agents',agentId,wid);
    if(agent.ownerId!==user.id) fail(403,'forbidden','Only the agent owner can start a run');
    const documentId=optionalId(input.documentId,'documentId'),baseVersionId=optionalId(input.baseVersionId,'baseVersionId');
    const payload={agentId,prompt,documentId,baseVersionId};
    const requestId=key(input.clientRequestId),existing=db.prepare('SELECT response,fingerprint FROM requests WHERE user_id=? AND scope=? AND request_id=?').get(user.id,`${wid}:runs`,requestId);
    if(existing){if(existing.fingerprint!==hash(JSON.stringify(payload)))fail(409,'idempotency_conflict','Request key was used with different input');return json(response,200,JSON.parse(existing.response));}
    if(!credentials.has(agent.ownerId)) fail(409,'credential_required','Add your API key before running this agent');
    rateLimit('runs',user.id,10,60_000);
    if(documentId){const document=entityInWorkspace('documents',documentId,wid);if(!baseVersionId||document.currentVersionId!==baseVersionId)fail(409,'version_conflict','Current document version is required');}
    else if(baseVersionId)fail(400,'validation_error','baseVersionId requires documentId');
    const result=idempotent(user.id,`${wid}:runs`,requestId,payload,changes=>{
      const run={id:id(),workspaceId:wid,agentId,requestedBy:user.id,prompt,documentId,baseVersionId,status:'running',outputText:'',error:null,createdAt:now(),updatedAt:now()};
      put('runs',run);event(changes,wid,'run',run.id,user.id,'Agent run started');return {run};
    });
    json(response,201,result);setImmediate(()=>executeRun(result.run,agent));return;
  }
  const cancelRoute=tail.match(/^runs\/([^/]+)\/cancel$/);
  if(cancelRoute){
    const run=entityInWorkspace('runs',cancelRoute[1],wid),agent=entityInWorkspace('agents',run.agentId,wid);
    if(agent.ownerId!==user.id) fail(403,'forbidden','Only the agent owner can cancel a run');
    if(run.status==='running'){
      transaction(changes=>{run.status='cancelled';run.error='Run cancelled';run.updatedAt=now();put('runs',run);event(changes,wid,'run',run.id,user.id,'Agent run cancelled');});
      controllers.get(run.id)?.abort();
    }
    return json(response,200,{run});
  }
  fail(404,'not_found','Endpoint not found');
}
async function handle(request,response) {
  try {
    guardOrigin(request);
    const url=new URL(request.url,`http://${request.headers.host}`);
    if(url.pathname.startsWith('/api/'))rateLimit('api',request.socket.remoteAddress||'local',300,60_000);
    if(url.pathname.startsWith('/api/')) return await api(request,response,url);
    const staticFiles={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
    if(request.method==='GET'&&Object.hasOwn(staticFiles,url.pathname)){
      const name=staticFiles[url.pathname],file=fs.readFileSync(path.join(__dirname,name));
      const mime=name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':'text/css';
      response.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});return response.end(file);
    }
    if(request.method==='GET'&&url.pathname==='/favicon.ico')return response.writeHead(204).end();
    fail(404,'not_found','Not found');
  }catch(error){
    if(response.headersSent){response.end();return;}
    if(!error.status)console.error('Request failed:',error);
    json(response,error.status||500,{error:{code:error.code||'internal_error',message:error.status?error.message:'An internal error occurred'}});
  }
}

if (require.main === module) {
  if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw new Error('Invalid RENDEZ_PORT');
  if(HOST!=='127.0.0.1'&&HOST!=='localhost'&&!PUBLIC_ORIGIN)throw new Error('RENDEZ_PUBLIC_ORIGIN is required for non-local binding');
  setup();
  http.createServer(handle).listen(PORT,HOST,()=>console.log(`Rendez listening on http://${HOST}:${PORT}`));
}

module.exports = { setup,handle };
