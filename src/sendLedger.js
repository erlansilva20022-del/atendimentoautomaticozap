// FC Core v2.0.0 — registro de envios (anti-duplicação) e lease de executor único.
// FC Core v2.1.1 — reserva atômica de envio: a extensão reserva o envio ANTES de
// clicar no WhatsApp (POST /api/sends/reserve) e só confirma com o reservationId
// + whatsappMessageId dentro do TTL e com o lease ainda válido. Sem reserva não
// há confirmação no fluxo automático — mark-preview-sent/mark-final-sent não
// registram mais um envio confirmado "do nada".
// FC Core v2.1.2 — envio incerto registrado no Core (POST /api/sends/uncertain):
// quando o clique no WhatsApp produz um resultado desconhecido, a extensão
// registra o 'uncertain' IMEDIATAMENTE no Core — antes só a extensão travava
// o reenvio localmente, e uma reserva pendente expirada podia ser renovada.
// A reserva incerta é invalidada no Core: nenhum confirm nem renew com aquele
// reservationId passa mais (ver markReservationUncertain).
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
// FC Core v2.1.1 — TTL padrão da reserva de envio (10 min): tempo que a extensão
// tem entre reservar e confirmar, antes da reserva expirar.
const RESERVATION_TTL_MS = (config.reservationTtlSeconds || 600) * 1000;

function dedupKey(orderId, action, imageKind, imageSha256) {
  return `${orderId}|${action}|${imageKind}|${imageSha256}`;
}

function getLedgerByKey(db, key) {
  return db.prepare('SELECT * FROM send_ledger WHERE dedup_key = ?').get(key) || null;
}

function getReservationById(db, reservationId) {
  if (!reservationId) return null;
  return db.prepare('SELECT * FROM send_ledger WHERE reservation_id = ?').get(reservationId) || null;
}

// FC Core v2.1.1 — reserva atômica de envio.
//
// A extensão chama ANTES de clicar no WhatsApp: o Core cria (ou renova) um
// registro 'pending' com reservation_id + expiração, de forma atômica, SÓ se:
//   - o executor detém um lease válido daquela conversa;
//   - não existe envio confirmado/incerto/em andamento (reserva viva) para a chave;
//   - o sha256 pertence a uma foto registrada do pedido, com o tipo certo
//     (para 'final', o sha256 é o hash da versão do conjunto de fotos finais).
// Retorna { ok: true, reservationId, dedupKey, expiresAt, record } ou
// { ok: false, error: 'no_lease'|'duplicate'|'uncertain'|'in_progress'|... }.
// Uma reserva expirada pode ser renovada (o registro é atualizado no lugar,
// com novo reservation_id) — o envio nunca aconteceu, então não há nada
// incerto para revisar; a confirmação de uma reserva expirada é que é incerta.
function reserveSend(db, { orderId, phone, action, imageKind, imageSha256, executorId, ttlMs = RESERVATION_TTL_MS }) {
  if (!orderId || !phone || !action || !imageKind || !imageSha256) {
    return { ok: false, error: 'dados_incompletos' };
  }
  if (!executorId) return { ok: false, error: 'executor_obrigatorio' };
  if (!['preview', 'final'].includes(action)) return { ok: false, error: 'acao_invalida' };
  const order = dbMod.getOrder(db, orderId);
  if (!order) return { ok: false, error: 'pedido_nao_encontrado' };
  if (order.phone !== phone) return { ok: false, error: 'phone_nao_confere' };
  // O executor precisa deter um lease válido da conversa AGORA.
  const lease = getLease(db, phone);
  if (!lease || lease.executor_id !== executorId) return { ok: false, error: 'no_lease' };
  // O hash precisa pertencer a uma foto registrada do pedido, com o tipo certo.
  let imagePath;
  let imageBytes;
  if (action === 'final') {
    const finals = dbMod.listPhotos(db, orderId, 'final');
    if (finals.length === 0 || versionHashForPhotos(finals) !== imageSha256) {
      return { ok: false, error: 'hash_nao_registrado_no_pedido' };
    }
    imagePath = finals[0].path;
    imageBytes = finals.reduce((s, f) => s + f.bytes, 0);
  } else {
    const photo = dbMod.listPhotos(db, orderId, imageKind)
      .find((p) => p.sha256.toLowerCase() === String(imageSha256).toLowerCase());
    if (!photo) return { ok: false, error: 'hash_nao_registrado_no_pedido' };
    imagePath = photo.path;
    imageBytes = photo.bytes;
  }
  const key = dedupKey(orderId, action, imageKind, imageSha256);
  const now = dbMod.nowIso();
  const reservationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  // Atômico: a checagem e a criação/renovação acontecem numa só transação —
  // duas extensões não reservam a mesma chave ao mesmo tempo.
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getLedgerByKey(db, key);
    if (existing) {
      if (existing.status === 'confirmed') {
        db.exec('COMMIT');
        return { ok: false, error: 'duplicate', existing };
      }
      if (existing.status === 'uncertain') {
        db.exec('COMMIT');
        return { ok: false, error: 'uncertain', existing };
      }
      if (existing.status === 'pending') {
        const live = existing.expires_at
          ? new Date(existing.expires_at).getTime() > Date.now()
          : true; // 'pending' sem reserva (fluxo interno/admin) = envio em andamento
        if (live) {
          db.exec('COMMIT');
          return { ok: false, error: 'in_progress', existing };
        }
        // Reserva expirada: renova no lugar (mesma chave, novo reservation_id).
        db.prepare(
          `UPDATE send_ledger SET reservation_id = ?, reserved_at = ?, expires_at = ?,
             executor_id = ?, updated_at = ? WHERE dedup_key = ?`
        ).run(reservationId, now, expiresAt, executorId, now, key);
        dbMod.logEvent(db, orderId, 'reserva_renovada',
          `${action} key=${key} reserva=${reservationId} expira=${expiresAt}`);
        db.exec('COMMIT');
        return { ok: true, reservationId, dedupKey: key, expiresAt, record: getLedgerByKey(db, key) };
      }
      db.exec('COMMIT');
      return { ok: false, error: 'duplicate', existing };
    }
    db.prepare(
      `INSERT INTO send_ledger (dedup_key, order_id, phone, action, image_kind, image_path,
         image_sha256, image_bytes, status, executor_id, reservation_id, reserved_at,
         expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
    ).run(key, orderId, phone, action, imageKind, imagePath, imageSha256, imageBytes,
      executorId, reservationId, now, expiresAt, now, now);
    dbMod.logEvent(db, orderId, 'envio_reservado',
      `${action} key=${key} reserva=${reservationId} expira=${expiresAt}`);
    db.exec('COMMIT');
    return { ok: true, reservationId, dedupKey: key, expiresAt, record: getLedgerByKey(db, key) };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    // Corrida residual: outra transação registrou a chave primeiro.
    if (String(err.message).includes('UNIQUE')) {
      const raced = getLedgerByKey(db, key);
      return { ok: false, error: raced && raced.status === 'confirmed' ? 'duplicate' : 'in_progress', existing: raced };
    }
    throw err;
  }
}

// FC Core v2.1.1 — confirmação de envio COM reserva.
//
// mark-preview-sent / mark-final-sent só confirmam com um reservationId válido:
// reserva 'pending', do MESMO executor, com o lease ainda válido e dentro do TTL.
// Sem reserva → { error: 'no_reservation' } (409). Reserva expirada → o envio
// vira 'uncertain' e o pedido vai para REVISAO (o clique pode ter acontecido e
// a confirmação chegado tarde — só revisão manual resolve). Lease inválido → 409
// 'no_lease' e a reserva continua viva até expirar (a extensão pode renovar o
// lease e tentar confirmar de novo). Idempotente: confirmar de novo com a mesma
// evidência devolve o registro sem duplicar.
function confirmReservedSend(db, { reservationId, evidence, executorId = null }) {
  if (!evidence || typeof evidence !== 'string' || !evidence.trim()) {
    throw new Error('evidência whatsappMessageId é obrigatória para confirmar o envio');
  }
  const rec = getReservationById(db, reservationId);
  if (!rec) return { error: 'no_reservation' };
  if (rec.status === 'confirmed') {
    if (rec.evidence === evidence.trim()) return { record: rec, duplicate: true };
    return { error: 'already_confirmed' };
  }
  if (rec.status === 'uncertain') return { error: 'uncertain' };
  if (rec.status !== 'pending') return { error: 'no_reservation' };
  // Reserva expirada: o envio é incerto — nunca confirmar automaticamente.
  if (rec.expires_at && new Date(rec.expires_at).getTime() <= Date.now()) {
    markUncertain(db, rec.dedup_key, 'reserva_expirada');
    return { error: 'reservation_expired', needsReview: true };
  }
  // A confirmação precisa vir do executor que reservou.
  if (executorId && rec.executor_id && rec.executor_id !== executorId) {
    return { error: 'executor_mismatch' };
  }
  // O lease precisa continuar válido na hora de confirmar.
  const lease = getLease(db, rec.phone);
  if (!lease || lease.executor_id !== rec.executor_id) {
    return { error: 'no_lease' };
  }
  const now = dbMod.nowIso();
  db.prepare(
    "UPDATE send_ledger SET status = 'confirmed', evidence = ?, confirmed_at = ?, updated_at = ? WHERE dedup_key = ?"
  ).run(evidence.trim(), now, now, rec.dedup_key);
  dbMod.logEvent(db, rec.order_id, 'envio_confirmado',
    `${rec.action} key=${rec.dedup_key} evidencia=${evidence.trim()} reserva=${reservationId}`);
  return { record: getLedgerByKey(db, rec.dedup_key), duplicate: false };
}

// FC Core v2.1.2 — registra um envio INCERTO no Core, com a reserva já feita.
//
// A extensão chama (POST /api/sends/uncertain) quando o clique no WhatsApp
// produziu um resultado desconhecido (timeout, erro, resposta ambígua).
// Retorna { record, duplicate } ou { error: 'no_reservation' |
// 'already_confirmed' | 'executor_mismatch' }.
//   - Reserva inexistente → 'no_reservation' (a rota vira 404).
//   - Já confirmado → 'already_confirmed' (não dá para "desconfirmar" um envio).
//   - Executor diferente do que reservou → 'executor_mismatch'.
//   - Já incerto → devolve o registro existente, idempotente (duplicate: true).
//   - Caso contrário: o ledger vira 'uncertain', o pedido vai para REVISAO e a
//     reserva é INVALIDADA — status 'uncertain' + expires_at no passado. O
//     reservationId continua no registro (auditoria + idempotência desta rota),
//     mas está morto: confirmReservedSend recusa qualquer registro 'uncertain'
//     e reserveSend recusa renovar uma chave incerta. Nenhum confirm nem renew
//     com esse reservationId passa mais — a proteção agora existe no Core, não
//     só na trava local da extensão.
function markReservationUncertain(db, { reservationId, executorId = null, reason = null }) {
  const rec = getReservationById(db, reservationId);
  if (!rec) return { error: 'no_reservation' };
  if (rec.status === 'confirmed') return { error: 'already_confirmed' };
  if (executorId && rec.executor_id && rec.executor_id !== executorId) {
    return { error: 'executor_mismatch' };
  }
  if (rec.status === 'uncertain') return { record: rec, duplicate: true };
  if (rec.status !== 'pending') return { error: 'no_reservation' };
  const detail = reason ? String(reason).slice(0, 200) : 'clique_sem_confirmacao';
  markUncertain(db, rec.dedup_key, detail);
  // Invalidação explícita da reserva: expiração imediata, além do status.
  db.prepare("UPDATE send_ledger SET expires_at = ? WHERE dedup_key = ?")
    .run(dbMod.nowIso(), rec.dedup_key);
  dbMod.logEvent(db, rec.order_id, 'envio_incerto_reserva',
    `${rec.action} key=${rec.dedup_key} reserva=${reservationId} motivo=${detail}`);
  return { record: getLedgerByKey(db, rec.dedup_key), duplicate: false };
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
// - 'in_progress': outro envio desta chave está em andamento.
// - 'uncertain': envio anterior incerto — pedido em REVISAO, sem reenvio.
// - 'lease': outra instância detém a conversa.
// - 'no_lease': o executor não detém um lease válido para esta conversa.
//   FC Core v2.1.0 (brecha b): envio automático (com executorId) EXIGE um
//   lease válido detido por aquele executor — não basta "não haver outro lease".
//   Envio manual do dono (sem executorId) continua sem passar pelo lease.
// - Retomar um envio 'pending' (brecha c): só o MESMO executor, com um lease
//   válido recém-adquirido e revalidando telefone/arquivo/hash. Qualquer outra
//   tentativa é recusada — nunca retomar no escuro.
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
      // Retomada: só o mesmo executor, com lease válido, revalidando tudo.
      const lease = executorId ? getLease(db, phone) : null;
      const sameExecutor = executorId && existing.executor_id === executorId;
      const leaseOk = lease && lease.executor_id === executorId;
      const revalidated =
        phone === existing.phone &&
        imageSha256 === existing.image_sha256 &&
        imagePath === existing.image_path;
      if (sameExecutor && leaseOk && revalidated) {
        return { allowed: true, ownPending: true, resumed: true, key, record: existing };
      }
      return { allowed: false, reason: 'in_progress', key, existing };
    }
  }
  // Lease obrigatório para envio automático (com executorId).
  if (executorId) {
    const lease = getLease(db, phone);
    if (!lease || lease.executor_id !== executorId) {
      return { allowed: false, reason: 'no_lease', key, lease: lease || null };
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
      const reason = !raced ? 'in_progress'
        : raced.status === 'confirmed' ? 'duplicate'
        : raced.status === 'uncertain' ? 'uncertain'
        : 'in_progress';
      return { allowed: false, reason, key, existing: raced };
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
// FC Core v2.1.0 (brecha a): a confirmação no fluxo automático EXIGE um
// whatsappMessageId — sem evidência, a confirmação é recusada. Idempotente:
// confirmar de novo com a mesma evidência não duplica nada nem registra o
// evento duas vezes.
function confirmSend(db, key, evidence) {
  if (!evidence || typeof evidence !== 'string' || !evidence.trim()) {
    throw new Error('evidência whatsappMessageId é obrigatória para confirmar o envio');
  }
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

// Confirmação manual do dono (override, SÓ via rota de admin): registra o envio
// sem whatsappMessageId, mas deixa registrado QUEM confirmou e POR QUÊ.
// Nunca é usada pelo fluxo automático — só por decisão explícita do dono,
// com o motivo registrado em evento e no ledger (evidence = 'override:<motivo>').
function confirmSendOverride(db, { orderId, phone, action, imageKind, imagePath, imageSha256, imageBytes, executorId = null, overriddenBy, reason }) {
  if (!overriddenBy || !reason) {
    throw new Error('override exige overriddenBy e reason');
  }
  const evidence = `override:${String(reason).slice(0, 200)}`;
  const key = dedupKey(orderId, action, imageKind, imageSha256);
  const existing = getLedgerByKey(db, key);
  const now = dbMod.nowIso();
  if (existing && existing.status === 'confirmed') {
    return { record: existing, duplicate: true };
  }
  if (existing) {
    db.prepare(
      "UPDATE send_ledger SET status = 'confirmed', evidence = ?, confirmed_at = ?, updated_at = ? WHERE dedup_key = ?"
    ).run(evidence, now, now, key);
  } else {
    db.prepare(
      `INSERT INTO send_ledger (dedup_key, order_id, phone, action, image_kind, image_path,
        image_sha256, image_bytes, status, executor_id, evidence, created_at, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`
    ).run(key, orderId, phone, action, imageKind, imagePath, imageSha256, imageBytes, executorId, evidence, now, now, now);
  }
  dbMod.logEvent(db, orderId, 'envio_confirmado_override',
    `${action} key=${key} por=${overriddenBy} motivo=${String(reason).slice(0, 200)}`);
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
  getReservationById,
  reserveSend,
  confirmReservedSend,
  markReservationUncertain,
  listLedger,
  guardSend,
  cancelPending,
  confirmSend,
  confirmSendOverride,
  markUncertain,
  getLease,
  listActiveLeases,
  acquireLease,
  releaseLease,
  versionHashForPhotos,
};
