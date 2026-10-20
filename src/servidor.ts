/**
 * API local que a tela de chat do RAG, aberta no navegador, chama para gerar a resposta
 * com o assistente desta máquina. Escuta só em 127.0.0.1.
 *
 * Proteção, já que qualquer site aberto no navegador consegue mandar requisição para o
 * localhost:
 * - `Host` precisa ser 127.0.0.1/localhost na porta do app (barra DNS rebinding);
 * - requisição de navegador (com `Origin`) só passa de origem que o usuário autorizou na
 *   primeira vez que ela chamou. Sem `Origin` é programa local, que já roda como o usuário.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lerPedido, lerPedidoGenerico, type Trecho, type Turno } from './prompt';

export interface RespostaGerada {
  resposta: string;
  assistente: string;
  modelo: string;
  duracaoMs: number;
  /** Assistentes que falharam antes deste responder (troca automática da lista). */
  trocouDe?: string;
}

export interface Dependencias {
  porta(): number;
  origemPermitida(origem: string): boolean;
  /** Pergunta ao usuário se a origem pode usar o assistente; grava a escolha se sim. */
  autorizarOrigem(origem: string): Promise<boolean>;
  status(): Record<string, unknown>;
  responder(pergunta: string, trechos: Trecho[], historico: Turno[]): Promise<RespostaGerada>;
  /** Prompt já montado por quem chama (ex.: o addon gerando SQL); o app só roda o assistente. */
  gerar(prompt: string): Promise<RespostaGerada>;
}

/** Erro com status HTTP, para a falha do assistente chegar à tela com o motivo certo. */
export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

const TAMANHO_MAXIMO_DO_CORPO = 2 * 1024 * 1024;
// ponytail: limite fixo de execuções simultâneas; tornar configurável se alguém abrir várias abas de chat
const EXECUCOES_SIMULTANEAS = 2;

export function criarServidor(dep: Dependencias): Server {
  let emExecucao = 0;
  const autorizacoesPendentes = new Map<string, Promise<boolean>>();

  /** Várias requisições da mesma origem nova geram uma pergunta só ao usuário. */
  function autorizar(origem: string): Promise<boolean> {
    if (dep.origemPermitida(origem)) return Promise.resolve(true);
    let pendente = autorizacoesPendentes.get(origem);
    if (!pendente) {
      pendente = dep.autorizarOrigem(origem).finally(() => autorizacoesPendentes.delete(origem));
      autorizacoesPendentes.set(origem, pendente);
    }
    return pendente;
  }

  return createServer((req, res) => {
    tratar(req, res).catch((erro: unknown) => {
      const status = erro instanceof ErroHttp ? erro.status : 500;
      enviar(res, status, { erro: erro instanceof Error ? erro.message : 'Erro interno.' });
    });
  });

  async function tratar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${dep.porta()}` && host !== `localhost:${dep.porta()}`) {
      return enviar(res, 403, { erro: 'Host não permitido.' });
    }

    const origem = req.headers.origin;
    if (origem) {
      if (!(await autorizar(origem))) {
        return enviar(res, 403, { erro: 'Origem não autorizada no AI Connect.' });
      }
      res.setHeader('Access-Control-Allow-Origin', origem);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      // Chrome: página de um endereço público chamando a rede local (Private Network Access).
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.writeHead(204).end();
      return;
    }

    const rota = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && rota === '/v1/status') {
      return enviar(res, 200, dep.status());
    }
    if (req.method === 'POST' && (rota === '/v1/responder' || rota === '/v1/gerar')) {
      const corpo = await lerJson(req);
      const pedido = rota === '/v1/gerar' ? lerPedidoGenerico(corpo) : lerPedido(corpo);
      if ('erro' in pedido) return enviar(res, 400, pedido);
      if (emExecucao >= EXECUCOES_SIMULTANEAS) {
        return enviar(res, 429, { erro: 'O assistente já está respondendo outras perguntas. Tente de novo em instantes.' });
      }
      emExecucao++;
      try {
        return enviar(
          res,
          200,
          await ('prompt' in pedido
            ? dep.gerar(pedido.prompt)
            : dep.responder(pedido.pergunta, pedido.trechos, pedido.historico)),
        );
      } finally {
        emExecucao--;
      }
    }
    return enviar(res, 404, { erro: 'Rota não encontrada.' });
  }
}

function lerJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolver, rejeitar) => {
    const partes: Buffer[] = [];
    let tamanho = 0;
    req.on('data', (parte: Buffer) => {
      tamanho += parte.length;
      if (tamanho > TAMANHO_MAXIMO_DO_CORPO) {
        rejeitar(new ErroHttp(413, 'Corpo da requisição acima de 2 MB.'));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      try {
        resolver(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'));
      } catch {
        rejeitar(new ErroHttp(400, 'JSON inválido.'));
      }
    });
    req.on('error', rejeitar);
  });
}

function enviar(res: ServerResponse, status: number, corpo: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}
