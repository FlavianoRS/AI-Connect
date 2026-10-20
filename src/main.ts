/**
 * AI Connect: fica na bandeja e expõe em 127.0.0.1 a API que a tela de chat do addon
 * RAG (rag-snk) chama para gerar a resposta com o assistente de IA instalado nesta máquina,
 * com o login do próprio usuário.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage } from 'electron';
import { nomeDoAssistente, resolverAssistente, situacaoDosAssistentes, type AssistenteDeIa } from './assistentes';
import { carregarConfiguracao, salvarConfiguracao, type Configuracao } from './configuracao';
import { gerarResposta, gerarTexto } from './gerarResposta';
import {
  ID_DO_APP,
  definirInicioAutomatico,
  foiIniciadoPeloWindows,
  inicioAutomaticoLigado,
} from './inicioAutomatico';
import { criarServidor } from './servidor';

const NOME = 'AI Connect';
const ICONE = join(__dirname, '..', 'assets', 'icone.png');
const ARQUIVO_DE_CONFIGURACAO = () => join(app.getPath('userData'), 'configuracao.json');

let configuracao: Configuracao;
let servidor: Server | null = null;
let erroDoServidor = '';
let bandeja: Tray | null = null;
let janela: BrowserWindow | null = null;
let saindo = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(ID_DO_APP);
  app.on('second-instance', () => mostrarJanela());
  // Fechar a janela não encerra: o app vive na bandeja.
  app.on('window-all-closed', () => {});
  app.whenReady().then(iniciar);
}

/** O app se chamava "RAG SNK Connect" até a 1.0.1: traz a configuração de lá na primeira abertura. */
function migrarConfiguracaoAntiga(): void {
  const antigo = join(app.getPath('appData'), 'RAG SNK Connect', 'configuracao.json');
  if (existsSync(ARQUIVO_DE_CONFIGURACAO()) || !existsSync(antigo)) return;
  try {
    mkdirSync(dirname(ARQUIVO_DE_CONFIGURACAO()), { recursive: true });
    copyFileSync(antigo, ARQUIVO_DE_CONFIGURACAO());
  } catch {
    // Sem a cópia, o app só começa com a configuração padrão.
  }
}

function iniciar(): void {
  migrarConfiguracaoAntiga();
  const primeiraVez = !existsSync(ARQUIVO_DE_CONFIGURACAO());
  configuracao = carregarConfiguracao(ARQUIVO_DE_CONFIGURACAO());
  registrarIpc();
  ligarServidor();
  criarBandeja();
  if (primeiraVez || !foiIniciadoPeloWindows()) mostrarJanela();
}

function ligarServidor(): void {
  servidor?.close();
  erroDoServidor = '';
  const porta = configuracao.porta;
  servidor = criarServidor({
    porta: () => porta,
    origemPermitida: (origem) => configuracao.origensPermitidas.includes(origem),
    autorizarOrigem,
    status: () => ({
      app: NOME,
      versao: app.getVersion(),
      assistente: configuracao.assistentes[0].assistente,
      // O que vai rodar de fato: o primeiro instalado da lista, com os reservas; vazio se nenhum.
      assistenteEmUso: assistenteEmUso(),
      modelo: configuracao.assistentes[0].modelo,
      raciocinio: configuracao.assistentes[0].raciocinio,
      assistentes: configuracao.assistentes,
      trocarEm: configuracao.trocarEm,
      // A tela confere antes de usar uma rota que versões antigas do app não têm.
      rotas: ['responder', 'gerar'],
    }),
    responder: (pergunta, trechos, historico) => gerarResposta(configuracao, pergunta, trechos, historico),
    gerar: (prompt) => gerarTexto(configuracao, prompt),
  });
  servidor.on('error', (erro: NodeJS.ErrnoException) => {
    erroDoServidor =
      erro.code === 'EADDRINUSE'
        ? `A porta ${porta} já está em uso por outro programa. Escolha outra nas configurações.`
        : erro.message;
    new Notification({ title: NOME, body: erroDoServidor, icon: ICONE }).show();
    atualizarBandeja();
  });
  servidor.listen(porta, '127.0.0.1', () => atualizarBandeja());
}

/** "Claude Code (reserva: Codex)": os instalados da lista, sem repetir. */
function assistenteEmUso(): string {
  const instalados: AssistenteDeIa[] = [];
  for (const item of configuracao.assistentes) {
    try {
      const id = resolverAssistente(item.assistente);
      if (!instalados.includes(id)) instalados.push(id);
    } catch {
      // não instalado: fica fora
    }
  }
  if (!instalados.length) return '';
  const [principal, ...reservas] = instalados.map(nomeDoAssistente);
  return reservas.length ? `${principal} (reserva: ${reservas.join(', ')})` : principal;
}

/** Primeira chamada de um endereço novo: o usuário decide, e a escolha "Permitir" fica gravada. */
async function autorizarOrigem(origem: string): Promise<boolean> {
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: NOME,
    buttons: ['Permitir', 'Recusar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    icon: nativeImage.createFromPath(ICONE),
    message: `Permitir que ${origem} use o seu assistente de IA?`,
    detail:
      'Esse endereço quer enviar perguntas, trechos de documentos e a estrutura de tabelas do Sankhya para o assistente instalado neste computador. ' +
      'Só permita se for o endereço do Sankhya da sua empresa.',
  });
  if (response !== 0) return false;
  configuracao = salvarConfiguracao(ARQUIVO_DE_CONFIGURACAO(), {
    ...configuracao,
    origensPermitidas: [...configuracao.origensPermitidas, origem],
  });
  janela?.webContents.send('configuracao-alterada');
  return true;
}

function criarBandeja(): void {
  bandeja = new Tray(nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 }));
  bandeja.on('click', () => mostrarJanela());
  // Montado a cada clique: o início automático pode ser desligado por fora (Gerenciador de Tarefas).
  bandeja.on('right-click', () =>
    bandeja?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: textoDoStatus(), enabled: false },
        { type: 'separator' },
        { label: 'Configurações', click: () => mostrarJanela() },
        {
          label: 'Iniciar com o Windows',
          type: 'checkbox',
          checked: inicioAutomaticoLigado(),
          click: (item) => definirInicioAutomatico(item.checked),
        },
        { type: 'separator' },
        { label: 'Sair', click: () => sair() },
      ]),
    ),
  );
  atualizarBandeja();
}

function textoDoStatus(): string {
  return erroDoServidor ? `Parado: ${erroDoServidor}` : `Ouvindo em 127.0.0.1:${configuracao.porta}`;
}

function atualizarBandeja(): void {
  bandeja?.setToolTip(`${NOME} — ${textoDoStatus()}`);
}

function mostrarJanela(): void {
  if (!janela) {
    janela = new BrowserWindow({
      width: 560,
      height: 720,
      title: NOME,
      icon: ICONE,
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    janela.loadFile(join(__dirname, '..', 'telas', 'configuracao.html'));
    janela.once('ready-to-show', () => janela?.show());
    janela.on('close', (evento) => {
      if (!saindo) {
        evento.preventDefault();
        janela?.hide();
      }
    });
    return;
  }
  janela.show();
  janela.focus();
}

function registrarIpc(): void {
  ipcMain.handle('situacao', async () => ({
    assistentes: await situacaoDosAssistentes(),
    porta: configuracao.porta,
    erroDoServidor,
    inicioAutomatico: inicioAutomaticoLigado(),
    versao: app.getVersion(),
  }));
  ipcMain.handle('configuracao:obter', () => configuracao);
  ipcMain.handle('configuracao:salvar', (_evento, dados: Configuracao & { inicioAutomatico?: boolean }) => {
    const portaAnterior = configuracao.porta;
    configuracao = salvarConfiguracao(ARQUIVO_DE_CONFIGURACAO(), dados);
    if (typeof dados.inicioAutomatico === 'boolean') definirInicioAutomatico(dados.inicioAutomatico);
    if (configuracao.porta !== portaAnterior || erroDoServidor) ligarServidor();
    return configuracao;
  });
  ipcMain.handle('testar', async () => {
    try {
      const r = await gerarResposta(configuracao, 'O AI Connect está funcionando?', [
        { fonte: 'teste', texto: 'O AI Connect está funcionando corretamente neste computador.' },
      ]);
      return { ok: true, ...r };
    } catch (erro) {
      return { ok: false, erro: (erro as Error).message };
    }
  });
}

function sair(): void {
  saindo = true;
  servidor?.close();
  app.quit();
}
