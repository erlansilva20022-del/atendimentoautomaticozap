# FC Artes Digitais — Atendimento Automático de WhatsApp

Sistema completo de atendimento via WhatsApp Business para retratos de casal:
o cliente envia as fotos originais, escolhe o estilo, recebe a **prévia com marca
d'água primeiro**, aprova, paga — e só então recebe o **HD original sem marca**.

Tudo roda **localmente no PC do dono** (Windows). Nada vai para nuvem pública,
nenhuma foto de cliente é enviada para serviço externo sem autorização.

## O fluxo

1. Cliente manda mensagem → saudação + tabela de preços (PT-BR ou ES-MX conforme o número).
2. Pergunta o estilo: **caricatura** ou **foto de estúdio profissional**.
3. Aguarda **todas** as fotos. O cliente avisa com `pronto` / `listo`.
4. Gera o retrato **só a partir das fotos daquele cliente**, preservando o rosto.
5. Cria a prévia com a marca `PRÉVIA — FC ARTES DIGITAIS` grande e centralizada
   sobre a imagem, e envia como **foto** no WhatsApp (nunca figurinha).
6. Cliente aprova com frase clara (`gostei`, `aprovado`, `sí, me gustó`, `hermosa`…).
   Silêncio ou só emoji **não** é aprovação. `Gostei mas...` = nova versão.
7. Só após a aprovação, o sistema envia a mensagem de pagamento
   (México: Oxxo/transferência; Brasil: PIX).
8. Pagamento é confirmado **somente** pelo dono (dashboard/API) — um `paguei`
   do cliente nunca confirma pagamento.
9. Após `PAGAMENTO_CONFIRMADO`, envia o HD original sem marca.

## Estados do pedido

```
NOVO → CONTATO_VALIDADO → ORIGINAL_BAIXADA → REFERENCIAS_VALIDAS →
PREVIA_GERADA → PREVIA_BAIXADA → ANEXO_CONFERIDO → PREVIA_ENVIADA →
AGUARDANDO_APROVACAO → APROVADO → AGUARDANDO_PAGAMENTO →
PAGAMENTO_CONFIRMADO → FINAL_ENTREGUE
```

Qualquer problema vai para `REVISAO` (sem reenvio automático).
Nenhum estado pode ser pulado — a transição é validada em `src/db.js`.

## Preços

| Qtd. | México (MXN) | Brasil (BRL) |
|-----:|-------------:|-------------:|
| 1 | $75 | R$ 9,90 |
| 2 | $100 | — |
| 3 | $139 | R$ 25 |
| 5 | $169 | R$ 35 |
| 10 | $299 | — |

## Instalação (Windows)

```bat
cd C:\caminho\atendimentoautomaticozap
npm install
copy .env.example .env
notepad .env
```

Preencha no `.env`: `QUACK_API_KEY`, `PIX_KEY` e troque o `ADMIN_TOKEN`.
Sem `QUACK_API_KEY`, a geração fica indisponível com erro claro — o sistema
**nunca inventa um rosto nem devolve imagem falsa**.

## Como rodar

```bat
npm start
```

Na primeira vez, aparece um **QR Code no terminal**: escaneie com o WhatsApp
Business do celular (o mesmo número do atendimento). A sessão fica salva na
pasta `session/` — não apague.

- Dashboard: http://localhost:3008
- Health: http://localhost:3008/health

## Endpoints (API)

| Método | Rota | Para quê |
|---|---|---|
| GET | `/health` | versão, `frontdeskMode: "muse"`, status do banco |
| GET | `/` | dashboard (lista pedidos, botões de ação) |
| GET | `/api/orders` | lista de pedidos |
| GET | `/api/orders/:id` | status, fotos e eventos do pedido |
| POST | `/api/muse/orders` | handoff do Muse: cria/recupera pedido por `{phone, observedClock, text}` (sem messageId nativo — fingerprint telefone+hora+texto) |
| POST | `/api/muse/order-result` | handoff do Muse: recebe a imagem gerada `{orderId, phone, source:"MUSE", sourceSha256, image}` (dataUrl ou base64); confere o SHA-256 e salva o original |
| POST | `/api/orders/:id/confirm-payment` | admin — confirma pagamento |
| POST | `/api/orders/:id/send-preview` | admin — envia a prévia com marca |
| POST | `/api/orders/:id/send-final` | admin — envia o HD (só após pagamento confirmado) |

Rotas de admin exigem o header `x-admin-token: <ADMIN_TOKEN>`.
Todas as rotas têm anti-duplicação por pedido + SHA-256.

## Pasta do Muse

O sistema vigia `storage/muse-inbox/` a cada 8 segundos. Imagens novas cujo
nome contenha o UUID de um pedido são importadas como original daquele pedido.
Arquivos sem UUID são ignorados com segurança.

## Regras de segurança (nunca quebrar)

- Nunca enviar o HD sem marca antes do pagamento confirmado.
- Nunca reutilizar a foto de um cliente em outro pedido.
- Nunca inventar rosto, preço, número de pedido ou comprovante.
- Nunca digitar caminho de arquivo na conversa do WhatsApp.
- Nunca enviar para conversa bloqueada sem autorização do dono.
- Fotos de clientes ficam em `storage/` (local) e nunca sobem para o Git
  (ver `.gitignore`).
