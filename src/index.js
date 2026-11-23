// Entrypoint: inicia banco, WhatsApp, servidor HTTP, vigia da pasta do Muse e
// worker da fila persistente de trabalhos.
// Tudo roda localmente no PC do dono. Nada vai para nuvem pública.
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const { createServer } = require('./server');
const whatsapp = require('./whatsapp');
const jobsMod = require('./jobs');
const { config, originalsDir } = require('./config');
const { sha256File } = require('./hash');
const { log } = require('./logger');

const INBOX_INTERVAL_MS = 8000;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Processa a pasta do Muse UMA vez (exportado para testes).
// FC Core v2.1.0 — vigia atômico e persistente:
// - Rastreamento persistente (tabela processed_inbox_files): arquivo já
//   importado/ignorado nunca é reprocessado nem recontado, mesmo após reiniciar.
// - Escrita completa: tamanho e data de modificação precisam estar estáveis
//   entre duas leituras (1s de intervalo) antes de importar.
// - Movimentação atômica: copia para arquivo temporário, sincroniza (fsync) e
//   renomeia para um destino IMUTÁVEL (nome inclui o hash) — nunca substitui
//   uma versão já registrada.
// - Deduplicação persistente por SHA-256 (tabela + fotos do pedido).
// - Hash conferido DEPOIS da cópia; divergência descarta o arquivo.
async function processInboxOnce(db) {
  const inbox = path.resolve(config.museInboxDir);
  fs.mkdirSync(inbox, { recursive: true });
  let files;
  try {
    files = fs.readdirSync(inbox);
  } catch (err) {
    log('error', 'inbox: não consegui ler a pasta', { error: err.message });
    return;
  }
  for (const file of files) {
    const full = path.join(inbox, file);
    try {
      if (!IMAGE_EXTS.has(path.extname(file).toLowerCase())) continue;
      if (dbMod.getProcessedInboxFile(db, file)) continue; // já processado — nunca reprocessar
      const match = file.match(UUID_RE);
      if (!match) {
        dbMod.recordProcessedInboxFile(db, { filename: file, status: 'ignored', reason: 'sem_uuid' });
        log('info', 'inbox: ignorado (sem UUID de pedido no nome)', { file });
        continue;
      }
      const orderId = match[0];
      const order = dbMod.getOrder(db, orderId);
      if (!order) {
        // Pedido ainda não existe: NÃO registra como processado — tenta de novo
        // no próximo ciclo (o pedido pode ser criado depois).
        log('info', 'inbox: pedido ainda não existe — tentando de novo depois', { file, orderId });
        continue;
      }
      // Escrita completa: tamanho e mtime estáveis entre duas leituras.
      const s1 = fs.statSync(full);
      await new Promise((r) => setTimeout(r, 1000));
      const s2 = fs.statSync(full);
      if (s1.size !== s2.size || s1.mtimeMs !== s2.mtimeMs) {
        log('info', 'inbox: arquivo ainda sendo escrito — tentando de novo depois', { file, orderId });
        continue;
      }
      const hash = sha256File(full);
      const alreadyBySha = dbMod.findProcessedInboxBySha(db, hash);
      if (alreadyBySha) {
        dbMod.recordProcessedInboxFile(db, { filename: file, sha256: hash, orderId, status: 'duplicate', reason: `mesmo hash de ${alreadyBySha.filename}` });
        log('info', 'inbox: duplicata por hash — ignorado', { file, orderId });
        continue;
      }
      const dup = dbMod.listPhotos(db, orderId, 'final').find((p) => p.sha256 === hash);
      if (dup) {
        dbMod.recordProcessedInboxFile(db, { filename: file, sha256: hash, orderId, status: 'duplicate', reason: 'foto já registrada no pedido' });
        log('info', 'inbox: duplicata já registrada no pedido — ignorado', { file, orderId });
        continue;
      }
      fs.mkdirSync(originalsDir, { recursive: true });
      const ext = path.extname(file).toLowerCase();
      const dest = path.join(originalsDir, `${orderId}_original_${hash.slice(0, 12)}${ext}`);
      if (fs.existsSync(dest)) {
        dbMod.recordProcessedInboxFile(db, { filename: file, sha256: hash, orderId, status: 'duplicate', reason: 'destino imutável já existe' });
        log('info', 'inbox: destino já existe — ignorado', { file, orderId });
        continue;
      }
      const tmp = `${dest}.tmp-${process.pid}`;
      fs.copyFileSync(full, tmp);
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dest);
      const bytes = fs.statSync(dest).size;
      const hashAfter = sha256File(dest);
      if (hashAfter !== hash) {
        try { fs.unlinkSync(dest); } catch {}
        dbMod.recordProcessedInboxFile(db, { filename: file, sha256: hash, orderId, status: 'ignored', reason: 'hash divergiu após cópia' });
        log('error', 'inbox: hash divergiu após cópia — arquivo descartado', { file, orderId });
        continue;
      }
      dbMod.addPhoto(db, orderId, { kind: 'final', path: dest, sha256: hash, bytes });
      dbMod.recordProcessedInboxFile(db, { filename: file, sha256: hash, orderId, status: 'imported' });
      dbMod.logEvent(db, orderId, 'imagem_muse_inbox', `${file} sha256=${hash}`);
      log('info', 'inbox: importado', { file, orderId, bytes, sha256: hash.slice(0, 12) });
    } catch (err) {
      log('error', 'inbox: erro ao processar arquivo', { file, error: err.message });
    }
  }
}

// Vigia contínuo da pasta do Muse (a cada 8s). Nunca roda dois ciclos ao mesmo tempo.
function watchMuseInbox(db) {
  const inbox = path.resolve(config.museInboxDir);
  fs.mkdirSync(inbox, { recursive: true });
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    processInboxOnce(db).finally(() => { running = false; });
  }, INBOX_INTERVAL_MS);
  log('info', 'inbox: vigia ativo', { inbox, intervalMs: INBOX_INTERVAL_MS });
}

function main() {
  const db = dbMod.initDb();
  log('info', 'banco pronto', { databasePath: config.databasePath });

  const client = whatsapp.startWhatsApp(db);
  const app = createServer(db, whatsapp);
  app.listen(config.port, () => {
    log('info', 'servidor no ar', { port: config.port, version: config.version });
  });

  watchMuseInbox(db);

  // Worker da fila persistente: envios passam pela mesma trava de envio
  // (registro + lease) do fluxo admin. Falha de envio vira 'needs_review'
  // + REVISAO, sem retry — a decisão é humana.
  const worker = jobsMod.createJobWorker(db, {
    send_preview: async (job) => {
      const executorId = (job.payload && job.payload.executorId) || null;
      const sent = await whatsapp.sendPreview(job.order_id, { executorId });
      return sent && sent.id ? (sent.id._serialized || sent.id.id) : 'enviado';
    },
    send_final: async (job) => {
      const executorId = (job.payload && job.payload.executorId) || null;
      return whatsapp.sendFinal(job.order_id, { executorId });
    },
  }, { intervalMs: config.jobWorkerIntervalMs || 5000, workerId: 'worker-main' });
  worker.start();

  const shutdown = () => {
    log('info', 'encerrando');
    try { worker.stop(); } catch {}
    try {
      if (client) client.destroy();
    } catch {}
    try {
      db.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();
module.exports = { main, watchMuseInbox, processInboxOnce };
