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
  `);
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

module.exports = {
  STATES,
  STATE_ORDER,
  initDb,
  nowIso,
  logEvent,
  transition,
  createOrder,
  getOrder,
  findOpenOrderByPhone,
  updateOrder,
  addPhoto,
  listPhotos,
  listOrders,
  listEvents,
};
