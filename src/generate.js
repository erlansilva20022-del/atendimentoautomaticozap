// Adaptador de geração de imagens (QuackAPI).
// Regra de segurança: sem QUACK_API_KEY, a geração fica indisponível com erro claro.
// NUNCA inventar um rosto nem devolver imagem falsa/genérica.
const { config } = require('./config');

const STYLE_PROMPTS = {
  caricatura: {
    pt: 'Caricatura romântica de casal, abraçados, roupas claras, fundo de pôr do sol, preservando rostos, olhos, nariz, boca, pele, cabelo e idade dos dois.',
    es: 'Caricatura romántica de pareja, abrazados, ropa clara, fondo de atardecer, preservando rostros, ojos, nariz, boca, piel, cabello y edad de los dos.',
  },
  studio: {
    pt: 'Foto de estúdio profissional, fundo cinza neutro, luz softbox suave, roupas elegantes simples, manter rigorosamente a identidade do rosto, olhos, nariz, boca, cabelo, barba, pele, idade, posição natural de cabeça, pescoço e mãos.',
    es: 'Foto de estudio profesional, fondo gris neutro, luz softbox suave, ropa elegante sencilla, mantener rigurosamente la identidad del rostro, ojos, nariz, boca, cabello, barba, piel, edad, posición natural de cabeza, cuello y manos.',
  },
};

// Gera o retrato a partir das fotos de referência do cliente.
// references: array de Buffers (bytes reais das fotos originais).
// Retorna um Buffer com os bytes da imagem gerada.
async function generatePortrait({ references, style, prompt, language = 'pt' }) {
  if (!config.quackApiKey) {
    throw new Error('geração indisponível: configure QUACK_API_KEY');
  }
  if (!config.quackApiUrl) {
    throw new Error('geração indisponível: configure QUACK_API_URL');
  }
  if (!references || references.length === 0) {
    throw new Error('geração indisponível: nenhuma foto de referência do cliente');
  }
  const stylePrompt =
    prompt || (STYLE_PROMPTS[style] || STYLE_PROMPTS.studio)[language] || STYLE_PROMPTS.studio.pt;

  const body = {
    prompt: stylePrompt,
    style,
    references: references.map((buf) => buf.toString('base64')),
  };

  const res = await fetch(config.quackApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.quackApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuackAPI falhou (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Aceita image em base64 ou dataUrl.
  const raw = data.image || data.dataUrl || data.data || null;
  if (!raw) throw new Error('QuackAPI não devolveu imagem');
  const base64 = String(raw).includes(',') ? String(raw).split(',').pop() : String(raw);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error('QuackAPI devolveu imagem vazia');
  return bytes;
}

module.exports = { generatePortrait, STYLE_PROMPTS };
