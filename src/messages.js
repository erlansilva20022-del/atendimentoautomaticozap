// Textos de atendimento — PT-BR (Brasil) e ES-MX (México).
// Saudação e preços diferem por país; o fluxo é o mesmo.
const { PRICES_MX, PRICES_BR, formatPrice } = require('./config');

function priceTable(language) {
  const table = language === 'es' ? PRICES_MX : PRICES_BR;
  return table
    .map((r) => `• ${r.quantity} ${r.quantity === 1 ? (language === 'es' ? 'foto' : 'foto') : (language === 'es' ? 'fotos' : 'fotos')} — ${formatPrice(language, r.price)}`)
    .join('\n');
}

const MESSAGES = {
  pt: {
    greeting: (name) =>
      `Olá${name ? `, ${name}` : ''}! 😊 Bem-vindo(a) à FC Artes Digitais.\n\nNossos retratos:\n${priceTable('pt')}\n\nPagamento via PIX. Qual estilo você prefere?`,
    askStyle:
      'Qual estilo você quer?\n1️⃣ Caricatura\n2️⃣ Foto de estúdio profissional\n\nMe diga o número ou o nome do estilo 🙂',
    askPhotos:
      'Perfeito! Agora envie TODAS as fotos que você quer no retrato. Pode mandar uma por uma — quando terminar, me avise com a palavra "pronto" que eu faço a montagem 😊',
    waitingPhotos:
      'Recebi sua foto! Se tiver mais fotos para o mesmo retrato, pode enviar. Quando terminar, escreva "pronto" 🙂',
    previewCaption: 'Aqui está sua prévia 😊 Você aprovou ou quer algum ajuste?',
    needApproval:
      'Para liberar o pagamento, preciso que você aprove a prévia. Você gostou ou quer algum ajuste?',
    payment: (quantity, price, pixKey) =>
      `Aprovado! 🎉\n\nSeu pedido: ${quantity} ${quantity === 1 ? 'foto' : 'fotos'} — ${formatPrice('pt', price)}.\n\nPagamento via PIX:\nChave PIX: ${pixKey}\n\nEnvie o comprovante aqui depois de pagar que eu libero as fotos originais sem a marca 😊`,
    adjustment:
      'Entendido! Vou fazer uma nova versão com esse ajuste. Assim que ficar pronta, te mando a nova prévia para aprovar 🙂',
    finalDelivery:
      'Pagamento confirmado! 🎉 Aqui estão suas fotos originais em alta qualidade, sem a marca. Obrigado pela preferência! 😊',
    generationFailed:
      'Desculpe, não consegui gerar seu retrato agora. Vou revisar e te aviso assim que estiver pronto 🙂',
    alreadyPaid: 'Seu pagamento já foi confirmado e as fotos já foram enviadas 😊',
  },
  es: {
    greeting: (name) =>
      `¡Hola${name ? `, ${name}` : ''}! 😊 Bienvenido(a) a FC Artes Digitais.\n\nNuestros retratos:\n${priceTable('es')}\n\nPago por Oxxo o transferencia. ¿Qué estilo prefieres?`,
    askStyle:
      '¿Qué estilo quieres?\n1️⃣ Caricatura\n2️⃣ Foto de estudio profesional\n\nDime el número o el nombre del estilo 🙂',
    askPhotos:
      '¡Perfecto! Ahora envía TODAS las fotos que quieres en el retrato. Puedes mandarlas una por una — cuando termines, avísame con la palabra "listo" y hago el montaje 😊',
    waitingPhotos:
      '¡Recibí tu foto! Si tienes más fotos para el mismo retrato, puedes enviarlas. Cuando termines, escribe "listo" 🙂',
    previewCaption: 'Aquí está tu previa 😊 ¿Te gustó o quieres algún ajuste?',
    needApproval:
      'Para liberar el pago, necesito que apruebes la previa. ¿Te gustó o quieres algún ajuste?',
    payment: (quantity, price, paymentInfo) =>
      `¡Aprobado! 🎉\n\nTu pedido: ${quantity} ${quantity === 1 ? 'foto' : 'fotos'} — ${formatPrice('es', price)}.\n\nPago por Oxxo o transferencia:\n${paymentInfo}\n\nEnvía el comprobante aquí después de pagar y te libero las fotos originales sin la marca 😊`,
    adjustment:
      '¡Entendido! Voy a hacer una nueva versión con ese ajuste. En cuanto esté lista, te mando la nueva previa para aprobar 🙂',
    finalDelivery:
      '¡Pago confirmado! 🎉 Aquí están tus fotos originales en alta calidad, sin la marca. ¡Gracias por tu preferencia! 😊',
    generationFailed:
      'Lo siento, no pude generar tu retrato ahora. Voy a revisarlo y te aviso en cuanto esté listo 🙂',
    alreadyPaid: 'Tu pago ya fue confirmado y las fotos ya fueron enviadas 😊',
  },
};

function t(language, key, ...args) {
  const lang = MESSAGES[language] ? language : 'pt';
  const value = MESSAGES[lang][key];
  return typeof value === 'function' ? value(...args) : value;
}

module.exports = { MESSAGES, priceTable, t };
