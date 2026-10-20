/* Tela de configuração. Fala com o processo principal só pela ponte `window.ragConnect`. */
const $ = (id) => document.getElementById(id);
const MAXIMO_DE_ASSISTENTES = 5; // mesmo limite de src/configuracao.ts
let situacao = null;
let origens = [];
/** [{assistente, modelo, raciocinio}], em ordem de preferência. */
let lista = [];

function opcao(valor, texto) {
  const o = document.createElement('option');
  o.value = valor;
  o.textContent = texto;
  return o;
}

function elemento(tag, propriedades, filhos) {
  const e = Object.assign(document.createElement(tag), propriedades || {});
  e.append(...(filhos || []));
  return e;
}

function assistenteEfetivo(escolha) {
  if (escolha !== 'auto') return situacao.assistentes.find((a) => a.id === escolha);
  return situacao.assistentes.find((a) => a.instalado);
}

/** Um cartão por assistente da lista: escolha, modelo, raciocínio e botões de ordem. */
function desenharAssistentes() {
  $('assistentes').replaceChildren(...lista.map((item, i) => {
    const a = assistenteEfetivo(item.assistente);
    const escolha = elemento('select', {}, [
      opcao('auto', 'Automático (primeiro instalado)'),
      ...situacao.assistentes.map((s) => opcao(s.id, s.instalado ? s.nome : `${s.nome} (não instalado)`)),
    ]);
    escolha.setAttribute('aria-label', `Assistente ${i + 1}º`);
    escolha.value = item.assistente;
    escolha.onchange = () => { lista[i] = { assistente: escolha.value, modelo: '', raciocinio: '' }; desenharAssistentes(); };

    const botao = (texto, titulo, desabilitado, acao) =>
      elemento('button', { className: 'peq', textContent: texto, title: titulo, disabled: desabilitado, onclick: acao });
    const mover = (de, para) => { [lista[de], lista[para]] = [lista[para], lista[de]]; desenharAssistentes(); };

    const idModelos = `modelos-${i}`;
    const modelo = elemento('input', { value: item.modelo, placeholder: a && a.modeloPadrao ? `padrão: ${a.modeloPadrao}` : 'padrão do assistente' });
    modelo.setAttribute('list', idModelos);
    const raciocinio = elemento('select');
    const atualizarRaciocinio = () => {
      const niveis = a ? (a.raciocinio[modelo.value.trim()] ?? a.raciocinio[''] ?? null) : null;
      raciocinio.replaceChildren(opcao('', 'padrão do modelo'), ...(niveis ? niveis.niveis.map((n) => opcao(n, n)) : []));
      raciocinio.disabled = !niveis;
      raciocinio.value = niveis && niveis.niveis.includes(lista[i].raciocinio) ? lista[i].raciocinio : '';
      lista[i].raciocinio = raciocinio.value;
    };
    modelo.oninput = () => { lista[i].modelo = modelo.value; atualizarRaciocinio(); };
    raciocinio.onchange = () => { lista[i].raciocinio = raciocinio.value; };
    atualizarRaciocinio();

    const caminho = elemento('div', {
      className: a && a.instalado ? 'dica' : 'dica erro',
      textContent: a ? (a.instalado ? `${a.nome}: ${a.caminho}` : `${a.nome} não está instalado; será pulado.`) : 'Nenhum assistente instalado.',
    });
    return elemento('div', { className: 'item' }, [
      elemento('div', { className: 'item-topo' }, [
        elemento('span', { className: 'ordem', textContent: `${i + 1}º` }),
        escolha,
        botao('↑', 'Subir', i === 0, () => mover(i, i - 1)),
        botao('↓', 'Descer', i === lista.length - 1, () => mover(i, i + 1)),
        botao('Remover', 'Tirar da lista', lista.length === 1, () => { lista.splice(i, 1); desenharAssistentes(); }),
      ]),
      caminho,
      elemento('div', { className: 'linha' }, [
        elemento('div', {}, [elemento('label', { textContent: 'Modelo' }), modelo,
          elemento('datalist', { id: idModelos }, (a ? a.modelos : []).map((m) => opcao(m, m)))]),
        elemento('div', {}, [elemento('label', { textContent: 'Raciocínio (effort)' }), raciocinio]),
      ]),
    ]);
  }));
  $('adicionar').disabled = lista.length >= MAXIMO_DE_ASSISTENTES;
}

$('adicionar').onclick = () => {
  // Sugere o primeiro instalado que ainda não está na lista.
  const livre = situacao.assistentes.find((a) => a.instalado && !lista.some((l) => l.assistente === a.id));
  lista.push({ assistente: livre ? livre.id : 'auto', modelo: '', raciocinio: '' });
  desenharAssistentes();
};

function desenharOrigens() {
  $('origens').replaceChildren(
    ...(origens.length ? origens : [null]).map((origem) => {
      const li = document.createElement('li');
      if (!origem) {
        li.textContent = 'Nenhum ainda.';
        return li;
      }
      const remover = document.createElement('button');
      remover.className = 'peq';
      remover.textContent = 'Remover';
      remover.onclick = () => { origens = origens.filter((o) => o !== origem); desenharOrigens(); };
      li.append(origem, remover);
      return li;
    }),
  );
}

async function carregar() {
  $('assistentes').replaceChildren(elemento('div', { className: 'dica', textContent: 'Procurando assistentes...' }));
  const [s, c] = await Promise.all([window.ragConnect.situacao(), window.ragConnect.obterConfiguracao()]);
  situacao = s;
  origens = [...c.origensPermitidas];
  lista = c.assistentes.map((a) => ({ ...a }));
  $('trocarEm').value = c.trocarEm;
  $('tempoLimite').value = c.tempoLimiteSegundos;
  $('porta').value = c.porta;
  $('inicioAutomatico').checked = s.inicioAutomatico;
  $('estadoServidor').textContent = s.erroDoServidor || `Ouvindo em 127.0.0.1:${s.porta} · versão ${s.versao}`;
  $('estadoServidor').className = s.erroDoServidor ? 'estado erro' : 'estado ok';
  desenharAssistentes();
  desenharOrigens();
}

$('salvar').onclick = async () => {
  await window.ragConnect.salvarConfiguracao({
    assistentes: lista,
    trocarEm: $('trocarEm').value,
    tempoLimiteSegundos: Number($('tempoLimite').value),
    porta: Number($('porta').value),
    origensPermitidas: origens,
    inicioAutomatico: $('inicioAutomatico').checked,
  });
  await carregar();
  $('resultado').className = 'ok';
  $('resultado').textContent = 'Configuração salva.';
};

$('testar').onclick = async () => {
  $('testar').disabled = true;
  $('resultado').className = '';
  $('resultado').textContent = 'Perguntando ao assistente (usa a configuração salva)...';
  const r = await window.ragConnect.testar();
  $('testar').disabled = false;
  $('resultado').className = r.ok ? 'ok' : 'erro';
  $('resultado').textContent = r.ok
    ? `${r.assistente} · ${r.modelo} · ${(r.duracaoMs / 1000).toFixed(1)} s${r.trocouDe ? ` · trocou de ${r.trocouDe}` : ''}\n\n${r.resposta}`
    : r.erro;
};

// Origem autorizada pelo aviso enquanto a janela estava aberta.
window.ragConnect.aoAlterarConfiguracao(() => window.ragConnect.obterConfiguracao().then((c) => {
  origens = [...new Set([...origens, ...c.origensPermitidas])];
  desenharOrigens();
}));

carregar();
