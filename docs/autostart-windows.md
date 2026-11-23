# FC Core — Início automático no Windows + backup

Este documento é para o PC do dono (Windows), onde roda o backend único
**FC Core na porta 3008**. O objetivo: o sistema subir sozinho ao ligar o PC,
sem depender de nenhuma aba aberta, e poder ser restaurado a partir de backup.

## Início automático (Agendador de Tarefas — recomendado)

O Agendador de Tarefas do Windows já vem no sistema e não precisa instalar nada.

1. Abra o **Agendador de Tarefas** (`taskschd.msc`).
2. **Criar Tarefa** (não "tarefa básica"):
   - Nome: `FC Core 3008`
   - Marque **"Executar com privilégios mais altos"** (opcional, recomendado).
   - Gatilho: **"Ao fazer logon"** do seu usuário.
   - Ação: **"Iniciar um programa"**
     - Programa: `C:\Program Files\nodejs\node.exe`
     - Argumentos: `C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\src\index.js`
     - Iniciar em: `C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap`
       (ajuste o caminho para onde o projeto foi instalado)
   - Configurações: marque **"Permitir que a tarefa seja executada sob demanda"**
     e **"Se a tarefa falhar, reiniciar a cada 1 minuto, até 3 vezes"**.
3. Teste: reinicie o PC (ou faça logoff/logon) e abra
   http://localhost:3008/health — deve responder `{"ok": true, "version": "2.0.0", ...}`.

### Alternativa: serviço do Windows (NSSM)

Se preferir rodar como serviço (sobe antes do logon):

1. Baixe o NSSM (https://nssm.cc) e coloque `nssm.exe` numa pasta fixa.
2. Como administrador:
   ```bat
   nssm install "FC Core 3008" "C:\Program Files\nodejs\node.exe" "C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\src\index.js"
   nssm set "FC Core 3008" AppDirectory "C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap"
   nssm set "FC Core 3008" AppStdout "C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\logs\fc-core.log"
   nssm set "FC Core 3008" AppStderr "C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\logs\fc-core-erros.log"
   nssm set "FC Core 3008" AppRestartDelay 5000
   nssm start "FC Core 3008"
   ```
3. Verifique em http://localhost:3008/health.

## Logs

- Com o Agendador de Tarefas, os logs vão para o **Histórico da tarefa** e para
  a saída do console (se redirecionada). Para registrar em arquivo, crie um
  `.bat` de inicialização:
  ```bat
  @echo off
  cd /d C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap
  if not exist logs mkdir logs
  "C:\Program Files\nodejs\node.exe" src\index.js >> logs\fc-core.log 2>&1
  ```
  e aponte a tarefa para esse `.bat`.
- Com NSSM, os logs estão em `logs\fc-core.log` e `logs\fc-core-erros.log`.
- O painel mostra erros recentes em http://localhost:3008 (seção "Erros e revisão").

## Backup (fazer antes de qualquer atualização)

Pare o backend antes de copiar o banco (ou copie também os arquivos WAL/SHM):

```bat
:: 1. Parar o backend (Agendador: desabilite a tarefa; NSSM: nssm stop "FC Core 3008")
:: 2. Copiar tudo para uma pasta de backup com a data, ex.: D:\Backup-FC\2026-11-22\
xcopy /E /I /Y C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\data D:\Backup-FC\2026-11-22\data
xcopy /E /I /Y C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\storage D:\Backup-FC\2026-11-22\storage
copy /Y C:\Projetos\FC-Automacao-Pedidos\atendimentoautomaticozap\.env D:\Backup-FC\2026-11-22\.env
:: 3. Banco da FC Bridge 3007 (histórico) — copiar o arquivo SQLite da pasta da Bridge
::    (o caminho exato é o da instalação da Bridge 0.5.8 no PC; inclua também o -wal e o -shm)
:: 4. Conferir: os arquivos fc-pedidos.db, fc-pedidos.db-wal e fc-pedidos.db-shm
::    devem estar todos no backup. Sem o -wal, transações recentes podem se perder.
:: 5. Subir o backend de novo e conferir http://localhost:3008/health
```

### O que entra no backup

| Item | Por quê |
|---|---|
| `data/fc-pedidos.db` + `-wal` + `-shm` | Pedidos, fotos, eventos, registro de envios, leases, conflitos |
| `storage/` (originais, prévias, finais, muse-inbox) | Arquivos das fotos — sem eles os hashes não conferem |
| `.env` | Tokens (ADMIN_TOKEN, BRIDGE_TOKEN), chaves, caminhos |
| Banco SQLite da Bridge 3007 (+ `-wal`/`-shm`) | Histórico antigo, para a importação/migração |
| `session/` (sessão do WhatsApp, se WHATSAPP_ENABLED=true) | Evita escanear o QR de novo |

## Restauração

1. Pare o backend.
2. Copie os arquivos do backup de volta para os mesmos caminhos.
3. Suba o backend e confira `/health` e o painel: os pedidos devem aparecer
   com os mesmos UUIDs e status de antes (conferir `AGUARDANDO_APROVACAO`
   dos pedidos 92402128 e 70b42417, se ainda estiverem pendentes).
4. Nunca restaure só o `.db` sem o `-wal`: copie os três arquivos juntos.

## Atualização do FC Core (ex.: 1.1.1 → 2.0.0)

1. Faça o backup completo acima.
2. Pare o backend.
3. Substitua os arquivos do projeto pela nova versão (sem apagar `data/`,
   `storage/`, `session/` nem `.env`).
4. Rode `npm install` (se o `package.json` mudou) e suba o backend.
5. Confira `/health` (deve mostrar a nova versão) e o painel.
6. Teste primeiro no número de teste do dono, depois no piloto limitado.
