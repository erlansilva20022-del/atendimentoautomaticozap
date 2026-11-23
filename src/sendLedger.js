// FC Core v2.0.0 — registro de envios (anti-duplicação) e lease de executor único.
//
// Regras duras:
// - Um envio é identificado por (pedido, ação, tipo de imagem, SHA-256 da imagem).
//   A mesma chave nunca envia duas vezes: a segunda tentativa é recusada e devolve
//   o registro existente.
// - Um envio só vira 'confirmed' com evidência verificável (a extensão confirma
//   explicitamente, com o id da mensagem do WhatsApp).
// - Resultado incerto (timeout, erro, resposta desconhecida) vira 'uncertain' e o
//   pedido vai para REVISAO — NUNCA há reenvio automático.
// - Só um executor detém o envio de uma conversa por vez (lease com expiração).
//   Envios manuais do dono (sem executorId) passam pelo registro, mas não pelo lease.
const crypto = require('crypto');
const dbMod = require('./db');
const { config } = require('./config');

const LEASE_TTL_MS = (config.leaseTtlSeconds || 120) * 1000;

function dedupKey(orderId, action, imageKind, imageSha256) {
  return `${orderId}|${action}|${imageKind}|${imageSha256}`;
}

function getLedgerByKey(db, key) {
  return db.prepare('SELECT * FROM send_ledger WHERE dedup_key = ?').get(key) || null;
}

function listLedger(db, orderId = null, limit = 100) {
  if (orderId) {
    return db.prepare('SELECT * FROM send_ledger WHERE order_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(orderId, limit);
  }
  return db.prepare('SELECT * FROM send_ledger ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Guarda de envio: verifica duplicata e lease ANTES de qualquer envio.
// Retorna { allowed, reason?, record?, existing?, lease? }.
// - 'duplicate': já confirmado com essa chave — não enviar de novo.
// - 'in_progress': outro executor já está enviando essa chave.
// - 'uncertain': envio anterior incerto — pedido em REVISAO, sem reenvio.
// - 'lease': outra instância detém a conversa.
function guardSend(db, { orderId, phone, action, imageKind, imageSha256, imagePath, imageBytes, executorId = null }) {
  const key = dedupKey(orderId, action, imageKind, imageSha256);
  const existing = getLedgerByKey(db, key);
  if (existing) {
    if (existing.status === 'confirmed') {
      return { allowed: false, reason: 'duplicate', key, existing };
    }
    if (existing.status === 'uncertain') {
      return { allowed: false, reason: 'uncertain', key, existing };
    }
    if (existing.status === 'pending') {
      // O mesmo chamador retomando o próprio envio em andamento: pode prosseguir.
      // Vale para o mesmo executorId ou para dois chamados sem executor (dono).
      if ((executorId && existing.executor_id === executorId) || (!executorId && !existing.executor_id)) {
        return { allowed: true, ownPending: true, key, record: existing };
      }
      return { allowed: false, reason: 'in_progress', key, existing };
    }
  }
  // Lease: só vale quando o chamador se identifica como executor (extensão).
  // Envio manual do dono (sem executorId) não passa pelo lease.
  if (executorId) {
    const lease = getLease(db, phone);
    if (lease && lease.executor_id !== executorId) {
      return { allowed: false, reason: 'lease', key, lease };
    }
  }
  const now = dbMod.nowIso();
  try {
    db.prepare(
      `INSERT INTO send_ledger (dedup_key, order_id, phone, action, image_kind, image_path,
        image_sha256, image_bytes, status, executor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(key, orderId, phone, action, imageKind, imagePath, imageSha256, imageBytes, executorId, now, now);
  } catch (err) {
    // Corrida: outro processo registrou a mesma chave entre a leitura e a inserção.
    if (String(err.message).includes('UNIQUE')) {
      const raced = getLedgerByKey(db, key);
      return { allowed: false, reason: raced && raced.status === 'confirmed' ? 'duplicate' : 'in_progress', key, existing: raced };
    }
    throw err;
  }
  return { allowed: true, key, record: getLedgerByKey(db, key) };
}

// Cancela um registro 'pending' que nunca chegou a tentar o envio
// (ex.: a trava recusou depois do registro). Não apaga confirmados nem incertos.
function cancelPending(db, key) {
  const rec = getLedgerByKey(db, key);
  if (!rec || rec.status !== 'pending') return false;
  db.prepare("DELETE FROM send_ledger WHERE dedup_key = ? AND status = 'pending'").run(key);
  return true;
}

// Confirma um envio com evidência verificável (ex.: id da mensagem no WhatsApp).
// Idempotente: confirmar de novo com a mesma evidência não duplica nada nem
// registra o evento duas vezes.
function confirmSend(db, key, evidence) {
  const rec = getLedgerByKey(db, key);
  if (!rec) return null;
  if (rec.status === 'confirmed' && rec.evidence === evidence) return rec;
  const now = dbMod.nowIso();
  db.prepare(
    "UPDATE send_ledger SET status = 'confirmed', evidence = ?, confirmed_at = ?, updated_at = ? WHERE dedup_key = ?"
  ).run(evidence || null, now, now, key);
  dbMod.logEvent(db, rec.order_id, 'envio_confirmado', `${rec.action} key=${key} evidencia=${evidence || '?'}`);
  return getLedgerByKey(db, key);
}

// Registra um envio confirmado que chegou por confirmação explícita da extensão,
// mesmo sem um registro 'pending' anterior (ex.: a extensão enviou e só depois
// confirmou). Cria o registro já como 'confirmed' a partir da foto registrada.
function confirmSendForPhoto(db, { orderId, phone, action, imageKind, imagePath, imageSha256, imageBytes, executorId = null, evidence }) {
  const key = dedupKey(orderId, action, imageKind, imageSha256);
  const existing = getLedgerByKey(db, key);
  const now = dbMod.nowIso();
  if (existing) {
    if (existing.status === 'confirmed') return { record: existing, duplicate: true };
    db.prepare(
      "UPDATE send_ledger SET status = 'confirmed', evidence = ?, confirmed_at = ?, updated_at = ? WHERE dedup_key = ?"
    ).run(evidence || null, now, now, key);
    dbMod.logEvent(db, orderId, 'envio_confirmado', `${action} key=${key} evidencia=${evidence || '?'}`);
    return { record: getLedgerByKey(db, key), duplicate: false };
  }
  db.prepare(
    `INSERT INTO send_ledger (dedup_key, order_id, phone, action, image_kind, image_path,
      image_sha256, image_bytes, status, executor_id, evidence, created_at, updated_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`
  ).run(key, orderId, phone, action, imageKind, imagePath, imageSha256, imageBytes, executorId, evidence || null, now, now, now);
  dbMod.logEvent(db, orderId, 'envio_confirmado', `${action} key=${key} evidencia=${evidence || '?'}`);
  return { record: getLedgerByKey(db, key), duplicate: false };
}

// Marca um envio como incerto e joga o pedido para REVISAO. Sem reenvio automático:
// só um humano (ou uma nova decisão explícita) tira o pedido de REVISAO.
function markUncertain(db, key, reason) {
  const rec = getLedgerByKey(db, key);
  if (!rec) return null;
  const now = dbMod.nowIso();
  db.prepare("UPDATE send_ledger SET status = 'uncertain', updated_at = ? WHERE dedup_key = ?").run(now, key);
  dbMod.logEvent(db, rec.order_id, 'envio_incerto', `${rec.action} key=${key} motivo=${reason || '?'}`);
  dbMod.transition(db, rec.order_id, 'REVISAO');
  return getLedgerByKey(db, key);
}

// --- Lease de executor único ---

function getLease(db, phone) {
  const lease = db.prepare('SELECT * FROM send_leases WHERE phone = ?').get(phone);
  if (!lease) return null;
  // Lease vencido não vale: expira sozinho.
  if (new Date(lease.expires_at).getTime() <= Date.now()) return null;
  return lease;
}

function listActiveLeases(db) {
  const now = new Date().toISOString();
  return db.prepare('SELECT * FROM send_leases WHERE expires_at > ? ORDER BY acquired_at').all(now);
}

// Adquire (ou renova, se for o mesmo executor) o lease de uma conversa.
// Retorna { acquired: true, lease } ou { acquired: false, lease } (detido por outro).
function acquireLease(db, phone, executorId, ttlMs = LEASE_TTL_MS) {
  if (!phone || !executorId) throw new Error('phone e executorId são obrigatórios');
  const existing = getLease(db, phone);
  if (existing && existing.executor_id !== executorId) {
    return { acquired: false, lease: existing };
  }
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  db.prepare(
    `INSERT INTO send_leases (phone, executor_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET executor_id = excluded.executor_id,
       acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`
  ).run(phone, executorId, now.toISOString(), expires.toISOString());
  return { acquired: true, lease: getLease(db, phone) };
}

// Libera o lease — só quem o detém pode liberar.
function releaseLease(db, phone, executorId) {
  const existing = getLease(db, phone);
  if (!existing) return { released: false, reason: 'sem lease ativo' };
  if (existing.executor_id !== executorId) return { released: false, reason: 'lease de outro executor' };
  db.prepare('DELETE FROM send_leases WHERE phone = ?').run(phone);
  return { released: true };
}

function versionHashForPhotos(photos) {
  // Versão de um conjunto de fotos: hash dos SHA-256 ordenados (determinístico).
  const joined = photos.map((p) => p.sha256).sort().join('|');
  return crypto.createHash('sha256').update(joined).digest('hex');
}

module.exports = {
  dedupKey,
  getLedgerByKey,
  listLedger,
  guardSend,
  cancelPending,
  confirmSend,
  confirmSendForPhoto,
  markUncertain,
  getLease,
  listActiveLeases,
  acquireLease,
  releaseLease,
  versionHashForPhotos,
};
