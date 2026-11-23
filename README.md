# FC Core — Atendimento Automático de WhatsApp

Sistema completo de atendimento via WhatsApp Business para retratos de casal:
o cliente envia as fotos originais, escolhe o estilo, recebe a **prévia com marca
d'água primeiro**, aprova, paga — e só então recebe o **HD original sem marca**.

Tudo roda **localmente no PC do dono** (Windows). Nada vai para nuvem pública,
nenhuma foto de cliente é enviada para serviço externo sem autorização.

## Arquitetura — FC Core v2.0.0 (um backend, uma extensão, um painel)

```
WhatsApp Web (1 aba) ──┐
                       ├─► FC Core 3008 (backend único: banco, arquivos, fila, segurança)
Muse (1 aba) ──────────┘        ▲
                                │  extensão única (captura + envio de prévia)
                         Painel único: http://localhost:3008
```

- **Um backend:** FC Core na porta **3008** (banco SQLite, arquivos, fila,
  registro de envios, lease de executor). A antiga **FC Bridge 3007** não é
  mais um serviço ativo no fluxo: seu histórico é importado para a 3008
  (ver "Importação do histórico da Bridge 3007" abaixo) e ela fica apenas
  como compatibilidade, sem envios próprios.
- **Uma extensão:** a extensão unificada do Chrome captura mensagens e fotos
  e executa os envios autorizados. A extensão antiga fica instalada, porém
  **desativada**, como reserva.
- **Um painel:** http://localhost:3008 reúne pedidos, originais, prévias,
  aprovações, pagamentos, erros, registro de envios e saúde do sistema.
  O painel **não precisa ficar aberto** para a automação funcionar.
- **O que continua separado:** a aba do WhatsApp Web e a aba do Muse são
  aplicações independentes e continuam como duas abas distintas. Meta diária:
  **2 abas** (WhatsApp + Muse), 3 com o painel.

## O que foi consolidado na v2.0.0 (antes era gambiarra, agora é sistema)

- **Registro de envios (anti-duplicação):** cada envio tem chave única por
  (pedido, ação, tipo de imagem, SHA-256). Duplicata é recusada antes de
  mandar; envio só é confirmado com evidência verificável (id da mensagem
  no WhatsApp); resultado incerto joga o pedido para `REVISAO` sem reenvio
  automático. Ver no painel: seção "Envios recentes" e detalhe do pedido.
- **Lease de executor único:** só uma instância da extensão detém o envio de
  uma conversa por vez (com expiração). Outra instância é recusada com 409.
- **Importação do histórico da Bridge 3007:** registros antigos entram como
  histórico, nunca sobrescrevem o progresso da 3008 e nunca criam segundo
  pedido para o mesmo UUID; fotos só entram com SHA-256 conferido antes e
  depois da cópia; conflitos vão para revisão manual.
- **Saúde e fila:** `/health` mostra versão, banco, profundidade da fila,
  leases ativos, estado do envio automático e contagem por status.
- **Início automático:** ver `docs/autostart-windows.md` (Agendador de
  Tarefas ou NSSM, logs e backup completo dos dois bancos com WAL).

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
| GET | `/health` | versão, `frontdeskMode: "muse"`, banco, fila, leases, envio automático, contagem por status |
| GET | `/` | painel de operações (pedidos, detalhe, envios, erros, importação) |
| GET | `/api/orders` | lista de pedidos |
| GET | `/api/orders/:id` | status, fotos, eventos e registro de envios do pedido |
| GET | `/api/ledger` | registro de envios (`?orderId=` filtra por pedido) |
| GET | `/api/leases/:phone` | lease ativo da conversa (se houver) |
| POST | `/api/leases/acquire` | extensão adquire o lease da conversa `{phone, executorId, ttlSeconds?}` (token da ponte) |
| POST | `/api/leases/release` | extensão libera o lease `{phone, executorId}` (token da ponte) |
| POST | `/api/muse/orders` | handoff do Muse: cria/recupera pedido por `{phone, observedClock, text}` (sem messageId nativo — fingerprint telefone+hora+texto) |
| POST | `/api/muse/order-result` | handoff do Muse: recebe a imagem gerada `{orderId, phone, source:"MUSE", sourceSha256, image}` (dataUrl ou base64); confere o SHA-256 e salva o original |
| GET | `/api/orders/:id/preview-file` | baixa a prévia com marca (token da ponte) |
| POST | `/api/orders/:id/mark-preview-sent` | extensão confirma o envio da prévia com evidência `{whatsappMessageId, executorId?}` (token da ponte) |
| POST | `/api/orders/:id/mark-final-sent` | extensão confirma o envio do HD com evidência (token da ponte) |
| POST | `/api/orders/:id/confirm-payment` | admin — confirma pagamento |
| POST | `/api/orders/:id/send-preview` | admin — envia a prévia com marca (trava anti-duplicação + lease) |
| POST | `/api/orders/:id/send-final` | admin — envia o HD (só após pagamento confirmado; trava anti-duplicação + lease) |
| POST | `/api/admin/import-bridge3007` | admin — importa o histórico da Bridge 3007 a partir de um JSON exportado |
| GET | `/api/admin/import-conflicts` | admin — conflitos da importação, para revisão manual |

Rotas de admin exigem o header `x-admin-token: <ADMIN_TOKEN>`.
Rotas da ponte exigem o header `x-bridge-token: <BRIDGE_TOKEN>` quando ele está
configurado. Todas as rotas têm anti-duplicação por pedido + SHA-256, e os
envios passam pelo registro de envios: duplicata, envio em andamento, envio
incerto anterior ou lease de outro executor recusam o envio antes de mandar.

## Importação do histórico da Bridge 3007

A Bridge 3007 tem banco e máquina de estados próprios — a migração não copia
o arquivo do banco. Exporte os pedidos antigos para JSON (formato em
`src/migrate3007.js`) e importe pelo painel (seção "Importar histórico") ou
pelo script:

```bat
set ADMIN_TOKEN=seu-token
node scripts\import-bridge3007.js C:\caminho\bridge3007-export.json
```

Regras da importação: UUID que já existe na 3008 vira **conflito** (nunca
sobrescreve, nunca duplica); fotos só entram com arquivo real e SHA-256
conferido antes e depois da cópia; eventos antigos entram com o prefixo
`3007:`. Conflitos aparecem no painel, em "Erros e revisão".

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
