/**
 * Os assistentes de IA de linha de comando instalados na máquina, e como pedir a cada
 * um uma resposta de texto sem deixá-lo mexer em nada.
 *
 * O desenho de segurança é o mesmo do Git AutoSync ao gerar mensagem de commit: o
 * assistente roda numa pasta temporária que só tem o que ele precisa ler, com escrita,
 * comandos e rede desligados no que cada um permite desligar. Isso não protege contra
 * um assistente malicioso; protege contra ele "ajudar" mexendo onde não devia.
 *
 * No Windows, `codex`, `opencode` e `gemini` se instalam pelo npm como shim `.cmd`, que
 * o `spawn` sem shell não executa. O shim só encaminha para o programa de verdade
 * dentro de `node_modules`, e é esse que é chamado; sem ele, o `.cmd` vai pelo
 * `cmd.exe` com a linha montada em `linhaDeComandoDoCmd.ts`.
 *
 * O adaptador do `cursor-agent` segue a documentação da Cursor e não foi testado numa
 * máquina com ele instalado.
 *
 * Copiado do HUB SNK (hub-snk-desenv/src/kanban/ia/assistentesDeIa.ts, v2.6.0); ao corrigir
 * algo aqui, ver se vale levar para lá.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { argumentosDoCmdParaScript } from './linhaDeComandoDoCmd';

export const ASSISTENTES_DE_IA = ['claude', 'codex', 'opencode', 'gemini', 'cursor'] as const;
export type AssistenteDeIa = (typeof ASSISTENTES_DE_IA)[number];
/** `auto` usa o primeiro instalado, na ordem de `ASSISTENTES_DE_IA`. */
export const ESCOLHAS_DE_ASSISTENTE = ['auto', ...ASSISTENTES_DE_IA] as const;
export type EscolhaDeAssistente = (typeof ESCOLHAS_DE_ASSISTENTE)[number];

export class AssistenteIndisponivelError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'AssistenteIndisponivelError';
  }
}

export class AssistenteFalhouError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'AssistenteFalhouError';
  }
}

/** O que a tela de configurações mostra de cada assistente. */
export interface SituacaoDoAssistente {
  id: AssistenteDeIa;
  nome: string;
  instalado: boolean;
  caminho: string;
  /** Sugestões para o campo de modelo; o campo continua aceitando qualquer nome. */
  modelos: string[];
  /** O modelo que o assistente usa quando nenhum é escolhido, quando dá para ler. */
  modeloPadrao: string;
  /** Se o assistente consegue ler um PDF sozinho, sem o texto extraído pelo HUB SNK. */
  lePdf: boolean;
  /**
   * Os níveis de raciocínio de cada modelo da lista, quando o assistente tem a opção.
   * Modelo fora do mapa não aceita nível; `padrao` é o que ele usa sem nível escolhido.
   */
  raciocinio: Record<string, NiveisDeRaciocinio>;
}

export interface NiveisDeRaciocinio {
  niveis: string[];
  padrao: string;
}

interface ModelosDoAssistente {
  modelos: string[];
  modeloPadrao: string;
  raciocinio?: Record<string, NiveisDeRaciocinio>;
}

/**
 * O pedido a um assistente. A pasta já tem os arquivos que ele pode ler (`escopo.pdf`,
 * `instrucoes.md`); o resto do prompt vai pela entrada padrão, quando o assistente aceita.
 */
export interface PedidoAoAssistente {
  prompt: string;
  pasta: string;
  /** Vazio deixa o assistente usar o modelo padrão dele. */
  modelo: string;
  /** Nível de raciocínio; vazio, ou num assistente sem a opção, fica o padrão do modelo. */
  raciocinio?: string;
  /** Nome, dentro da pasta, do arquivo que ele precisa abrir, como o PDF do escopo. */
  arquivoParaLer?: string;
  tempoLimiteMs: number;
}

export interface Comando {
  executavel: string;
  /** O script do shim, quando o executável é o `node`. */
  argumentosIniciais: string[];
  /** `.cmd` sem programa de verdade ao lado: só roda pelo `cmd.exe`. */
  viaCmd: boolean;
}

interface Execucao {
  codigo: number | null;
  saida: string;
  erro: string;
  expirou: boolean;
}

interface Adaptador {
  id: AssistenteDeIa;
  nome: string;
  lePdf: boolean;
  localizar(): Comando | null;
  listarModelos(comando: Comando): Promise<ModelosDoAssistente>;
  executar(comando: Comando, pedido: PedidoAoAssistente): Promise<string>;
}

const EH_WINDOWS = process.platform === 'win32';
const TEMPO_LIMITE_DA_LISTA_DE_MODELOS_MS = 20_000;
const TAMANHO_MAXIMO_DA_SAIDA = 10 * 1024 * 1024;

/** O `-p` do gemini e do cursor exige um texto; o pedido de verdade vem por outro canal. */
const PROMPT_DA_ENTRADA_PADRAO = 'Siga as instruções recebidas pela entrada padrão.';
const ARQUIVO_DE_INSTRUCOES = 'instrucoes.md';
const PROMPT_DO_ARQUIVO_DE_INSTRUCOES = `Leia o arquivo ${ARQUIVO_DE_INSTRUCOES} no diretório atual e siga as instruções dele à risca.`;

/** Nome do agente do OpenCode sem escrita, comandos nem rede, definido na pasta isolada. */
const AGENTE_DO_OPENCODE = 'hub-snk-somente-leitura';

function noPath(nome: string, extensoes: string[]): string {
  for (const pasta of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!pasta) {
      continue;
    }
    for (const extensao of extensoes) {
      const alvo = join(pasta, nome + extensao);
      if (existsSync(alvo)) {
        return alvo;
      }
    }
  }
  return '';
}

/**
 * O Node para rodar o script de um shim npm. Sem `node` no PATH, serve o executável do
 * próprio Electron, que o `rodar` chama com `ELECTRON_RUN_AS_NODE`.
 */
function executavelDoNode(): string {
  return noPath('node', EH_WINDOWS ? ['.exe'] : ['']) || process.execPath;
}

/**
 * Acha o programa pelo nome. `entradasDoShim` são os caminhos, relativos à pasta do
 * `.cmd`, onde o npm põe o programa de verdade.
 */
function localizarPorNome(nome: string, entradasDoShim: string[] = []): Comando | null {
  if (!EH_WINDOWS) {
    const caminho = noPath(nome, ['']);
    return caminho ? { executavel: caminho, argumentosIniciais: [], viaCmd: false } : null;
  }

  const exe = noPath(nome, ['.exe']);
  if (exe) {
    return { executavel: exe, argumentosIniciais: [], viaCmd: false };
  }

  const shim = noPath(nome, ['.cmd']);
  if (!shim) {
    return null;
  }
  for (const entrada of entradasDoShim) {
    const programa = join(dirname(shim), entrada);
    if (!existsSync(programa)) {
      continue;
    }
    return programa.endsWith('.js')
      ? { executavel: executavelDoNode(), argumentosIniciais: [programa], viaCmd: false }
      : { executavel: programa, argumentosIniciais: [], viaCmd: false };
  }
  return { executavel: shim, argumentosIniciais: [], viaCmd: true };
}

function caminhoParaMostrar(comando: Comando): string {
  return comando.argumentosIniciais[0] ?? comando.executavel;
}

/** Roda o programa com o prompt pela entrada padrão. Sem shell, a não ser o do shim `.cmd`. */
function rodar(
  comando: Comando,
  argumentos: string[],
  opcoes: { cwd: string; entrada?: string; tempoLimiteMs: number },
): Promise<Execucao> {
  const todos = [...comando.argumentosIniciais, ...argumentos];
  const [executavel, argumentosFinais] = comando.viaCmd
    ? ['cmd.exe', argumentosDoCmdParaScript(comando.executavel, todos)]
    : [comando.executavel, todos];

  return new Promise((resolver) => {
    const processo = spawn(executavel, argumentosFinais, {
      cwd: opcoes.cwd,
      windowsHide: true,
      windowsVerbatimArguments: comando.viaCmd,
      // Sem isso, o `process.execPath` do Electron abriria outra instância do app em vez de rodar o script.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: [opcoes.entrada === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let saida = '';
    let erro = '';
    let expirou = false;
    const prazo = setTimeout(() => {
      expirou = true;
      processo.kill();
    }, opcoes.tempoLimiteMs);

    processo.stdout?.on('data', (parte: Buffer) => {
      if (saida.length < TAMANHO_MAXIMO_DA_SAIDA) saida += parte.toString('utf8');
    });
    processo.stderr?.on('data', (parte: Buffer) => {
      if (erro.length < TAMANHO_MAXIMO_DA_SAIDA) erro += parte.toString('utf8');
    });
    processo.on('error', (falha) => {
      clearTimeout(prazo);
      resolver({ codigo: null, saida: '', erro: falha.message, expirou: false });
    });
    processo.on('close', (codigo) => {
      clearTimeout(prazo);
      resolver({ codigo, saida, erro, expirou });
    });

    // Assistente que sai antes de ler tudo fecha o pipe; o erro dele aparece no `close`.
    processo.stdin?.on('error', () => {});
    if (opcoes.entrada !== undefined) {
      processo.stdin?.end(opcoes.entrada, 'utf8');
    }
  });
}

/** Falha vira mensagem com o final do que o assistente disse, que é onde está o motivo. */
function exigirSucesso(nome: string, execucao: Execucao, tempoLimiteMs: number): string {
  if (execucao.expirou) {
    throw new AssistenteFalhouError(
      `O ${nome} não respondeu em ${Math.round(tempoLimiteMs / 60_000)} minutos.`,
    );
  }
  if (execucao.codigo !== 0) {
    const detalhe = (execucao.erro || execucao.saida)
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(' ')
      .slice(0, 400);
    throw new AssistenteFalhouError(`O ${nome} terminou com erro${detalhe ? `: ${detalhe}` : '.'}`);
  }
  return execucao.saida;
}

function lerArquivoOuVazio(caminho: string): string {
  try {
    return readFileSync(caminho, 'utf8');
  } catch {
    return '';
  }
}

function argumentoDeRaciocinio(opcao: string, nivel: string | undefined): string[] {
  return nivel?.trim() ? [opcao, nivel.trim()] : [];
}

function argumentoDeModelo(opcao: string, modelo: string): string[] {
  return modelo.trim() ? [opcao, modelo.trim()] : [];
}

/** Lista de modelos é conveniência: assistente que não responde fica só com o campo livre. */
async function linhasDoComando(comando: Comando, argumentos: string[]): Promise<string[]> {
  const execucao = await rodar(comando, argumentos, {
    cwd: homedir(),
    tempoLimiteMs: TEMPO_LIMITE_DA_LISTA_DE_MODELOS_MS,
  });
  return execucao.codigo === 0
    ? execucao.saida
        .split(/\r?\n/)
        .map((linha) => linha.trim())
        .filter(Boolean)
    : [];
}

const FERRAMENTAS_BLOQUEADAS_DO_CLAUDE =
  'Bash,Edit,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task';

/** Os modelos atuais da Anthropic, do mais capaz ao mais leve. */
const CATALOGO_DO_CLAUDE = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
];
const APELIDOS_DO_CLAUDE = ['opus', 'sonnet', 'haiku'];
const NIVEIS_DO_CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Os modelos que o Claude Code já registrou no `~/.claude.json` (uso por projeto): é o
 * que mostra os modelos que a conta desta máquina de fato alcança.
 */
export function modelosUsadosNoClaude(conteudo: string): string[] {
  let dados: unknown;
  try {
    dados = JSON.parse(conteudo);
  } catch {
    return [];
  }
  const encontrados = new Set<string>();
  const pendentes: unknown[] = [dados];
  while (pendentes.length) {
    const atual = pendentes.pop();
    if (!atual || typeof atual !== 'object') continue;
    for (const [chave, valor] of Object.entries(atual)) {
      if (/^claude-[a-z]+-[0-9][a-z0-9-]*$/.test(chave)) encontrados.add(chave);
      if (typeof valor === 'string' && /^claude-[a-z]+-[0-9][a-z0-9-]*$/.test(valor)) {
        encontrados.add(valor);
      }
      if (valor && typeof valor === 'object') pendentes.push(valor);
    }
  }
  // Mais novos primeiro: a versão no nome ordena como texto dentro de cada família.
  return [...encontrados].sort((um, outro) => outro.localeCompare(um, 'en', { numeric: true }));
}

const claude: Adaptador = {
  id: 'claude',
  nome: 'Claude Code',
  lePdf: true,
  localizar: () => localizarPorNome('claude', ['node_modules/@anthropic-ai/claude-code/cli.js']),
  async listarModelos() {
    const configuracao = lerArquivoOuVazio(join(homedir(), '.claude', 'settings.json'));
    let modeloPadrao = '';
    try {
      modeloPadrao = String((JSON.parse(configuracao) as { model?: unknown }).model ?? '');
    } catch {
      // Sem configuração própria: o Claude Code usa o padrão da conta.
    }
    // O Claude Code não lista modelos: vale o catálogo atual, o que já foi usado nesta
    // máquina e os apelidos, que sempre apontam para o mais novo de cada família.
    const usados = modelosUsadosNoClaude(lerArquivoOuVazio(join(homedir(), '.claude.json')));
    const modelos = [...new Set([...CATALOGO_DO_CLAUDE, ...usados, ...APELIDOS_DO_CLAUDE])];
    // O `--effort` vale para toda a família, menos o Haiku, que não tem nível de raciocínio.
    const raciocinio: Record<string, NiveisDeRaciocinio> = {};
    for (const modelo of ['', ...modelos]) {
      if (!/haiku/.test(modelo || modeloPadrao)) {
        raciocinio[modelo] = { niveis: NIVEIS_DO_CLAUDE, padrao: '' };
      }
    }
    return { modelos, modeloPadrao, raciocinio };
  },
  async executar(comando, pedido) {
    const ferramentas = pedido.arquivoParaLer
      ? ['--allowedTools', 'Read', '--disallowedTools', FERRAMENTAS_BLOQUEADAS_DO_CLAUDE]
      : ['--disallowedTools', `Read,${FERRAMENTAS_BLOQUEADAS_DO_CLAUDE}`];
    const execucao = await rodar(
      comando,
      [
        '-p',
        '--output-format',
        'text',
        ...argumentoDeModelo('--model', pedido.modelo),
        ...argumentoDeRaciocinio('--effort', pedido.raciocinio),
        ...ferramentas,
      ],
      { cwd: pedido.pasta, entrada: pedido.prompt, tempoLimiteMs: pedido.tempoLimiteMs },
    );
    return exigirSucesso(this.nome, execucao, pedido.tempoLimiteMs);
  },
};

const codex: Adaptador = {
  id: 'codex',
  nome: 'Codex',
  // Sem ferramenta de leitura de PDF; no sandbox somente leitura ele dependeria de achar
  // um conversor instalado na máquina.
  lePdf: false,
  localizar: () => localizarPorNome('codex', ['node_modules/@openai/codex/bin/codex.js']),
  async listarModelos(comando) {
    const configuracao = lerArquivoOuVazio(join(homedir(), '.codex', 'config.toml'));
    const modeloPadrao = /^\s*model\s*=\s*"([^"]+)"/m.exec(configuracao)?.[1] ?? '';
    // O nível gravado no `config.toml` vale para o modelo padrão, por cima do dele.
    const raciocinioPadrao =
      /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(configuracao)?.[1] ?? '';
    const linhas = await linhasDoComando(comando, ['debug', 'models']);
    try {
      const catalogo = JSON.parse(linhas.join('\n')) as {
        models?: {
          slug?: unknown;
          visibility?: unknown;
          default_reasoning_level?: unknown;
          supported_reasoning_levels?: { effort?: unknown }[];
        }[];
      };
      const listados = (catalogo.models ?? []).filter(
        (modelo) => modelo.visibility === undefined || modelo.visibility === 'list',
      );
      const raciocinio: Record<string, NiveisDeRaciocinio> = {};
      for (const modelo of catalogo.models ?? []) {
        const slug = String(modelo.slug ?? '');
        const niveis = (modelo.supported_reasoning_levels ?? [])
          .map((nivel) => String(nivel.effort ?? ''))
          .filter(Boolean);
        if (!slug || !niveis.length) continue;
        const padrao = String(modelo.default_reasoning_level ?? '');
        raciocinio[slug] = {
          niveis,
          padrao: slug === modeloPadrao && raciocinioPadrao ? raciocinioPadrao : padrao,
        };
      }
      const doPadrao = raciocinio[modeloPadrao];
      if (doPadrao) raciocinio[''] = doPadrao;
      const modelos = listados.map((modelo) => String(modelo.slug ?? '')).filter(Boolean);
      return { modelos, modeloPadrao, raciocinio };
    } catch {
      return { modelos: [], modeloPadrao };
    }
  },
  async executar(comando, pedido) {
    // A resposta final vem do arquivo do `-o`: o stdout traz o andamento junto.
    const arquivoDaResposta = join(pedido.pasta, 'resposta-do-codex.txt');
    const execucao = await rodar(
      comando,
      [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '-C',
        pedido.pasta,
        '-o',
        arquivoDaResposta,
        ...argumentoDeModelo('-m', pedido.modelo),
        // O valor do `-c` é TOML: o nível vai entre aspas, como no `config.toml`.
        ...(pedido.raciocinio?.trim()
          ? ['-c', `model_reasoning_effort="${pedido.raciocinio.trim()}"`]
          : []),
        '-',
      ],
      { cwd: pedido.pasta, entrada: pedido.prompt, tempoLimiteMs: pedido.tempoLimiteMs },
    );
    exigirSucesso(this.nome, execucao, pedido.tempoLimiteMs);
    return lerArquivoOuVazio(arquivoDaResposta);
  },
};

/**
 * A saída do `opencode models --verbose`: o nome do modelo numa linha e o JSON dele nas
 * seguintes. Sem o `--verbose` (versão antiga), sobram só os nomes, sem níveis.
 */
export function modelosDoOpencode(linhas: string[]): ModelosDoAssistente {
  const modelos: string[] = [];
  const raciocinio: Record<string, NiveisDeRaciocinio> = {};
  let atual = '';
  let bloco: string[] = [];
  const fecharBloco = () => {
    if (!atual || !bloco.length) return;
    try {
      const dados = JSON.parse(bloco.join('\n')) as { variants?: Record<string, unknown> };
      const niveis = Object.keys(dados.variants ?? {});
      if (niveis.length) raciocinio[atual] = { niveis, padrao: '' };
    } catch {
      // Bloco que não é JSON: o modelo fica sem níveis.
    }
    bloco = [];
  };
  for (const linha of linhas) {
    if (/^[\w.@-]+\/\S+$/.test(linha)) {
      fecharBloco();
      atual = linha;
      modelos.push(linha);
    } else if (atual) {
      bloco.push(linha);
    }
  }
  fecharBloco();
  return { modelos, modeloPadrao: '', raciocinio };
}

const opencode: Adaptador = {
  id: 'opencode',
  nome: 'OpenCode',
  lePdf: true,
  localizar: () =>
    localizarPorNome('opencode', [
      'node_modules/opencode-ai/bin/opencode.exe',
      'node_modules/opencode-ai/bin/opencode',
    ]),
  async listarModelos(comando) {
    // O `--verbose` traz, depois de cada nome, um JSON com as variantes (os níveis de raciocínio).
    const linhas = await linhasDoComando(comando, ['models', '--verbose']);
    return modelosDoOpencode(linhas);
  },
  async executar(comando, pedido) {
    /*
     * O agente somente leitura vai no `opencode.json` da pasta isolada, que o OpenCode
     * lê como configuração do projeto: a configuração global do usuário fica intocada.
     */
    writeFileSync(
      join(pedido.pasta, 'opencode.json'),
      JSON.stringify({
        agent: {
          [AGENTE_DO_OPENCODE]: {
            description: 'Gera texto a partir do prompt, sem alterar arquivos nem rodar comandos.',
            tools: { write: false, edit: false, bash: false, webfetch: false, patch: false },
            permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
          },
        },
      }),
    );
    const anexo = pedido.arquivoParaLer ? ['-f', join(pedido.pasta, pedido.arquivoParaLer)] : [];
    const execucao = await rodar(
      comando,
      [
        'run',
        '--dir',
        pedido.pasta,
        '--agent',
        AGENTE_DO_OPENCODE,
        '--format',
        'json',
        ...argumentoDeModelo('-m', pedido.modelo),
        ...argumentoDeRaciocinio('--variant', pedido.raciocinio),
        ...anexo,
      ],
      { cwd: pedido.pasta, entrada: pedido.prompt, tempoLimiteMs: pedido.tempoLimiteMs },
    );
    // Um evento JSON por linha; a resposta é o texto dos eventos `text`, na ordem.
    const partes: string[] = [];
    let erroDoProvedor = '';
    for (const linha of `${execucao.saida}\n${execucao.erro}`.split(/\r?\n/)) {
      try {
        const evento = JSON.parse(linha) as {
          type?: string;
          part?: { text?: string };
          error?: { data?: { message?: string }; name?: string };
        };
        if (evento.type === 'text' && evento.part?.text) {
          partes.push(evento.part.text);
        } else if (evento.type === 'error') {
          erroDoProvedor = evento.error?.data?.message ?? evento.error?.name ?? '';
        }
      } catch {
        // Linha de andamento, não evento.
      }
    }
    // O erro do provedor (assinatura, modelo bloqueado) vem como evento: sem ele, o JSON cru.
    if (erroDoProvedor && !execucao.expirou) {
      throw new AssistenteFalhouError(`O ${this.nome} terminou com erro: ${erroDoProvedor}`);
    }
    exigirSucesso(this.nome, execucao, pedido.tempoLimiteMs);
    return partes.join('\n');
  },
};

const gemini: Adaptador = {
  id: 'gemini',
  nome: 'Gemini CLI',
  lePdf: true,
  localizar: () =>
    localizarPorNome('gemini', [
      'node_modules/@google/gemini-cli/bundle/gemini.js',
      'node_modules/@google/gemini-cli/dist/index.js',
    ]),
  async listarModelos() {
    const configuracao = lerArquivoOuVazio(join(homedir(), '.gemini', 'settings.json'));
    let modeloPadrao = '';
    try {
      const dados = JSON.parse(configuracao) as { model?: { name?: unknown } | string };
      modeloPadrao = String(
        typeof dados.model === 'string' ? dados.model : (dados.model?.name ?? ''),
      );
    } catch {
      // Sem configuração própria: o Gemini CLI escolhe sozinho.
    }
    // O Gemini CLI não lista modelos; os apelidos acompanham a geração mais nova.
    return { modelos: ['auto', 'pro', 'flash', 'flash-lite'], modeloPadrao };
  },
  async executar(comando, pedido) {
    // `plan` é o modo somente leitura: lê arquivos da pasta, não edita nem roda comandos.
    const execucao = await rodar(
      comando,
      [
        '-p',
        PROMPT_DA_ENTRADA_PADRAO,
        '--approval-mode',
        'plan',
        '--skip-trust',
        '-o',
        'text',
        ...argumentoDeModelo('-m', pedido.modelo),
      ],
      { cwd: pedido.pasta, entrada: pedido.prompt, tempoLimiteMs: pedido.tempoLimiteMs },
    );
    return exigirSucesso(this.nome, execucao, pedido.tempoLimiteMs);
  },
};

const cursor: Adaptador = {
  id: 'cursor',
  nome: 'Cursor Agent',
  lePdf: false,
  localizar: () => {
    const peloPath = localizarPorNome('cursor-agent');
    if (peloPath || !EH_WINDOWS) {
      return peloPath;
    }
    // O instalador da Cursor no Windows põe o CLI aqui, nem sempre no PATH.
    const instalado = join(process.env['LOCALAPPDATA'] ?? '', 'cursor-agent', 'cursor-agent.cmd');
    return existsSync(instalado)
      ? { executavel: instalado, argumentosIniciais: [], viaCmd: true }
      : null;
  },
  async listarModelos(comando) {
    const modelos = (await linhasDoComando(comando, ['models']))
      .map((linha) => linha.replace(/^[-*•]\s*/, '').split(/\s+/)[0] ?? '')
      .filter((linha) => /^[\w.-]+$/.test(linha) && !/^(available|models?)$/i.test(linha));
    return { modelos, modeloPadrao: '' };
  },
  async executar(comando, pedido) {
    /*
     * O prompt vai por arquivo: argumento de linha de comando tem limite de tamanho e,
     * pelo `cmd.exe`, não aceita aspas. Sem `--force`, o modo `-p` não grava nada.
     */
    writeFileSync(join(pedido.pasta, ARQUIVO_DE_INSTRUCOES), pedido.prompt, 'utf8');
    const execucao = await rodar(
      comando,
      [
        '-p',
        PROMPT_DO_ARQUIVO_DE_INSTRUCOES,
        '--output-format',
        'text',
        ...argumentoDeModelo('--model', pedido.modelo),
      ],
      { cwd: pedido.pasta, tempoLimiteMs: pedido.tempoLimiteMs },
    );
    return exigirSucesso(this.nome, execucao, pedido.tempoLimiteMs);
  },
};

const ADAPTADORES: Record<AssistenteDeIa, Adaptador> = { claude, codex, opencode, gemini, cursor };

export function ehEscolhaDeAssistente(valor: unknown): valor is EscolhaDeAssistente {
  return (ESCOLHAS_DE_ASSISTENTE as readonly unknown[]).includes(valor);
}

export function nomeDoAssistente(id: AssistenteDeIa): string {
  return ADAPTADORES[id].nome;
}

export function assistenteLePdf(id: AssistenteDeIa): boolean {
  return ADAPTADORES[id].lePdf;
}

/** Cada assistente com o que dá para saber dele sem rodar uma análise. */
export async function situacaoDosAssistentes(): Promise<SituacaoDoAssistente[]> {
  return Promise.all(
    ASSISTENTES_DE_IA.map(async (id) => {
      const adaptador = ADAPTADORES[id];
      const comando = adaptador.localizar();
      const base = { id, nome: adaptador.nome, lePdf: adaptador.lePdf };
      if (!comando) {
        return {
          ...base,
          instalado: false,
          caminho: '',
          modelos: [],
          modeloPadrao: '',
          raciocinio: {},
        };
      }
      const { modelos, modeloPadrao, raciocinio = {} } = await adaptador.listarModelos(comando);
      return {
        ...base,
        instalado: true,
        caminho: caminhoParaMostrar(comando),
        modelos,
        modeloPadrao,
        raciocinio,
      };
    }),
  );
}

/** O assistente que vai rodar: o escolhido, se instalado, ou o primeiro disponível no `auto`. */
export function resolverAssistente(escolha: EscolhaDeAssistente): AssistenteDeIa {
  if (escolha !== 'auto') {
    if (!ADAPTADORES[escolha].localizar()) {
      throw new AssistenteIndisponivelError(
        `O ${ADAPTADORES[escolha].nome} não foi encontrado nesta máquina. Escolha outro assistente nas configurações.`,
      );
    }
    return escolha;
  }
  const instalado = ASSISTENTES_DE_IA.find((id) => ADAPTADORES[id].localizar());
  if (!instalado) {
    throw new AssistenteIndisponivelError(
      'Nenhum assistente de IA (claude, codex, opencode, gemini ou cursor-agent) foi encontrado nesta máquina.',
    );
  }
  return instalado;
}

/** Pede ao assistente e devolve o texto da resposta, já sem espaços nas pontas. */
export async function perguntarAoAssistente(
  id: AssistenteDeIa,
  pedido: PedidoAoAssistente,
): Promise<string> {
  const adaptador = ADAPTADORES[id];
  const comando = adaptador.localizar();
  if (!comando) {
    throw new AssistenteIndisponivelError(`O ${adaptador.nome} não foi encontrado nesta máquina.`);
  }
  const resposta = (await adaptador.executar(comando, pedido)).trim();
  if (!resposta) {
    throw new AssistenteFalhouError(`O ${adaptador.nome} não devolveu resposta.`);
  }
  return resposta;
}
