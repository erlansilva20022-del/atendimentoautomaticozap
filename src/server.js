// Servidor HTTP: API da ponte + dashboard + health check.
const express = require('express');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const ledger = require('./sendLedger');
const { createBridgeRouter } = require('./bridge');
const { config } = require('./config');

// Estados com trabalho pendente (fila de atendimento).
const QUEUE_STATES = [
  'CONTATO_VALIDADO', 'ORIGINAL_BAIXADA', 'REFERENCIAS_VALIDAS',
  'PREVIA_GERADA', 'PREVIA_BAIXADA', 'ANEXO_CONFERIDO',
];

function createServer(db, whatsapp) {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // imagens em base64 podem ser grandes
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/health', (req, res) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    // Contagem de pedidos por estado.
    const countsByStatus = {};
    try {
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) {
        countsByStatus[row.status] = row.n;
      }
    } catch {}
    // Fila: pedidos em estados de trabalho + arquivos novos na pasta do Muse.
    let queueDepth = 0;
    try {
      queueDepth = QUEUE_STATES.reduce((s, st) => s + (countsByStatus[st] || 0), 0);
      const inbox = path.resolve(config.museInboxDir);
      if (fs.existsSync(inbox)) {
        queueDepth += fs.readdirSync(inbox).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)).length;
      }
    } catch {}
    let activeLeases = [];
    try {
      activeLeases = ledger.listActiveLeases(db).map((l) => ({
        phone: l.phone, executorId: l.executor_id, expiresAt: l.expires_at,
      }));
    } catch {}
    res.json({
      ok: dbOk,
      version: config.version,
      frontdeskMode: config.frontdeskMode,
      db: dbOk ? 'ok' : 'erro',
      autoSend: config.autoReplyEnabled,
      whatsappEnabled: config.whatsappEnabled,
      queueDepth,
      countsByStatus,
      leases: { active: activeLeases.length, holders: activeLeases },
    });
  });

  app.use(createBridgeRouter(db, whatsapp));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

module.exports = { createServer };
