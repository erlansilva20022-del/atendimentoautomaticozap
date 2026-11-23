// Banco SQLite (node:sqlite, nativo do Node 22+ — sem compilação nativa,
// funciona no Windows sem Visual Studio) — pedidos, fotos e eventos.
// Máquina de estados: nenhum estado pode ser pulado; só avançar ou ir para REVISAO.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { config } = require('./config');

const STATES = [
  'NOVO',
  'CONTATO_VALIDADO',
  'ORIGINAL_BAIXADA',
  'REFERENCIAS_VALIDAS',
  'PREVIA_GERADA',
  'PREVIA_BAIXADA',
  'ANEXO_CONFERIDO',
  'PREVIA_ENVIADA',
  'AGUARDANDO_APROVACAO',
  'APROVADO',
  'AGUARDANDO_PAGAMENTO',
  'PAGAMENTO_CONFIRMADO',
  'FINAL_ENTREGUE',
  'REVISAO',
];

// Ordem de avanço permitida (índice no array). REVISAO pode vir de qualquer estado.
const STATE_ORDER = STATES.filter((s) => s !== 'REVISAO');

function initDb(dbPath = config.databasePath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT,
      language TEXT NOT NULL DEFAULT 'pt',
      style TEXT,
      quantity INTEGER,
      price REAL,
      currency TEXT,
      status TEXT NOT NULL DEFAULT 'NOVO',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      kind TEXT NOT NULL CHECK (kind IN ('original', 'preview', 'final')),
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(order_id, sha256, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_photos_order ON order_photos(order_id);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);

    -- FC Core v2.0.0 — registro de envios (anti-duplicação).
    -- Chave única por (pedido, ação, tipo de imagem, hash da imagem): o mesmo
    -- envio nunca é repetido. Um envio só vira 'confirmed' com evidência
    -- verificável (confirmação explícita da extensão). Resultado incerto vira
    -- 'uncertain' e o pedido vai para REVISAO, sem reenvio automático.
    CREATE TABLE IF NOT EXISTS send_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL REFERENCES orders(id),
      phone TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('preview', 'final')),
      image_kind TEXT NOT NULL,
      image_path TEXT NOT NULL,
      image_sha256 TEXT NOT NULL,
      image_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'uncertain', 'refused_duplicate')),
      executor_id TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_order ON send_ledger(order_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_status ON send_ledger(status);

    -- FC Core v2.0.0 — lease de executor único: só uma instância da extensão
    -- detém o envio de uma conversa por vez. O lease expira (TTL) e pode ser
    -- renovado pelo mesmo executor; outro executor não pode tomar a conversa.
    CREATE TABLE IF NOT EXISTS send_leases (
      phone TEXT PRIMARY KEY,
      executor_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- FC Core v2.0.0 — conflitos da importação do histórico da FC Bridge 3007,
    -- para revisão manual do dono (nunca sobrescrevem o progresso da 3008).
    CREATE TABLE IF NOT EXISTS import_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'bridge3007',
      order_id TEXT,
      reason TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conflicts_order ON import_conflicts(order_id);

    -- FC Core v2.1.0 — fila persistente de trabalhos (durable job queue).
    -- Um trabalho sobrevive à queda do processo: nada fica só em memória.
    -- kind define a política de retry: envios de foto (send_preview/send_final)
    -- NUNCA repetem automaticamente — falha vira 'needs_review' e o pedido vai
    -- para REVISAO. Leituras/downloads/verificações tentam até max_attempts
    -- com espera crescente (backoff) antes de falhar.
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES orders(id),
      step TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT,
      deadline TEXT,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'done', 'failed', 'needs_review')),
      result TEXT,
      failure_reason TEXT,
      correlation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_order ON jobs(order_id);

    -- FC Core v2.1.0 — reconciliação de envios históricos (anteriores à v2.0.0).
    -- Registra no ledger envios já confirmados no passado, SEM reenviar arquivos
    -- e SEM mudar o estado do pedido. Sem evidência suficiente, a entrada fica
    -- como 'review' (só revisão manual) e NÃO entra no ledger como confirmada.
    CREATE TABLE IF NOT EXISTS reconciliation_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('preview', 'final')),
      image_kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      whatsapp_message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('confirmed', 'review', 'skipped')),
      reason TEXT,
      ledger_dedup_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_order ON reconciliation_entries(order_id);

    -- FC Core v2.1.0 — arquivos da pasta muse-inbox já processados (persistente).
    -- Substitui a lista em memória do vigia: um arquivo já importado/ignorado
    -- nunca é reprocessado nem recontado na fila, mesmo após reiniciar o processo.
    CREATE TABLE IF NOT EXISTS processed_inbox_files (
      filename TEXT PRIMARY KEY,
      sha256 TEXT,
      order_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('imported', 'ignored', 'duplicate')),
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_sha ON processed_inbox_files(sha256);

    -- FC Core v2.1.0 — metadados do sistema (chave/valor): último backup, último
    -- heartbeat da extensão, estado da sessão do WhatsApp, etc.
    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // FC Core v2.1.1 — migração da reserva atômica de envio: o registro de envios
  // ganha reservation_id/reserved_at/expires_at. Bancos antigos (v2.0.0/v2.1.0)
  // recebem as colunas na abertura, sem recriar a tabela nem perder registros.
  const ledgerCols = db.prepare('PRAGMA table_info(send_ledger)').all().map((c) => c.name);
  for (const [col, def] of [
    ['reservation_id', 'TEXT'],
    ['reserved_at', 'TEXT'],
    ['expires_at', 'TEXT'],
  ]) {
    if (!ledgerCols.includes(col)) {
      db.exec(`ALTER TABLE send_ledger ADD COLUMN ${col} ${def}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_reservation ON send_ledger(reservation_id)');
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function logEvent(db, orderId, type, detail) {
  db.prepare('INSERT INTO events (order_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(orderId, type, detail || null, nowIso());
}

// Transição validada: só avança (ou vai para REVISAO, de qualquer estado).
// Retorna true se a transição foi aplicada, false se for inválida.
function transition(db, orderId, toState) {
  if (!STATES.includes(toState)) throw new Error(`Estado inválido: ${toState}`);
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
  const from = order.status;
  if (from === toState) return true; // idempotente
  if (toState === 'REVISAO') {
    applyTransition(db, orderId, from, toState);
    return true;
  }
  const fromIdx = STATE_ORDER.indexOf(from);
  const toIdx = STATE_ORDER.indexOf(toState);
  if (fromIdx === -1 || toIdx === -1) return false;
  if (toIdx !== fromIdx + 1) {
    // Não permite pular estados nem voltar.
    logEvent(db, orderId, 'transicao_invalida', `${from} -> ${toState}`);
    return false;
  }
  applyTransition(db, orderId, from, toState);
  return true;
}

function applyTransition(db, orderId, from, to) {
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
    .run(to, nowIso(), orderId);
  logEvent(db, orderId, 'status', `${from} -> ${to}`);
}

function createOrder(db, { phone, name = null, language = 'pt' }) {
  const id = randomUUID();
  return createOrderWithId(db, { id, phone, name, language });
}

// Cria um pedido com um UUID já existente (ex.: importado do banco antigo da FC Bridge).
// Usado para vincular o pedido de teste 92402128-07de-4e51-8c99-cf5d145fc3ab em vez de criar outro.
function createOrderWithId(db, { id, phone, name = null, language = 'pt' }) {
  const now = nowIso();
  db.prepare(
    'INSERT INTO orders (id, phone, name, language, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, phone, name, language, 'NOVO', now, now);
  logEvent(db, id, 'criado', `phone=${phone} language=${language}`);
  return getOrder(db, id);
}

function getOrder(db, id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

function findOpenOrderByPhone(db, phone) {
  // Pedido aberto = qualquer status que não seja FINAL_ENTREGUE nem REVISAO.
  return (
    db.prepare(
      "SELECT * FROM orders WHERE phone = ? AND status NOT IN ('FINAL_ENTREGUE', 'REVISAO') ORDER BY created_at DESC LIMIT 1"
    ).get(phone) || null
  );
}

function updateOrder(db, id, fields) {
  const allowed = ['name', 'language', 'style', 'quantity', 'price', 'currency'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getOrder(db, id);
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getOrder(db, id);
}

function addPhoto(db, orderId, { kind, path: filePath, sha256, bytes }) {
  try {
    const info = db.prepare(
      'INSERT INTO order_photos (order_id, kind, path, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(orderId, kind, filePath, sha256, bytes, nowIso());
    logEvent(db, orderId, 'foto_registrada', `${kind} sha256=${sha256} bytes=${bytes}`);
    return info.lastInsertRowid;
  } catch (err) {
    // UNIQUE(order_id, sha256, kind): mesma foto já registrada — anti-duplicação.
    if (String(err.message).includes('UNIQUE')) return null;
    throw err;
  }
}

function listPhotos(db, orderId, kind = null) {
  if (kind) {
    return db.prepare('SELECT * FROM order_photos WHERE order_id = ? AND kind = ? ORDER BY created_at')
      .all(orderId, kind);
  }
  return db.prepare('SELECT * FROM order_photos WHERE order_id = ? ORDER BY created_at').all(orderId);
}

function listOrders(db, limit = 50) {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
}

function listEvents(db, orderId) {
  return db.prepare('SELECT * FROM events WHERE order_id = ? ORDER BY created_at').all(orderId);
}

// --- FC Core v2.1.0 — metadados do sistema (chave/valor) ---

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM system_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value), nowIso());
}

// --- FC Core v2.1.0 — arquivos da pasta muse-inbox já processados ---

function getProcessedInboxFile(db, filename) {
  return db.prepare('SELECT * FROM processed_inbox_files WHERE filename = ?').get(filename) || null;
}

function findProcessedInboxBySha(db, sha256) {
  return db.prepare('SELECT * FROM processed_inbox_files WHERE sha256 = ? ORDER BY created_at LIMIT 1').get(sha256) || null;
}

function recordProcessedInboxFile(db, { filename, sha256 = null, orderId = null, status, reason = null }) {
  db.prepare(
    `INSERT INTO processed_inbox_files (filename, sha256, order_id, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(filename) DO UPDATE SET sha256 = excluded.sha256, order_id = excluded.order_id,
       status = excluded.status, reason = excluded.reason, created_at = excluded.created_at`
  ).run(filename, sha256, orderId, status, reason, nowIso());
}

module.exports = {
  STATES,
  STATE_ORDER,
  initDb,
  nowIso,
  logEvent,
  transition,
  createOrder,
  createOrderWithId,
  getOrder,
  findOpenOrderByPhone,
  updateOrder,
  addPhoto,
  listPhotos,
  listOrders,
  listEvents,
  getMeta,
  setMeta,
  getProcessedInboxFile,
  findProcessedInboxBySha,
  recordProcessedInboxFile,
};
