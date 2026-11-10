'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, readFile, readdir, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const net = require('node:net');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = () => crypto.randomUUID();

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer({ port, dataDir, providerUrl }) {
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RENDEZ_PORT: String(port),
      RENDEZ_DATA_DIR: dataDir,
      ...(providerUrl ? { RENDEZ_OPENAI_RESPONSES_URL: providerUrl } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`${base}/api/session`);
      if (response.ok) return { child, base, output: () => output };
      output += ` readiness HTTP ${response.status} ${await response.text()}`;
    } catch (error) { output += ` readiness ${error.message}`; }
    await pause(100);
  }
  child.kill();
  throw new Error(`Server did not start: ${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, 'exit'), pause(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function client(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(method, route, body, options = {}) {
      const response = await fetch(`${base}/api${route}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const type = response.headers.get('content-type') || '';
      const data = type.includes('json') ? await response.json() : await response.text();
      return { status: response.status, data, headers: response.headers };
    },
    get(route, options) { return this.request('GET', route, undefined, options); },
    post(route, body, options) { return this.request('POST', route, body, options); },
    delete(route, options) { return this.request('DELETE', route, undefined, options); },
    async events(route, signal) {
      return fetch(`${base}/api${route}`, {
        headers: { ...(cookie ? { cookie } : {}), accept: 'text/event-stream' }, signal,
      });
    },
  };
}

function ok(result, label) {
  assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}
function denied(result, label) {
  assert.ok([401, 403, 404].includes(result.status), `${label}: ${result.status} ${JSON.stringify(result.data)}`);
  assert.equal(typeof result.data?.error?.code, 'string');
}
async function eventually(fn, label, timeout = 6000) {
  const until = Date.now() + timeout;
  let last;
  do {
    last = await fn();
    if (last) return last;
    await pause(50);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}

test('authenticated collaboration, event recovery and persistent versions', { timeout: 90000 }, async t => {
  await mkdir(join(ROOT, 'work'), { recursive: true });
  const temp = await mkdtemp(join(ROOT, 'work', 'qa-'));
  const port = await freePort();
  let server = await startServer({ port, dataDir: temp });
  t.after(async () => { await stopServer(server.child); await rm(temp, { recursive: true, force: true }); });
  const a = client(server.base), b = client(server.base), outsider = client(server.base), anonymous = client(server.base);
  const stamp = id().slice(0, 8);
  const password = `Strong-${id()}-A9!`;
  const register = async (c, name) => ok(await c.post('/auth/register', { name, email: `${name}-${stamp}@example.test`, password }), `${name} register`).user;
  const alice = await register(a, 'Alice');
  const bob = await register(b, 'Bob');
  await register(outsider, 'Outsider');
  assert.notEqual(a.cookie, b.cookie, 'independent session cookies');
  assert.match(a.cookie, /.+/);
  assert.equal(ok(await a.get('/session'), 'Alice session').user.id, alice.id);
  assert.equal(ok(await b.get('/session'), 'Bob session').user.id, bob.id);
  denied(await anonymous.get('/workspaces'), 'anonymous workspaces');
  const created = ok(await a.post('/workspaces', { name: 'Test workspace' }), 'create workspace');
  const wid = created.workspace.id;
  assert.equal((await a.post(`/workspaces/${wid}/messages`, { text:'cross-origin', clientRequestId:id() }, { headers:{ origin:'https://outside.example.test' } })).status,403,'cross-origin mutation rejected');
  assert.ok(created.inviteCode || created.workspace.inviteCode);
  const inviteCode = created.inviteCode || created.workspace.inviteCode;
  denied(await outsider.get(`/workspaces/${wid}/state`), 'outsider state');
  denied(await outsider.post(`/workspaces/${wid}/messages`, { text: 'intrusion', clientRequestId: id() }), 'outsider message');
  denied(await outsider.post(`/workspaces/${wid}/documents`, { title: 'Intrusion', body: 'x', clientRequestId: id() }), 'outsider document');
  denied(await outsider.post(`/workspaces/${wid}/agents`, { name: 'Intrusion', model: 'gpt-4.1-mini', instructions: 'x' }), 'outsider agent');
  const sseAbort = new AbortController();
  const sse = await outsider.events(`/workspaces/${wid}/events?after=0`, sseAbort.signal);
  assert.ok([401, 403, 404].includes(sse.status), `outsider SSE: ${sse.status}`);
  sseAbort.abort();
  ok(await b.post('/workspaces/join', { inviteCode }), 'Bob joins');
  const initial = ok(await b.get(`/workspaces/${wid}/state`), 'joined state');
  assert.equal(initial.members.length, 2);
  const cursor = initial.cursor;
  const messageId = id();
  const firstMessage = ok(await a.post(`/workspaces/${wid}/messages`, { text: 'Hello from Alice', clientRequestId: messageId }), 'send message').message;
  const retryMessage = ok(await a.post(`/workspaces/${wid}/messages`, { text: 'Hello from Alice', clientRequestId: messageId }), 'retry message').message;
  assert.equal(firstMessage.id, retryMessage.id, 'request retry is idempotent');
  assert.equal(firstMessage.authorId, alice.id, 'author from session');
  assert.equal((ok(await b.get(`/workspaces/${wid}/state`), 'Bob sees message').messages.filter(m => m.id === firstMessage.id)).length, 1);
  const changedPayload = await a.post(`/workspaces/${wid}/messages`, { text: 'different text', clientRequestId: messageId });
  assert.ok([400, 409, 422].includes(changedPayload.status), 'same request ID with changed payload rejected');
  const replay = await b.events(`/workspaces/${wid}/events?after=${cursor}`, new AbortController().signal);
  assert.equal(replay.status, 200);
  assert.match(replay.headers.get('content-type') || '', /text\/event-stream/);
  const reader = replay.body.getReader();
  const replayChunk = await Promise.race([reader.read(), pause(3000).then(() => { throw new Error('SSE replay timed out'); })]);
  assert.match(new TextDecoder().decode(replayChunk.value), /event: change|data:/);
  await reader.cancel();
  const docId = id();
  const doc = ok(await a.post(`/workspaces/${wid}/documents`, { title: 'Shared draft', body: 'Version one', clientRequestId: docId }), 'create document').document;
  assert.equal(doc.versions.length, 1);
  const v1 = doc.currentVersionId;
  const v2Doc = ok(await b.post(`/workspaces/${wid}/documents/${doc.id}/versions`, { body: 'Bob revision', baseVersionId: v1, clientRequestId: id() }), 'Bob revision').document;
  assert.notEqual(v2Doc.currentVersionId, v1);
  assert.equal(v2Doc.versions.length, 2);
  const stale = await a.post(`/workspaces/${wid}/documents/${doc.id}/versions`, { body: 'Alice stale revision', baseVersionId: v1, clientRequestId: id() });
  assert.equal(stale.status, 409);
  assert.equal((ok(await a.get(`/workspaces/${wid}/state`), 'state after stale write').documents.find(d => d.id === doc.id)).currentVersionId, v2Doc.currentVersionId);
  const staleApproval = await a.post(`/workspaces/${wid}/documents/${doc.id}/approve`, { versionId: v1, clientRequestId: id() });
  assert.equal(staleApproval.status, 409);
  const approved = ok(await a.post(`/workspaces/${wid}/documents/${doc.id}/approve`, { versionId: v2Doc.currentVersionId, clientRequestId: id() }), 'approve exact version').document;
  assert.equal(approved.approvals.at(-1).versionId, v2Doc.currentVersionId);
  assert.equal(approved.approvals.at(-1).userId, alice.id);
  const v3 = ok(await b.post(`/workspaces/${wid}/documents/${doc.id}/versions`, { body: 'New unapproved text', baseVersionId: v2Doc.currentVersionId, clientRequestId: id() }), 'next version').document;
  assert.equal(v3.versions.length, 3);
  assert.equal(v3.approvals.filter(x => x.versionId === v3.currentVersionId).length, 0);
  denied(await outsider.post(`/workspaces/${wid}/documents/${doc.id}/versions`, { body: 'bad', baseVersionId: v3.currentVersionId, clientRequestId: id() }), 'outsider version');
  denied(await outsider.post(`/workspaces/${wid}/documents/${doc.id}/approve`, { versionId: v3.currentVersionId, clientRequestId: id() }), 'outsider approval');
  const sql = new DatabaseSync(join(temp,'rendez.sqlite'));
  sql.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(`Outsider-${stamp}@example.test`.toLowerCase());
  sql.close();
  denied(await outsider.get('/workspaces'), 'expired session');
  const agent = ok(await a.post(`/workspaces/${wid}/agents`, { name: 'Alice agent', model: 'gpt-4.1-mini', instructions: 'Be concise' }), 'Alice agent').agent;
  denied(await outsider.post(`/workspaces/${wid}/runs`, { agentId: agent.id, prompt: 'bad', clientRequestId: id() }), 'outsider run');
  denied(await b.post(`/workspaces/${wid}/runs`, { agentId: agent.id, prompt: 'bad', clientRequestId: id() }), 'nonowner run');
  const unconfigured = await a.post(`/workspaces/${wid}/runs`, { agentId: agent.id, prompt: 'Write a note', clientRequestId: id() });
  assert.ok([400, 409, 422].includes(unconfigured.status), `unconfigured run: ${unconfigured.status}`);
  await stopServer(server.child);
  server = await startServer({ port, dataDir: temp });
  const recovered = ok(await a.get(`/workspaces/${wid}/state`), 'state after restart');
  assert.equal(recovered.documents.find(d => d.id === doc.id).versions.length, 3);
  assert.equal(recovered.messages.filter(m => m.id === firstMessage.id).length, 1);
  assert.ok(recovered.agents.some(x => x.id === agent.id));
  assert.ok(recovered.cursor >= cursor);
  assert.equal(ok(await a.get('/runtime'), 'runtime after restart').available, false);
  ok(await a.post('/auth/logout', {}), 'logout');
  denied(await a.get(`/workspaces/${wid}/state`), 'logged out state');
});

function fakeProvider() {
  const calls = [];
  const pending = new Map();
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const call = { auth: request.headers.authorization, input, path: request.url };
    calls.push(call);
    const prompt = input.input || '';
    const hold = prompt.includes('HOLD_FOR_TEST');
    const fail = prompt.includes('FAIL_FOR_TEST');
    const incomplete = prompt.includes('INCOMPLETE_FOR_TEST');
    const fragmented = prompt.includes('FRAGMENT_FOR_TEST');
    response.writeHead(fail ? 503 : 200, { 'content-type': fail ? 'application/json' : 'text/event-stream' });
    if (fail) return response.end('{"error":{"message":"sensitive-provider-detail"}}');
    if (hold) {
      const marker = prompt.match(/HOLD_FOR_TEST_[A-Z]+/)?.[0] || 'HOLD_FOR_TEST';
      pending.set(marker, response);
      response.write(': waiting\n\n');
      return;
    }
    if (incomplete) {
      response.write(`event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial draft' })}\r\n\r\n`);
      return response.end();
    }
    if (fragmented) {
      const frame = `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Fragmented output' })}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\r\n\r\n`;
      for (let i = 0; i < frame.length; i += 3) response.write(frame.slice(i, i + 3));
      return response.end();
    }
    send(`Mock output ${calls.length}`, response);
  });
  function send(output, response) {
    response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: output })}\n\n`);
    response.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`);
    response.end();
  }
  return {
    server, calls, pending,
    release(marker, output) {
      const response = pending.get(marker);
      assert.ok(response, `pending provider request ${marker}`);
      pending.delete(marker);
      send(output, response);
    },
  };
}

test('mock OpenAI HTTP adapter: owner keys, runs, cancellation and conflicts', { timeout: 90000 }, async t => {
  await mkdir(join(ROOT, 'work'), { recursive: true });
  const temp = await mkdtemp(join(ROOT, 'work', 'qa-provider-'));
  const port = await freePort();
  const mock = fakeProvider();
  mock.server.listen(0, '127.0.0.1');
  await once(mock.server, 'listening');
  const providerUrl = `http://127.0.0.1:${mock.server.address().port}/v1/responses`;
  let app = await startServer({ port, dataDir: temp, providerUrl });
  t.after(async () => {
    await stopServer(app.child);
    mock.server.closeAllConnections();
    await new Promise(resolve => mock.server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  const a = client(app.base), b = client(app.base);
  const stamp = id().slice(0, 8);
  const password = `Strong-${id()}-A9!`;
  const alice = ok(await a.post('/auth/register', { name: 'Alice', email: `alice-${stamp}@example.test`, password }), 'Alice register').user;
  const bob = ok(await b.post('/auth/register', { name: 'Bob', email: `bob-${stamp}@example.test`, password }), 'Bob register').user;
  const created = ok(await a.post('/workspaces', { name: 'Provider test' }), 'create workspace');
  const wid = created.workspace.id;
  ok(await b.post('/workspaces/join', { inviteCode: created.inviteCode }), 'join workspace');
  const keyA = `test-key-alice-${id()}`;
  const keyB = `test-key-bob-${id()}`;
  assert.equal(ok(await a.post('/runtime/credentials', { apiKey: keyA, model: 'gpt-4.1-mini' }), 'Alice config').available, true);
  assert.equal(ok(await b.post('/runtime/credentials', { apiKey: keyB, model: 'gpt-4.1-mini' }), 'Bob config').available, true);
  assert.ok(!JSON.stringify(ok(await a.get('/runtime'), 'Alice runtime')).includes(keyA));
  assert.ok(!JSON.stringify(ok(await b.get('/runtime'), 'Bob runtime')).includes(keyB));
  const agentA = ok(await a.post(`/workspaces/${wid}/agents`, { name: 'Agent A', model: 'gpt-4.1-mini', instructions: 'Draft' }), 'Agent A').agent;
  const agentB = ok(await b.post(`/workspaces/${wid}/agents`, { name: 'Agent B', model: 'gpt-4.1-mini', instructions: 'Draft' }), 'Agent B').agent;
  denied(await b.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'steal', clientRequestId: id() }), 'Bob cannot run Alice agent');
  const runA = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'Say hello', clientRequestId: id() }), 'Alice run').run;
  const runB = ok(await b.post(`/workspaces/${wid}/runs`, { agentId: agentB.id, prompt: 'Say hello', clientRequestId: id() }), 'Bob run').run;
  await eventually(async () => {
    const runs = ok(await a.get(`/workspaces/${wid}/state`), 'completed state').runs;
    return runs.find(r => r.id === runA.id)?.status === 'completed' && runs.find(r => r.id === runB.id)?.status === 'completed';
  }, 'two completed runs');
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].auth, `Bearer ${keyA}`);
  assert.equal(mock.calls[1].auth, `Bearer ${keyB}`);
  for (const call of mock.calls) {
    assert.equal(call.path, '/v1/responses');
    assert.equal(call.input.stream, true);
    assert.equal(call.input.store, false);
  }
  const state = ok(await a.get(`/workspaces/${wid}/state`), 'shared completed state');
  assert.ok(state.messages.some(m => m.runId === runA.id && m.authorId === agentA.id));
  assert.ok(state.messages.some(m => m.runId === runB.id && m.authorId === agentB.id));
  assert.ok(!JSON.stringify(state).includes(keyA) && !JSON.stringify(state).includes(keyB));
  const doc = ok(await a.post(`/workspaces/${wid}/documents`, { title: 'Agent draft', body: 'Base', clientRequestId: id() }), 'document').document;
  const sameRequestId = id();
  const documentRun = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'Replace draft', documentId: doc.id, baseVersionId: doc.currentVersionId, clientRequestId: sameRequestId }), 'document run').run;
  const retry = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'Replace draft', documentId: doc.id, baseVersionId: doc.currentVersionId, clientRequestId: sameRequestId }), 'retry document run').run;
  assert.equal(retry.id, documentRun.id);
  await eventually(async () => ok(await a.get(`/workspaces/${wid}/state`), 'document run state').runs.find(r => r.id === documentRun.id)?.status === 'completed', 'completed document run');
  assert.equal(mock.calls.length, 3, 'retry did not call provider twice');
  const afterDoc = ok(await a.get(`/workspaces/${wid}/state`), 'agent document version').documents.find(d => d.id === doc.id);
  assert.equal(afterDoc.versions.length, 2);
  assert.equal(afterDoc.versions.at(-1).runId, documentRun.id);
  assert.equal(afterDoc.versions.at(-1).authorType, 'agent');
  const fragmentedRun = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'FRAGMENT_FOR_TEST', clientRequestId: id() }), 'fragmented provider run').run;
  await eventually(async () => ok(await a.get(`/workspaces/${wid}/state`), 'fragmented state').runs.find(r => r.id === fragmentedRun.id)?.status === 'completed', 'fragmented stream completion');
  assert.equal(ok(await a.get(`/workspaces/${wid}/state`), 'fragmented output').runs.find(r => r.id === fragmentedRun.id).outputText, 'Fragmented output');
  const incompleteBase = afterDoc.currentVersionId;
  const incomplete = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'INCOMPLETE_FOR_TEST', documentId: doc.id, baseVersionId: incompleteBase, clientRequestId: id() }), 'incomplete response run').run;
  await eventually(async () => ok(await a.get(`/workspaces/${wid}/state`), 'incomplete state').runs.find(r => r.id === incomplete.id)?.status === 'failed', 'incomplete stream failure');
  assert.equal(ok(await a.get(`/workspaces/${wid}/state`), 'incomplete document').documents.find(d => d.id === doc.id).currentVersionId, incompleteBase);
  const failed = ok(await b.post(`/workspaces/${wid}/runs`, { agentId: agentB.id, prompt: 'FAIL_FOR_TEST', clientRequestId: id() }), 'failing run').run;
  await eventually(async () => ok(await b.get(`/workspaces/${wid}/state`), 'failure state').runs.find(r => r.id === failed.id)?.status === 'failed', 'failed provider run');
  const failRecord = ok(await b.get(`/workspaces/${wid}/state`), 'failure state detail').runs.find(r => r.id === failed.id);
  assert.ok(!JSON.stringify(failRecord).includes('sensitive-provider-detail'));
  const holdCancel = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'HOLD_FOR_TEST_CANCEL', clientRequestId: id() }), 'held run').run;
  await eventually(() => mock.pending.has('HOLD_FOR_TEST_CANCEL'), 'held provider request');
  denied(await b.post(`/workspaces/${wid}/runs/${holdCancel.id}/cancel`, {}), 'Bob cannot cancel Alice run');
  assert.equal(ok(await a.post(`/workspaces/${wid}/runs/${holdCancel.id}/cancel`, {}), 'cancel owned run').run.status, 'cancelled');
  mock.pending.delete('HOLD_FOR_TEST_CANCEL');
  const afterCancel = ok(await a.get(`/workspaces/${wid}/state`), 'cancelled state');
  assert.equal(afterCancel.runs.find(r => r.id === holdCancel.id).status, 'cancelled');
  assert.ok(!afterCancel.messages.some(m => m.runId === holdCancel.id));
  const currentDoc = afterCancel.documents.find(d => d.id === doc.id);
  const conflictRun = ok(await a.post(`/workspaces/${wid}/runs`, { agentId: agentA.id, prompt: 'HOLD_FOR_TEST_CONFLICT', documentId: doc.id, baseVersionId: currentDoc.currentVersionId, clientRequestId: id() }), 'held document run').run;
  await eventually(() => mock.pending.has('HOLD_FOR_TEST_CONFLICT'), 'held document provider request');
  const manual = ok(await b.post(`/workspaces/${wid}/documents/${doc.id}/versions`, { body: 'Human edit wins', baseVersionId: currentDoc.currentVersionId, clientRequestId: id() }), 'concurrent human revision').document;
  mock.release('HOLD_FOR_TEST_CONFLICT', 'Agent conflicting output');
  await eventually(async () => ok(await a.get(`/workspaces/${wid}/state`), 'conflict state').runs.find(r => r.id === conflictRun.id)?.status === 'conflict', 'run conflict');
  const conflictState = ok(await a.get(`/workspaces/${wid}/state`), 'conflict detail');
  assert.equal(conflictState.documents.find(d => d.id === doc.id).currentVersionId, manual.currentVersionId);
  assert.equal(conflictState.runs.find(r => r.id === conflictRun.id).outputText, 'Agent conflicting output');
  const restartRequestId = id();
  const holdRestart = ok(await b.post(`/workspaces/${wid}/runs`, { agentId: agentB.id, prompt: 'HOLD_FOR_TEST_RESTART', clientRequestId: restartRequestId }), 'held restart run').run;
  await eventually(() => mock.pending.has('HOLD_FOR_TEST_RESTART'), 'restart provider request');
  await stopServer(app.child);
  app = await startServer({ port, dataDir: temp, providerUrl });
  const restarted = ok(await b.get(`/workspaces/${wid}/state`), 'restart state');
  assert.equal(restarted.runs.find(r => r.id === holdRestart.id).status, 'failed');
  assert.ok(!restarted.messages.some(m => m.runId === holdRestart.id));
  assert.equal(ok(await b.get('/runtime'), 'runtime cleared after restart').available, false);
  const beforeRetryCount = mock.calls.length;
  ok(await b.post('/runtime/credentials', { apiKey: keyB, model: 'gpt-4.1-mini' }), 'reconfigure Bob credential after restart');
  const retryRestart = ok(await b.post(`/workspaces/${wid}/runs`, { agentId: agentB.id, prompt: 'HOLD_FOR_TEST_RESTART', clientRequestId: restartRequestId }), 'retry interrupted run').run;
  assert.equal(retryRestart.id, holdRestart.id);
  assert.equal(mock.calls.length, beforeRetryCount);
  assert.ok(!JSON.stringify(restarted).includes(keyA) && !JSON.stringify(restarted).includes(keyB));
  const files = await readdir(temp);
  for (const name of files.filter(name => name.startsWith('rendez.sqlite'))) {
    const bytes = await readFile(join(temp, name));
    assert.ok(!bytes.includes(Buffer.from(keyA)) && !bytes.includes(Buffer.from(keyB)), `${name} contains no API key`);
  }
  assert.ok(!app.output().includes(keyA) && !app.output().includes(keyB), 'server output contains no API key');
  ok(await a.delete('/runtime/credentials'), 'disconnect credential');
});
