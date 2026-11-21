// Dashboard do FC Artes Digitais — sem build, chama a API do servidor local.
const $ = (id) => document.getElementById(id);
const msgEl = $('msg');

function token() {
  return $('token').value.trim();
}

function showMsg(text, isError = true) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? '#b00' : '#080';
}

async function loadHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    $('health').textContent = `v${data.version} • modo ${data.frontdeskMode} • banco ${data.db}`;
  } catch {
    $('health').textContent = 'servidor fora do ar';
  }
}

async function loadOrders() {
  const tbody = $('orders');
  try {
    const res = await fetch('/api/orders');
    const data = await res.json();
    if (!data.ok || !data.orders.length) {
      tbody.innerHTML = '<tr><td colspan="7">Nenhum pedido ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = data.orders.map((o) => `
      <tr>
        <td title="${o.id}">${o.id.slice(0, 8)}…</td>
        <td>${o.phone}</td>
        <td>${o.style || '—'}</td>
        <td>${o.quantity || '—'}</td>
        <td>${o.price ? `${o.currency} ${o.price}` : '—'}</td>
        <td class="status">${o.status}</td>
        <td>
          <button data-action="confirm-payment" data-id="${o.id}" ${o.status === 'AGUARDANDO_PAGAMENTO' || o.status === 'APROVADO' ? '' : 'disabled'}>Confirmar pagamento</button>
          <button data-action="send-preview" data-id="${o.id}" class="secondary" ${o.status === 'PREVIA_GERADA' || o.status === 'PREVIA_BAIXADA' ? '' : 'disabled'}>Enviar prévia</button>
          <button data-action="send-final" data-id="${o.id}" class="secondary" ${o.status === 'PAGAMENTO_CONFIRMADO' ? '' : 'disabled'}>Enviar HD</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7">Erro ao carregar pedidos.</td></tr>';
  }
}

async function callAction(action, id) {
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
    loadOrders();
  } catch (err) {
    showMsg(`Erro de rede: ${err.message}`);
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) callAction(btn.dataset.action, btn.dataset.id);
});
$('refresh').addEventListener('click', () => { loadHealth(); loadOrders(); });

loadHealth();
loadOrders();
setInterval(loadOrders, 15000);
