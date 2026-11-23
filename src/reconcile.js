// FC Core v2.1.0 — reconciliação de envios históricos (anteriores à v2.0.0).
//
// O registro de envios da v2.0.0 começou vazio: os envios feitos antes dele
// não estão protegidos contra duplicação. Esta rotina registra os envios
// históricos CONFIRMADOS no ledger, com base em evidência verificável
// (id da mensagem no WhatsApp) e no hash da imagem registrada no pedido.
//
// Regras duras:
// - NUNCA reenvia arquivos e NUNCA muda o estado do pedido: a reconciliação
//   só registra o passado. Um pedido AGUARDANDO_APROVACAO continua exatamente
//   onde estava — não se usa mark-preview-sent para "refazer" o fluxo dele.
// - Sem evidência suficiente (sem whatsappMessageId, hash não registrado no
//   pedido, telefone divergente, pedido inexistente), a entrada fica como
//   'review' (só revisão manual) e NÃO entra no ledger como confirmada.
// - Chave já registrada no ledger (confirmada ou incerta) vira 'skipped' —
//   nunca duplica o registro.
const dbMod = require('./db');
const ledger = require('./sendLedger');
const { log } = require('./logger');

const SHA256_RE = /^[0-9a-f]{64}$/i;

function reconcileHistoricalSends(db, entries) {
  if (!Array.isArray(entries)) throw new Error('entries deve ser um array');
  const result = { confirmed: [], review: [], skipped: [] };

  for (const entry of entries) {
    const { orderId, phone, action, imageKind, sha256, imageBytes, whatsappMessageId } = entry || {};
    const now = dbMod.nowIso();
    const base = { orderId: orderId || null, phone: phone || null, action: action || null, imageKind: imageKind || null, sha256: sha256 || null };

    const review = (reason) => {
      db.prepare(
        `INSERT INTO reconciliation_entries (order_id, phone, action, image_kind, sha256,
           whatsapp_message_id, status, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'review', ?, ?)`
      ).run(orderId || null, phone || null, action || null, imageKind || null, sha256 || null,
        whatsappMessageId || null, reason, now);
      result.review.push({ ...base, reason });
      log('warn', 'envio histórico sem evidência suficiente — só revisão', { ...base, reason });
    };

    if (!orderId || !phone || !['preview', 'final'].includes(action) || !imageKind || !SHA256_RE.test(String(sha256 || ''))) {
      review('dados_incompletos');
      continue;
    }
    const order = dbMod.getOrder(db, orderId);
    if (!order) {
      review('pedido_nao_encontrado');
      continue;
    }
    if (order.phone !== phone) {
      review('phone_nao_confere');
      continue;
    }
    const key = ledger.dedupKey(orderId, action, imageKind, sha256);
    const existing = ledger.getLedgerByKey(db, key);
    if (existing) {
      db.prepare(
        `INSERT INTO reconciliation_entries (order_id, phone, action, image_kind, sha256,
           whatsapp_message_id, status, reason, ledger_dedup_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)`
      ).run(orderId, phone, action, imageKind, sha256, whatsappMessageId || null,
        `ja_registrado (${existing.status})`, key, now);
      result.skipped.push({ ...base, reason: `ja_registrado (${existing.status})` });
      continue;
    }
    if (!whatsappMessageId || typeof whatsappMessageId !== 'string' || !whatsappMessageId.trim()) {
      review('sem_evidencia_whatsapp');
      continue;
    }
    // O hash precisa pertencer a uma foto registrada do pedido — senão não dá
    // para afirmar que aquele envio foi desta imagem.
    const photos = dbMod.listPhotos(db, orderId);
    const photo = photos.find((p) => p.sha256.toLowerCase() === String(sha256).toLowerCase());
    if (!photo) {
      review('hash_nao_registrado_no_pedido');
      continue;
    }
    // Confirma o envio histórico no ledger — sem tocar no estado do pedido.
    db.prepare(
      `INSERT INTO send_ledger (dedup_key, order_id, phone, action, image_kind, image_path,
         image_sha256, image_bytes, status, executor_id, evidence, created_at, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'reconciliacao-historica', ?, ?, ?, ?)`
    ).run(key, orderId, phone, action, imageKind, photo.path, sha256,
      imageBytes || photo.bytes, whatsappMessageId.trim(), now, now, now);
    db.prepare(
      `INSERT INTO reconciliation_entries (order_id, phone, action, image_kind, sha256,
         whatsapp_message_id, status, reason, ledger_dedup_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`
    ).run(orderId, phone, action, imageKind, sha256, whatsappMessageId.trim(),
      'envio historico confirmado com evidencia', key, now);
    dbMod.logEvent(db, orderId, 'envio_historico_reconciliado',
      `${action} sha256=${sha256} msg=${whatsappMessageId.trim()}`);
    result.confirmed.push({ ...base, whatsappMessageId: whatsappMessageId.trim() });
    log('info', 'envio histórico reconciliado no ledger', { ...base, whatsappMessageId: whatsappMessageId.trim() });
  }

  return {
    ok: true,
    counts: {
      confirmed: result.confirmed.length,
      review: result.review.length,
      skipped: result.skipped.length,
    },
    ...result,
  };
}

function reconciliationReport(db, limit = 100) {
  const counts = { confirmed: 0, review: 0, skipped: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM reconciliation_entries GROUP BY status').all()) {
    counts[row.status] = row.n;
  }
  const entries = db.prepare(
    'SELECT * FROM reconciliation_entries ORDER BY created_at DESC LIMIT ?'
  ).all(Math.min(limit, 500));
  return { ok: true, counts, entries };
}

module.exports = { reconcileHistoricalSends, reconciliationReport };
