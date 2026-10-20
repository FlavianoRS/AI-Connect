/**
 * Configuração do AI Connect, num JSON na pasta de dados do usuário. É por máquina:
 * os assistentes escolhidos dependem do que está instalado aqui.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ESCOLHAS_DE_ASSISTENTE, type EscolhaDeAssistente } from './assistentes';

/** Um assistente da lista, com o modelo e o raciocínio dele. */
export interface AssistenteDaLista {
  assistente: EscolhaDeAssistente;
  /** Vazio usa o modelo padrão do assistente. */
  modelo: string;
  /** Nível de raciocínio (effort); vazio usa o padrão do modelo. */
  raciocinio: string;
}

/** Quando passar para o próximo assistente da lista. */
export type TrocarEm = 'limite' | 'falha';

export interface Configuracao {
  porta: number;
  /** Em ordem de preferência: o primeiro responde; os outros entram quando ele falha (ver trocarEm). */
  assistentes: AssistenteDaLista[];
  trocarEm: TrocarEm;
  tempoLimiteSegundos: number;
  /** Endereços do Sankhya (origem do navegador) que o usuário autorizou. */
  origensPermitidas: string[];
}

export const MAXIMO_DE_ASSISTENTES = 5;

export const CONFIGURACAO_PADRAO: Configuracao = {
  porta: 47811,
  assistentes: [{ assistente: 'auto', modelo: '', raciocinio: '' }],
  trocarEm: 'limite',
  tempoLimiteSegundos: 180,
  origensPermitidas: [],
};

/** Campo inválido ou ausente volta ao padrão: um JSON editado à mão não derruba o app. */
export function normalizar(dados: unknown): Configuracao {
  const d = (dados && typeof dados === 'object' ? dados : {}) as Record<string, unknown>;
  const inteiro = (valor: unknown, minimo: number, maximo: number, padrao: number) =>
    Number.isInteger(valor) && (valor as number) >= minimo && (valor as number) <= maximo
      ? (valor as number)
      : padrao;
  const texto = (valor: unknown) => (typeof valor === 'string' ? valor.trim() : '');
  const item = (valor: unknown): AssistenteDaLista | null => {
    const i = (valor && typeof valor === 'object' ? valor : {}) as Record<string, unknown>;
    if (!(ESCOLHAS_DE_ASSISTENTE as readonly unknown[]).includes(i['assistente'])) return null;
    return { assistente: i['assistente'] as EscolhaDeAssistente, modelo: texto(i['modelo']), raciocinio: texto(i['raciocinio']) };
  };
  // Até a 1.2.0 era um assistente só, nos campos soltos assistente/modelo/raciocinio.
  const lista = Array.isArray(d['assistentes']) ? d['assistentes'] : [d];
  const assistentes = lista
    .map(item)
    .filter((a): a is AssistenteDaLista => a !== null)
    .filter((a, i, todos) => todos.findIndex((b) => b.assistente === a.assistente) === i)
    .slice(0, MAXIMO_DE_ASSISTENTES);
  return {
    porta: inteiro(d['porta'], 1024, 65535, CONFIGURACAO_PADRAO.porta),
    assistentes: assistentes.length ? assistentes : [...CONFIGURACAO_PADRAO.assistentes],
    trocarEm: d['trocarEm'] === 'falha' ? 'falha' : 'limite',
    tempoLimiteSegundos: inteiro(d['tempoLimiteSegundos'], 10, 1800, CONFIGURACAO_PADRAO.tempoLimiteSegundos),
    origensPermitidas: Array.isArray(d['origensPermitidas'])
      ? [...new Set(d['origensPermitidas'].map(texto).filter((o) => /^https?:\/\/[^/\s]+$/.test(o)))]
      : [],
  };
}

export function carregarConfiguracao(arquivo: string): Configuracao {
  if (!existsSync(arquivo)) return { ...CONFIGURACAO_PADRAO };
  try {
    return normalizar(JSON.parse(readFileSync(arquivo, 'utf8')));
  } catch {
    return { ...CONFIGURACAO_PADRAO };
  }
}

export function salvarConfiguracao(arquivo: string, configuracao: Configuracao): Configuracao {
  const normalizada = normalizar(configuracao);
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, JSON.stringify(normalizada, null, 2), 'utf8');
  return normalizada;
}
