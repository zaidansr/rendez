(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const id = () => crypto.randomUUID();
  const date = value => value ? new Intl.DateTimeFormat(undefined, {dateStyle:'medium', timeStyle:'short'}).format(new Date(value)) : '';
  const app = $('#app');
  const state = {user:null,workspaces:[],workspaceId:null,data:null,runtime:null,tab:'overview',docId:null,stream:null,connected:false,modal:null,authMode:'login',busy:false,error:'',credentialError:'',docBase:null,loadSeq:0,drafts:{message:'',prompt:'',docBody:'',docTitle:''},docDrafts:{},draftHistory:{},editorDirty:false,pendingIds:{}};
  const storageKey = 'rendez-ui-v1';
  let savedUserId=null;
  try { const saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); savedUserId=saved.userId||null; if (saved.theme) document.documentElement.dataset.theme = saved.theme; if (saved.workspaceId) state.workspaceId = saved.workspaceId; if (saved.docId) state.docId = saved.docId; if (saved.drafts) state.drafts = {...state.drafts,...saved.drafts}; if (saved.docDrafts) state.docDrafts=saved.docDrafts; if (saved.draftHistory) state.draftHistory=saved.draftHistory; } catch {}
  function persist() { savedUserId=state.user?.id||null; try { localStorage.setItem(storageKey, JSON.stringify({userId:savedUserId,theme:document.documentElement.dataset.theme,workspaceId:state.workspaceId,docId:state.docId,drafts:state.drafts,docDrafts:state.docDrafts,draftHistory:state.draftHistory})); } catch {} }
  function clearPrivateDrafts() { state.workspaceId=null;state.docId=null;state.docBase=null;state.editorDirty=false;state.drafts={message:'',prompt:'',docBody:'',docTitle:''};state.docDrafts={};state.draftHistory={};state.pendingIds={};persist(); }
  function docDraftKey() { return `${state.workspaceId}:${state.docId}`; }
  function restoreDocDraft() { const draft=state.docDrafts[docDraftKey()]; state.editorDirty=!!draft; state.docBase=draft?.baseVersionId||currentDoc()?.currentVersionId||null; state.drafts.docBody=draft?.body??currentVersion()?.body??''; }
  function requestId(key) { return state.pendingIds[key] ||= id(); }
  function requestDone(key) { delete state.pendingIds[key]; }
  let toastTimer;
  function toast(message) { const el=$('#toast'); el.textContent=message; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.hidden=true,4000); }
  async function api(path, options={}) {
    const res = await fetch('/api'+path, {method:options.method||'GET', credentials:'same-origin', headers:options.body ? {'content-type':'application/json'} : {}, body: options.body ? JSON.stringify(options.body) : undefined});
    const payload = await res.json().catch(()=>({}));
    if (!res.ok) { const error = new Error(payload.error?.message || `Request failed (${res.status})`); error.code=payload.error?.code; error.status=res.status; throw error; }
    return payload;
  }
  async function act(button, work, success) {
    if (state.busy) return;
    state.busy=true; if (button) button.disabled=true;
    try { await work(); state.error=''; if (success) toast(success); }
    catch(error) { state.error=error.message; toast(error.message); }
    finally { state.busy=false; if (button) button.disabled=false; render(); }
  }
  function snapshotDrafts() {
    const message=$('#message-text'), prompt=$('#run-prompt'), editor=$('#doc-body'), title=$('#doc-title');
    if (message) state.drafts.message=message.value;
    if (prompt) state.drafts.prompt=prompt.value;
    if (editor) { state.drafts.docBody=editor.value; state.editorDirty=editor.value !== currentVersion()?.body; if (state.editorDirty) state.docDrafts[docDraftKey()]={body:editor.value,baseVersionId:state.docBase}; else delete state.docDrafts[docDraftKey()]; }
    if (title) state.drafts.docTitle=title.value;
    const newBody=$('#new-doc-body'); if (newBody) state.drafts.docBody=newBody.value;
    persist();
  }
  async function bootstrap() {
    try {
      const session=await api('/session'); state.user=session.user;
      if (savedUserId!==state.user?.id) clearPrivateDrafts();
      if (state.user) await loadWorkspaces(); else render();
    } catch { renderUnavailable(); }
  }
  async function loadWorkspaces() {
    const [spaces, runtime]=await Promise.all([api('/workspaces'),api('/runtime')]);
    state.workspaces=spaces.workspaces||[]; state.runtime=runtime;
    if (!state.workspaces.some(w=>w.id===state.workspaceId)) state.workspaceId=state.workspaces[0]?.id||null;
    persist();
    if (state.workspaceId) await loadState(true); else { closeStream(); render(); }
  }
  async function loadState(connect=false) {
    if (!state.workspaceId) return;
    snapshotDrafts();
    const wid=state.workspaceId, seq=++state.loadSeq;
    const data=await api(`/workspaces/${encodeURIComponent(wid)}/state`);
    if (wid!==state.workspaceId || seq!==state.loadSeq) return;
    state.data=data;
    if (!data.documents?.some(d=>d.id===state.docId)) state.docId=data.documents?.[0]?.id||null;
    restoreDocDraft();
    const agentEntryInProgress=state.tab==='agents' && (
      document.activeElement?.closest('#credential-form,#agent-form') ||
      $('#credential-form input[name="apiKey"]')?.value ||
      $('#agent-form input[name="name"]')?.value ||
      $('#agent-form textarea[name="instructions"]')?.value
    );
    if (!agentEntryInProgress) render();
    if (connect) connectStream();
  }
  function closeStream() { if (state.stream) state.stream.close(); state.stream=null; state.connected=false; }
  function connectStream() {
    closeStream(); if (!state.workspaceId || !state.user) return;
    const wid=state.workspaceId;
    const source=new EventSource(`/api/workspaces/${encodeURIComponent(wid)}/events?after=${Number(state.data?.cursor)||0}`);
    state.stream=source;
    let opened=false;
    source.onopen=()=>{
      const reconnect=opened; opened=true;
      state.connected=true; updateConnection();
      if (reconnect) loadState().catch(error=>toast(error.message));
    };
    source.onerror=()=>{state.connected=false; updateConnection();};
    let pending=false, queued=false;
    source.addEventListener('change', async()=>{
      if (state.workspaceId!==wid) return;
      queued=true;
      if (pending) return;
      pending=true;
      try { while (queued && state.workspaceId===wid) { queued=false; await loadState(); } }
      catch(error) { toast(error.message); }
      finally { pending=false; }
    });
  }
  function updateConnection() { const el=$('#connection'); if (!el) return; el.textContent=state.connected?'Live updates connected':'Reconnecting updates…'; el.classList.toggle('live',state.connected); }
  function renderUnavailable() { app.innerHTML=`<div class="unavailable"><div class="unavailable-card"><div class="brand"><span class="mark">r.</span>rendez</div><h1>Server unavailable</h1><p>Start Rendez with <code>npm run server</code> in the project folder. Your workspace data lives on that local server.</p><button class="button primary" data-action="retry">Retry connection</button></div></div>`; }
  function renderAuth() {
    const register=state.authMode==='register';
    app.innerHTML=`<div class="auth-wrap"><section class="auth-card"><div class="brand"><span class="mark">r.</span>rendez</div><h1>${register?'Create your account':'Welcome back'}</h1><p>Collaborate with people and agents in a shared workspace.</p><form id="auth-form">${register?'<label class="field"><span>Name</span><input name="name" autocomplete="name" required maxlength="80"></label>':''}<label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" required></label><label class="field"><span>Password</span><input type="password" name="password" autocomplete="${register?'new-password':'current-password'}" required ${register?'minlength="10"':''}></label>${state.error?`<p class="error">${esc(state.error)}</p>`:''}<button class="button primary" type="submit">${register?'Create account':'Sign in'}</button></form><div class="auth-switch"><span>${register?'Have an account?':'New to Rendez?'}</span><button class="button quiet" data-action="auth-switch">${register?'Sign in':'Create account'}</button></div></section></div>`;
  }
  function workspace() { return state.data?.workspace || state.workspaces.find(w=>w.id===state.workspaceId); }
  function currentDoc() { return state.data?.documents?.find(d=>d.id===state.docId); }
  function currentVersion() { const d=currentDoc(); return d?.versions?.find(v=>v.id===d.currentVersionId); }
  function nameFor(id, type='user') { if (type==='agent') return state.data?.agents?.find(x=>x.id===id)?.name || 'Agent'; return state.data?.members?.find(x=>x.id===id)?.name || (id===state.user?.id?state.user.name:'Member'); }
  function initials(name) { return String(name||'?').split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(); }
  function agentOptions(ownedOnly=false) { return (state.data?.agents||[]).filter(a=>!ownedOnly||a.ownerId===state.user.id); }
  function renderShell() {
    const w=workspace();
    app.innerHTML=`<div class="app"><aside class="sidebar"><div class="brand"><span class="mark">r.</span>rendez</div><div class="workspace-box"><label class="eyebrow" for="workspace-select">Workspace</label><select id="workspace-select" aria-label="Choose workspace">${state.workspaces.map(space=>`<option value="${esc(space.id)}" ${space.id===state.workspaceId?'selected':''}>${esc(space.name)}</option>`).join('')||'<option value="">Choose a workspace</option>'}</select><div class="workspace-actions"><button class="button small" data-action="create-workspace">Create</button><button class="button small" data-action="join-workspace">Join</button></div></div><div class="side-label eyebrow">Workspace</div><nav class="nav" aria-label="Workspace navigation">${[['overview','Overview'],['conversation','Conversation'],['documents','Documents'],['agents','Agents & runs']].map(([tab,label])=>`<button data-tab="${tab}" class="${state.tab===tab?'active':''}" ${state.tab===tab?'aria-current="page"':''}>${label}</button>`).join('')}</nav><div class="sidebar-foot"><strong>${esc(state.user.name)}</strong><small>${esc(state.user.email)}</small><button class="button small" data-action="logout">Sign out</button></div></aside><main class="main"><header class="topbar"><strong>${esc(w?.name||'Your workspaces')}</strong><div class="right-tools"><span id="connection" class="connection ${state.connected?'live':''}">${state.connected?'Live updates connected':'Reconnecting updates…'}</span><button class="button small" data-action="theme" aria-label="Switch theme">${document.documentElement.dataset.theme==='dark'?'Light':'Dark'} mode</button></div></header><div id="main-view" class="${state.tab==='conversation'?'conversation':''}"></div></main><aside class="rightbar">${renderSidebar()}</aside></div>${state.modal?renderModal():''}`;
    renderView();
  }
  function renderSidebar() {
    if (!state.data) return `<div class="right-section"><div class="eyebrow">Get started</div><p class="right-note">Create a workspace or join one with an invite code.</p></div>`;
    const w=workspace();
    return `<div class="right-section"><div class="eyebrow">People · ${state.data.members.length}</div>${state.data.members.map(m=>`<div class="mini-member"><div class="avatar">${esc(initials(m.name))}</div><div><strong>${esc(m.name)}</strong><small>${m.id===w.ownerId?'Owner':'Member'}</small></div></div>`).join('')}</div><div class="right-section"><div class="eyebrow">Agents · ${state.data.agents.length}</div>${state.data.agents.map(a=>`<div class="mini-member"><div class="avatar agent">${esc(initials(a.name))}</div><div><strong>${esc(a.name)}</strong><small>${esc(nameFor(a.ownerId))} · ${esc(a.model)}</small></div></div>`).join('')||'<p class="right-note">No agents registered yet.</p>'}</div><div class="right-section"><div class="eyebrow">Invite a teammate</div><span class="invite-code">${esc(w.inviteCode)}</span><button class="button small" data-action="copy-invite">Copy code</button><p class="right-note spaced">Share this code with someone who has a Rendez account.</p></div>`;
  }
  function page(title,subtitle,content,actions='') { return `<div class="page-head"><div class="eyebrow">${esc(workspace()?.name||'Rendez')}</div><div class="row"><div><h1>${title}</h1><p>${subtitle}</p></div>${actions}</div></div><div class="main-scroll">${content}</div>`; }
  function renderView() {
    const el=$('#main-view'); if (!el) return;
    if (!state.data) {el.innerHTML=page('Your workspaces','Create a space or join your team.',`<div class="notice">A workspace gives your team one place for messages, documents, and agent work.</div>`); return;}
    if (state.tab==='conversation') el.innerHTML=renderConversation();
    else if (state.tab==='documents') el.innerHTML=renderDocuments();
    else if (state.tab==='agents') el.innerHTML=renderAgents();
    else el.innerHTML=renderOverview();
  }
  function renderOverview() {
    const d=state.data; const active=d.runs.filter(r=>r.status==='running').length;
    const recent=[...(d.events||[])].slice(-6).reverse();
    return page('Overview','The latest work across your workspace.',`<div class="stack"><div class="metrics"><div class="metric"><div class="eyebrow">Members</div><b>${d.members.length}</b><span>People in this workspace</span></div><div class="metric"><div class="eyebrow">Documents</div><b>${d.documents.length}</b><span>Shared versioned work</span></div><div class="metric"><div class="eyebrow">Runs in progress</div><b>${active}</b><span>Agent work underway</span></div></div><section class="panel"><div class="panel-head"><h2>Recent activity</h2></div>${recent.map(e=>`<div class="item"><div class="avatar">${esc(initials(nameFor(e.actorId)))}</div><div class="item-body"><strong>${esc(e.summary||e.type)}</strong><small>${esc(nameFor(e.actorId))} · ${esc(date(e.createdAt))}</small></div></div>`).join('')||'<div class="empty">Activity will appear as your team works together.</div>'}</section></div>`);
  }
  function renderConversation() {
    const d=state.data;
    return `<div class="page-head"><div class="eyebrow">${esc(workspace().name)}</div><h1>Conversation</h1><p>Messages appear for every member in this workspace.</p></div><div class="messages" id="messages">${d.messages.map(m=>{const n=nameFor(m.authorId,m.authorType);return `<article class="message"><div class="avatar ${m.authorType==='agent'?'agent':''}">${esc(initials(n))}</div><div class="message-copy"><header><strong>${esc(n)}</strong><time>${esc(date(m.createdAt))}</time></header><p>${esc(m.text)}</p>${m.runId?'<small>Agent run output</small>':''}</div></article>`}).join('')||'<div class="empty">Start the conversation with a message.</div>'}</div><form id="message-form" class="composer"><label class="field" for="message-text"><span>Message workspace</span><textarea id="message-text" placeholder="Write a message…" maxlength="10000" required>${esc(state.drafts.message)}</textarea></label><div class="row"><small>Enter to send · Shift+Enter for a new line</small><button class="button primary">Send message</button></div></form>`;
  }
  function renderDocuments() {
    const docs=state.data.documents,d=currentDoc(),v=currentVersion();
    const approvals=d?.approvals?.filter(a=>a.versionId===d.currentVersionId)||[];
    const canReview=!!v && !state.editorDirty && state.docBase===d.currentVersionId && state.drafts.docBody===v.body;
    const savedCopy=state.draftHistory[docDraftKey()]?.length||0;
    const list=docs.map(doc=>`<button data-doc="${esc(doc.id)}" class="${doc.id===state.docId?'active':''}"><strong>${esc(doc.title)}</strong><br><small>Version ${doc.versions.find(v=>v.id===doc.currentVersionId)?.number||'—'}</small></button>`).join('')||'<div class="empty">No documents yet.</div>';
    let detail='<div class="empty">Create a document to begin shared work.</div>';
    if (d) {
      const notice=state.editorDirty?`<p class="notice">${state.docBase!==d.currentVersionId?'A newer version exists. Your local draft is based on an older version and cannot overwrite it.':'Unsaved draft on this device. Saving creates a new immutable version.'}</p>`:'';
      const history=[...d.versions].reverse().map(version=>`<div class="history-item"><div><strong>Version ${version.number}${version.id===d.currentVersionId?' · Current':''}</strong><br><small>${esc(nameFor(version.authorId,version.authorType))} · ${esc(date(version.createdAt))}${version.runId?' · Agent run':''}</small></div><button class="button small" data-version="${esc(version.id)}">View</button></div>`).join('');
      const reviewers=approvals.map(a=>`<div class="history-item"><span>${esc(nameFor(a.userId))}</span><time>${esc(date(a.createdAt))}</time></div>`).join('');
      detail=`<div class="panel editor"><div class="panel-head"><div><h2>${esc(d.title)}</h2><small>Current version ${v?.number||'—'} · ${esc(date(v?.createdAt))}</small></div><span class="badge ${approvals.length?'good':''}">${approvals.length?`Approved by ${approvals.length}`:'Awaiting approval'}</span></div><div class="panel-body"><label class="field"><span>Document body</span><textarea id="doc-body">${esc(state.drafts.docBody)}</textarea></label>${notice}<div class="row wrap"><button class="button primary" data-action="save-doc">Save new version</button><button class="button" data-action="review-doc" data-version="${esc(v?.id||'')}" ${canReview?'':'disabled'}>Review &amp; approve version ${v?.number||'—'}</button><button class="button" data-action="reload-doc" ${state.editorDirty?'':'hidden'}>Keep copy &amp; load current</button>${savedCopy?'<button class="button" data-action="saved-copy">View saved local copy</button>':''}</div><p class="right-note spaced" id="review-hint" ${canReview?'hidden':''}>Save or load the current version before approval.</p><div class="history"><h3>Version history</h3>${history}</div>${approvals.length?`<div class="history"><h3>Current approvals</h3>${reviewers}</div>`:''}</div></div>`;
    }
    return page('Documents','Write, revise, and approve exact versions.',`<div class="doc-layout"><div class="doc-list">${list}</div><div>${detail}</div></div>`,'<button class="button primary" data-action="create-doc">New document</button>');
  }
  function renderAgents() {
    const runtime=state.runtime||{}; const owned=agentOptions(true);
    const status=runtime.available?'<span class="badge good">Key configured</span>':'<span class="badge">Key needed</span>';
    const lastRun=[...state.data.runs].filter(r=>r.requestedBy===state.user.id).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
    const outcomes={running:'Your latest run is in progress.',completed:'Your latest run completed. Its output is available below.',cancelled:'Your latest run was cancelled.',conflict:'Your latest run produced output, but the document changed before it could save.'};
    const outcome=lastRun?.status==='failed'?`Your latest run failed${lastRun.error?`: ${esc(lastRun.error)}`:''}. Review the run details below.`:lastRun?outcomes[lastRun.status]||`Your latest run is ${esc(lastRun.status)}.`:owned.length?'Your agent is ready for a prompt. No model request has been made yet.':'Next, register an agent with a name, model, and instructions. No model request has been made yet.';
    const nextStep=lastRun?'runs':owned.length?'run':'register';
    const nextLabel=lastRun?'Review latest run':owned.length?'Continue to run an agent':'Continue to register an agent';
    const confirmation=runtime.available?`<div class="connection-confirmation" id="connection-result" role="status"><strong>API key saved for your account.</strong><p>${outcome}</p><button class="button" data-action="go-agent-step" data-step="${nextStep}">${nextLabel}</button></div>`:'';
    const connection=`<section class="panel"><div class="panel-head"><h2>Personal OpenAI connection</h2>${status}</div><div class="panel-body">${confirmation}<p class="notice">Your API key is held in server memory for your account. It is forgotten when the server restarts and is never shared with workspace members. A configured key alone does not verify account or model access; the run result reports the outcome.</p>${state.credentialError?`<p class="error" role="alert">${esc(state.credentialError)}</p>`:''}${runtime.error&&!runtime.available?`<p class="right-note spaced">${esc(runtime.error)}</p>`:''}<form id="credential-form" class="spaced"><label class="field"><span>API key</span><input name="apiKey" type="password" autocomplete="off" spellcheck="false" required></label><label class="field"><span>Default model (optional)</span><input name="model" value="${esc(runtime.models?.[0]||'')}" placeholder="e.g. gpt-4.1-mini"></label><div class="row wrap"><button class="button primary">${runtime.available?'Replace key':'Connect key'}</button>${runtime.available?'<button type="button" class="button danger" data-action="disconnect-key">Disconnect key</button>':''}</div></form></div></section>`;
    const addAgent=`<section class="panel" id="agent-registration"><div class="panel-head"><h2>Register your agent</h2></div><div class="panel-body"><form id="agent-form"><label class="field"><span>Name</span><input name="name" required maxlength="80" placeholder="Research agent"></label><label class="field"><span>OpenAI model</span><input name="model" required value="${esc(runtime.models?.[0]||'gpt-4.1-mini')}" placeholder="gpt-4.1-mini"></label><label class="field"><span>Instructions</span><textarea name="instructions" required placeholder="Describe the agent's role and boundaries."></textarea></label><button class="button primary">Register agent</button></form></div></section>`;
    const runForm=`<section class="panel" id="agent-run"><div class="panel-head"><h2>Run an agent</h2></div><div class="panel-body">${owned.length?`<form id="run-form"><label class="field"><span>Your agent</span><select name="agentId">${owned.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.model)}</option>`).join('')}</select></label><label class="field"><span>Prompt</span><textarea id="run-prompt" name="prompt" required placeholder="What should the agent work on?">${esc(state.drafts.prompt)}</textarea></label><label class="field"><span>Revise document (optional)</span><select name="documentId"><option value="">No document — post output to conversation</option>${state.data.documents.map(d=>`<option value="${esc(d.id)}">${esc(d.title)}</option>`).join('')}</select><small>When selected, the agent starts from the current version. If someone saves a newer version first, the run keeps its output for manual review.</small></label><button class="button primary" ${runtime.available?'':'disabled'}>Start run</button>${runtime.available?'':'<p class="error">Connect your API key to run an agent.</p>'}</form>`:'<div class="empty">Register your own agent to start a run.</div>'}</div></section>`;
    const runs=`<section class="panel" id="agent-runs"><div class="panel-head"><h2>Runs</h2><small>${state.data.runs.length} total</small></div>${[...state.data.runs].reverse().map(r=>{const a=state.data.agents.find(x=>x.id===r.agentId);return `<article class="run-item"><header><div><strong>${esc(a?.name||'Agent')}</strong><small>${esc(date(r.createdAt))} · ${esc(nameFor(r.requestedBy))}${r.documentId?' · Document revision':''}</small></div><span class="badge ${r.status==='completed'?'good':['failed','conflict'].includes(r.status)?'bad':''}">${esc(r.status)}</span></header><p class="run-output">${esc(r.prompt)}</p>${r.error?`<p class="error">${esc(r.error)}</p>`:''}${r.outputText?`<details><summary>View output</summary><div class="run-output">${esc(r.outputText)}</div></details>`:''}${r.status==='running'&&r.requestedBy===state.user.id?`<button class="button small danger spaced" data-cancel-run="${esc(r.id)}">Cancel run</button>`:''}</article>`}).join('')||'<div class="empty">Agent runs will appear here.</div>'}</section>`;
    return page('Agents & runs','Connect your provider, register an agent, and share its work.',`<div class="stack">${connection}${addAgent}${runForm}${runs}</div>`);
  }
  function renderModal() {
    const m=state.modal;
    const head=(title,subtitle='')=>`<header><div><div class="eyebrow">${esc(subtitle)}</div><h2 id="modal-title">${esc(title)}</h2></div><button class="close" data-action="close-modal" aria-label="Close dialog">×</button></header>`;
    let content='';
    if (m.type==='create-workspace') content=head('Create workspace','Collaboration')+`<form id="create-workspace-form"><label class="field"><span>Name</span><input name="name" maxlength="100" required placeholder="Studio North"></label><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary">Create workspace</button></div></form>`;
    if (m.type==='join-workspace') content=head('Join workspace','Invite code')+`<form id="join-workspace-form"><label class="field"><span>Invite code</span><input name="inviteCode" required autocomplete="off" spellcheck="false"></label><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary">Join workspace</button></div></form>`;
    if (m.type==='create-doc') content=head('New document','Shared work')+`<form id="create-doc-form"><label class="field"><span>Title</span><input id="doc-title" name="title" required maxlength="120" value="${esc(state.drafts.docTitle)}"></label><label class="field"><span>Body</span><textarea id="new-doc-body" name="body" required>${esc(state.drafts.docBody)}</textarea></label><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary">Create document</button></div></form>`;
    if (m.type==='version') {const d=currentDoc(),v=d?.versions.find(x=>x.id===m.versionId);content=head(`Version ${v?.number||'—'}`,d?.title||'')+`<p class="notice">${esc(nameFor(v?.authorId,v?.authorType))} · ${esc(date(v?.createdAt))}</p><div class="run-output">${esc(v?.body||'')}</div><div class="modal-actions"><button class="button primary" data-action="close-modal">Close</button></div>`;}
    if (m.type==='review') {const d=currentDoc(),v=d?.versions.find(x=>x.id===m.versionId);content=head(`Review version ${v?.number||'—'}`,d?.title||'')+`<p class="notice">Approval records your account and time for this exact version. Check the text below before confirming.</p><div class="run-output">${esc(v?.body||'')}</div><div class="modal-actions"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="confirm-approve" data-version="${esc(m.versionId)}">Approve this version</button></div>`;}
    if (m.type==='saved-copy') {const copy=state.draftHistory[docDraftKey()]?.at(-1);content=head('Saved local copy',currentDoc()?.title||'')+`<p class="notice">This text was kept on this device when you loaded a newer version. Copy anything you need into the current editor.</p><div class="run-output">${esc(copy?.body||'')}</div><div class="modal-actions"><button class="button primary" data-action="close-modal">Close</button></div>`;}
    return `<div class="modal-scrim" id="modal-scrim"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${content}</section></div>`;
  }
  function render() { if (!state.user) renderAuth(); else renderShell(); }
  function switchWorkspace(wid) {snapshotDrafts(); state.workspaceId=wid||null;state.data=null;state.docId=null;state.editorDirty=false;state.drafts.docBody='';closeStream();persist(); if (wid) loadState(true).catch(e=>{toast(e.message);render();}); else render();}
  document.addEventListener('click', async event=>{
    const button=event.target.closest('button'); if (!button) return;
    if (button.dataset.tab) {snapshotDrafts();state.tab=button.dataset.tab;render();return;}
    if (button.dataset.doc) {snapshotDrafts();state.docId=button.dataset.doc;restoreDocDraft();persist();render();return;}
    if (button.dataset.version && !button.dataset.action) {state.modal={type:'version',versionId:button.dataset.version};render();return;}
    if (button.dataset.cancelRun) {await act(button,async()=>{await api(`/workspaces/${state.workspaceId}/runs/${button.dataset.cancelRun}/cancel`,{method:'POST',body:{}});await loadState();},'Run cancellation requested.');return;}
    const action=button.dataset.action;if (!action) return;
    if (action==='retry') {await bootstrap();return;}
    if (action==='auth-switch') {state.authMode=state.authMode==='login'?'register':'login';state.error='';render();return;}
    if (action==='theme') {document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';persist();render();return;}
    if (action==='logout') {await act(button,async()=>{await api('/auth/logout',{method:'POST',body:{}});closeStream();state.user=null;state.data=null;state.workspaces=[];state.runtime=null;state.error='';clearPrivateDrafts();},'Signed out.');return;}
    if (action==='create-workspace'||action==='join-workspace'||action==='create-doc') {snapshotDrafts();state.modal={type:action};render();$('#modal-scrim input')?.focus();return;}
    if (action==='close-modal') {state.modal=null;render();return;}
    if (action==='copy-invite') {try {await navigator.clipboard.writeText(workspace().inviteCode);toast('Invite code copied.');}catch {toast('Clipboard unavailable. Select the code to copy it.');}return;}
    if (action==='go-agent-step') {const target=button.dataset.step==='runs'?'#agent-runs':button.dataset.step==='run'?'#agent-run':'#agent-registration';$(target)?.scrollIntoView({block:'start',behavior:'smooth'});$(target+' input, '+target+' textarea')?.focus({preventScroll:true});return;}
    if (action==='disconnect-key') {await act(button,async()=>{await api('/runtime/credentials',{method:'DELETE'});state.runtime=await api('/runtime');},'API key disconnected.');return;}
    if (action==='save-doc') {snapshotDrafts();const d=currentDoc(),key=`version:${d.id}:${state.docBase}`;await act(button,async()=>{await api(`/workspaces/${state.workspaceId}/documents/${d.id}/versions`,{method:'POST',body:{body:state.drafts.docBody,baseVersionId:state.docBase,clientRequestId:requestId(key)}});requestDone(key);delete state.docDrafts[docDraftKey()];state.editorDirty=false;await loadState();},'New version saved.');return;}
    if (action==='reload-doc') {snapshotDrafts();const key=docDraftKey();(state.draftHistory[key]||=[]).push({body:state.drafts.docBody,baseVersionId:state.docBase,savedAt:new Date().toISOString()});state.draftHistory[key]=state.draftHistory[key].slice(-3);delete state.docDrafts[key];restoreDocDraft();persist();render();toast('Draft kept as a local copy. Current version loaded.');return;}
    if (action==='saved-copy') {state.modal={type:'saved-copy'};render();return;}
    if (action==='review-doc') {snapshotDrafts();const d=currentDoc(),v=currentVersion();if(state.editorDirty||state.docBase!==d.currentVersionId||state.drafts.docBody!==v.body||button.dataset.version!==v.id){toast('Load the current version before approval.');return;}state.modal={type:'review',versionId:button.dataset.version};render();return;}
    if (action==='confirm-approve') {const d=currentDoc(),versionId=button.dataset.version,key=`approve:${d.id}:${versionId}`;if(state.modal?.type!=='review'||state.modal.versionId!==versionId||d.currentVersionId!==versionId){toast('The version changed. Review the current version again.');return;}await act(button,async()=>{await api(`/workspaces/${state.workspaceId}/documents/${d.id}/approve`,{method:'POST',body:{versionId,clientRequestId:requestId(key)}});requestDone(key);state.modal=null;await loadState();},`Version ${currentVersion()?.number||''} approved.`);return;}
  });
  document.addEventListener('change', event=>{if(event.target.id==='workspace-select')switchWorkspace(event.target.value);});
  document.addEventListener('input', event=>{
    const field=event.target.id;
    if (!['message-text','run-prompt','doc-body','doc-title','new-doc-body'].includes(field)) return;
    if (field==='message-text') requestDone('message');
    if (field==='run-prompt') requestDone('run');
    if (field==='doc-body') requestDone(`version:${state.docId}:${state.docBase}`);
    if (field==='doc-title'||field==='new-doc-body') requestDone('create-doc');
    snapshotDrafts();
    if (field==='doc-body') {
      const review=$('[data-action="review-doc"]'), reload=$('[data-action="reload-doc"]'), hint=$('#review-hint');
      const d=currentDoc(),v=currentVersion();
      const canReview=!!v&&!state.editorDirty&&state.docBase===d.currentVersionId&&state.drafts.docBody===v.body;
      if(review)review.disabled=!canReview;
      if(reload)reload.hidden=!state.editorDirty;
      if(hint)hint.hidden=canReview;
    }
  });
  document.addEventListener('submit',async event=>{
    const form=event.target;if(!form.id)return;event.preventDefault();const data=Object.fromEntries(new FormData(form));const button=form.querySelector('[type=submit],button:not([type])');
    if(form.id==='auth-form'){await act(button,async()=>{const path=state.authMode==='register'?'/auth/register':'/auth/login';const result=await api(path,{method:'POST',body:data});state.user=result.user;if(savedUserId!==state.user.id)clearPrivateDrafts();await loadWorkspaces();},'Signed in.');return;}
    if(form.id==='create-workspace-form'){await act(button,async()=>{const {workspace:w}=await api('/workspaces',{method:'POST',body:{name:data.name.trim()}});state.modal=null;await loadWorkspaces();switchWorkspace(w.id);},'Workspace created.');return;}
    if(form.id==='join-workspace-form'){await act(button,async()=>{const {workspace:w}=await api('/workspaces/join',{method:'POST',body:{inviteCode:data.inviteCode.trim()}});state.modal=null;await loadWorkspaces();switchWorkspace(w.id);},'Joined workspace.');return;}
    if(form.id==='message-form'){const text=$('#message-text').value.trim();if(!text)return;await act(button,async()=>{await api(`/workspaces/${state.workspaceId}/messages`,{method:'POST',body:{text,clientRequestId:requestId('message')}});requestDone('message');state.drafts.message='';persist();await loadState();},'Message sent.');return;}
    if(form.id==='create-doc-form'){await act(button,async()=>{const {document:d}=await api(`/workspaces/${state.workspaceId}/documents`,{method:'POST',body:{title:data.title.trim(),body:data.body,clientRequestId:requestId('create-doc')}});requestDone('create-doc');state.modal=null;state.drafts.docTitle='';state.drafts.docBody='';state.docId=d.id;state.tab='documents';await loadState();},'Document created.');return;}
    if(form.id==='credential-form'){
      const apiKey=data.apiKey;
      form.querySelector('[name=apiKey]').value='';
      await act(button,async()=>{
        try {state.runtime=await api('/runtime/credentials',{method:'POST',body:{apiKey,model:data.model.trim()||undefined}});state.credentialError='';}
        catch(error){state.credentialError=error.message;throw error;}
      },'API key saved. Register an agent, then start a run.');
      return;
    }
    if(form.id==='agent-form'){await act(button,async()=>{await api(`/workspaces/${state.workspaceId}/agents`,{method:'POST',body:{name:data.name.trim(),model:data.model.trim(),instructions:data.instructions.trim()}});await loadState();},'Agent registered.');return;}
    if(form.id==='run-form'){const doc=state.data.documents.find(d=>d.id===data.documentId);await act(button,async()=>{await api(`/workspaces/${state.workspaceId}/runs`,{method:'POST',body:{agentId:data.agentId,prompt:data.prompt.trim(),documentId:doc?.id,baseVersionId:doc?.currentVersionId,clientRequestId:requestId('run')}});requestDone('run');state.drafts.prompt='';persist();await loadState();},'Agent run started.');return;}
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.modal){state.modal=null;render();}if(event.key==='Enter'&&event.target.id==='message-text'&&!event.shiftKey){event.preventDefault();$('#message-form')?.requestSubmit();}});
  document.addEventListener('mousedown',event=>{if(event.target.id==='modal-scrim'){state.modal=null;render();}});
  bootstrap();
})();
