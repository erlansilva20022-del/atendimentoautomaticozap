// Marca d'água da prévia: texto grande e centralizado SOBRE a imagem.
// Gera uma cópia *_previa.jpg — NUNCA sobrescreve o original.
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const WATERMARK_TEXT = 'PRÉVIA — FC ARTES DIGITAIS';

// Gera um SVG com o texto da marca, dimensionado para a imagem.
function watermarkSvg(width, height) {
  const fontSize = Math.max(28, Math.round(width / 14));
  const lineHeight = fontSize * 1.25;
  // Quebra em duas linhas para caber bem em retratos verticais.
  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .wm { font-family: Arial, Helvetica, sans-serif; font-size: ${fontSize}px; font-weight: bold;
          fill: rgba(255,255,255,0.85); stroke: rgba(0,0,0,0.75); stroke-width: ${Math.max(2, fontSize / 14)}px;
          paint-order: stroke; text-anchor: middle; }
  </style>
  <text x="50%" y="50%" class="wm">PRÉVIA — FC</text>
  <text x="50%" y="calc(50% + ${lineHeight}px)" class="wm">ARTES DIGITAIS</text>
</svg>`;
  return Buffer.from(svg);
}

// Cria a prévia com marca a partir do arquivo original.
// Retorna o caminho da prévia gerada.
async function applyWatermark(inputPath, outputPath) {
  const image = sharp(inputPath);
  const metadata = await image.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const overlay = watermarkSvg(width, height);
  await image
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outputPath);
  return outputPath;
}

// Conveniência: dada a foto original, gera a prévia ao lado dela (mesma pasta, sufixo _previa).
async function makePreview(inputPath) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(dir, `${base}_previa.jpg`);
  if (fs.existsSync(outputPath)) return outputPath; // idempotente
  return applyWatermark(inputPath, outputPath);
}

module.exports = { WATERMARK_TEXT, applyWatermark, makePreview };
