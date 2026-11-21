// Cliente WhatsApp (whatsapp-web.js) — sessão local, QR no terminal.
// Regras duras:
// - Pré-visualização SEMPRE como FOTO (MessageMedia a partir de arquivo), nunca figurinha.
// - HD original SÓ após PAGAMENTO_CONFIRMADO.
// - Nunca digitar caminho de arquivo no chat.
// - Nunca enviar para conversa bloqueada.
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const { OrderService, isDoneWord } = require('./orders');
const { t } = require('./messages');
const { config } = require('./config');

let client = null;
let service = null;
let db = null;

function isBlockedChat(chat) {
  // Conversa bloqueada não tem campo de digitação: whatsapp-web.js a sinaliza como archived/readonly em alguns casos.
  // Verificação prática: se a conversa não aceita envio, o sendMessage falha — tratamos o erro sem repetir.
  return chat && chat.isReadOnly === true;
}

async function sendPreview(orderId) {
  if (!client) throw new Error('WhatsApp não conectado — verifique WHATSAPP_ENABLED e o QR Code');
  const order = dbMod.getOrder(db, orderId);
  if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
  const previews = dbMod.listPhotos(db, orderId, 'preview');
  if (previews.length === 0) throw new Error('prévia ainda não gerada');
  const preview = previews[previews.length - 1]; // a mais recente
  const chat = await client.getChatById(`${order.phone}@c.us`);
  if (isBlockedChat(chat)) throw new Error('conversa bloqueada — não enviar sem autorização do dono');
  const media = MessageMedia.fromFilePath(preview.path);
  const sent = await chat.sendMessage(media, { caption: t(order.language, 'previewCaption') });
  if (!sent || !sent.id) throw new Error('envio da prévia não confirmado pelo WhatsApp');
  service.markPreviewSent(orderId);
  dbMod.logEvent(db, orderId, 'previa_enviada', `msg=${sent.id._serialized || sent.id.id || '?'}`);
  return sent;
}

async function sendFinal(orderId) {
  if (!client) throw new Error('WhatsApp não conectado — verifique WHATSAPP_ENABLED e o QR Code');
  const order = dbMod.getOrder(db, orderId);
  if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
  if (order.status !== 'PAGAMENTO_CONFIRMADO') {
    throw new Error('HD original só pode ser enviado após PAGAMENTO_CONFIRMADO');
  }
  const finals = dbMod.listPhotos(db, orderId, 'final');
  if (finals.length === 0) throw new Error('arquivo final não encontrado');
  const chat = await client.getChatById(`${order.phone}@c.us`);
  if (isBlockedChat(chat)) throw new Error('conversa bloqueada — não enviar sem autorização do dono');
  for (const file of finals) {
    const media = MessageMedia.fromFilePath(file.path);
    const sent = await chat.sendMessage(media);
    if (!sent || !sent.id) throw new Error('envio do arquivo final não confirmado pelo WhatsApp');
  }
  await chat.sendMessage(t(order.language, 'finalDelivery'));
  service.markFinalDelivered(orderId);
  return true;
}

async function handleTextMessage(msg, order) {
  const text = (msg.body || '').trim();
  const lang = order.language;
  const lower = text.toLowerCase();

  // 1) Cliente dizendo que terminou de enviar as fotos.
  if (isDoneWord(text)) {
    const originals = dbMod.listPhotos(db, order.id, 'original');
    if (originals.length === 0) {
      await msg.reply(t(lang, 'askPhotos'));
      return;
    }
    if (!order.style) {
      await msg.reply(t(lang, 'askStyle'));
      return;
    }
    try {
      const result = await service.generatePreview(order.id);
      await sendPreview(order.id);
      dbMod.logEvent(db, order.id, 'previa_gerada_enviada', `sha256=${result.sha256}`);
    } catch (err) {
      await msg.reply(t(lang, 'generationFailed'));
      dbMod.logEvent(db, order.id, 'erro_geracao', String(err.message).slice(0, 300));
    }
    return;
  }

  // 2) Escolha de estilo (1/2, caricatura, estúdio/studio).
  if (!order.style) {
    if (lower.includes('1') || lower.includes('caricatura')) {
      service.setStyle(order.id, 'caricatura');
      await msg.reply(t(lang, 'askPhotos'));
      return;
    }
    if (lower.includes('2') || lower.includes('studio') || lower.includes('estudio') || lower.includes('estúdio')) {
      service.setStyle(order.id, 'studio');
      await msg.reply(t(lang, 'askPhotos'));
      return;
    }
    await msg.reply(t(lang, 'askStyle'));
    return;
  }

  // 3) Aprovação / pedido de ajuste da prévia mais recente.
  if (order.status === 'AGUARDANDO_APROVACAO') {
    const result = service.handleApprovalText(order.id, text);
    if (result === 'approved') {
      const updated = dbMod.getOrder(db, order.id);
      const paymentInfo = lang === 'es' ? 'Oxxo o transferencia — os dados chegam na próxima mensagem.' : config.pixKey;
      await msg.reply(t(lang, 'payment', updated.quantity || 1, updated.price || 0, paymentInfo));
      return;
    }
    if (result === 'adjustment') {
      await msg.reply(t(lang, 'adjustment'));
      return;
    }
    await msg.reply(t(lang, 'needApproval'));
    return;
  }

  // 4) Cliente falando de pagamento antes da aprovação: não cobrar.
  if (order.status === 'AGUARDANDO_PAGAMENTO') {
    await msg.reply(t(lang, 'needApproval'));
    return;
  }

  // 5) Pedido já entregue.
  if (order.status === 'FINAL_ENTREGUE') {
    await msg.reply(t(lang, 'alreadyPaid'));
    return;
  }

  // 6) Cliente novo ou sem foto ainda: saudação + preços + estilo.
  await msg.reply(t(lang, 'greeting', msg._data?.notifyName || null));
  await msg.reply(t(lang, 'askStyle'));
}

function startWhatsApp(database) {
  db = database;
  service = new OrderService(db);

  // Cliente próprio desligado (WHATSAPP_ENABLED=false): o servidor HTTP e a ponte
  // continuam funcionando; só não há conexão com o WhatsApp neste processo.
  if (!config.whatsappEnabled) {
    console.log('[whatsapp] Desligado por configuração (WHATSAPP_ENABLED=false) — servidor e ponte seguem ativos.');
    return null;
  }
  // Respostas automáticas desligadas por padrão (AUTO_REPLY_ENABLED=false): enquanto o
  // Muse for o atendente principal, este cliente NÃO responde clientes sozinho — evita
  // atendimento duplicado. O envio de prévia/HD pela API continua funcionando.
  if (!config.autoReplyEnabled) {
    console.log('[whatsapp] Respostas automáticas DESLIGADAS (AUTO_REPLY_ENABLED=false) — o Muse atende; este sistema só envia prévia/HD por API.');
  }
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', (qr) => {
    console.log('[whatsapp] Escaneie o QR Code com o WhatsApp Business:');
    qrcode.generate(qr, { small: true });
  });
  client.on('ready', () => console.log('[whatsapp] Cliente pronto e autenticado.'));
  client.on('auth_failure', (m) => console.error('[whatsapp] Falha de autenticação:', m));
  client.on('disconnected', (reason) => console.error('[whatsapp] Desconectado:', reason));

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.isStatus) return;
      // Atendimento automático desligado: só registra a chegada, não responde nem gera nada.
      if (!config.autoReplyEnabled) {
        console.log(`[whatsapp] Mensagem recebida (auto-reply off, sem resposta): ${msg.from} ${msg.type}`);
        return;
      }
      const phone = msg.from.replace('@c.us', '');
      const order = service.getOrCreateOrder(phone, msg._data?.notifyName || null);

      if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
        const media = await msg.downloadMedia();
        if (!media || !media.data) return;
        const buffer = Buffer.from(media.data, 'base64');
        const ext = media.mimetype?.split('/')[1] || 'jpg';
        const result = await service.addReferencePhoto(order.id, buffer, `foto.${ext}`);
        if (result.duplicate) return; // mesma foto: não duplicar
        const updated = dbMod.getOrder(db, order.id);
        if (!updated.style) {
          await msg.reply(t(updated.language, 'askStyle'));
        } else {
          await msg.reply(t(updated.language, 'waitingPhotos'));
        }
        return;
      }

      if (msg.type === 'chat') {
        await handleTextMessage(msg, order);
      }
    } catch (err) {
      console.error('[whatsapp] Erro ao processar mensagem:', err.message);
    }
  });

  client.initialize();
  return client;
}

module.exports = { startWhatsApp, sendPreview, sendFinal, getClient: () => client };
