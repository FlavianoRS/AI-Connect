/**
 * Script `.bat`/`.cmd` só roda pelo `cmd.exe`, e o `cmd.exe` não segue as regras de
 * aspas que o Node usa para montar a linha de comando: um caminho com `&` e sem
 * espaço ia sem aspas, e o texto depois do `&` virava outro comando; um `.cmd` numa
 * pasta com espaço, chamado com um argumento com espaço, tinha as aspas descartadas
 * pelo `/c` e não rodava.
 *
 * A linha é montada aqui: cada parte que não é um token simples vai entre aspas, onde
 * `&`, `|`, `<`, `>` e `^` são texto, e o todo vai nas aspas externas que o `/s`
 * remove. Quem chama passa ao `spawn` com `windowsVerbatimArguments`, para o Node não
 * reescrever nada.
 *
 * `%` e `"` não têm escape dentro de aspas no `cmd.exe` — `%PATH%` seria expandido —,
 * então uma parte com eles é recusada.
 */

export class ArgumentoInseguroParaOCmdError extends Error {
  constructor(argumento: string) {
    super(`O caminho "${argumento}" tem % ou aspas, que o cmd.exe não aceita como texto.`);
    this.name = 'ArgumentoInseguroParaOCmdError';
  }
}

/* Sem aspas, porque um `.bat` compara o argumento com o texto cru (`if "%1" == "-b"`). */
const TOKEN_SIMPLES = /^[\w\-.:=/\\]+$/;
const CARACTERES_SEM_ESCAPE = /["%]/;

function citarParaOCmd(parte: string): string {
  return TOKEN_SIMPLES.test(parte) ? parte : `"${parte}"`;
}

/** Argumentos do `cmd.exe` para rodar `script` com `argumentos`, prontos para o `spawn` literal. */
export function argumentosDoCmdParaScript(script: string, argumentos: string[]): string[] {
  const partes = [script, ...argumentos];
  const insegura = partes.find((parte) => CARACTERES_SEM_ESCAPE.test(parte));
  if (insegura !== undefined) {
    throw new ArgumentoInseguroParaOCmdError(insegura);
  }

  const linha = [`"${script}"`, ...argumentos.map(citarParaOCmd)].join(' ');
  return ['/d', '/s', '/c', `"${linha}"`];
}
