/** BOOP design v1.0 — own interfaces, not DSH native declarations.
 * Compile & bind DshAdapter against rc.2 before enabling writes (G01-G09).
 */
export type TaskLife = 'draft'|'active'|'paused'|'blocked'|'recovery_required'|'completed'|'cancelled';
export type Verification = 'not_requested'|'pending'|'passed'|'failed'|'waived';
export type ActionState = 'planned'|'awaiting_approval'|'dispatching'|'accepted'|'running'|'settled'|'stopped'|'outcome_unknown'|'rejected';
export interface EvidenceRef {scopeId:string; sessionId:string; sourceGeneration:string; seq:number; hash?:string; artifactRef?:string}
export interface VerifiedActor {ownerId:string; scopeId:string; channel:'dsh'|'dingtalk'|'feishu'; bindingId?:string}
export interface Task {id:string;scopeId:string;goal:string;version:number;lifecycle:TaskLife;verification:Verification;criteria:string[];exclusions:string[]}
export interface ActionProposal {taskId:string;expectedVersion:number;targetSessionId:string;instruction:string;mode:'queue'|'steer';evidenceRefs:EvidenceRef[]}
export interface CommandEnvelope {scopeId:string;taskId:string;taskVersion:number;actionId:string;messageId:string;policyEpoch:number;payloadHash:string;initiatorRef:string;instruction:string;mode:'queue'|'steer'}
export interface ApprovalBinding {id:string;actionId:string;taskVersion:number;policyEpoch:number;payloadHash:string;requestingOwner:string;expiresAt:string;nonceHash:string}
export interface Snapshot {scopeId:string;ownerId:string;version:number;body:string;coverage:Record<string,{sourceGeneration:string;throughSeq:number}>;freshness:'current'|'stale'|'unknown'}
export interface MemoryChange {status?:'active'|'disputed';op:'add'|'edit'|'supersede'|'conflict';factId?:string;kind:string;text:string;authority:string;evidenceRefs:EvidenceRef[];supersedes:string[]}
export interface MemoryProposal {schemaVersion:1;scopeId:string;sessionId:string;fromSeq:number;toSeq:number;baselineVersion:number;changes:MemoryChange[];unresolved:string[]}
export interface InboundEnvelope {channel:'dingtalk'|'feishu';appId:string;tenantId:string;actorId:string;conversationId:string;eventId:string;messageId:string;timestamp:string;text:string;verifiedBindingId:string}
export interface ReadTarget {scopeId:string;sessionId:string}
export interface DshAdapter {
  capabilities():Promise<Record<string,boolean>>;
  listTargets(scopeId:string):Promise<Array<{workspaceId?:string;sessionId:string;running:boolean;title?:string}>>;
  readHistory(target:ReadTarget, afterSeq:number, signal:AbortSignal):AsyncIterable<unknown>;
  readInbox(target:ReadTarget, signal:AbortSignal):Promise<Array<{messageId:string;source:unknown}>>;
  ensureMain(scopeId:string, presetId:string, signal:AbortSignal):Promise<{sessionId:string}>;
  // Adapter must preserve agent provenance; must NOT send a fake human prompt.
  enqueueProxy(envelope:CommandEnvelope, signal:AbortSignal):Promise<{messageId:string;accepted:boolean}>;
  flush(target:ReadTarget, signal:AbortSignal):Promise<void>;
  cancelOwned(target:ReadTarget, actionId:string, signal:AbortSignal):Promise<{requested:boolean;settled:boolean}>;
}
export interface ChannelAdapter {
  connect(signal:AbortSignal):Promise<void>;
  verifyAndNormalize(raw:unknown):Promise<InboundEnvelope|null>;
  acknowledgeReceipt(raw:unknown):Promise<void>;
  sendReply(origin:InboundEnvelope, text:string, logicalReplyId:string):Promise<{receipt:string}>;
  disconnect():Promise<void>;
}
