// Log estruturado em JSON — uma linha por evento.
// Toda linha referente a um pedido carrega correlationId = UUID do pedido,
// para rastrear o pedido inteiro nos logs. NUNCA registra tokens, segredos,
// senhas ou chaves: campos com esses nomes são substituídos por '[redacted]'.
const SENSITIVE_KEY = /token|secret|password|senha|api[_-]?key|authorization|pix[_-]?key/i;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return depth > 2 ? '[array]' : value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 2) return '[object]';
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function log(level, msg, fields = {}) {
  const { correlationId, orderId, ...rest } = fields || {};
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(correlationId ? { correlationId } : {}),
    ...(orderId ? { correlationId: orderId } : {}),
    ...sanitize(rest),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  log,
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};
