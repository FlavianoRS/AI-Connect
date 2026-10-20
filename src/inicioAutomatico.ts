/**
 * Início junto com o Windows, ligado e desligado pela bandeja. Quem guarda a escolha é o
 * próprio Windows (chave `Run` do usuário, sem administrador). Adaptado do HUB SNK.
 */
import { app } from 'electron';

export const ID_DO_APP = 'br.com.sankhya.aiconnect';

/** Marca a abertura feita pelo Windows no login: o app sobe só na bandeja. */
const ARGUMENTO_DE_INICIO_AUTOMATICO = '--iniciado-com-o-windows';

/** Em desenvolvimento o executável é o `electron.exe`, que precisa da pasta do projeto. */
function opcoesDaEntrada(): { path: string; args: string[] } {
  const pastaDoApp = app.isPackaged ? [] : [app.getAppPath()];
  return { path: process.execPath, args: [...pastaDoApp, ARGUMENTO_DE_INICIO_AUTOMATICO] };
}

export function inicioAutomaticoLigado(): boolean {
  const { launchItems } = app.getLoginItemSettings(opcoesDaEntrada());
  return launchItems.some((entrada) => entrada.name === ID_DO_APP && entrada.enabled);
}

export function definirInicioAutomatico(ligado: boolean): void {
  app.setLoginItemSettings({ ...opcoesDaEntrada(), name: ID_DO_APP, openAtLogin: ligado, enabled: ligado });
}

export function foiIniciadoPeloWindows(): boolean {
  return process.argv.includes(ARGUMENTO_DE_INICIO_AUTOMATICO);
}
