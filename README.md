# AI Connect

App de bandeja (Windows) que expõe, por HTTP em `127.0.0.1`, o assistente de IA de linha de comando já instalado e logado na máquina do usuário — **Claude Code**, **Codex**, **OpenCode**, **Gemini CLI** ou **Cursor Agent**. Qualquer página web aberta no navegador (de qualquer sistema rodando na rede local ou na própria máquina) pode pedir um texto gerado por IA sem que o sistema precise guardar, pagar ou gerenciar uma chave de API: quem gera a resposta é o assistente que a pessoa já usa no dia a dia, com o login e a assinatura dela.

Nasceu para o addon de RAG do ERP Sankhya ([`rag-snk`](https://github.com/FlavianoRS)), mas a API é genérica — serve para qualquer aplicação web (interna, SaaS on-premise, ferramenta interna) que precise gerar texto com IA sem integrar uma API paga.

## Por que isso existe

- **Sem chave de API no servidor.** Cada usuário usa o assistente e a conta que já tem instalada. O backend do seu sistema não guarda, não paga e não gerencia limite de nenhuma API de LLM.
- **Funciona com o que a pessoa já tem.** Detecta automaticamente qual assistente está instalado (Claude Code, Codex, OpenCode, Gemini CLI, Cursor Agent) e usa o primeiro disponível, com fallback para os próximos se um falhar ou estourar o limite de uso.
- **Isolado por padrão.** Cada pedido roda o assistente numa pasta temporária vazia, com ferramentas de escrita, execução de comando e rede desligadas (no que cada CLI permite desligar). O assistente só gera texto a partir do prompt — não lê, não edita, não executa nada do sistema do usuário.

## Como funciona

1. O app fica na bandeja do Windows e sobe um servidor HTTP só em `127.0.0.1:<porta>` (padrão `47811`).
2. Uma página web (sua aplicação) faz uma requisição `fetch` para essa porta, pedindo um texto.
3. O app roda o assistente configurado numa pasta temporária isolada, devolve a resposta em JSON.

```
Navegador (sua aplicação web)
        │  fetch('http://127.0.0.1:47811/v1/gerar', {...})
        ▼
   AI Connect (app local, bandeja do Windows)
        │  spawn do CLI do assistente, numa pasta temp vazia
        ▼
   Claude Code / Codex / OpenCode / Gemini CLI / Cursor Agent
        │  (já logado com a conta do usuário desta máquina)
        ▼
   resposta em texto
```

## API

Só responde em `127.0.0.1`/`localhost`, na porta configurada.

| Rota | Método | Corpo | Resposta |
|---|---|---|---|
| `/v1/status` | GET | — | `{app, versao, assistente, assistenteEmUso, modelo, raciocinio, assistentes, trocarEm, rotas}` — para a página saber se o app está aberto e qual assistente vai responder |
| `/v1/gerar` | POST | `{prompt}` (até 400 mil caracteres) | `{resposta, assistente, modelo, duracaoMs}` — **rota genérica**: você monta o prompt do seu jeito, o app só roda o assistente e devolve o texto |
| `/v1/responder` | POST | `{pergunta, trechos: [{fonte, texto}], historico?}` | `{resposta, assistente, modelo, duracaoMs}` — rota de conveniência para RAG: monta o prompt de "responda com base nestes trechos" internamente (ver `src/prompt.ts`) |

Para integrar num projeto novo, use `/v1/gerar` — ela não assume nada sobre o seu domínio, só executa o prompt que você montar.

### Exemplo de integração (JavaScript, no navegador)

```js
async function gerarTexto(prompt) {
  const resposta = await fetch('http://127.0.0.1:47811/v1/gerar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!resposta.ok) {
    const erro = await resposta.json().catch(() => ({}));
    throw new Error(erro.erro || `AI Connect respondeu ${resposta.status}`);
  }
  const { resposta: texto, assistente, modelo } = await resposta.json();
  return { texto, assistente, modelo };
}
```

### Erros

`{erro: "..."}` com status:

- `400` — pedido inválido (prompt vazio, acima do limite, JSON malformado).
- `403` — host ou origem (`Origin`) não autorizados.
- `413` — corpo da requisição acima de 2 MB.
- `429` — mais de 2 respostas simultâneas (limite fixo, pra não sobrecarregar a máquina do usuário).
- `502` — o assistente rodou e falhou (erro do provedor, limite de uso, timeout).
- `503` — nenhum assistente de IA instalado nesta máquina.

### Segurança

Qualquer página aberta no navegador consegue, em teoria, mandar requisição para `localhost`. Para isso não virar uma porta aberta para qualquer site:

- **`Host` obrigatório.** Só aceita requisição cujo cabeçalho `Host` seja `127.0.0.1:<porta>` ou `localhost:<porta>` — impede ataques de DNS rebinding.
- **Lista de origens autorizadas.** Na primeira chamada de cada `Origin` (endereço da página que está chamando), o app pergunta ao usuário se autoriza; a escolha fica salva. Requisição sem `Origin` (programa local, não navegador) já roda com o usuário logado na própria máquina, então passa direto.
- **Private Network Access.** Responde ao preflight que o Chrome manda quando uma página pública tenta chamar a rede local.

## Configuração

Aberta pela janela da bandeja, gravada em `%APPDATA%\AI Connect\configuracao.json`:

- **Assistentes, em ordem de preferência** (até 5), cada um com modelo e nível de raciocínio (effort) opcionais. Se o atual falhar, o app tenta o próximo da lista — por padrão só quando detecta mensagem de limite de uso ("usage limit", "rate limit", "quota", `429`...), ou, se configurado, em qualquer falha. A resposta traz `trocouDe` quando houve troca.
- **Tempo limite** da resposta.
- **Porta local** (a aplicação que consome a API precisa usar a mesma).
- **Endereços autorizados** (lista de `Origin` liberados) e **início automático** com o Windows.

## Assistentes suportados

| Assistente | Lê PDF sozinho | Observação |
|---|---|---|
| Claude Code | Sim | Ferramentas de edição/execução/rede desligadas via `--disallowedTools` |
| Codex | Não | Roda em `--sandbox read-only` |
| OpenCode | Sim | Agente dedicado sem permissão de escrita/bash/rede, configurado por pedido |
| Gemini CLI | Sim | Roda em `--approval-mode plan` (somente leitura) |
| Cursor Agent | Não | Adaptador segue a documentação da Cursor; não testado em máquina com o CLI instalado |

Detecção automática do executável instalado (PATH, ou pasta local do instalador no caso do Cursor no Windows); no modo `auto`, usa o primeiro disponível na ordem acima.

## Desenvolvimento

Requer Node.js e, no Windows, pelo menos um dos assistentes de IA instalado para testar de ponta a ponta.

```bash
npm install
npm test          # compila e roda os testes (node:test)
npm start         # abre o app (ícone na bandeja + janela de configuração)
npm run empacotar # gera o instalador NSIS em release/ (electron-builder)
```

Estrutura:

```
src/
  main.ts                 # processo principal do Electron (bandeja, ciclo de vida)
  servidor.ts              # servidor HTTP e regras de segurança (host, origem, limites)
  prompt.ts                # validação dos pedidos e montagem do prompt de /v1/responder
  gerarResposta.ts          # orquestra a lista de assistentes com fallback
  assistentes.ts            # adaptador de cada CLI (localizar, listar modelos, executar isolado)
  linhaDeComandoDoCmd.ts     # monta a linha de comando para shims .cmd no Windows
  configuracao.ts           # leitura/gravação da configuração do usuário
  inicioAutomatico.ts        # registro de início com o Windows
  preload.ts                 # ponte Electron (main ↔ janela de configuração)
telas/
  configuracao.html/js       # janela de configuração aberta pela bandeja
```

## Adaptando para o seu projeto

- Para gerar texto livre, chame só `/v1/gerar` — não precisa mexer em nada.
- Para um fluxo de RAG parecido com o original, adapte o prompt fixo em `src/prompt.ts` (`montarPrompt`) para o domínio da sua aplicação, ou monte o prompt completo no seu backend/frontend e use `/v1/gerar`.
- Para adicionar outro assistente de CLI, implemente a interface `Adaptador` em `src/assistentes.ts` (localizar o executável, listar modelos, executar com isolamento) e inclua o `id` em `ASSISTENTES_DE_IA`.

## Licença

MIT — veja [LICENSE](LICENSE).
