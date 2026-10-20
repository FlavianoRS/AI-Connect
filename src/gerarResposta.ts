/**
 * Roda os assistentes configurados, em ordem, numa pasta temporária vazia e devolve o texto gerado.
 * Quando um falha (por limite de uso, ou por qualquer motivo, conforme `trocarEm`), tenta o próximo.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssistenteFalhouError,
  AssistenteIndisponivelError,
  nomeDoAssistente,
  perguntarAoAssistente,
  resolverAssistente,
  type AssistenteDeIa,
} from './assistentes';
import type { Configuracao, TrocarEm } from './configuracao';
import { montarPrompt, type Trecho, type Turno } from './prompt';
import { ErroHttp, type RespostaGerada } from './servidor';

/** Como cada assistente avisa que a cota ou o limite de uso acabou (texto do erro que ele escreve). */
// ponytail: lista de textos conhecidos; se um assistente mudar a mensagem, o "qualquer falha" ainda cobre
const LIMITE_DE_USO =
  /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b|credit balance|limit (reached|exceeded)|hit your (usage )?limit|resource[ _-]?exhausted|out of (credits|tokens)|insufficient[ _-]?quota/i;

export function deveTrocar(trocarEm: TrocarEm, mensagem: string): boolean {
  return trocarEm === 'falha' || LIMITE_DE_USO.test(mensagem);
}

export function gerarResposta(
  configuracao: Configuracao,
  pergunta: string,
  trechos: Trecho[],
  historico: Turno[] = [],
): Promise<RespostaGerada> {
  return gerarTexto(configuracao, montarPrompt(pergunta, trechos, historico));
}

/** Roda um assistente; separado para o teste trocar por um falso. */
export type Executor = (id: AssistenteDeIa, modelo: string, raciocinio: string) => Promise<string>;

export async function gerarTexto(
  configuracao: Configuracao,
  prompt: string,
  executar: Executor = executorPadrao(configuracao, prompt),
  resolver: (escolha: Configuracao['assistentes'][number]['assistente']) => AssistenteDeIa = resolverAssistente,
): Promise<RespostaGerada> {
  const inicio = Date.now();
  const falhas: string[] = [];
  let ultimoErro: Error | null = null;
  for (const [n, item] of configuracao.assistentes.entries()) {
    let id: AssistenteDeIa;
    try {
      id = resolver(item.assistente);
    } catch (erro) {
      if (!(erro instanceof AssistenteIndisponivelError)) throw erro;
      ultimoErro = erro; // não instalado nesta máquina: segue para o próximo
      continue;
    }
    try {
      const resposta = await executar(id, item.modelo, item.raciocinio);
      return {
        resposta,
        assistente: nomeDoAssistente(id),
        modelo: item.modelo || 'padrão do assistente',
        duracaoMs: Date.now() - inicio,
        ...(falhas.length ? { trocouDe: falhas.join(', ') } : {}),
      };
    } catch (erro) {
      if (!(erro instanceof AssistenteFalhouError || erro instanceof AssistenteIndisponivelError)) throw erro;
      ultimoErro = erro;
      falhas.push(nomeDoAssistente(id));
      if (n === configuracao.assistentes.length - 1 || !deveTrocar(configuracao.trocarEm, erro.message)) break;
    }
  }
  if (ultimoErro instanceof AssistenteIndisponivelError && !falhas.length) throw new ErroHttp(503, ultimoErro.message);
  throw new ErroHttp(502, ultimoErro ? ultimoErro.message : 'Nenhum assistente configurado.');
}

function executorPadrao(configuracao: Configuracao, prompt: string): Executor {
  return async (id, modelo, raciocinio) => {
    // Pasta vazia: o assistente não tem nada da máquina para ler, só o prompt.
    const pasta = mkdtempSync(join(tmpdir(), 'ai-connect-'));
    try {
      return await perguntarAoAssistente(id, {
        prompt,
        pasta,
        modelo,
        raciocinio,
        tempoLimiteMs: configuracao.tempoLimiteSegundos * 1000,
      });
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  };
}
