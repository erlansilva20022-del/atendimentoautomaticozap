// Ponte HTTP para o handoff do Muse (FC Bridge).
// - POST /api/muse/orders: cria/recupera pedido por telefone + hora observada + texto
//   (sem messageId nativo — usa fingerprint telefone+hora+texto).
// - POST /api/muse/order-result: recebe os bytes da imagem gerada pelo Muse
//   (dataUrl ou base64), confere o SHA-256 e salva o original.
// - GET /api/orders/:id: status, fotos e eventos.
// - POST /api/orders/:id/confirm-payment e /send-preview: só com ADMIN_TOKEN.
// Anti-duplicação por orderId + sha256 em todas as rotas.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const { sha256Buffer } = require('./hash');
const { OrderService, detectLanguage } = require('./orders');
const { config, originalsDir } = require('./config');

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
  router.post('/api/muse/orders', (req, res) => {
    const { phone, observedClock, text } = req.body || {};
    if (!phone || !observedClock || !text) {
      return res.status(400).json({ ok: false, error: 'phone, observedClock e text são obrigatórios' });
    }
    const fp = fingerprint(phone, observedClock, text);
    const existing = db.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone);
    if (existing) {
      const ev = dbMod.listEvents(db, existing.id).find((e) => e.type === 'pedido_observado' && e.detail === fp);
      if (ev) return res.json({ ok: true, orderId: existing.id, status: existing.status, duplicate: true });
    }
    const language = detectLanguage(phone);
    const order = dbMod.createOrder(db, { phone, language });
    dbMod.logEvent(db, order.id, 'pedido_observado', fp);
    dbMod.logEvent(db, order.id, 'texto_pedido', String(text).slice(0, 500));
    dbMod.transition(db, order.id, 'CONTATO_VALIDADO');
    return res.json({ ok: true, orderId: order.id, status: 'CONTATO_VALIDADO', duplicate: false });
  });

  // Recebe o resultado da geração do Muse: bytes da imagem + hash para validação.
  router.post('/api/muse/order-result', async (req, res) => {
    const { orderId, phone, source, sourceSha256, image } = req.body || {};
    if (source !== 'MUSE') return res.status(400).json({ ok: false, error: 'source deve ser "MUSE"' });
    if (!orderId || !sourceSha256 || !image) {
      return res.status(400).json({ ok: false, error: 'orderId, sourceSha256 e image são obrigatórios' });
    }
    const order = dbMod.getOrder(db, orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
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
    // Anti-duplicação: mesmo pedido + mesmo hash já registrado.
    const dup = dbMod.listPhotos(db, orderId, 'final').find((p) => p.sha256 === hash);
    if (dup) return res.json({ ok: true, orderId, status: order.status, sha256: hash, duplicate: true });
    fs.mkdirSync(originalsDir, { recursive: true });
    const filePath = path.join(originalsDir, `${orderId}_original.jpg`);
    fs.writeFileSync(filePath, bytes);
    dbMod.addPhoto(db, orderId, { kind: 'final', path: filePath, sha256: hash, bytes: bytes.length });
    dbMod.logEvent(db, orderId, 'imagem_muse_recebida', `sha256=${hash} bytes=${bytes.length}`);
    // Avança a máquina de estados sem pular etapas.
    const cur = dbMod.getOrder(db, orderId).status;
    const steps = ['ORIGINAL_BAIXADA', 'REFERENCIAS_VALIDAS', 'PREVIA_GERADA', 'PREVIA_BAIXADA'];
    for (const step of steps) {
      const now = dbMod.getOrder(db, orderId).status;
      if (now === step) continue;
      if (!dbMod.transition(db, orderId, step)) break;
    }
    const updated = dbMod.getOrder(db, orderId);
    return res.json({ ok: true, orderId, status: updated.status, sha256: hash, bytes: bytes.length, path: filePath });
  });

  // Status completo do pedido.
  router.get('/api/orders/:id', (req, res) => {
    const status = service.getStatus(req.params.id);
    if (!status) return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    return res.json({ ok: true, order: status });
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
  router.post('/api/orders/:id/send-preview', requireAdmin, async (req, res) => {
    try {
      await whatsapp.sendPreview(req.params.id);
      const order = dbMod.getOrder(db, req.params.id);
      return res.json({ ok: true, order });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Envia o HD original (admin) — só funciona após PAGAMENTO_CONFIRMADO.
  router.post('/api/orders/:id/send-final', requireAdmin, async (req, res) => {
    try {
      await whatsapp.sendFinal(req.params.id);
      const order = dbMod.getOrder(db, req.params.id);
      return res.json({ ok: true, order });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createBridgeRouter, fingerprint, requireAdmin };
