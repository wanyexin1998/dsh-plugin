/**
 * Schema 2 migration body.
 *
 * Applied inside the caller's transaction. Idempotent for a database that is
 * already at v2. A v1 `task_target.workspace_id NOT NULL` is rebuilt in place;
 * row counts and column values are compared before the old table is dropped.
 */

export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): {
    all(...args: any[]): any[]
    get(...args: any[]): any
    run(...args: any[]): { changes?: number }
  }
}

function columns(db: SqlDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  return new Set(rows.map((row) => String(row.name)))
}

function addColumn(db: SqlDb, table: string, name: string, ddl: string): void {
  if (columns(db, table).has(name)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
}

function tableSql(db: SqlDb, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql?: unknown }
    | undefined
  return typeof row?.sql === 'string' ? row.sql : ''
}

function swapTaskTarget(db: SqlDb): void {
  const sql = tableSql(db, 'task_target')
  if (sql === '' || !sql.includes('workspace_id TEXT NOT NULL')) return
  const dependents = db
    .prepare("SELECT name, type, sql FROM sqlite_master WHERE sql LIKE '%task_target%' AND name != 'task_target'")
    .all() as Array<{ name?: unknown; type?: unknown; sql?: unknown }>
  const unexpected = dependents.filter((row) => {
    const type = String(row.type)
    const name = String(row.name)
    return !(type === 'index' && name.startsWith('sqlite_autoindex'))
  })
  if (unexpected.length > 0) {
    throw new Error(`MIGRATION_FAILED: unexpected task_target dependency ${unexpected.map((row) => String(row.name)).join(',')}`)
  }
  db.exec(`CREATE TABLE task_target_v2 (
    task_id TEXT NOT NULL, scope_id TEXT NOT NULL, workspace_id TEXT,
    session_id TEXT NOT NULL, role TEXT NOT NULL, resource_key TEXT NOT NULL,
    PRIMARY KEY(task_id,scope_id,session_id),
    FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id)
  )`)
  db.exec(`INSERT INTO task_target_v2(task_id,scope_id,workspace_id,session_id,role,resource_key)
    SELECT task_id,scope_id,workspace_id,session_id,role,resource_key FROM task_target`)
  const before = Number((db.prepare('SELECT COUNT(*) AS c FROM task_target').get() as { c: number }).c)
  const after = Number((db.prepare('SELECT COUNT(*) AS c FROM task_target_v2').get() as { c: number }).c)
  if (before !== after) throw new Error('MIGRATION_FAILED: task_target copy count mismatch')
  const diff = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT task_id,scope_id,workspace_id,session_id,role,resource_key FROM task_target
             EXCEPT
             SELECT task_id,scope_id,workspace_id,session_id,role,resource_key FROM task_target_v2
             UNION ALL
             SELECT task_id,scope_id,workspace_id,session_id,role,resource_key FROM task_target_v2
             EXCEPT
             SELECT task_id,scope_id,workspace_id,session_id,role,resource_key FROM task_target
           )`,
        )
        .get() as { c: number }
    ).c,
  )
  if (diff !== 0) throw new Error('MIGRATION_FAILED: task_target column mismatch')
  db.exec('DROP TABLE task_target')
  db.exec('ALTER TABLE task_target_v2 RENAME TO task_target')
}

const NEW_TABLES = `
CREATE TABLE IF NOT EXISTS home_binding_history (
  scope_id TEXT NOT NULL, binding_version INTEGER NOT NULL CHECK(binding_version>0),
  session_id TEXT NOT NULL, previous_session_id TEXT, preset_id TEXT NOT NULL,
  cwd_fingerprint TEXT NOT NULL, context_ref TEXT, opened_at TEXT NOT NULL, closed_at TEXT,
  PRIMARY KEY(scope_id,binding_version), UNIQUE(scope_id,session_id),
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_home ON home_binding_history(scope_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS home_provisioning (
  scope_id TEXT PRIMARY KEY, provision_key TEXT NOT NULL UNIQUE,
  expected_binding_version INTEGER NOT NULL CHECK(expected_binding_version>=0),
  requested_session_id TEXT NOT NULL, returned_session_id TEXT, legacy_session_id TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('prepared','native_created','verified','bound','repair_required')),
  error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE IF NOT EXISTS source_access (
  scope_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('none','selected','all_authorized')),
  workspace_ids_json TEXT NOT NULL CHECK(json_valid(workspace_ids_json)),
  session_ids_json TEXT NOT NULL CHECK(json_valid(session_ids_json)),
  granted_by TEXT NOT NULL, grant_ref TEXT NOT NULL, policy_epoch INTEGER NOT NULL CHECK(policy_epoch>0),
  updated_at TEXT NOT NULL, FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE IF NOT EXISTS request_receipt (
  scope_id TEXT NOT NULL, operation TEXT NOT NULL, origin_ref TEXT NOT NULL, request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, task_id TEXT, action_id TEXT, applied_task_version INTEGER,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(scope_id,operation,origin_ref,request_id),
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id),
  FOREIGN KEY(task_id,scope_id) REFERENCES task(id,scope_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE IF NOT EXISTS context_snapshot (
  id TEXT NOT NULL, scope_id TEXT NOT NULL, main_session_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL, target_session_id TEXT NOT NULL,
  source_generation TEXT NOT NULL, head_seq INTEGER NOT NULL CHECK(head_seq>=-1),
  latest_user_seq INTEGER NOT NULL CHECK(latest_user_seq>=-1), latest_user_message_id TEXT,
  policy_epoch INTEGER NOT NULL CHECK(policy_epoch>0), context_hash TEXT NOT NULL,
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY(id,scope_id), FOREIGN KEY(scope_id) REFERENCES scopes(scope_id)
);
CREATE TABLE IF NOT EXISTS action_runtime (
  action_id TEXT NOT NULL, scope_id TEXT NOT NULL, context_id TEXT NOT NULL,
  main_session_id TEXT NOT NULL, main_binding_version INTEGER NOT NULL CHECK(main_binding_version>0),
  origin_message_id TEXT NOT NULL, origin_turn_id TEXT NOT NULL, tool_call_id TEXT,
  target_generation TEXT NOT NULL, latest_user_seq INTEGER NOT NULL CHECK(latest_user_seq>=-1),
  dispatch_policy TEXT NOT NULL DEFAULT 'when_idle' CHECK(dispatch_policy='when_idle'),
  queue_reason TEXT CHECK(queue_reason IN ('global_slot','target_busy','previous_action','context_changed','recovery')),
  observed_through_seq INTEGER NOT NULL DEFAULT -1 CHECK(observed_through_seq>=-1),
  claim_seq INTEGER, terminal_seq INTEGER,
  ownership TEXT NOT NULL DEFAULT 'not_started' CHECK(ownership IN ('not_started','exclusive','mixed','user_takeover','unknown','ended')),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
  stop_reason TEXT, native_approval_id TEXT, runtime_fence INTEGER, updated_at TEXT NOT NULL,
  PRIMARY KEY(action_id,scope_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id),
  FOREIGN KEY(context_id,scope_id) REFERENCES context_snapshot(id,scope_id)
);
CREATE TABLE IF NOT EXISTS action_admission (
  action_id TEXT NOT NULL, scope_id TEXT NOT NULL, message_id TEXT NOT NULL,
  target_generation TEXT NOT NULL, turn_id TEXT NOT NULL,
  admitted_at TEXT NOT NULL, evidence_seq INTEGER,
  PRIMARY KEY(action_id,scope_id), UNIQUE(scope_id,message_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE IF NOT EXISTS execution_slot (
  scope_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('free','held','recovery_barrier')),
  action_id TEXT, holder TEXT, fencing_token INTEGER, slot_revision INTEGER NOT NULL DEFAULT 0 CHECK(slot_revision>=0),
  reason TEXT, updated_at TEXT NOT NULL,
  CHECK((state='held' AND action_id IS NOT NULL) OR (state!='held' AND action_id IS NULL)),
  FOREIGN KEY(scope_id) REFERENCES scopes(scope_id),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE IF NOT EXISTS task_result (
  id TEXT NOT NULL, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
  action_id TEXT NOT NULL, logical_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('progress','blocked','final','stopped')),
  source_generation TEXT NOT NULL, event_seq INTEGER NOT NULL CHECK(event_seq>=0), turn_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','stopped','inconclusive','blocked','progress')),
  deliverable INTEGER NOT NULL CHECK(deliverable IN (0,1)),
  summary TEXT NOT NULL, artifacts_json TEXT NOT NULL CHECK(json_valid(artifacts_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), checks_json TEXT NOT NULL CHECK(json_valid(checks_json)),
  missing_json TEXT NOT NULL CHECK(json_valid(missing_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(id,scope_id), UNIQUE(scope_id,logical_key), UNIQUE(id,scope_id,task_id,task_version),
  FOREIGN KEY(task_id,scope_id,task_version) REFERENCES task_revision(task_id,scope_id,version),
  FOREIGN KEY(action_id,scope_id) REFERENCES action(id,scope_id)
);
CREATE TABLE IF NOT EXISTS result_outbox (
  result_id TEXT NOT NULL, scope_id TEXT NOT NULL, native_message_id TEXT NOT NULL,
  target_main_session_id TEXT NOT NULL, target_binding_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','unknown','suppressed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  updated_at TEXT NOT NULL, PRIMARY KEY(result_id,scope_id), UNIQUE(scope_id,native_message_id),
  FOREIGN KEY(result_id,scope_id) REFERENCES task_result(id,scope_id)
);
CREATE TABLE IF NOT EXISTS task_acceptance (
  id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
  result_id TEXT NOT NULL, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, origin_ref TEXT NOT NULL,
  accepted_at TEXT NOT NULL, PRIMARY KEY(task_id,scope_id,task_version),
  FOREIGN KEY(result_id,scope_id,task_id,task_version) REFERENCES task_result(id,scope_id,task_id,task_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_single_executor_v2
  ON task_target(scope_id,task_id) WHERE role='executor-v2';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_delegation_v2 ON action(scope_id)
  WHERE managed_v2=1 AND state IN ('dispatching','accepted','running','outcome_unknown');
CREATE INDEX IF NOT EXISTS action_runtime_target ON action_runtime(scope_id,target_generation,observed_through_seq);
CREATE INDEX IF NOT EXISTS result_delivery_queue ON result_outbox(scope_id,state,updated_at);
CREATE INDEX IF NOT EXISTS result_task_history ON task_result(scope_id,task_id,task_version,created_at);
`

export function applySchemaV2(db: SqlDb, now = new Date().toISOString()): void {
  addColumn(db, 'task', 'state_seq', 'INTEGER NOT NULL DEFAULT 0 CHECK(state_seq>=0)')
  addColumn(db, 'task', 'engine_version', 'INTEGER NOT NULL DEFAULT 1 CHECK(engine_version IN (1,2))')
  addColumn(db, 'task', 'stop_requested', 'INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1))')
  addColumn(db, 'action', 'managed_v2', 'INTEGER NOT NULL DEFAULT 0 CHECK(managed_v2 IN (0,1))')
  swapTaskTarget(db)
  db.exec(NEW_TABLES)
  db.prepare(
    `INSERT INTO execution_slot(scope_id,state,action_id,holder,fencing_token,slot_revision,reason,updated_at)
     SELECT scope_id, 'free', NULL, NULL, NULL, 0, NULL, ?
     FROM scopes
     WHERE NOT EXISTS (SELECT 1 FROM execution_slot e WHERE e.scope_id = scopes.scope_id)`,
  ).run(now)
  const inflight = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM action
           WHERE managed_v2 = 0 AND state IN ('dispatching','accepted','running','outcome_unknown','awaiting_approval')`,
        )
        .get() as { c: number }
    ).c,
  )
  if (inflight > 0) {
    db.prepare(
      `UPDATE execution_slot
       SET state = 'recovery_barrier', action_id = NULL, holder = NULL, fencing_token = NULL,
           slot_revision = slot_revision + 1, reason = 'legacy-inflight', updated_at = ?
       WHERE state != 'held'`,
    ).run(now)
  }
}
