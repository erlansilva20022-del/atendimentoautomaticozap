// FC Core v2.0.0 — painel de operações unificado (sem build, chama a API local).
// O painel NÃO precisa ficar aberto: a automação roda no servidor, não no navegador.
const $ = (id) => document.getElementById(id);
const msgEl = $('msg');

function token() { return $('token').value.trim(); }
function bridgeToken() { return $('bridgeToken').value.trim(); }

function showMsg(text, isError = true) {
  msgEl.textContent = text;
  msgEl.className = isError ? '' : 'ok';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadHealth() {
  try {
    const res = await fetch('/health');
    const d = await res.json();
    $('health').innerHTML = `
      <span class="stat"><b>v${esc(d.version)}</b>versão</span>
      <span class="stat"><b>${esc(d.db)}</b>banco</span>
      <span class="stat"><b>${d.queueDepth ?? '—'}</b>fila</span>
      <span class="stat"><b>${d.leases ? d.leases.active : '—'}</b>leases ativos</span>
      <span class="stat"><b>${d.autoSend ? 'LIGADO' : 'desligado'}</b>envio automático</span>
      <span class="stat"><b>${esc(d.frontdeskMode)}</b>modo</span>`;
    const counts = d.countsByStatus || {};
    $('counts').innerHTML = Object.keys(counts).length
      ? Object.entries(counts).map(([s, n]) => `<span class="stat"><b>${n}</b>${esc(s)}</span>`).join('')
      : '<span class="muted">Sem pedidos.</span>';
  } catch {
    $('health').innerHTML = '<span class="muted">servidor fora do ar</span>';
  }
}

async function loadOrders() {
  const tbody = $('orders');
  try {
    const res = await fetch('/api/orders');
    const data = await res.json();
    if (!data.ok || !data.orders.length) {
      tbody.innerHTML = '<tr><td colspan="8">Nenhum pedido ainda.</td></tr>';
      $('errors').innerHTML = '<tr><td colspan="4">Nenhum pedido em revisão.</td></tr>';
      return;
    }
    tbody.innerHTML = data.orders.map((o) => `
      <tr>
        <td title="${esc(o.id)}">${esc(o.id.slice(0, 8))}…</td>
        <td>${esc(o.phone)}</td>
        <td>${esc(o.style || '—')}</td>
        <td>${o.quantity || '—'}</td>
        <td>${o.price ? `${esc(o.currency)} ${o.price}` : '—'}</td>
        <td class="status">${esc(o.status)}</td>
        <td>${o.photos}</td>
        <td>
          <button data-action="detail" data-id="${esc(o.id)}" class="secondary">Detalhe</button>
          <button data-action="confirm-payment" data-id="${esc(o.id)}" ${o.status === 'AGUARDANDO_PAGAMENTO' || o.status === 'APROVADO' ? '' : 'disabled'}>Confirmar pagamento</button>
          <button data-action="send-preview" data-id="${esc(o.id)}" class="secondary" ${o.status === 'PREVIA_GERADA' || o.status === 'PREVIA_BAIXADA' ? '' : 'disabled'}>Enviar prévia</button>
          <button data-action="send-final" data-id="${esc(o.id)}" class="secondary" ${o.status === 'PAGAMENTO_CONFIRMADO' ? '' : 'disabled'}>Enviar HD</button>
        </td>
      </tr>`).join('');
    const revisao = data.orders.filter((o) => o.status === 'REVISAO');
    $('errors').innerHTML = revisao.length
      ? revisao.map((o) => `<tr><td title="${esc(o.id)}">${esc(o.id.slice(0, 8))}…</td><td>${esc(o.phone)}</td><td class="status">${esc(o.status)}</td><td>${esc(o.updated_at)}</td></tr>`).join('')
      : '<tr><td colspan="4">Nenhum pedido em revisão.</td></tr>';
  } catch {
    tbody.innerHTML = '<tr><td colspan="8">Erro ao carregar pedidos.</td></tr>';
  }
}

async function loadLedger() {
  try {
    const res = await fetch('/api/ledger?limit=30');
    const data = await res.json();
    const tbody = $('ledger');
    if (!data.ok || !data.ledger.length) {
      tbody.innerHTML = '<tr><td colspan="6">Nenhum envio registrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.ledger.map((l) => `
      <tr>
        <td title="${esc(l.order_id)}">${esc(l.order_id.slice(0, 8))}…</td>
        <td>${esc(l.action)}</td>
        <td class="mono">${esc(l.image_sha256.slice(0, 12))}…</td>
        <td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td>
        <td>${esc(l.executor_id || '—')}</td>
        <td class="mono">${esc(l.evidence || '—')}</td>
      </tr>`).join('');
  } catch {
    $('ledger').innerHTML = '<tr><td colspan="6">Erro ao carregar envios.</td></tr>';
  }
}

async function loadConflicts() {
  if (!token()) { $('conflicts').textContent = 'Informe o token de admin para ver os conflitos.'; return; }
  try {
    const res = await fetch('/api/admin/import-conflicts', { headers: { 'x-admin-token': token() } });
    const data = await res.json();
    $('conflicts').textContent = data.ok
      ? (data.conflicts.length ? JSON.stringify(data.conflicts, null, 2) : 'Nenhum conflito registrado.')
      : `Erro: ${data.error}`;
  } catch (err) {
    $('conflicts').textContent = `Erro de rede: ${err.message}`;
  }
}

async function loadDetail(id) {
  try {
    const res = await fetch(`/api/orders/${id}`);
    const data = await res.json();
    if (!data.ok) { showMsg(`Erro: ${data.error}`); return; }
    const o = data.order;
    $('detailSection').style.display = '';
    $('detailId').textContent = o.id;
    $('detail').innerHTML = `
      <p>Telefone: <b>${esc(o.phone)}</b> • Idioma: ${esc(o.language)} • Estilo: ${esc(o.style || '—')} •
      Qtd.: ${o.quantity || '—'} • Preço: ${o.price ? `${esc(o.currency)} ${o.price}` : '—'} •
      Status: <b>${esc(o.status)}</b> • Criado: ${esc(o.created_at)}</p>`;
    $('detailPhotos').innerHTML = o.photos.length
      ? o.photos.map((p) => `<tr><td>${esc(p.kind)}</td><td class="mono">${esc(p.path)}</td><td class="mono">${esc(p.sha256.slice(0, 16))}…</td><td>${p.bytes}</td></tr>`).join('')
      : '<tr><td colspan="4">Sem fotos.</td></tr>';
    $('detailLedger').innerHTML = (o.sendLedger || []).length
      ? o.sendLedger.map((l) => `<tr><td>${esc(l.action)}</td><td class="mono">${esc(l.image_sha256.slice(0, 12))}…</td><td><span class="badge ${esc(l.status)}">${esc(l.status)}</span></td><td>${esc(l.executor_id || '—')}</td><td class="mono">${esc(l.evidence || '—')}</td><td>${esc(l.created_at)}</td></tr>`).join('')
      : '<tr><td colspan="6">Nenhum envio registrado.</td></tr>';
    $('detailEvents').textContent = (o.events || []).map((e) => `${e.created_at}  ${e.type}  ${e.detail || ''}`).join('\n') || 'Sem eventos.';
    $('detailSection').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showMsg(`Erro de rede: ${err.message}`);
  }
}

async function callAction(action, id) {
  if (action === 'detail') { loadDetail(id); return; }
  if (!token()) { showMsg('Informe o token de admin (ADMIN_TOKEN do .env).'); return; }
  showMsg('Enviando…', false);
  try {
    const res = await fetch(`/api/orders/${id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token() },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!data.ok) { showMsg(`Erro: ${data.error}`); return; }
    showMsg('OK.', false);
    refreshAll();
  } catch (err) {
    showMsg(`Erro de rede: ${err.message}`);
  }
}

async function import3007() {
  const file = $('importFile').files[0];
  if (!file) { showMsg('Escolha o arquivo JSON exportado da Bridge 3007.'); return; }
  if (!token()) { showMsg('Informe o token de admin (ADMIN_TOKEN do .env).'); return; }
  showMsg('Importando…', false);
  try {
    const payload = JSON.parse(await file.text());
    const res = await fetch('/api/admin/import-bridge3007', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token() },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    $('importResult').textContent = JSON.stringify(data, null, 2);
    showMsg(data.ok ? 'Importação concluída — confira os conflitos.' : `Erro: ${data.error}`, !data.ok);
    refreshAll();
  } catch (err) {
    showMsg(`Erro: ${err.message}`);
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) callAction(btn.dataset.action, btn.dataset.id);
});
$('refresh').addEventListener('click', refreshAll);
$('importBtn').addEventListener('click', import3007);

function refreshAll() {
  loadHealth();
  loadOrders();
  loadLedger();
  loadConflicts();
}

refreshAll();
setInterval(refreshAll, 15000);
