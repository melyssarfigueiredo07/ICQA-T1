// Controle de RQ — atualizar um documento que já existe no Grid, sem perder os dados.
// Como usar: abra a página do documento no Grid, cole este arquivo inteiro no console
// e escolha o controle-rq-grid.zip quando a janela pedir.
(() => {
  // Documento atual do Controle de RQ no Grid. Troque aqui se o documento mudar.
  const ID_PADRAO = '01M7J64B17CD8HS33DAQG024XC';
  const ler = (b, pos, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + b[pos + i]; return v; };

  // Confere o zip antes de enviar: o Grid recusa zip com index.html fora da raiz ou com executáveis.
  async function checarZip(file) {
    const b = new Uint8Array(await file.arrayBuffer());
    let fim = -1;
    for (let i = b.length - 22; i >= 0 && i >= b.length - 65557; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { fim = i; break; }
    }
    if (fim < 0) return ['não é um arquivo zip válido'];
    const total = ler(b, fim + 10, 2);
    let p = ler(b, fim + 16, 4);
    const nomes = [];
    for (let k = 0; k < total && ler(b, p, 4) === 0x02014b50; k++) {
      const nl = ler(b, p + 28, 2), el = ler(b, p + 30, 2), cl = ler(b, p + 32, 2);
      nomes.push(new TextDecoder().decode(b.slice(p + 46, p + 46 + nl)));
      p += 46 + nl + el + cl;
    }
    const erros = [];
    if (!nomes.includes('index.html')) {
      const achado = nomes.find(n => n.endsWith('/index.html'));
      erros.push('index.html precisa estar na raiz do zip' + (achado ? ' (encontrado em: ' + achado + ')' : ''));
    }
    nomes.filter(n => /\.(exe|sh|py|bat)$/i.test(n)).forEach(n => erros.push('arquivo executável, o Grid recusa: ' + n));
    return erros;
  }

  function baixar(blob, nome) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // Cópia dos dados do app (o estado). Só funciona se o app estiver aberto nesta página.
  async function salvarDados() {
    try {
      const ifr = [...document.querySelectorAll('iframe')].find(f => {
        try { return !!(f.contentWindow && f.contentWindow.GRID && f.contentWindow.GRID.state); } catch (e) { return false; }
      });
      if (!ifr) return false;
      const r = await ifr.contentWindow.GRID.state.get();
      baixar(new Blob([JSON.stringify(r.state, null, 2)], { type: 'application/json' }), 'backup-dados-do-app.json');
      return true;
    } catch (e) { return false; }
  }

  // Cópia do zip da versão atual (ele continua no histórico do Grid).
  async function salvarZip(id, versao) {
    try {
      const meta = await fetch(`/api/v1/documents/${id}/download?version=${versao}`, { credentials: 'include' }).then(r => r.json());
      const r = await fetch(new URL(meta.download_url, location.href));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      baixar(await r.blob(), `backup-zip-v${versao}.zip`);
      return true;
    } catch (e) { return false; }
  }

  async function atualizar(id, inp) {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { alert('Escolha um arquivo .zip'); return; }
    const erros = await checarZip(file);
    if (erros.length) { alert('Este zip NÃO deve ser enviado:\n- ' + erros.join('\n- ')); return; }

    const api = path => fetch(`/api/v1/documents/${id}${path}`, { credentials: 'include' });
    const docR = await api('');
    if (!docR.ok) { alert('Não consegui abrir o documento (HTTP ' + docR.status + '). Confira o ID.'); return; }
    const doc = await docR.json();
    if (doc.doc_type !== 'site') { alert('Este documento não é um site (tipo: ' + doc.doc_type + '). Confira o ID.'); return; }
    const verR = await api('/versions');
    if (!verR.ok) { alert('Não consegui ler as versões (HTTP ' + verR.status + ').'); return; }
    const atual = (await verR.json()).current_version;

    if (!confirm(`Atualizar "${doc.title || id}" com "${file.name}"?\n\nVersão atual: ${atual} → nova: ${atual + 1}\n\nA versão anterior continua no histórico do Grid.`)) return;

    if (!(await salvarDados()) && !confirm('Não consegui salvar os dados do app automaticamente (o app precisa estar aberto nesta página).\n\nVocê já fez o "Backup (JSON)" dentro do app?')) return;
    if (!(await salvarZip(id, atual)) && !confirm('Não consegui baixar o zip da versão atual. Continuar mesmo assim?')) return;

    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('if_version', String(atual)); // o Grid responde 409 se alguém publicou uma versão depois desta leitura
    const r = await fetch(`/api/v1/documents/${id}/versions`, { method: 'POST', body: fd, credentials: 'include' });
    const txt = await r.text();
    console.log('STATUS', r.status, txt);
    if (r.status === 409) { alert('Conflito: alguém publicou outra versão depois da sua. Nada foi enviado. Rode de novo para pegar a versão atual.'); return; }
    if (!r.ok) { alert('Não foi enviado (' + r.status + '):\n' + txt.slice(0, 300)); return; }
    alert(`Versão ${atual + 1} publicada.\nAbra o documento e confira se os dados continuam aparecendo.`);
  }

  const m = (prompt('ID do documento do Controle de RQ (está no link /d/ID/view):', ID_PADRAO) || '').match(/[0-9A-Z]{26}/);
  if (!m) { alert('ID inválido'); return; }
  const id = m[0];
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.zip';
  inp.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#ff0;padding:8px';
  document.body.prepend(inp);
  inp.addEventListener('cancel', () => inp.remove());
  inp.onchange = () => atualizar(id, inp);
  inp.click();
})();
