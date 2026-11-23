// Servidor HTTP: API da ponte + dashboard + health check.
const express = require('express');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const ledger = require('./sendLedger');
const jobsMod = require('./jobs');
const { createBridgeRouter } = require('./bridge');
const { config } = require('./config');
const { log } = require('./logger');

function createServer(db, whatsapp) {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // imagens em base64 podem ser grandes
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Health: saúde REAL da operação, não só "o Node está online".
  // - queueDepth conta SÓ trabalhos pendentes da fila persistente (v2.1.0) —
  //   arquivos antigos na muse-inbox NÃO entram na fila (são rastreados à parte).
  // - sendState mostra separadamente Core, extensão e sessão do WhatsApp (ou
  //   'unknown' quando a extensão nunca reportou heartbeat).
  // - disk mostra espaço livre com alerta quando baixo; lastBackupAt mostra o
  //   último backup registrado; sends resume confirmados/incertos/bloqueados.
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
    // Fila persistente: SÓ trabalhos pendentes contam (v2.1.0 — sem contar
    // arquivos da muse-inbox, que já foram importados ou ignorados).
    let jobs = { pending: 0, in_progress: 0, done: 0, failed: 0, needs_review: 0, oldestPendingAgeMs: null };
    try {
      jobs = jobsMod.countPendingJobs(db);
    } catch (err) {
      log('error', 'health: não consegui contar os trabalhos', { error: err.message });
    }
    let activeLeases = [];
    try {
      activeLeases = ledger.listActiveLeases(db).map((l) => ({
        phone: l.phone, executorId: l.executor_id, expiresAt: l.expires_at,
      }));
    } catch {}
    // Resumo dos envios: confirmados, incertos e recusados (duplicata).
    const sends = { confirmed: 0, uncertain: 0, refused_duplicate: 0, pending: 0 };
    try {
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM send_ledger GROUP BY status').all()) {
        if (row.status in sends) sends[row.status] = row.n;
      }
    } catch {}
    // Estados da extensão e da sessão do WhatsApp (via heartbeat da extensão).
    let extensionState = { state: 'unknown' };
    try {
      const hb = dbMod.getMeta(db, 'extension_last_heartbeat');
      if (hb) {
        extensionState = {
          state: 'reported',
          lastHeartbeat: hb,
          executorId: dbMod.getMeta(db, 'extension_executor_id') || null,
          whatsappAuthenticated: dbMod.getMeta(db, 'extension_whatsapp_authenticated'),
          autoSend: dbMod.getMeta(db, 'extension_auto_send'),
          lastCaptureAt: dbMod.getMeta(db, 'extension_last_capture_at') || null,
        };
      }
    } catch {}
    const whatsappSession = {
      state: extensionState.whatsappAuthenticated === 'true'
        ? 'authenticated'
        : (extensionState.whatsappAuthenticated === 'false' ? 'disconnected' : 'unknown'),
    };
    // Espaço em disco (alerta quando livre abaixo do limite configurado).
    let disk = { freeBytes: null, freeGb: null, low: null };
    try {
      const stats = fs.statfsSync(path.resolve(config.databasePath, '..'));
      disk = {
        freeBytes: stats.bfree * stats.bsize,
        freeGb: Math.round((stats.bfree * stats.bsize) / 1e9 * 100) / 100,
        low: (stats.bfree * stats.bsize) / 1e9 < (config.diskWarnFreeGb || 5),
      };
    } catch {}
    let lastBackupAt = null;
    try {
      lastBackupAt = dbMod.getMeta(db, 'last_backup_at');
    } catch {}
    res.json({
      ok: dbOk,
      version: config.version,
      frontdeskMode: config.frontdeskMode,
      db: dbOk ? 'ok' : 'erro',
      autoSend: config.autoReplyEnabled,
      whatsappEnabled: config.whatsappEnabled,
      queueDepth: jobs.pending,
      jobs: {
        pending: jobs.pending,
        inProgress: jobs.in_progress,
        done: jobs.done,
        failed: jobs.failed,
        needsReview: jobs.needs_review,
        oldestPendingAgeMs: jobs.oldestPendingAgeMs,
      },
      countsByStatus,
      leases: { active: activeLeases.length, holders: activeLeases },
      sends,
      sendState: {
        core: { autoSend: config.autoReplyEnabled, whatsappEnabled: config.whatsappEnabled },
        extension: extensionState,
        whatsappSession,
      },
      disk,
      lastBackupAt,
    });
  });

  app.use(createBridgeRouter(db, whatsapp));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

module.exports = { createServer };
