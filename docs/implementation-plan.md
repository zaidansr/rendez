# Rendez collaboration MVP implementation plan

## Outcome and boundaries

Two independently signed-in Electron clients exchange messages, each runs an owned agent, both revise one shared document, and a human approves the exact final version. Retain the existing layout and light/dark styling, using neutral grayscale values. This milestone is a trusted local-host collaboration MVP, not an internet deployment or autonomous tool-execution platform.

The inspected starting implementation contains a single HTML UI with localStorage sample messages/tasks, hardcoded people and agent presence, simulated replies, and fixed file snippets. The Electron window already disables Node integration and enables context isolation and sandboxing. There is no backend, authentication, synchronization, genuine agent execution, document version history, or approval record.

## Architecture and ownership

- **Sol backend:** one Node server, authenticated HTTP commands, durable SQLite state and event log, SSE notifications, workspace authorization, OpenAI provider text adapter. Node v24.22.1 and built-in node:sqlite were verified locally. Backend owns server modules.
- **Sol client:** preserve visual direction; replace sample state with real account/workspace data; conversation, agent controls, document history/review; isolated Electron profiles connecting to the same Node-served origin. Own frontend and Electron startup/profile changes.
- **Sol QA:** own tests/, integration/backtesting and desktop workflow verification. Mock-provider checks and real model execution must be reported separately.
- **Astra:** feature decomposition, frozen API/data contract, acceptance criteria in this document.

Start one server and connect both desktop profiles to it. Keep SQLite and generated runtime data out of git. Localhost is the default binding. Bind beyond loopback only through explicit deployment configuration; TLS/internet hardening is outside this milestone. Use the fixed official OpenAI endpoint, not arbitrary client URLs. No shell tools or arbitrary filesystem access are exposed to agents. User selected provider API agents. Enter a key privately through the desktop UI; send it to the trusted local server and retain it only in memory scoped to the authenticated user. Never store it in SQLite, localStorage, shared state, logs, or responses. Clear on server restart and through an explicit disconnect control. Clear the UI password field after submission.

## Individual features and acceptance checks

| Order | Feature | Observable acceptance |
| --- | --- | --- |
| 1 | Durable shared service | Restart server and recover users, memberships, messages, documents, versions, approvals, and completed runs. Entity change and event commit atomically. |
| 2 | Register, sign in, sign out | Two actual accounts can sign in independently; passwords are hashed and session tokens are opaque, expiring, revocable cookies. Signed-out access is rejected. No seeded fake users. |
| 3 | Create/join workspace | One account creates a workspace; another joins with its invite code. A third nonmember cannot read or mutate any workspace resource or subscribe to its events. |
| 4 | Shared messages | Sending from one client appears in the other. Author comes from authenticated session. Retrying an operation ID does not create duplicates. |
| 5 | Live sync and recovery | SSE invalidates/refetches state; reconnect uses durable cursor. Missing events recover through a fresh snapshot. Compose/editor drafts survive remote updates. |
| 6 | Owned agent setup | Each person adds a named agent with a model and instructions. UI supports per-user API key setup and clearing. Configured credentials are labelled configured, not verified; a real run establishes validity. No simulated ready state. |
| 7 | Real run lifecycle | Owner submits prompt, sees running/completed/failed/cancelled/conflict state, and can cancel. Another user cannot launch or cancel that owner's agent. Unconfigured runtime produces an actionable error. |
| 8 | Shared document | Member creates a document and saves immutable revisions with author and timestamp. Two edits against the same base cannot silently overwrite each other. |
| 9 | Agent document revision | Owner selects document and runs agent against a fixed base version. Successful output creates a new version; intervening edits yield conflict and preserve generated output for review. |
| 10 | Version-specific approval | Member approves current version. Record identifies reviewer, exact version, and timestamp. New revision is unapproved; old approval stays in history. Stale approval request returns conflict. |
| 11 | Desktop integration | Two separate Electron profiles share backend but isolate sessions. Retain sandbox/context isolation; allow only intended server navigation. Light/dark themes remain usable and grayscale. |
| 12 | Recovery and delivery | Server restart marks unfinished runs interrupted/failed without rerunning them. README includes server, two-client launch, runtime configuration, test commands and limitations. |

## Frozen HTTP contract

All routes below are prefixed `/api`. Requests/responses are JSON except SSE. UI is served from the same origin as the API. Session cookie should be HttpOnly and SameSite=Strict; validate request origin for mutations. Derive actor and membership on the server. Errors use `{error:{code,message}}`; stale edits/approvals use HTTP 409. IDs are strings except numeric event IDs/cursors. Dates are ISO strings.

| Method and route | Request | Response |
| --- | --- | --- |
| POST /auth/register | name,email,password | {user} |
| POST /auth/login | email,password | {user} |
| POST /auth/logout | {} | {ok:true} |
| GET /session | — | {user:null or User} |
| GET /runtime | — | {provider:'openai',available,models:[string],error:null or string} |
| GET /workspaces | — | {workspaces} |
| POST /workspaces | name | {workspace,inviteCode} |
| POST /workspaces/join | inviteCode | {workspace} |
| GET /workspaces/:wid/state | — | {workspace,members,agents,messages,documents,runs,events,cursor} |
| POST /workspaces/:wid/messages | text,clientRequestId | {message} |
| POST /workspaces/:wid/agents | name,model,instructions | {agent} |
| POST /workspaces/:wid/runs | agentId,prompt,documentId?,baseVersionId?,clientRequestId | {run} |
| POST /workspaces/:wid/runs/:rid/cancel | {} | {run} |
| POST /workspaces/:wid/documents | title,body,clientRequestId | {document} |
| POST /workspaces/:wid/documents/:did/versions | body,baseVersionId,clientRequestId | {document} |
| POST /workspaces/:wid/documents/:did/approve | versionId,clientRequestId | {document} |
| GET /workspaces/:wid/events?after=cursor | — | SSE named event `change`, data {id,type,entityId} |

SSE subscribers refetch state after a change. Publish only committed events. Mutation retry IDs are scoped by actor/workspace/action; reject reuse with a different request payload. No documentId means a run creates an agent conversation reply. A document run requires baseVersionId and generates a full replacement draft; compare the base against current head both at submission and commit. Completed run output and its version/message should commit consistently. Cancellation must prevent later provider completion from committing a result.

## Frozen entity shapes

```text
User / Member {id,name,email}
Workspace {id,name,ownerId,inviteCode,createdAt}
Agent {id,workspaceId,ownerId,name,model,instructions,createdAt}
Message {id,workspaceId,authorId,authorType:'user'|'agent',text,createdAt,runId:null|string}
Document {id,workspaceId,title,currentVersionId,versions:[Version],approvals:[Approval],createdAt}
Version {id,documentId,number,body,baseVersionId:null|string,authorId,authorType:'user'|'agent',runId:null|string,createdAt}
Approval {id,documentId,versionId,userId,createdAt}
Run {id,workspaceId,agentId,requestedBy,prompt,documentId:null|string,baseVersionId:null|string,status:'running'|'completed'|'failed'|'cancelled'|'conflict',outputText,error:null|string,createdAt,updatedAt}
Event {id:number,workspaceId,type,entityId,actorId,summary,createdAt}
```

State includes full document histories for this bounded MVP. Derive current approval only from approvals whose versionId matches currentVersionId. Any member can contribute/review; only the agent owner can start/cancel its runs. For this first milestone, agents are user-owned configurations executed by one trusted local server, not remote access to each person's private computer.

## Verification sequence

1. Run isolated temporary-database integration tests: auth/session expiry/logout, workspace isolation on every resource including SSE, request deduplication, document compare-and-swap, exact-version approvals, run ownership, cancellation race, provider failure, server restart persistence and interrupted runs.
2. Use a deterministic mock model server only in tests to exercise real HTTP adapter requests, completion and failure paths. Label these as mock-provider tests; never show them as real AI output in the application.
3. Desktop acceptance: launch two profiles, register two accounts, create/join space, exchange messages, create one document, configure one agent per user, run each against successive document versions, save a manual revision and approve it. Verify history and shared state in both clients, then restart and recover.
4. Repeat the agent portion with an available real configured OpenAI provider. Record runtime/model and observed success. If no runtime/model/credential is available, report the live-run check as unverified rather than claiming completion from mocks.

Do not expand into CRDT editing, autonomous agent-to-agent chains, marketplace integrations, billing, cloud credential custody, or a general tool sandbox during this milestone.

## Provider credential routes (final user-selected update)

Authenticated POST /api/runtime/credentials accepts {apiKey,model?} and returns {provider:'openai',available:true,models:[string],error:null}. DELETE /api/runtime/credentials returns {ok:true}. GET /api/runtime returns the authenticated user's configuration status, never credentials. available means key configured, not provider health verified. A run uses its owner's key from server memory. Use the official provider endpoint and validate request/response against official documentation. No Ollama requirement remains. QA must verify one user's key is never used for another user's runs and cannot appear in state or logs.

