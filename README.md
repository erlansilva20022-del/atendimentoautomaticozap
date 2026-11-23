# FC Core — Atendimento Automático de WhatsApp

Sistema completo de atendimento via WhatsApp Business para retratos de casal:
o cliente envia as fotos originais, escolhe o estilo, recebe a **prévia com marca
d'água primeiro**, aprova, paga — e só então recebe o **HD original sem marca**.

Tudo roda **localmente no PC do dono** (Windows). Nada vai para nuvem pública,
nenhuma foto de cliente é enviada para serviço externo sem autorização.

## Arquitetura — FC Core v2.1.2 (um backend, uma extensão, um painel)

```
WhatsApp Web (1 aba) ──┐
                       ├─► FC Core 3008 (backend único: banco, arquivos, fila, segurança)
Muse (1 aba) ──────────┘        ▲
                                │  extensão única (captura + envio de prévia)
                         Painel único: http://localhost:3008
```

- **Um backend:** FC Core na porta **3008** (banco SQLite, arquivos, fila
  persistente, registro de envios, lease de executor). A antiga **FC Bridge 3007** não é
  mais um serviço ativo no fluxo: seu histórico é importado para a 3008
  (ver "Importação do histórico da Bridge 3007" abaixo) e ela fica apenas
  como compatibilidade, sem envios próprios.
- **Uma extensão:** a extensão unificada do Chrome captura mensagens e fotos
  e executa os envios autorizados. A extensão antiga fica instalada, porém
  **desativada**, como reserva.
- **Um painel:** http://localhost:3008 reúne pedidos, originais, prévias,
  aprovações, pagamentos, erros, registro de envios, fila de trabalhos e
  saúde do sistema. O painel **não precisa ficar aberto** para a automação
  funcionar.
- **O que continua separado:** a aba do WhatsApp Web e a aba do Muse são
  aplicações independentes e continuam como duas abas distintas. Meta diária:
  **2 abas** (WhatsApp + Muse), 3 com o painel.
- **Fonte única da verdade:** o FC Core decide e registra; o Muse decide e
  produz (geração e atendimento); a extensão só executa no WhatsApp. Nenhum
  dos três decide o trabalho do outro sem coordenação.

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

## O que mudou na v2.1.0 (estabilidade — fecha as brechas da v2.0.0)

- **Fila persistente de trabalhos (`jobs`):** todo trabalho vive no SQLite e
  sobrevive a reinício do processo — nada fica só em memória. Cada trabalho
  tem id, pedido, etapa, tipo, tentativas, prazo, responsável, resultado e
  motivo da falha. O worker processa um trabalho por vez. Retry difere por
  tipo: leituras/downloads/verificações tentam até 3 vezes com espera
  crescente; **envio de foto nunca repete automaticamente** — falha vira
  `needs_review` e o pedido vai para `REVISAO`. Ver no painel: seção
  "Fila de trabalhos" e detalhe do pedido. Endpoints: `POST /api/jobs`
  (admin), `GET /api/jobs`, `GET /api/jobs/:id`.
- **Lease obrigatório (brecha b):** envio automático (com `executorId`) EXIGE
  um lease válido detido por aquele executor para aquela conversa — não basta
  "não haver outro lease". Sem lease, o envio é recusado com 409
  (`no_lease`). Envio manual do dono (sem `executorId`) continua sem lease.
- **Retomada segura (brecha c):** um envio `pending` só pode ser retomado
  pelo MESMO executor, com um lease válido recém-adquirido e revalidando
  telefone/arquivo/hash. Qualquer outra tentativa é recusada como
  `in_progress`. Se o resultado anterior foi incerto, o pedido está em
  `REVISAO` e não há retomada automática.
- **Uma operação por vez (brecha d):** só um envio em andamento por
  (pedido, ação, versão da imagem) — a segunda tentativa é recusada com 409.
- **Evidência obrigatória (brecha a):** `mark-preview-sent` e
  `mark-final-sent` EXIGEM `whatsappMessageId` — sem evidência verificável,
  a confirmação é recusada com 400. Existe uma rota separada de override,
  só admin, que registra QUEM confirmou e POR QUÊ
  (`POST /api/orders/:id/mark-preview-sent-override` com `reason` e
  `overriddenBy`) — nunca usada pelo fluxo automático.
- **Reconciliação de envios históricos:** `POST /api/admin/reconcile-historical-sends`
  registra no ledger envios confirmados antes da v2.0.0, SEM reenviar arquivos
  e SEM mudar o estado de nenhum pedido. Cada entrada precisa de pedido,
  telefone, ação, tipo de imagem, SHA-256 (que deve pertencer a uma foto
  registrada do pedido) e `whatsappMessageId`. Sem evidência suficiente, a
  entrada fica como `review` (só revisão manual) e NÃO entra no ledger.
  Relatório em `GET /api/admin/reconciliation-report`. Atenção: NÃO usar
  `mark-preview-sent` para "refazer" o fluxo de pedidos que já estão
  aguardando aprovação — a reconciliação registra o passado, não simula
  um envio novo.
- **Fila honesta no `/health`:** `queueDepth` conta SÓ trabalhos pendentes
  da fila persistente — arquivos antigos na muse-inbox não entram na fila
  (são rastreados à parte, na tabela `processed_inbox_files`).
- **Vigia atômico da pasta do Muse:** o arquivo só é importado após
  validação de escrita completa (tamanho e data estáveis entre duas leituras);
  a cópia é feita para arquivo temporário com fsync e renomeada para um
  destino imutável (nome inclui o hash); o hash é conferido depois da cópia;
  deduplicação persistente por SHA-256. Arquivos já importados/ignorados
  nunca são reprocessados, mesmo após reiniciar o processo.
- **Saúde e monitoramento:** `/health` agora mostra separadamente o estado
  do Core, da extensão e da sessão do WhatsApp (via heartbeat da extensão —
  `POST /api/extension/heartbeat`), espaço livre em disco com alerta quando
  baixo (`DISK_WARN_FREE_GB`, padrão 5 GB), último backup registrado
  (`POST /api/admin/record-backup`), contagens de envios confirmados /
  incertos / bloqueados e idade do trabalho pendente mais antigo.
- **Log estruturado:** linhas em JSON com `correlationId` = UUID do pedido
  em todo log referente a um pedido. Tokens e segredos nunca entram no log.
- **Autenticação em rotas de dados do cliente:** pedidos, detalhe, fotos,
  registro de envios, leases e trabalhos da fila exigem token de admin OU
  token da ponte. `/health` continua público (monitoramento).

## O que mudou na v2.1.1 (reserva atômica de envio — fecha a brecha da v2.1.0)

Na v2.1.0 a confirmação exigia `whatsappMessageId`, mas `mark-preview-sent`
ainda podia registrar um envio confirmado sem nenhuma reserva prévia no ledger
e sem provar que o executor detinha um lease válido. A v2.1.1 fecha isso:

- **Reserva atômica de envio:** `POST /api/sends/reserve` (token da ponte).
  A extensão reserva ANTES de clicar no WhatsApp. A reserva só é criada se
  o executor detém um lease válido da conversa, não há envio confirmado /
  incerto / em andamento (reserva viva) para a chave e o hash pertence a uma
  foto registrada do pedido, com o tipo certo (para `final`, o hash é o da
  versão do conjunto de fotos finais). A checagem e a criação acontecem numa
  só transação — duas extensões não reservam a mesma chave ao mesmo tempo.
  Corpo: `{orderId, phone, action, imageKind, imageSha256, executorId,
  ttlSeconds?}` (padrão 600 s = 10 min, `RESERVATION_TTL_SECONDS`).
  Resposta: `{reservationId, dedupKey, expiresAt}`. Segunda reserva para a
  mesma chave com uma reserva viva é recusada com 409 (`in_progress`); sem
  lease, 409 (`no_lease`); hash não registrado, 400.
  Fluxo completo da extensão: `acquire lease` → `reserve` → clica no
  WhatsApp → `mark-preview-sent {reservationId, whatsappMessageId}`.
- **Confirmação exige reserva:** `mark-preview-sent` e `mark-final-sent` só
  confirmam com um `reservationId` válido — reserva `pending`, do mesmo
  executor, com o lease ainda válido e dentro do TTL. Sem reserva → 409
  (`no_reservation`). Reserva expirada → 409 (`reservation_expired`) e o
  envio vai para `uncertain` + pedido em `REVISAO` (o clique pode ter
  acontecido e a confirmação chegado tarde — só revisão manual resolve).
  Lease inválido na confirmação → 409 (`no_lease`) e a reserva continua viva
  até expirar (a extensão pode renovar o lease e tentar de novo). Confirmar
  de novo com a mesma evidência continua idempotente. O override de admin
  continua como estava (registra quem e por quê, nunca automático).
- **Envios interrompidos por reinício:** na inicialização, trabalhos de envio
  (`send_preview`/`send_final`) que ficaram `in_progress` vão DIRETO para
  `needs_review` — nunca voltam automaticamente para a fila. O worker também
  não reenfileira mais envios travados (só leituras/downloads/verificações
  voltam, com backoff). Um envio interrompido tem resultado desconhecido —
  só revisão manual, com conferência no histórico do WhatsApp, decide.
- **Heartbeat com expiração no `/health`:** sem heartbeat dentro de
  `HEARTBEAT_TTL_SECONDS` (padrão 120 s), a extensão vira `stale` e a sessão
  do WhatsApp vira `unknown` — nunca é mostrada como autenticada
  indefinidamente. O `/health` expõe `heartbeatTtlSeconds`, `heartbeatAgeMs`
  e `lastHeartbeat`.
- **Reconciliação com validação estrita:** cada entrada de
  `POST /api/admin/reconcile-historical-sends` agora valida que o tipo da
  imagem é o tipo da foto registrada com aquele hash (`image_kind_nao_confere`
  se o hash for de outro tipo), que o telefone é o do pedido e que o
  `whatsappMessageId` tem o formato real do WhatsApp Web (prefixo `wamid.` —
  texto genérico vira `evidencia_invalida`). Cada falha vira `review` com o
  motivo específico, nunca confirmado.
- **`/api/muse/orders` continua sem token nesta versão** — decisão consciente,
  mantida na v2.1.1: o GPT recomendou exigir `x-bridge-token` só numa
  atualização coordenada com a extensão unificada, que ainda não está pronta.
  Reavaliar quando a extensão unificada estiver instalada.

## O que mudou na v2.1.2 (envio incerto registrado no Core — fecha a brecha da v2.1.1)

Na v2.1.1 a extensão já travava o reenvio localmente quando um clique no
WhatsApp produzia um resultado desconhecido, mas o Core não tinha como saber:
uma reserva `pending` expirada podia ser renovada mesmo depois de um clique
incerto — a proteção existia só na extensão. A v2.1.2 fecha isso:

- **`POST /api/sends/uncertain` (token da ponte):** a extensão registra o
  `uncertain` IMEDIATAMENTE após um clique sem confirmação (timeout, erro,
  resposta ambígua). Corpo: `{reservationId, executorId, reason?}`. O Core
  marca o ledger como `uncertain`, joga o pedido para `REVISAO` e INVALIDA a
  reserva (status `uncertain` + expiração imediata). Nenhum `confirm` nem
  `renew` com aquele `reservationId` passa mais: `confirmReservedSend`
  recusa registros `uncertain` e `reserveSend` recusa renovar uma chave
  incerta. Reserva inexistente → 404; já confirmado → 409
  (`already_confirmed`); executor diferente do que reservou → 409
  (`executor_mismatch`). Chamar de novo com a mesma reserva é idempotente
  (devolve o registro existente, `duplicate: true`). Fluxo da extensão:
  `acquire lease` → `reserve` → clica no WhatsApp → se o resultado for
  desconhecido, `POST /api/sends/uncertain {reservationId, executorId,
  reason}` na hora (não espera a reserva expirar).

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
| GET | `/health` | versão, `frontdeskMode: "muse"`, banco, fila persistente (só trabalhos pendentes), leases, envio automático, contagem por status, envios confirmados/incertos/bloqueados, estados do Core/extensão/sessão WhatsApp (heartbeat com expiração — `stale`/`unknown` sem heartbeat no TTL), disco livre, último backup |
| GET | `/` | painel de operações (pedidos, detalhe, envios, fila de trabalhos, erros, importação) |
| GET | `/api/orders` | lista de pedidos (autenticada: admin ou ponte) |
| GET | `/api/orders/:id` | status, fotos, eventos, registro de envios e trabalhos da fila do pedido (autenticada) |
| GET | `/api/ledger` | registro de envios (`?orderId=` filtra por pedido) (autenticada) |
| GET | `/api/leases/:phone` | lease ativo da conversa (se houver) (autenticada) |
| POST | `/api/leases/acquire` | extensão adquire o lease da conversa `{phone, executorId, ttlSeconds?}` (token da ponte) |
| POST | `/api/leases/release` | extensão libera o lease `{phone, executorId}` (token da ponte) |
| POST | `/api/sends/reserve` | **v2.1.1** — extensão reserva o envio antes de clicar no WhatsApp `{orderId, phone, action, imageKind, imageSha256, executorId, ttlSeconds?}` (token da ponte) — devolve `{reservationId, dedupKey, expiresAt}` |
| POST | `/api/sends/uncertain` | **v2.1.2** — extensão registra o envio incerto no Core imediatamente após um clique sem confirmação `{reservationId, executorId, reason?}` (token da ponte) — ledger vira `uncertain`, reserva invalidada, pedido em REVISAO; idempotente |
| POST | `/api/jobs` | admin — cria um trabalho na fila persistente `{orderId, step, kind, payload?, owner?, maxAttempts?, deadline?}` |
| GET | `/api/jobs` | trabalhos da fila (`?status=` `?orderId=`) (autenticada) |
| GET | `/api/jobs/:id` | um trabalho da fila (autenticada) |
| POST | `/api/extension/heartbeat` | extensão informa estado: `{executorId, whatsappAuthenticated, autoSend, lastCaptureAt}` (token da ponte) |
| POST | `/api/admin/record-backup` | admin — registra quando o último backup foi feito `{at?, path?}` |
| POST | `/api/muse/orders` | handoff do Muse: cria/recupera pedido por `{phone, observedClock, text}` (sem messageId nativo — fingerprint telefone+hora+texto) |
| POST | `/api/muse/order-result` | handoff do Muse: recebe a imagem gerada `{orderId, phone, source:"MUSE", sourceSha256, image}` (dataUrl ou base64); confere o SHA-256 e salva o original |
| GET | `/api/orders/:id/preview-file` | baixa a prévia com marca (token da ponte) |
| POST | `/api/orders/:id/mark-preview-sent` | extensão confirma o envio da prévia **com reserva prévia** `{reservationId, whatsappMessageId, executorId?}` (token da ponte) — `reservationId` e `whatsappMessageId` são obrigatórios; reserva expirada → 409 `reservation_expired` + pedido em REVISAO |
| POST | `/api/orders/:id/mark-final-sent` | extensão confirma o envio do HD **com reserva prévia** `{reservationId, whatsappMessageId, executorId?}` (token da ponte) — mesmos requisitos da prévia |
| POST | `/api/orders/:id/mark-preview-sent-override` | admin — confirmação manual do dono sem whatsappMessageId, com `{reason, overriddenBy}` registrados; nunca usada pelo fluxo automático |
| POST | `/api/orders/:id/confirm-payment` | admin — confirma pagamento |
| POST | `/api/orders/:id/send-preview` | admin — envia a prévia com marca (trava anti-duplicação + lease) |
| POST | `/api/orders/:id/send-final` | admin — envia o HD (só após pagamento confirmado; trava anti-duplicação + lease) |
| POST | `/api/admin/import-bridge3007` | admin — importa o histórico da Bridge 3007 a partir de um JSON exportado |
| GET | `/api/admin/import-conflicts` | admin — conflitos da importação, para revisão manual |
| POST | `/api/admin/reconcile-historical-sends` | admin — registra envios históricos confirmados no ledger, sem reenviar e sem mudar estados `{entries: [{orderId, phone, action, imageKind, sha256, whatsappMessageId}]}` — validação estrita (v2.1.1): tipo da imagem precisa ser o da foto registrada com aquele hash, telefone precisa ser o do pedido, `whatsappMessageId` precisa ter o formato `wamid.`; cada falha vira `review` com o motivo |
| GET | `/api/admin/reconciliation-report` | admin — resumo da reconciliação (confirmados, em revisão, ignorados) |

Rotas de admin exigem o header `x-admin-token: <ADMIN_TOKEN>`.
Rotas da ponte exigem o header `x-bridge-token: <BRIDGE_TOKEN>` quando ele está
configurado. Rotas de dados do cliente (pedidos, detalhe, registro de envios,
leases, trabalhos) aceitam **admin OU ponte**. Todas as rotas têm anti-duplicação
por pedido + SHA-256, e os envios passam pelo registro de envios: duplicata,
envio em andamento, envio incerto anterior, reserva ausente/expirada ou lease ausente/inválido recusam
o envio antes de mandar.

## Modelo de autenticação (v2.1.1)

| Quem | Header | Acessa |
|---|---|---|
| Dono (painel) | `x-admin-token` | tudo, incluindo admin, override e reconciliação |
| Extensão (ponte) | `x-bridge-token` | ordem-result, prévia, confirmação de envio, lease, heartbeat, leitura de dados do cliente |
| Monitoramento | — | só `/health` (público) |
| Ninguém (sem token) | — | nada que exponha dados de cliente — 401 |

`POST /api/muse/orders` continua sem token (é a ingestão da ponte, com
fingerprint telefone+hora+texto para deduplicar) — decisão consciente, mantida
na v2.1.1: o GPT recomendou exigir `x-bridge-token` só numa atualização
coordenada com a extensão unificada, que ainda não está pronta. Reavaliar
quando a extensão unificada estiver instalada. O backend ouve só em
`127.0.0.1` quando usado localmente; nunca exponha a porta 3008 na rede.

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

Na v2.1.0 o vigia é atômico e persistente: o arquivo só entra após validação
de escrita completa (tamanho estável entre duas leituras); a cópia vai para
um arquivo temporário com fsync e é renomeada para um destino imutável (o
nome inclui o hash); o hash é conferido depois da cópia; arquivos já
importados, duplicados ou ignorados ficam registrados na tabela
`processed_inbox_files` e nunca são reprocessados — nem após reiniciar o
processo. A fila do `/health` NÃO conta arquivos da inbox: só trabalhos
pendentes da fila persistente contam.

## Reconciliação de envios históricos

Os envios feitos antes da v2.0.0 não estão no registro de envios. Para
protegê-los contra duplicação, registre-os com evidência:

```bat
set ADMIN_TOKEN=seu-token
curl -X POST http://localhost:3008/api/admin/reconcile-historical-sends ^
  -H "x-admin-token: %ADMIN_TOKEN%" -H "Content-Type: application/json" ^
  -d "{\"entries\":[{\"orderId\":\"<uuid>\",\"phone\":\"+558592019111\",\"action\":\"preview\",\"imageKind\":\"preview\",\"sha256\":\"<hash da foto registrada>\",\"whatsappMessageId\":\"wamid....\"}]}"
```

Regras: o SHA-256 precisa pertencer a uma foto registrada do pedido; sem
`whatsappMessageId` a entrada fica como `review` e NÃO entra no ledger;
chave já registrada vira `skipped`; **o estado do pedido nunca muda**.
Relatório em `GET /api/admin/reconciliation-report`. Casos sem evidência
suficiente ficam em revisão — não invente `whatsappMessageId`.

## Regras de segurança (nunca quebrar)

- Nunca enviar o HD sem marca antes do pagamento confirmado.
- Nunca reutilizar a foto de um cliente em outro pedido.
- Nunca inventar rosto, preço, número de pedido ou comprovante.
- Nunca digitar caminho de arquivo na conversa do WhatsApp.
- Nunca enviar para conversa bloqueada sem autorização do dono.
- Fotos de clientes ficam em `storage/` (local) e nunca sobem para o Git
  (ver `.gitignore`).
