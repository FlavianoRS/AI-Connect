/** Ponte da tela de configuração com o processo principal (contextIsolation ligado). */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ragConnect', {
  situacao: () => ipcRenderer.invoke('situacao'),
  obterConfiguracao: () => ipcRenderer.invoke('configuracao:obter'),
  salvarConfiguracao: (configuracao: unknown) => ipcRenderer.invoke('configuracao:salvar', configuracao),
  testar: () => ipcRenderer.invoke('testar'),
  aoAlterarConfiguracao: (aviso: () => void) => ipcRenderer.on('configuracao-alterada', () => aviso()),
});
