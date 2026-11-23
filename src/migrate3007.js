// FC Core v2.0.0 — importação do histórico da FC Bridge 3007.
//
// A Bridge 3007 tem seu próprio banco e sua própria máquina de estados. Esta
// migração NÃO copia arquivos de banco e NÃO apaga nada da 3008:
// - Cada registro antigo entra como HISTÓRICO (nunca sobrescreve progresso novo).
// - UUID que já existe na 3008: conflito registrado para revisão manual, sem
//   criar segundo pedido e sem alterar o pedido existente.
// - Fotos: o arquivo é copiado para storage/ com SHA-256 conferido ANTES e
//   DEPOIS da cópia; divergência ou arquivo ausente vira conflito, sem inventar.
// - Eventos antigos entram com o prefixo "3007:" no tipo.
//
// Entrada: um JSON exportado do banco da Bridge 3007, no formato:
//   { "source": "bridge3007", "exportedAt": "ISO-8601",
//     "orders": [ { "id": "uuid", "phone": "+55...", "name": null,
//       "language": "pt", "style": "caricatura"|"studio"|null,
//       "quantity": 2, "price": 100, "currency": "MXN",
//       "status": "AGUARDANDO_APROVACAO", "created_at": "ISO", "updated_at": "ISO",
//       "photos": [ { "kind": "original"|"preview"|"final",
//         "path": "C:\\...\\foto.jpg", "sha256": "hex", "bytes": 123 } ],
//       "events": [ { "type": "status", "detail": "...", "created_at": "ISO" } ] } ] }
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const { sha256File } = require('./hash');
const { originalsDir } = require('./config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function logConflict(db, orderId, reason, detail) {
  db.prepare('INSERT INTO import_conflicts (source, order_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('bridge3007', orderId || null, reason, detail || null, dbMod.nowIso());
}

function listConflicts(db, limit = 100) {
  return db.prepare('SELECT * FROM import_conflicts ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Importa os registros. Nunca lança por registro ruim: o erro vira conflito
// e a importação segue para o próximo pedido.
function importBridge3007(db, payload) {
  const orders = Array.isArray(payload?.orders) ? payload.orders : [];
  const summary = { received: orders.length, imported: [], skipped: [], conflicts: [] };

  for (const rec of orders) {
    const id = rec?.id;
    if (!id || !UUID_RE.test(id)) {
      const reason = 'uuid_invalido';
      logConflict(db, id || null, reason, `registro sem UUID válido: ${JSON.stringify(rec).slice(0, 200)}`);
      summary.conflicts.push({ orderId: id || null, reason });
      summary.skipped.push({ orderId: id || null, reason });
      continue;
    }
    if (!rec.phone) {
      logConflict(db, id, 'sem_telefone', 'registro sem phone — não importado');
      summary.conflicts.push({ orderId: id, reason: 'sem_telefone' });
      summary.skipped.push({ orderId: id, reason: 'sem_telefone' });
      continue;
    }
    const existing = dbMod.getOrder(db, id);
    if (existing) {
      // UUID já existe na 3008: NUNCA sobrescrever, NUNCA duplicar.
      const reason = 'uuid_existente';
      const detail = `pedido já existe na 3008 com status ${existing.status} — histórico da 3007 preservado apenas como referência`;
      logConflict(db, id, reason, detail);
      dbMod.logEvent(db, id, 'import_3007_conflito', detail);
      summary.conflicts.push({ orderId: id, reason });
      summary.skipped.push({ orderId: id, reason });
      continue;
    }

    // Novo na 3008: importa como histórico, com o status antigo (se válido).
    const status = dbMod.STATES.includes(rec.status) ? rec.status : 'REVISAO';
    const now = dbMod.nowIso();
    db.prepare(
      `INSERT INTO orders (id, phone, name, language, style, quantity, price, currency,
        status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, rec.phone, rec.name || null, rec.language || 'pt', rec.style || null,
      rec.quantity ?? null, rec.price ?? null, rec.currency || null,
      status, rec.created_at || now, rec.updated_at || now
    );
    dbMod.logEvent(db, id, 'importado_3007', `status original da Bridge 3007: ${rec.status || '?'} -> ${status}`);

    // Fotos: só entram com arquivo real e SHA-256 conferido antes e depois da cópia.
    for (const photo of Array.isArray(rec.photos) ? rec.photos : []) {
      if (!photo || !['original', 'preview', 'final'].includes(photo.kind) || !photo.sha256 || !photo.path) {
        logConflict(db, id, 'foto_incompleta', `foto sem kind/path/sha256: ${JSON.stringify(photo).slice(0, 200)}`);
        summary.conflicts.push({ orderId: id, reason: 'foto_incompleta' });
        continue;
      }
      if (!fs.existsSync(photo.path)) {
        logConflict(db, id, 'arquivo_ausente', `arquivo da Bridge 3007 não encontrado: ${photo.path} (sha256 ${photo.sha256})`);
        summary.conflicts.push({ orderId: id, reason: 'arquivo_ausente' });
        continue;
      }
      try {
        const hashBefore = sha256File(photo.path);
        if (hashBefore !== photo.sha256) {
          logConflict(db, id, 'sha256_divergente', `${photo.path}: esperado ${photo.sha256}, arquivo tem ${hashBefore}`);
          summary.conflicts.push({ orderId: id, reason: 'sha256_divergente' });
          continue;
        }
        fs.mkdirSync(originalsDir, { recursive: true });
        const dest = path.join(originalsDir, `${id}_3007_${path.basename(photo.path)}`);
        fs.copyFileSync(photo.path, dest);
        const hashAfter = sha256File(dest);
        if (hashAfter !== photo.sha256) {
          logConflict(db, id, 'sha256_apos_copia', `cópia de ${photo.path} divergiu do original`);
          summary.conflicts.push({ orderId: id, reason: 'sha256_apos_copia' });
          try { fs.unlinkSync(dest); } catch {}
          continue;
        }
        const bytes = fs.statSync(dest).size;
        dbMod.addPhoto(db, id, { kind: photo.kind, path: dest, sha256: photo.sha256, bytes });
        dbMod.logEvent(db, id, 'foto_importada_3007', `${photo.kind} ${dest} sha256 conferido`);
      } catch (err) {
        logConflict(db, id, 'erro_copia_foto', `${photo.path}: ${err.message}`);
        summary.conflicts.push({ orderId: id, reason: 'erro_copia_foto' });
      }
    }

    // Eventos antigos entram como histórico com prefixo 3007:.
    for (const ev of Array.isArray(rec.events) ? rec.events : []) {
      if (!ev || !ev.type) continue;
      db.prepare('INSERT INTO events (order_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
        .run(id, `3007:${ev.type}`, ev.detail ? String(ev.detail).slice(0, 500) : null, ev.created_at || now);
    }
    summary.imported.push({ orderId: id, status });
  }
  return summary;
}

module.exports = { importBridge3007, listConflicts, logConflict };
