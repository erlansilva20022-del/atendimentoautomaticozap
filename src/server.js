// Servidor HTTP: API da ponte + dashboard + health check.
const express = require('express');
const path = require('path');
const dbMod = require('./db');
const { createBridgeRouter } = require('./bridge');
const { config } = require('./config');

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
    res.json({
      ok: dbOk,
      version: config.version,
      frontdeskMode: config.frontdeskMode,
      db: dbOk ? 'ok' : 'erro',
      autoSend: false,
    });
  });

  app.use(createBridgeRouter(db, whatsapp));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

module.exports = { createServer };
