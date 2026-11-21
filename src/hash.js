// Hash SHA-256 de arquivos e buffers — usado para validar entregas e evitar duplicatas.
const crypto = require('crypto');
const fs = require('fs');

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return sha256Buffer(buffer);
}

module.exports = { sha256Buffer, sha256File };
