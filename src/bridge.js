// Ponte HTTP para o handoff do Muse (FC Bridge).
// - POST /api/muse/orders: cria/recupera pedido por telefone + hora observada + texto
//   (sem messageId nativo — usa fingerprint telefone+hora+texto; aceita orderId para importar UUID).
// - POST /api/muse/order-result: recebe os bytes da imagem gerada pelo Muse
//   (dataUrl ou base64 puro), confere o SHA-256 e a assinatura do arquivo, salva o original
//   e cria/registra a prévia com marca. Protegido por requireBridge quando BRIDGE_TOKEN existe.
// - GET /api/orders/:id/preview-file: baixa a prévia com marca (protegido, usado pela extensão).
// - POST /api/orders/:id/mark-preview-sent: registra o envio confirmado pela extensão (protegido).
// - POST /api/orders/:id/mark-final-sent: registra o envio do HD confirmado (protegido).
// - GET /api/orders/:id: status, fotos, eventos e registro de envios.
// - POST /api/leases/acquire|release, GET /api/leases/:phone: lease de executor único.
// - GET /api/ledger: registro de envios (anti-duplicação).
// - POST /api/admin/import-bridge3007, GET /api/admin/import-conflicts: importação do
//   histórico da FC Bridge 3007 (só admin).
// - POST /api/orders/:id/confirm-payment e /send-preview: só com ADMIN_TOKEN.
// FC Core v2.0.0: todos os envios passam pelo registro de envios (sendLedger) —
// duplicata, envio em andamento, envio incerto anterior ou lease de outro executor
// recusam o envio ANTES de mandar. Envio incerto joga o pedido para REVISAO.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const ledger = require('./sendLedger');
const migrate = require('./migrate3007');
const { sha256Buffer } = require('./hash');
const { makePreview } = require('./watermark');
const { OrderService, detectLanguage } = require('./orders');
const { config, originalsDir } = require('./config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Middleware da ponte (contribuição local do GPT, incorporada na v1.2.0):
// se BRIDGE_TOKEN não está configurado, libera; se está, exige o header x-bridge-token.
// Protege as rotas que a extensão usa para buscar a prévia e registrar o envio.
function requireBridge(req, res, next) {
  if (!config.bridgeToken) return next();
  if (req.headers['x-bridge-token'] !== config.bridgeToken) {
    return res.status(401).json({ ok: false, error: 'x-bridge-token inválido' });
  }
  next();
}

// Valida a assinatura real do arquivo (magic bytes) — não confia só no base64 nem na extensão.
// Retorna { ext, mime } ou null quando o conteúdo não é JPEG, PNG ou WebP.
function detectImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

function fingerprint(phone, observedClock, text) {
  return crypto.createHash('sha256').update(`${phone}|${observedClock}|${text}`).digest('hex');
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!config.adminToken || token !== config.adminToken) {
    return res.status(401).json({ ok: false, error: 'admin token inválido' });
  }
  next();
}

function createBridgeRouter(db, whatsapp) {
  const router = express.Router();
  const service = new OrderService(db);

  // Cria ou recupera um pedido a partir de uma mensagem observada no WhatsApp.
  // Aceita orderId opcional: quando informado um UUID válido e o pedido já existe,
  // ele é vinculado (não cria outro); quando não existe, o pedido é criado COM esse UUID
  // — é assim que o pedido de teste existente (ex.: 92402128-...) é importado para o banco novo.
  router.post('/api/muse/orders', (req, res) => {
    const { phone, observedClock, text, orderId } = req.body || {};
    if (!phone || !observedClock || !text) {
      return res.status(400).json({ ok: false, error: 'phone, observedClock e text são obrigatórios' });
    }
    if (orderId && !UUID_RE.test(orderId)) {
      return res.status(400).json({ ok: false, error: 'orderId inválido (esperado UUID)' });
    }
    if (orderId) {
      const linked = dbMod.getOrder(db, orderId);
      if (linked) return res.json({ ok: true, orderId, status: linked.status, duplicate: true, linked: true });
    }
    const fp = fingerprint(phone, observedClock, text);
    const existing = db.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone);
    if (existing) {
      const ev = dbMod.listEvents(db, existing.id).find((e) => e.type === 'pedido_observado' && e.detail === fp);
      if (ev) return res.json({ ok: true, orderId: existing.id, status: existing.status, duplicate: true });
    }
    const language = detectLanguage(phone);
    const order = orderId
      ? dbMod.createOrderWithId(db, { id: orderId, phone, language })
      : dbMod.createOrder(db, { phone, language });
    if (orderId) dbMod.logEvent(db, order.id, 'pedido_importado', `uuid existente vinculado: ${orderId}`);
    dbMod.logEvent(db, order.id, 'pedido_observado', fp);
    dbMod.logEvent(db, order.id, 'texto_pedido', String(text).slice(0, 500));
    dbMod.transition(db, order.id, 'CONTATO_VALIDADO');
    return res.json({ ok: true, orderId: order.id, status: 'CONTATO_VALIDADO', duplicate: false });
  });

  // Recebe o resultado da geração do Muse: bytes da imagem + hash para validação.
  // Aceita base64 puro (preferido pela ponte) ou dataUrl. Valida SHA-256 e a assinatura
  // real do arquivo (JPEG/PNG/WebP). Salva o original, GERA a prévia com marca e registra
  // as duas fotos (kind 'final' e kind 'preview') — sem a prévia registrada, o envio falharia.
  // Se o pedido ainda não existe neste banco, ele é criado com o UUID informado (importação).
  router.post('/api/muse/order-result', requireBridge, async (req, res) => {
    const { orderId, phone, source, sourceSha256, image } = req.body || {};
    if (source !== 'MUSE') return res.status(400).json({ ok: false, error: 'source deve ser "MUSE"' });
    if (!orderId || !UUID_RE.test(orderId) || !sourceSha256 || !image) {
      return res.status(400).json({ ok: false, error: 'orderId (UUID), sourceSha256 e image são obrigatórios' });
    }
    let order = dbMod.getOrder(db, orderId);
    if (!order) {
      if (!phone) return res.status(404).json({ ok: false, error: 'pedido não encontrado — informe phone para importar o UUID' });
      order = dbMod.createOrderWithId(db, { id: orderId, phone, language: detectLanguage(phone) });
      dbMod.logEvent(db, orderId, 'pedido_importado', `uuid existente vinculado via order-result: ${orderId}`);
      // Sem esta transição o pedido ficaria em NOVO e os avanços seguintes seriam rejeitados
      // (a máquina de estados não permite pular CONTATO_VALIDADO).
      dbMod.transition(db, orderId, 'CONTATO_VALIDADO');
    }
    if (phone && order.phone !== phone) {
      return res.status(400).json({ ok: false, error: 'phone não confere com o pedido' });
    }
    const raw = String(image);
    const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
    let bytes;
    try {
      bytes = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: 'image inválida (esperado dataUrl ou base64)' });
    }
    if (bytes.length === 0) return res.status(400).json({ ok: false, error: 'image vazia' });
    const hash = sha256Buffer(bytes);
    if (hash !== sourceSha256) {
      return res.status(400).json({ ok: false, error: 'sha256 não confere com os bytes recebidos', receivedSha256: hash });
    }
    const type = detectImageType(bytes);
    if (!type) {
      return res.status(400).json({ ok: false, error: 'tipo de imagem não reconhecido (esperado JPEG, PNG ou WebP)' });
    }
    // Anti-duplicação: mesmo pedido + mesmo hash já registrado.
    const dup = dbMod.listPhotos(db, orderId, 'final').find((p) => p.sha256 === hash);
    if (dup) return res.json({ ok: true, orderId, status: order.status, sha256: hash, duplicate: true });
    fs.mkdirSync(originalsDir, { recursive: true });
    const filePath = path.join(originalsDir, `${orderId}_original.${type.ext}`);
    fs.writeFileSync(filePath, bytes);
    dbMod.addPhoto(db, orderId, { kind: 'final', path: filePath, sha256: hash, bytes: bytes.length });
    dbMod.logEvent(db, orderId, 'imagem_muse_recebida', `sha256=${hash} bytes=${bytes.length} tipo=${type.mime}`);
    // Cria a prévia com marca E registra kind 'preview' — o envio usa essa foto.
    const previewPath = await makePreview(filePath);
    const previewBytes = fs.readFileSync(previewPath);
    dbMod.addPhoto(db, orderId, {
      kind: 'preview',
      path: previewPath,
      sha256: sha256Buffer(previewBytes),
      bytes: previewBytes.length,
    });
    dbMod.logEvent(db, orderId, 'previa_criada', `${previewPath} bytes=${previewBytes.length}`);
    // Avança a máquina de estados sem pular etapas.
    const steps = ['ORIGINAL_BAIXADA', 'REFERENCIAS_VALIDAS', 'PREVIA_GERADA', 'PREVIA_BAIXADA'];
    for (const step of steps) {
      const now = dbMod.getOrder(db, orderId).status;
      if (now === step) continue;
      if (!dbMod.transition(db, orderId, step)) break;
    }
    const updated = dbMod.getOrder(db, orderId);
    return res.json({ ok: true, orderId, status: updated.status, sha256: hash, bytes: bytes.length, path: filePath, previewPath });
  });

  // Status completo do pedido.
  router.get('/api/orders/:id', (req, res) => {
    const status = service.getStatus(req.params.id);
    if (!status) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    return res.json({ ok: true, order: status });
  });

  // Baixa a prévia com marca do pedido (rota protegida, usada pela extensão).
  // Retorna o arquivo JPEG da prévia mais recente.
  router.get('/api/orders/:id/preview-file', requireBridge, (req, res) => {
    const order = dbMod.getOrder(db, req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    const previews = dbMod.listPhotos(db, req.params.id, 'preview');
    if (previews.length === 0) return res.status(404).json({ ok: false, error: 'prévia ainda não gerada' });
    const preview = previews[previews.length - 1];
    if (!fs.existsSync(preview.path)) return res.status(404).json({ ok: false, error: 'arquivo da prévia não encontrado' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}_previa.jpg"`);
    return res.sendFile(path.resolve(preview.path));
  });

  // Registra o envio da prévia confirmado pela extensão (rota protegida).
  // A extensão só chama depois de confirmar o balão de foto no WhatsApp, e
  // passa a evidência (id da mensagem). Confirma o registro de envio e avança
  // o pedido. Idempotente: confirmar de novo não duplica nada.
  router.post('/api/orders/:id/mark-preview-sent', requireBridge, (req, res) => {
    try {
      const order = dbMod.getOrder(db, req.params.id);
      if (!order) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
      const previews = dbMod.listPhotos(db, req.params.id, 'preview');
      if (previews.length === 0) return res.status(400).json({ ok: false, error: 'prévia ainda não gerada' });
      const preview = previews[previews.length - 1];
      const evidence = (req.body && (req.body.whatsappMessageId || req.body.evidence)) || null;
      const executorId = (req.body && req.body.executorId) || null;
      const { record, duplicate } = ledger.confirmSendForPhoto(db, {
        orderId: order.id, phone: order.phone, action: 'preview', imageKind: 'preview',
        imagePath: preview.path, imageSha256: preview.sha256, imageBytes: preview.bytes,
        executorId, evidence,
      });
      const updated = service.markPreviewSent(req.params.id);
      return res.json({ ok: true, order: updated, ledger: record, duplicate });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Registra o envio do HD confirmado pela extensão (rota protegida).
  // Só é válido após PAGAMENTO_CONFIRMADO; se o estado estiver errado, o envio
  // fica registrado no ledger com a evidência, mas a transição falha e o pedido
  // vai para revisão manual.
  router.post('/api/orders/:id/mark-final-sent', requireBridge, (req, res) => {
    const order = dbMod.getOrder(db, req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    const finals = dbMod.listPhotos(db, req.params.id, 'final');
    if (finals.length === 0) return res.status(400).json({ ok: false, error: 'arquivo final não encontrado' });
    const versionHash = ledger.versionHashForPhotos(finals);
    const evidence = (req.body && (req.body.whatsappMessageId || req.body.evidence)) || null;
    const executorId = (req.body && req.body.executorId) || null;
    const { record } = ledger.confirmSendForPhoto(db, {
      orderId: order.id, phone: order.phone, action: 'final', imageKind: 'final',
      imagePath: finals[0].path, imageSha256: versionHash,
      imageBytes: finals.reduce((s, f) => s + f.bytes, 0), executorId, evidence,
    });
    try {
      const updated = service.markFinalDelivered(req.params.id);
      return res.json({ ok: true, order: updated, ledger: record });
    } catch (err) {
      dbMod.logEvent(db, req.params.id, 'final_enviado_estado_invalido', err.message);
      return res.status(400).json({
        ok: false, error: err.message, ledger: record,
        note: 'envio registrado no ledger com evidência, mas a transição de estado falhou — revisar manualmente',
      });
    }
  });

  // Lease de executor único: só uma instância da extensão detém o envio de uma
  // conversa por vez. Protegido pelo token da ponte (a extensão o possui).
  router.post('/api/leases/acquire', requireBridge, (req, res) => {
    const { phone, executorId, ttlSeconds } = req.body || {};
    if (!phone || !executorId) {
      return res.status(400).json({ ok: false, error: 'phone e executorId são obrigatórios' });
    }
    try {
      const result = ledger.acquireLease(db, phone, executorId, ttlSeconds ? ttlSeconds * 1000 : undefined);
      if (!result.acquired) {
        return res.status(409).json({ ok: false, error: 'lease detido por outro executor', lease: result.lease });
      }
      return res.json({ ok: true, lease: result.lease });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/leases/release', requireBridge, (req, res) => {
    const { phone, executorId } = req.body || {};
    if (!phone || !executorId) {
      return res.status(400).json({ ok: false, error: 'phone e executorId são obrigatórios' });
    }
    const result = ledger.releaseLease(db, phone, executorId);
    if (!result.released) return res.status(409).json({ ok: false, error: result.reason });
    return res.json({ ok: true });
  });

  router.get('/api/leases/:phone', (req, res) => {
    return res.json({ ok: true, lease: ledger.getLease(db, req.params.phone) });
  });

  // Registro de envios (somente leitura). ?orderId= filtra por pedido.
  router.get('/api/ledger', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    return res.json({ ok: true, ledger: ledger.listLedger(db, req.query.orderId || null, limit) });
  });

  // Importação do histórico da FC Bridge 3007 (só admin).
  // Recebe o JSON exportado do banco antigo; nunca sobrescreve progresso da 3008
  // nem cria segundo pedido para o mesmo UUID — conflitos vão para revisão manual.
  router.post('/api/admin/import-bridge3007', requireAdmin, (req, res) => {
    try {
      const summary = migrate.importBridge3007(db, req.body || {});
      return res.json({ ok: true, ...summary });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/admin/import-conflicts', requireAdmin, (req, res) => {
    return res.json({ ok: true, conflicts: migrate.listConflicts(db, 100) });
  });

  // Lista resumida de pedidos (dashboard).
  router.get('/api/orders', (req, res) => {
    const orders = dbMod.listOrders(db, 100).map((o) => ({
      ...o,
      photos: dbMod.listPhotos(db, o.id).length,
    }));
    return res.json({ ok: true, orders });
  });

  // Confirma pagamento (admin). Nunca confirmar por mensagem "paguei" do cliente.
  router.post('/api/orders/:id/confirm-payment', requireAdmin, (req, res) => {
    try {
      const order = service.confirmPayment(req.params.id, req.body || {});
      return res.json({ ok: true, order });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Envia a prévia com marca pelo WhatsApp (admin).
  // FC Core v2.0.0: a trava de envio (registro + lease) é verificada ANTES de
  // mandar. Duplicata confirmada, envio em andamento, envio incerto anterior ou
  // lease de outro executor devolvem 409 sem enviar. Erro/timeout no envio marca
  // o registro como incerto e joga o pedido para REVISAO — sem reenvio automático.
  router.post('/api/orders/:id/send-preview', requireAdmin, async (req, res) => {
    const order = dbMod.getOrder(db, req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    const previews = dbMod.listPhotos(db, req.params.id, 'preview');
    if (previews.length === 0) return res.status(400).json({ ok: false, error: 'prévia ainda não gerada' });
    const preview = previews[previews.length - 1];
    const executorId = (req.body && req.body.executorId) || null;
    const guard = ledger.guardSend(db, {
      orderId: order.id, phone: order.phone, action: 'preview', imageKind: 'preview',
      imageSha256: preview.sha256, imagePath: preview.path, imageBytes: preview.bytes, executorId,
    });
    if (!guard.allowed) {
      return res.status(409).json({ ok: false, error: `envio recusado (${guard.reason})`, reason: guard.reason, existing: guard.existing || null });
    }
    try {
      const sent = await whatsapp.sendPreview(req.params.id, { executorId });
      const evidence = (sent && sent.id && (sent.id._serialized || sent.id.id)) || 'admin-api';
      ledger.confirmSend(db, guard.key, evidence);
      try { service.markPreviewSent(req.params.id); } catch {}
      return res.json({ ok: true, order: dbMod.getOrder(db, req.params.id) });
    } catch (err) {
      if (String(err.message).includes('envio recusado')) {
        // A trava recusou depois do registro: cancela o 'pending', não é envio incerto.
        ledger.cancelPending(db, guard.key);
        return res.status(409).json({ ok: false, error: err.message });
      }
      const rec = ledger.getLedgerByKey(db, guard.key);
      if (rec && rec.status === 'pending') ledger.markUncertain(db, guard.key, err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Envia o HD original (admin) — só funciona após PAGAMENTO_CONFIRMADO.
  // Mesma trava de envio da prévia (registro + lease, sem reenvio automático).
  router.post('/api/orders/:id/send-final', requireAdmin, async (req, res) => {
    const order = dbMod.getOrder(db, req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    if (order.status !== 'PAGAMENTO_CONFIRMADO') {
      return res.status(400).json({ ok: false, error: 'HD original só pode ser enviado após PAGAMENTO_CONFIRMADO' });
    }
    const finals = dbMod.listPhotos(db, req.params.id, 'final');
    if (finals.length === 0) return res.status(400).json({ ok: false, error: 'arquivo final não encontrado' });
    const versionHash = ledger.versionHashForPhotos(finals);
    const executorId = (req.body && req.body.executorId) || null;
    const guard = ledger.guardSend(db, {
      orderId: order.id, phone: order.phone, action: 'final', imageKind: 'final',
      imageSha256: versionHash, imagePath: finals[0].path,
      imageBytes: finals.reduce((s, f) => s + f.bytes, 0), executorId,
    });
    if (!guard.allowed) {
      return res.status(409).json({ ok: false, error: `envio recusado (${guard.reason})`, reason: guard.reason, existing: guard.existing || null });
    }
    try {
      const sent = await whatsapp.sendFinal(req.params.id, { executorId });
      const evidence = (sent && sent.id && (sent.id._serialized || sent.id.id)) || 'admin-api';
      ledger.confirmSend(db, guard.key, evidence);
      try { service.markFinalDelivered(req.params.id); } catch {}
      return res.json({ ok: true, order: dbMod.getOrder(db, req.params.id) });
    } catch (err) {
      if (String(err.message).includes('envio recusado')) {
        ledger.cancelPending(db, guard.key);
        return res.status(409).json({ ok: false, error: err.message });
      }
      const rec = ledger.getLedgerByKey(db, guard.key);
      if (rec && rec.status === 'pending') ledger.markUncertain(db, guard.key, err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createBridgeRouter, fingerprint, requireAdmin, requireBridge };
