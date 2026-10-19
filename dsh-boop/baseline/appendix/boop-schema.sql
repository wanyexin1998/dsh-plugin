-- BOOP v1.0: design-only SQLite schema; not an installed plugin.
-- Test with SQLite >=3.38; node:sqlite/Electron availability remains Gate G08.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE scopes (
 scope_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, main_session_id TEXT,
 policy_epoch INTEGER NOT NULL DEFAULT 1 CHECK(policy_epoch>0),
 schema_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE task (
 id TEXT NOT NULL, scope_id TEXT NOT NULL, goal TEXT NOT NULL,
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','paused','blocked','recovery_required','completed','cancelled')),
 verification TEXT NOT NULL CHECK(verification IN ('not_requested','pending','passed','failed','waived')),
 version INTEGER NOT NULL CHECK(version>0),
 criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)),
 exclusions_json TEXT NOT NULL CHECK(json_valid(exclusions_json)),
 intent_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(id,scope_id), FOREIGN KEY(scope_id) REFERENCES scopes(scope_id),
 CHECK(lifecycle!='completed' OR verification IN ('passed','waived'))
);
CREATE TABLE task_revision (
 task_id TEXT NOT NULL, scope_id TEXT NOT NULL, version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), intent_ref TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,scope_id,version), FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id)
);
CREATE TABLE task_target (
 task_id TEXT NOT NULL, scope_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 session_id TEXT NOT NULL, role TEXT NOT NULL, resource_key TEXT NOT NULL,
 PRIMARY KEY(task_id,scope_id,session_id),
 FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id)
);
CREATE TABLE task_dependency (
 task_id TEXT NOT NULL, depends_on TEXT NOT NULL, scope_id TEXT NOT NULL,
 PRIMARY KEY(task_id,depends_on,scope_id), CHECK(task_id!=depends_on),
 FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id),
 FOREIGN KEY(depends_on,scope_id) REFERENCES task(id,scope_id)
); -- Transitive cycles must be rejected by repository transaction logic.
CREATE TABLE action (
 id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL,
 task_version INTEGER NOT NULL, target_session_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 state TEXT NOT NULL CHECK(state IN ('planned','awaiting_approval','dispatching','accepted','running','settled','stopped','outcome_unknown','rejected')),
 message_id TEXT, turn_id TEXT, policy_epoch INTEGER NOT NULL,
 origin_ref TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(id,scope_id), UNIQUE(scope_id,message_id),
 FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id),
 FOREIGN KEY(task_id,scope_id,task_version) REFERENCES task_revision(task_id,scope_id,version)
);
CREATE TABLE command_outbox (
 action_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','blocked','sending','accepted','unknown','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
 PRIMARY KEY(action_id,scope_id), FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE ingress (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, channel TEXT NOT NULL,
 app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL,
 actor_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 state TEXT NOT NULL CHECK(state IN ('received','verified','rejected','admitted','settled','expired')),
 native_message_id TEXT, received_at TEXT NOT NULL,
 UNIQUE(scope_id,channel,app_id,tenant_id,event_id),
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE channel_binding (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, channel TEXT NOT NULL,
 app_id TEXT NOT NULL, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 allowed_ops_json TEXT NOT NULL CHECK(json_valid(allowed_ops_json)),
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 credential_ref TEXT, verified_at TEXT NOT NULL,
 UNIQUE(scope_id,channel,app_id,tenant_id,actor_id),
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE channel_outbox (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, logical_reply_id TEXT NOT NULL,
 channel TEXT NOT NULL, origin_conversation TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','sent','failed','expired')),
 native_message_id TEXT, platform_receipt TEXT,
 UNIQUE(scope_id,logical_reply_id,channel,origin_conversation),
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE approval (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, action_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL, task_version INTEGER NOT NULL, policy_epoch INTEGER NOT NULL,
 requesting_owner TEXT NOT NULL, nonce_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL, consumed_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','allowed','rejected','expired','stale','cancelled')),
 FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE source_cursor (
 scope_id TEXT NOT NULL, session_id TEXT NOT NULL, source_generation TEXT NOT NULL,
 through_seq INTEGER NOT NULL DEFAULT -1 CHECK(through_seq>=-1),
 state TEXT NOT NULL CHECK(state IN ('fresh','dirty','processing','gap','excluded')),
 PRIMARY KEY(scope_id,session_id,source_generation),
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE memory_job (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
 session_id TEXT, from_seq INTEGER, to_seq INTEGER, baseline_version INTEGER NOT NULL,
 input_hash TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed','cancelled','superseded')),
 created_at TEXT NOT NULL,
 CHECK(from_seq IS NULL OR to_seq>=from_seq),
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE fact (
 id TEXT NOT NULL, scope_id TEXT NOT NULL, owner_type TEXT NOT NULL,
 owner_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','disputed','superseded','tombstoned')),
 authority TEXT NOT NULL CHECK(authority IN ('user_confirmed','user_exploration','agent_reported','tool_observed','import_unverified','inference')),
 valid_time TEXT, version INTEGER NOT NULL CHECK(version>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(id,scope_id), FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE fact_version (
 fact_id TEXT NOT NULL, scope_id TEXT NOT NULL, version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at TEXT NOT NULL,
 PRIMARY KEY(fact_id,scope_id,version), FOREIGN KEY(fact_id,scope_id) REFERENCES fact(id,scope_id)
);
CREATE TABLE fact_evidence (
 id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 session_id TEXT, seq INTEGER, source_hash TEXT NOT NULL, artifact_ref TEXT,
 FOREIGN KEY(fact_id,scope_id) REFERENCES fact(id,scope_id),
 CHECK(seq IS NULL OR seq>=0)
);
CREATE TABLE fact_relation (
 from_fact TEXT NOT NULL, to_fact TEXT NOT NULL, scope_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('supports','supersedes','conflicts')),
 PRIMARY KEY(from_fact,to_fact,scope_id,kind), CHECK(from_fact!=to_fact),
 FOREIGN KEY(from_fact,scope_id) REFERENCES fact(id,scope_id),
 FOREIGN KEY(to_fact,scope_id) REFERENCES fact(id,scope_id)
); -- Prevent support cycles in application transaction, not timestamps.
CREATE TABLE memory_snapshot (
 scope_id TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
 version INTEGER NOT NULL, body TEXT NOT NULL,
 coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(scope_id,owner_type,owner_id,version),
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE fact_consumption (
 id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, scope_id TEXT NOT NULL,
 fact_version INTEGER NOT NULL, task_id TEXT NOT NULL, action_id TEXT,
 use_kind TEXT NOT NULL CHECK(use_kind IN ('answer','plan','dispatch','verification')),
 FOREIGN KEY(fact_id,scope_id) REFERENCES fact(id,scope_id),
 FOREIGN KEY(fact_id,scope_id,fact_version) REFERENCES fact_version(fact_id,scope_id,version),
 FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id),
 FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE forget_rule (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
 selector_json TEXT NOT NULL CHECK(json_valid(selector_json)),
 mode TEXT NOT NULL CHECK(mode IN ('exclude_source','forget_fact','exclude_scope')),
 created_at TEXT NOT NULL, FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE audit_event (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, time TEXT NOT NULL,
 actor TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT,
 before_hash TEXT, after_hash TEXT, reason TEXT,
 FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE runtime_lease (
 scope_id TEXT PRIMARY KEY, holder TEXT NOT NULL, fencing_token INTEGER NOT NULL,
 expires_at TEXT NOT NULL, FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE INDEX task_state_idx ON task(scope_id,lifecycle,updated_at);
CREATE INDEX action_state_idx ON action(scope_id,state,updated_at);
CREATE INDEX fact_owner_idx ON fact(scope_id,owner_type,owner_id,status);
CREATE INDEX evidence_source_idx ON fact_evidence(scope_id,session_id,seq);
CREATE INDEX job_pending_idx ON memory_job(scope_id,status,created_at);
CREATE INDEX consumption_task_idx ON fact_consumption(scope_id,task_id,action_id);
-- Optional derived index; availability must be capability-probed.
CREATE VIRTUAL TABLE fact_fts USING fts5(scope_id UNINDEXED, fact_id UNINDEXED, text, tokenize='trigram');
-- Only validated active facts enter FTS. Repository transaction owns insert/update/delete.
-- FTS, permissions, CAS, one-shot approvals, lifecycle & outbox reconciliation are NOT implemented by DDL alone.
