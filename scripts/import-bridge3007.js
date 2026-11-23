// Cliente CLI da importação do histórico da FC Bridge 3007.
// Uso:  ADMIN_TOKEN=... node scripts/import-bridge3007.js <export.json> [baseUrl]
// O export.json é o JSON exportado do banco da Bridge 3007 (ver src/migrate3007.js
// para o formato). O script só envia; a validação acontece no servidor.
const fs = require('fs');

async function main() {
  const [file, baseUrl = 'http://localhost:3008'] = process.argv.slice(2);
  if (!file) {
    console.error('Uso: node scripts/import-bridge3007.js <export.json> [baseUrl]');
    process.exit(1);
  }
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('Defina ADMIN_TOKEN no ambiente (o mesmo do .env do backend).');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/admin/import-bridge3007`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error('Falha na importação:', err.message);
  process.exit(1);
});
