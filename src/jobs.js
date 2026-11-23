// FC Core v2.1.0 — fila persistente de trabalhos (durable job queue).
//
// Regras duras:
// - Todo trabalho vive no SQLite: criar o job, reiniciar o processo e o job
//   continua pendente — nada fica só em memória.
// - Retry difere por tipo de operação:
//   * Leituras/downloads/verificações: até max_attempts (padrão 3) com espera
//     crescente (backoff 5s, 10s, 20s...). Depois disso, status 'failed'.
//   * Envios de foto (send_preview/send_final): NUNCA repetem automaticamente.
//     Uma falha (timeout, erro, resultado incerto) vira 'needs_review' e o
//     pedido vai para REVISAO — só um humano decide o próximo passo.
// - O worker reivindica um job por vez de forma atômica (UPDATE ... WHERE
//   status='pending'): dois workers não pegam o mesmo job.
const { randomUUID } = require('crypto');
const dbMod = require('./db');
const { log } = require('./logger');

const SEND_KINDS = new Set(['send_preview', 'send_final']);
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5000;

function createJob(db, { orderId = null, step, kind, payload = null, owner = null, maxAttempts = null, deadline = null, correlationId = null }) {
  if (!step || !kind) throw new Error('step e kind são obrigatórios');
  const isSend = SEND_KINDS.has(kind);
  const id = randomUUID();
  const now = dbMod.nowIso();
  db.prepare(
    `INSERT INTO jobs (id, order_id, step, kind, payload, attempts, max_attempts,
       next_attempt_at, deadline, owner, status, correlation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    id, orderId, step, kind, payload ? JSON.stringify(payload) : null,
    maxAttempts !== null && maxAttempts !== undefined ? maxAttempts : (isSend ? 1 : DEFAULT_MAX_ATTEMPTS),
    now, deadline, owner, correlationId || orderId, now, now,
  );
  log('info', 'job criado', { jobId: id, orderId, step, kind });
  return getJob(db, id);
}

function getJob(db, id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
  if (job && job.payload) {
    try { job.payload = JSON.parse(job.payload); } catch { /* mantém como texto */ }
  }
  return job;
}

function listJobs(db, { status = null, orderId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (orderId) { where.push('order_id = ?'); params.push(orderId); }
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(limit, 500));
  return db.prepare(sql).all(...params).map((job) => {
    if (job.payload) {
      try { job.payload = JSON.parse(job.payload); } catch { /* mantém como texto */ }
    }
    return job;
  });
}

function countPendingJobs(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
  const counts = { pending: 0, in_progress: 0, done: 0, failed: 0, needs_review: 0 };
  for (const r of rows) counts[r.status] = r.n;
  const oldest = db.prepare(
    "SELECT MIN(created_at) AS oldest FROM jobs WHERE status = 'pending'"
  ).get();
  const oldestPendingAgeMs = oldest && oldest.oldest
    ? Math.max(0, Date.now() - new Date(oldest.oldest).getTime())
    : null;
  return { ...counts, oldestPendingAgeMs };
}

// Reivindica o próximo job devido, de forma atômica: só um worker pega cada job.
// (Não incrementa attempts aqui: a tentativa só conta quando falha ou conclui.)
function claimDueJob(db, workerId) {
  const now = dbMod.nowIso();
  const row = db.prepare(
    `SELECT * FROM jobs WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC LIMIT 1`
  ).get(now);
  if (!row) return null;
  const changed = db.prepare(
    `UPDATE jobs SET status = 'in_progress', owner = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(workerId, now, row.id);
  if (changed.changes === 0) return null; // outro worker pegou primeiro
  return getJob(db, row.id);
}

// Devolve para 'pending' trabalhos travados em 'in_progress' há mais de
// staleAfterMs (ex.: o processo caiu no meio da execução). A retomada é segura:
// envios passam pela trava do registro de envios antes de mandar.
function requeueStaleJobs(db, staleAfterMs = 10 * 60 * 1000) {
  const threshold = new Date(Date.now() - staleAfterMs).toISOString();
  const res = db.prepare(
    "UPDATE jobs SET status = 'pending', owner = NULL, updated_at = ? WHERE status = 'in_progress' AND updated_at < ?"
  ).run(dbMod.nowIso(), threshold);
  if (res.changes > 0) {
    log('warn', 'trabalhos travados devolvidos para a fila', { count: res.changes });
  }
  return res.changes;
}

function completeJob(db, id, result = null) {
  const now = dbMod.nowIso();
  db.prepare(
    "UPDATE jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?"
  ).run(result ? String(result) : null, now, id);
  const job = getJob(db, id);
  log('info', 'job concluído', { jobId: id, orderId: job && job.order_id, step: job && job.step });
  return job;
}

// Falha de um job. A política depende do tipo:
// - Envio de foto: vira 'needs_review' IMEDIATAMENTE (sem retry) e o pedido vai
//   para REVISAO — nunca reenviar automaticamente.
// - Demais tipos: se ainda há tentativas, volta para 'pending' com backoff;
//   se esgotou, vira 'failed'.
function failJob(db, id, reason) {
  const job = getJob(db, id);
  if (!job) return null;
  const now = dbMod.nowIso();
  const attemptsAfter = job.attempts + 1;
  if (SEND_KINDS.has(job.kind)) {
    db.prepare(
      "UPDATE jobs SET status = 'needs_review', attempts = ?, failure_reason = ?, updated_at = ? WHERE id = ?"
    ).run(attemptsAfter, String(reason || 'falha no envio').slice(0, 500), now, id);
    log('error', 'job de envio falhou — sem retry, pedido em REVISAO', { jobId: id, orderId: job.order_id, step: job.step, reason });
    if (job.order_id) {
      try { dbMod.transition(db, job.order_id, 'REVISAO'); } catch {}
      dbMod.logEvent(db, job.order_id, 'job_envio_falhou', `${job.step}: ${String(reason || '').slice(0, 200)}`);
    }
    return getJob(db, id);
  }
  if (attemptsAfter < job.max_attempts) {
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptsAfter - 1));
    const next = new Date(Date.now() + backoffMs).toISOString();
    db.prepare(
      "UPDATE jobs SET status = 'pending', attempts = ?, failure_reason = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?"
    ).run(attemptsAfter, String(reason || 'falha').slice(0, 500), next, now, id);
    log('warn', 'job falhou — nova tentativa agendada', { jobId: id, orderId: job.order_id, step: job.step, attempt: attemptsAfter, nextAttemptAt: next, reason });
  } else {
    db.prepare(
      "UPDATE jobs SET status = 'failed', attempts = ?, failure_reason = ?, updated_at = ? WHERE id = ?"
    ).run(attemptsAfter, String(reason || 'falha').slice(0, 500), now, id);
    log('error', 'job falhou definitivamente (tentativas esgotadas)', { jobId: id, orderId: job.order_id, step: job.step, reason });
  }
  return getJob(db, id);
}

// Worker: pega jobs devidos um por vez e executa o handler do tipo.
// handlers: { [kind]: async (job) => resultString }. Tipo sem handler falha
// imediatamente (sem retry) — é erro de configuração, não de rede.
function createJobWorker(db, handlers, { intervalMs = 5000, workerId = 'worker-1' } = {}) {
  let timer = null;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      requeueStaleJobs(db);
      const job = claimDueJob(db, workerId);
      if (!job) return;
      const handler = handlers[job.kind];
      if (!handler) {
        // Tipo desconhecido: erro de configuração — falha sem retry.
        db.prepare("UPDATE jobs SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
          .run(`sem handler para o tipo ${job.kind}`, dbMod.nowIso(), job.id);
        log('error', 'job sem handler — marcado como failed', { jobId: job.id, orderId: job.order_id, kind: job.kind });
        return;
      }
      try {
        const result = await handler(job);
        completeJob(db, job.id, result === undefined ? null : result);
      } catch (err) {
        failJob(db, job.id, err.message);
      }
    } catch (err) {
      log('error', 'erro no worker de jobs', { error: err.message });
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      log('info', 'worker de jobs iniciado', { intervalMs, workerId });
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    tick,
  };
}

module.exports = {
  SEND_KINDS,
  DEFAULT_MAX_ATTEMPTS,
  createJob,
  getJob,
  listJobs,
  countPendingJobs,
  claimDueJob,
  requeueStaleJobs,
  completeJob,
  failJob,
  createJobWorker,
};
