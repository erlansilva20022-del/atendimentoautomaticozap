// Serviço de pedidos — regras comerciais do FC Artes Digitais.
// - Aprovação só conta se for clara E se referir à prévia mais recente.
// - Silêncio ou só emoji NÃO é aprovação.
// - "Gostei mas..." = pedido de ajuste (nova versão + nova aprovação).
// - Pagamento só é marcado por confirmação explícita (admin/API), nunca por "paguei".
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const dbMod = require('./db');
const ledger = require('./sendLedger');
const { sha256Buffer } = require('./hash');
const { APPROVAL_PHRASES, ADJUSTMENT_MARKERS, priceFor, config, originalsDir } = require('./config');
const { generatePortrait } = require('./generate');
const { makePreview } = require('./watermark');

const DONE_WORDS = ['pronto', 'listo', 'listo ✅', 'pronto ✅', 'já enviei', 'ya envié', 'eso es todo', 'são essas', 'son esas'];

// Detecta idioma pela origem do número: +55 = Brasil (pt), demais = México (es).
function detectLanguage(phone) {
  return String(phone).startsWith('55') ? 'pt' : 'es';
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Retorna: 'approved' | 'adjustment' | null
function detectApproval(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  const hasApproval = APPROVAL_PHRASES.some((p) => norm.includes(normalizeText(p)));
  if (!hasApproval) return null;
  const hasAdjustment = ADJUSTMENT_MARKERS.some((m) => norm.includes(normalizeText(m)));
  if (hasAdjustment) return 'adjustment';
  return 'approved';
}

function isDoneWord(text) {
  const norm = normalizeText(text);
  return DONE_WORDS.some((w) => norm === normalizeText(w) || norm.includes(normalizeText(w)));
}

class OrderService {
  constructor(db) {
    this.db = db;
  }

  getOrCreateOrder(phone, name = null) {
    const existing = dbMod.findOpenOrderByPhone(this.db, phone);
    if (existing) return existing;
    const language = detectLanguage(phone);
    const order = dbMod.createOrder(this.db, { phone, name, language });
    dbMod.transition(this.db, order.id, 'CONTATO_VALIDADO');
    return dbMod.getOrder(this.db, order.id);
  }

  // Registra uma foto de referência enviada pelo cliente.
  // Deduplica por telefone + pedido + hash: a mesma foto não entra duas vezes.
  async addReferencePhoto(orderId, buffer, filename) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    const hash = sha256Buffer(buffer);
    const existing = dbMod.listPhotos(this.db, orderId, 'original').find((p) => p.sha256 === hash);
    if (existing) return { duplicate: true, photo: existing };
    fs.mkdirSync(originalsDir, { recursive: true });
    const safeName = `${orderId}_${randomUUID().slice(0, 8)}_${path.basename(filename || 'foto.jpg')}`;
    const filePath = path.join(originalsDir, safeName);
    fs.writeFileSync(filePath, buffer);
    dbMod.addPhoto(this.db, orderId, { kind: 'original', path: filePath, sha256: hash, bytes: buffer.length });
    dbMod.logEvent(this.db, orderId, 'referencia_recebida', `${safeName} bytes=${buffer.length}`);
    if (order.status === 'CONTATO_VALIDADO') {
      dbMod.transition(this.db, orderId, 'ORIGINAL_BAIXADA');
    }
    return { duplicate: false, path: filePath, sha256: hash, bytes: buffer.length };
  }

  setStyle(orderId, style) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (!['caricatura', 'studio'].includes(style)) throw new Error(`Estilo inválido: ${style}`);
    return dbMod.updateOrder(this.db, orderId, { style });
  }

  setQuantity(orderId, quantity) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    const price = priceFor(order.language, quantity);
    if (price === null) throw new Error(`Quantidade sem preço na tabela: ${quantity}`);
    const currency = order.language === 'es' ? 'MXN' : 'BRL';
    return dbMod.updateOrder(this.db, orderId, { quantity, price, currency });
  }

  // Gera o retrato a partir das referências do pedido e cria a prévia com marca.
  // Só gera quando há referências válidas e estilo definido.
  async generatePreview(orderId) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    const originals = dbMod.listPhotos(this.db, orderId, 'original');
    if (originals.length === 0) throw new Error('sem fotos de referência para gerar');
    if (!order.style) throw new Error('estilo não definido — pergunte caricatura ou estúdio');
    if (order.status === 'ORIGINAL_BAIXADA') {
      dbMod.transition(this.db, orderId, 'REFERENCIAS_VALIDAS');
    }
    const references = originals.map((p) => fs.readFileSync(p.path));
    const bytes = await generatePortrait({ references, style: order.style, language: order.language });
    const hash = sha256Buffer(bytes);
    const finalPath = path.join(originalsDir, `${orderId}_original.jpg`);
    fs.writeFileSync(finalPath, bytes);
    dbMod.addPhoto(this.db, orderId, { kind: 'final', path: finalPath, sha256: hash, bytes: bytes.length });
    const previewPath = await makePreview(finalPath);
    const previewBytes = fs.readFileSync(previewPath);
    dbMod.addPhoto(this.db, orderId, {
      kind: 'preview',
      path: previewPath,
      sha256: sha256Buffer(previewBytes),
      bytes: previewBytes.length,
    });
    dbMod.transition(this.db, orderId, 'PREVIA_GERADA');
    dbMod.transition(this.db, orderId, 'PREVIA_BAIXADA');
    return { originalPath: finalPath, previewPath, sha256: hash, bytes: bytes.length };
  }

  markPreviewSent(orderId) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    dbMod.transition(this.db, orderId, 'ANEXO_CONFERIDO');
    dbMod.transition(this.db, orderId, 'PREVIA_ENVIADA');
    dbMod.transition(this.db, orderId, 'AGUARDANDO_APROVACAO');
    return dbMod.getOrder(this.db, orderId);
  }

  // Analisa o texto do cliente APÓS a prévia ter sido enviada.
  // Retorna 'approved' | 'adjustment' | null (null = não é aprovação).
  handleApprovalText(orderId, text) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) return null;
    if (order.status !== 'AGUARDANDO_APROVACAO') return null;
    const result = detectApproval(text);
    if (result === 'approved') {
      dbMod.transition(this.db, orderId, 'APROVADO');
      dbMod.transition(this.db, orderId, 'AGUARDANDO_PAGAMENTO');
      dbMod.logEvent(this.db, orderId, 'aprovacao', text.slice(0, 200));
    } else if (result === 'adjustment') {
      dbMod.transition(this.db, orderId, 'REVISAO');
      dbMod.logEvent(this.db, orderId, 'ajuste_pedido', text.slice(0, 200));
    }
    return result;
  }

  // Pagamento SÓ por confirmação explícita (admin/dashboard/API).
  // Uma mensagem "paguei" do cliente NUNCA confirma pagamento.
  confirmPayment(orderId, { method = null, reference = null } = {}) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== 'AGUARDANDO_PAGAMENTO' && order.status !== 'APROVADO') {
      throw new Error(`Pagamento não pode ser confirmado no estado ${order.status}`);
    }
    if (order.status === 'APROVADO') {
      dbMod.transition(this.db, orderId, 'AGUARDANDO_PAGAMENTO');
    }
    dbMod.transition(this.db, orderId, 'PAGAMENTO_CONFIRMADO');
    dbMod.logEvent(this.db, orderId, 'pagamento_confirmado', `method=${method || '?'} ref=${reference || '?'}`);
    return dbMod.getOrder(this.db, orderId);
  }

  markFinalDelivered(orderId) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== 'PAGAMENTO_CONFIRMADO') {
      throw new Error('HD original só pode ser enviado após PAGAMENTO_CONFIRMADO');
    }
    dbMod.transition(this.db, orderId, 'FINAL_ENTREGUE');
    return dbMod.getOrder(this.db, orderId);
  }

  getStatus(orderId) {
    const order = dbMod.getOrder(this.db, orderId);
    if (!order) return null;
    return {
      ...order,
      photos: dbMod.listPhotos(this.db, orderId),
      events: dbMod.listEvents(this.db, orderId),
      sendLedger: ledger.listLedger(this.db, orderId),
    };
  }
}

module.exports = { OrderService, detectLanguage, detectApproval, isDoneWord, DONE_WORDS };
