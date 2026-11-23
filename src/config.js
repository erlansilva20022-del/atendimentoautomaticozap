// Configuração central do FC Artes Digitais.
// Carrega variáveis de ambiente e centraliza preços, textos e regras de aprovação.
require('dotenv').config();
const path = require('path');

const config = {
  // Porta padrão 3008: a 3007 já é da FC Bridge 0.5.8 — nunca suba os dois na mesma porta.
  port: parseInt(process.env.PORT || '3008', 10),
  sessionPath: process.env.WHATSAPP_SESSION_PATH || './session',
  quackApiKey: process.env.QUACK_API_KEY || '',
  quackApiUrl: process.env.QUACK_API_URL || '',
  pixKey: process.env.PIX_KEY || '',
  databasePath: process.env.DATABASE_PATH || './data/fc-pedidos.db',
  museInboxDir: process.env.MUSE_INBOX_DIR || './storage/muse-inbox',
  adminToken: process.env.ADMIN_TOKEN || '',
  // Token opcional da ponte: se configurado, /api/muse/order-result exige o header x-bridge-token.
  bridgeToken: process.env.BRIDGE_TOKEN || '',
  // Cliente WhatsApp próprio: DESLIGADO por padrão (WHATSAPP_ENABLED=true para ligar).
  // Enquanto o Muse é o atendente, este processo não deve abrir outra sessão de WhatsApp.
  whatsappEnabled: process.env.WHATSAPP_ENABLED === 'true',
  // Respostas automáticas no WhatsApp: DESLIGADO por padrão enquanto o Muse é o atendente
  // principal — ligar (AUTO_REPLY_ENABLED=true) só quando este sistema assumir o atendimento.
  autoReplyEnabled: process.env.AUTO_REPLY_ENABLED === 'true',
  // FC Core v2.0.0 — lease de executor único (TTL em segundos; padrão 120s).
  leaseTtlSeconds: parseInt(process.env.LEASE_TTL_SECONDS || '120', 10),
  version: '2.0.0',
  // Modo de atendimento: o Muse é o atendente principal; o backend só faz logística de imagem.
  frontdeskMode: 'muse',
};

// Tabela de preços — México (MXN). Valores já usados nos atendimentos reais.
const PRICES_MX = [
  { quantity: 1, price: 75 },
  { quantity: 2, price: 100 },
  { quantity: 3, price: 139 },
  { quantity: 5, price: 169 },
  { quantity: 10, price: 299 },
];

// Tabela de preços — Brasil (BRL, via PIX).
const PRICES_BR = [
  { quantity: 1, price: 9.9 },
  { quantity: 3, price: 25 },
  { quantity: 5, price: 35 },
];

// Estilos que o cliente pode escolher. Perguntar sempre antes de gerar.
const STYLES = {
  caricatura: { pt: 'Caricatura', es: 'Caricatura' },
  studio: { pt: 'Foto de estúdio profissional', es: 'Foto de estudio profesional' },
};

// Frases que contam como aprovação CLARA da prévia mais recente.
// Silêncio ou só emoji NÃO é aprovação. "Gostei mas..." pede nova versão.
const APPROVAL_PHRASES = [
  'gostei', 'aprovado', 'aprovada', 'aprovei', 'perfeito', 'perfeita',
  'amei', 'lindo', 'linda', 'maravilhoso', 'maravilhosa', 'excelente',
  'sí, me gustó', 'si, me gustó', 'sí me gustó', 'si me gustó', 'me gustó',
  'me gusto', 'me encantó', 'me encanto', 'hermosa', 'hermoso', 'hermoso',
  'excelente', 'perfecto', 'perfecta', 'aprobado', 'aprobada', 'apruebo',
  'quedó bien', 'quedo bien', 'me encanta', 'está bien', 'esta bien',
  'quero', 'vou pagar', 'voy a pagar', 'pode enviar', 'puedes enviar',
];
// Palavras que transformam um "gostei" em pedido de ajuste (nova versão + nova aprovação).
const ADJUSTMENT_MARKERS = ['mas', 'porém', 'porem', 'só', 'so', 'só que', 'pero', 'solo', 'sin', 'sem', 'tira', 'quita', 'remove', 'remova', 'corrigir', 'corregir', 'arreglar', 'ajeitar', 'mudar', 'cambiar'];

function priceFor(language, quantity) {
  const table = language === 'es' ? PRICES_MX : PRICES_BR;
  const row = table.find((r) => r.quantity === quantity);
  return row ? row.price : null;
}

function formatPrice(language, price) {
  if (language === 'es') return `$${price} MXN`;
  return `R$ ${price.toFixed(2).replace('.', ',')}`;
}

module.exports = {
  config,
  PRICES_MX,
  PRICES_BR,
  STYLES,
  APPROVAL_PHRASES,
  ADJUSTMENT_MARKERS,
  priceFor,
  formatPrice,
  storageDir: path.resolve(__dirname, '..', 'storage'),
  originalsDir: path.resolve(__dirname, '..', 'storage', 'originals'),
  previewsDir: path.resolve(__dirname, '..', 'storage', 'previews'),
  finalsDir: path.resolve(__dirname, '..', 'storage', 'finals'),
};
