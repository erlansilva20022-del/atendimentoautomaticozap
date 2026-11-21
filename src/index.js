// Entrypoint: inicia banco, WhatsApp, servidor HTTP e o vigia da pasta do Muse.
// Tudo roda localmente no PC do dono. Nada vai para nuvem pública.
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const { createServer } = require('./server');
const whatsapp = require('./whatsapp');
const { config, originalsDir } = require('./config');
const { sha256File } = require('./hash');

const INBOX_INTERVAL_MS = 8000;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Importa arquivos novos da pasta do Muse.
// Só importa se o nome do arquivo contiver um UUID de pedido; senão ignora com segurança.
function watchMuseInbox(db) {
  const inbox = path.resolve(config.museInboxDir);
  fs.mkdirSync(inbox, { recursive: true });
  const seen = new Set();
  setInterval(() => {
    let files = [];
    try {
      files = fs.readdirSync(inbox);
    } catch (err) {
      console.error('[inbox] Não consegui ler a pasta:', err.message);
      return;
    }
    for (const file of files) {
      const full = path.join(inbox, file);
      if (seen.has(full)) continue;
      if (!IMAGE_EXTS.has(path.extname(file).toLowerCase())) continue;
      seen.add(full);
      const match = file.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (!match) {
        console.log(`[inbox] Ignorado (sem UUID de pedido no nome): ${file}`);
        continue;
      }
      const orderId = match[0];
      const order = dbMod.getOrder(db, orderId);
      if (!order) {
        console.log(`[inbox] Pedido não encontrado para ${file} — ignorado.`);
        continue;
      }
      try {
        const hash = sha256File(full);
        const dup = dbMod.listPhotos(db, orderId, 'final').find((p) => p.sha256 === hash);
        if (dup) {
          console.log(`[inbox] Duplicata ignorada: ${file}`);
          continue;
        }
        fs.mkdirSync(originalsDir, { recursive: true });
        const dest = path.join(originalsDir, `${orderId}_original${path.extname(file).toLowerCase()}`);
        fs.copyFileSync(full, dest);
        const bytes = fs.statSync(dest).size;
        dbMod.addPhoto(db, orderId, { kind: 'final', path: dest, sha256: hash, bytes });
        dbMod.logEvent(db, orderId, 'imagem_muse_inbox', `${file} sha256=${hash}`);
        console.log(`[inbox] Importado para o pedido ${orderId}: ${file} (${bytes} bytes, sha256 ${hash.slice(0, 12)}...)`);
      } catch (err) {
        console.error(`[inbox] Erro ao importar ${file}:`, err.message);
      }
    }
  }, INBOX_INTERVAL_MS);
  console.log(`[inbox] Vigia ativo em ${inbox} (a cada 8s).`);
}

function main() {
  const db = dbMod.initDb();
  console.log('[fc] Banco pronto:', config.databasePath);

  const client = whatsapp.startWhatsApp(db);
  const app = createServer(db, whatsapp);
  app.listen(config.port, () => {
    console.log(`[fc] Servidor em http://localhost:${config.port} (dashboard + API)`);
    console.log(`[fc] Health: http://localhost:${config.port}/health`);
  });

  watchMuseInbox(db);

  const shutdown = () => {
    console.log('\n[fc] Encerrando...');
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
module.exports = { main, watchMuseInbox };
