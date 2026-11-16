(function(){
  'use strict';

  // ---------- configuração ----------
  const POLL_MS   = 10000; // leitura periódica do Grid, só com a aba visível (6 req/min por aba; limite do Grid é 60/min)
  const SAVE_MS   = 500;   // agrupa digitações antes de gravar
  const TURNOS    = ['Manhã','Tarde','Noite'];
  const CARGOS    = ['Operador','Conferente','Líder','Supervisor','Coordenador','Gerente'];
  const TURNO_CLS = {'Manhã':'t-manha','Tarde':'t-tarde','Noite':'t-noite'};

  // ---------- utilidades ----------
  const $ = s => document.querySelector(s);
  const norm = s => String(s ?? '').trim().toLowerCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hhmm = () => new Date().toTimeString().slice(0,5);
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
  const fmtBR = iso => { if(!iso) return ''; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const uniq = arr => [...new Set(arr.map(v => String(v ?? '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b,'pt-BR'));
  const byNome = (a,b) => a.nome.localeCompare(b.nome,'pt-BR');
  const hasData = s => !!s && ((Array.isArray(s.baixas) && s.baixas.length > 0) || (Array.isArray(s.responsaveis) && s.responsaveis.length > 0));

  // ---------- armazenamento: window.GRID.state (compartilhado e ao vivo) ----------
  // Fora do Grid (ex.: prévia local) não existe estado compartilhado: usamos uma cópia só em memória.
  const preview = !(window.GRID && window.GRID.state);
  let memDoc = {state: {}, updated_at: null};
  const store = preview ? {
    get: () => Promise.resolve(JSON.parse(JSON.stringify(memDoc))),
    set: data => { memDoc = {state: JSON.parse(JSON.stringify(data)), updated_at: new Date().toISOString()}; return Promise.resolve(JSON.parse(JSON.stringify(memDoc))); }
  } : window.GRID.state;

  // ---------- modelo de dados (mesmo formato do JSON base / backup) ----------
  // {teamName, responsaveis:[{id,nome,turno,cargo}], baixas:[{id,sku,quantidade,origem,skuReingresso,responsavel,turno,data}]}
  const emptyRoot = () => ({teamName:'', responsaveis:[], baixas:[]});
  function normRoot(s){
    s = s || {};
    return {
      teamName: String(s.teamName || ''),
      responsaveis: Array.isArray(s.responsaveis) ? s.responsaveis.slice() : [],
      baixas: (Array.isArray(s.baixas) ? s.baixas : []).map(b => ({...b, quantidade: Number(b.quantidade) || 0}))
    };
  }
  // Cada alteração local é uma operação. Ao gravar, as operações são reaplicadas sobre o estado do Grid,
  // então uma gravação de outra pessoa não apaga as nossas (e vice-versa).
  function applyOps(base, ops){
    let r = normRoot(base);
    for(const op of ops){
      if(op.t === 'replace'){ r = normRoot(op.root); continue; }
      if(op.t === 'root'){ r.teamName = op.teamName; continue; }
      const list = r[op.c];
      const i = list.findIndex(x => x.id === (op.t === 'add' ? op.rec.id : op.id));
      if(op.t === 'add'){ if(i >= 0) list[i] = {...op.rec}; else list.unshift({...op.rec}); }
      else if(op.t === 'set' && i >= 0){ list[i] = {...list[i], ...op.patch}; }
      else if(op.t === 'del' && i >= 0){ list.splice(i, 1); }
    }
    return r;
  }

  // ---------- estado ----------
  let serverRoot = emptyRoot(), serverAt = null, loaded = false; // último estado confirmado pelo Grid
  let pending = [], view = emptyRoot();                          // operações ainda não confirmadas e o que aparece na tela
  let timer = null, inFlight = false, needRender = false;
  const F = {de:'', ate:'', turno:'', sku:'', origem:'', nome:''};

  const findResp = nome => { const n = norm(nome); return n ? view.responsaveis.find(r => norm(r.nome) === n) : undefined; };
  const turnoOf = b => { const r = findResp(b.responsavel); return r ? r.turno : (b.turno || ''); };
  const gridFocused = () => { const ae = document.activeElement; return !!(ae && ae.closest && ae.closest('#rows,#resp-rows')); };

  // ---------- status, avisos e diálogos ----------
  function setStatus(txt, cls){ const el = $('#sync'); el.textContent = txt; el.className = 'sync ' + (cls || ''); }
  function banner(msg){ const el = $('#banner'); el.textContent = msg || ''; el.hidden = !msg; }

  function dialog(msg, ok, cancel, danger){
    return new Promise(resolve => {
      const m = $('#modal'), okB = $('#modal-ok'), noB = $('#modal-no');
      $('#modal-msg').textContent = msg;
      okB.textContent = ok;
      okB.className = danger ? 'btn-danger-solid' : 'btn-add';
      noB.hidden = !cancel;
      noB.textContent = cancel || '';
      m.hidden = false;
      okB.focus();
      const done = v => { m.hidden = true; okB.onclick = noB.onclick = m.onkeydown = null; resolve(v); };
      okB.onclick = () => done(true);
      noB.onclick = () => done(false);
      m.onkeydown = e => { if(e.key === 'Escape' && cancel) done(false); };
    });
  }
  const confirmar = (msg, ok, danger = false) => dialog(msg, ok, 'Cancelar', danger);
  const avisar    = msg => dialog(msg, 'Entendi', null, false);

  // ---------- sincronização ----------
  function takeServer(res){
    serverRoot = normRoot(res.state);
    serverAt = res.updated_at || null;
    loaded = true;
    view = applyOps(serverRoot, pending);
  }
  // leitura periódica: ignora uma resposta mais antiga do que a que já temos
  function adoptIfNewer(res){
    const novo = Date.parse(res.updated_at), atual = Date.parse(serverAt);
    if(serverAt && !isNaN(novo) && !isNaN(atual) && novo < atual) return false;
    takeServer(res);
    return true;
  }
  function later(ms){ clearTimeout(timer); timer = setTimeout(flush, ms); }

  function commit(ops){
    pending.push(...ops);
    view = applyOps(serverRoot, pending);
    renderSoon();
    setStatus(loaded ? 'Salvando…' : 'Carregando…', 'busy');
    later(SAVE_MS);
  }

  async function flush(){
    if(!loaded) return;                 // nunca grava antes de ler o estado do Grid
    if(!pending.length) return;
    if(inFlight){ later(300); return; }
    inFlight = true;
    const n = pending.length;
    const next = applyOps(serverRoot, pending.slice(0, n));
    try{
      const res = serverAt ? await store.set(next, serverAt) : await store.set(next);
      serverRoot = next;
      serverAt = res.updated_at || serverAt;
      pending.splice(0, n);
      view = applyOps(serverRoot, pending);
      if(pending.length){
        setStatus('Salvando…', 'busy');
        later(SAVE_MS);
      } else {
        setStatus(preview ? 'Prévia · não salvo fora do Grid' : `Salvo · ${hhmm()}`, preview ? 'warn' : 'ok');
      }
      renderSoon();
    }catch(err){
      if(err && err.error === 'state_conflict'){
        // outra pessoa gravou antes: pega o estado atual e refaz nossas alterações por cima
        try{
          takeServer(await store.get());
          renderSoon();
          setStatus('Atualizado por outra pessoa · reaplicando…', 'warn');
          later(0);
        }catch(e){
          setStatus('Sem conexão com o Grid — alterações mantidas nesta tela', 'err');
          later(5000);
        }
      } else {
        setStatus('Sem conexão com o Grid — tentando de novo…', 'err');
        later(5000);
      }
    }finally{
      inFlight = false;
    }
  }

  async function poll(){
    if(preview || !loaded || inFlight || document.hidden) return;
    try{
      const res = await store.get();
      if(res.updated_at !== serverAt){
        if(adoptIfNewer(res)){
          if(!pending.length) setStatus(`Atualizado · ${hhmm()}`, 'ok');
          renderSoon();
        }
      } else if(!pending.length){
        setStatus(`Sincronizado · ${hhmm()}`, 'ok');
      }
    }catch(e){
      setStatus('Sem conexão com o Grid — exibindo a última cópia', 'err');
    }
  }

  async function load(){
    let res = await store.get();
    // um documento novo pode voltar vazio por um instante: tenta mais duas vezes antes de aceitar
    for(let i = 0; i < 2 && !hasData(res.state); i++){ await sleep(700); res = await store.get(); }
    takeServer(res);
    banner(preview ? 'Prévia fora do Grid: as alterações não são salvas. Abra o documento no Grid para usar de verdade.' : '');
    renderAll();
    setStatus(preview ? 'Prévia · não salvo fora do Grid' : `Sincronizado · ${hhmm()}`, preview ? 'warn' : 'ok');
    if(pending.length) later(0);
  }
  async function loadWithRetry(){
    try{ await load(); }
    catch(err){
      setStatus('Não foi possível ler o Grid — nada será gravado até a conexão voltar', 'err');
      banner('Sem leitura do Grid. Tentando de novo em instantes…');
      setTimeout(loadWithRetry, 3000);
    }
  }

  // ---------- abas ----------
  function showTab(t, focus = true){
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    $('#tab-baixas').hidden = t !== 'baixas';
    $('#tab-resp').hidden   = t !== 'resp';
    if(focus) (t === 'baixas' ? $('#sku') : $('#r-nome')).focus();
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- render ----------
  // Não redesenha a grid enquanto alguém está editando uma célula (o foco se perderia).
  function renderSoon(){
    if(gridFocused()){ needRender = true; updateStats(); return; }
    renderAll();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if(needRender && !gridFocused()) renderAll(); }, 0));

  function renderAll(){
    needRender = false;
    refreshSelects();
    renderResp();
    renderBaixas();
    if(document.activeElement !== $('#teamName')) $('#teamName').value = view.teamName;
  }

  function setOptions(sel, html, value){
    if(sel.dataset.html !== html){ sel.innerHTML = html; sel.dataset.html = html; }
    if(value !== undefined && [...sel.options].some(o => o.value === value)) sel.value = value;
  }
  function refreshSelects(){
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    const origens = uniq(view.baixas.map(b => b.origem));
    const pessoas = uniq([...nomes, ...view.baixas.map(b => b.responsavel)]);
    setOptions($('#responsavel'),
      (nomes.length ? '<option value="">Selecione…</option>' : '<option value="">Cadastre um responsável primeiro</option>') +
      nomes.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join(''), $('#responsavel').value);
    setOptions($('#f-origem'), '<option value="">Todas</option>' + origens.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''), F.origem);
    setOptions($('#f-nome'),   '<option value="">Todos</option>' + pessoas.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''), F.nome);
    $('#dl-origem').innerHTML = origens.map(v => `<option value="${esc(v)}">`).join('');
    F.origem = $('#f-origem').value;
    F.nome   = $('#f-nome').value;
    updateTurnoInfo();
  }
  function updateTurnoInfo(){
    const r = findResp($('#responsavel').value);
    $('#turno-info').textContent = r ? `Turno: ${r.turno}` : '';
  }

  function renderResp(){
    const list = view.responsaveis.slice().sort(byNome);
    $('#resp-rows').innerHTML = list.length ? list.map(r => `
        <tr data-id="${esc(r.id)}">
          <td><input data-rf="nome" value="${esc(r.nome)}"></td>
          <td><select data-rf="turno">${TURNOS.map(t => `<option ${t === r.turno ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
          <td><input data-rf="cargo" list="dl-cargo" value="${esc(r.cargo)}"></td>
          <td class="actions"><button class="btn-danger" data-rdel title="Remover">✕</button></td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">Nenhum responsável cadastrado ainda. Cadastre acima para liberar os lançamentos.</td></tr>';
    $('#st-resp').textContent = `${list.length} ${list.length === 1 ? 'responsável' : 'responsáveis'}`;
  }

  function turnoHTML(t){
    return t ? `<span class="turno ${TURNO_CLS[t] || 't-none'}">${esc(t)}</span>` : '<span class="turno t-none">—</span>';
  }
  function respOpts(sel){
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    if(sel && !nomes.some(n => norm(n) === norm(sel))) nomes.unshift(sel);
    return nomes.map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  function rowHTML(b){
    return `
      <td><input data-f="sku" class="sku" value="${esc(b.sku)}"></td>
      <td class="num"><input data-f="quantidade" type="number" min="1" step="1" value="${esc(b.quantidade)}"></td>
      <td><input data-f="origem" value="${esc(b.origem)}"></td>
      <td><input data-f="skuReingresso" class="sku" value="${esc(b.skuReingresso)}"></td>
      <td><select data-f="responsavel">${respOpts(b.responsavel)}</select></td>
      <td data-turno>${turnoHTML(turnoOf(b))}</td>
      <td><input data-f="data" type="date" value="${esc(b.data)}"></td>
      <td class="actions"><button class="btn-danger" data-del title="Remover">✕</button></td>`;
  }
  function matches(b){
    if(F.de  && b.data < F.de) return false;
    if(F.ate && b.data > F.ate) return false;
    if(F.turno && turnoOf(b) !== F.turno) return false;
    if(F.sku && !String(b.sku).toLowerCase().includes(F.sku)) return false;
    if(F.origem && norm(b.origem) !== norm(F.origem)) return false;
    if(F.nome   && norm(b.responsavel) !== norm(F.nome)) return false;
    return true;
  }
  function renderBaixas(flashId){
    const list = view.baixas.filter(matches);
    const tb = $('#rows');
    if(!list.length){
      tb.innerHTML = `<tr><td colspan="8" class="empty">${
        view.baixas.length ? 'Nenhuma baixa corresponde aos filtros.'
                           : 'Nenhuma baixa ainda. Preencha o formulário acima e pressione Enter.'}</td></tr>`;
    } else {
      const frag = document.createDocumentFragment();
      list.forEach(b => {
        const tr = document.createElement('tr');
        tr.dataset.id = b.id;
        if(b.id === flashId) tr.classList.add('flash');
        tr.innerHTML = rowHTML(b);
        frag.appendChild(tr);
      });
      tb.replaceChildren(frag);
    }
    updateStats();
  }
  function updateStats(){
    const list = view.baixas.filter(matches);
    const units = list.reduce((s,x) => s + (Number(x.quantidade) || 0), 0);
    const filtrado = list.length !== view.baixas.length;
    $('#st-linhas').textContent = `${list.length} ${list.length === 1 ? 'baixa' : 'baixas'}${filtrado ? ` de ${view.baixas.length}` : ''}`;
    $('#st-qtd').textContent = `${units} ${units === 1 ? 'unidade' : 'unidades'}`;
  }

  // ---------- Responsáveis ----------
  $('#r-turno').innerHTML = TURNOS.map(t => `<option>${t}</option>`).join('');
  $('#r-turno').value = 'Manhã';
  $('#dl-cargo').innerHTML = CARGOS.map(c => `<option value="${esc(c)}">`).join('');

  $('#formResp').addEventListener('submit', e => {
    e.preventDefault();
    const nome  = $('#r-nome').value.trim();
    const turno = $('#r-turno').value;
    const cargo = $('#r-cargo').value.trim();
    if(!nome){ $('#r-nome').focus(); return; }
    if(findResp(nome)){
      avisar(`Já existe um responsável cadastrado como "${nome}".`).then(() => $('#r-nome').select());
      return;
    }
    commit([{t:'add', c:'responsaveis', rec:{id: uid(), nome, turno, cargo}}]);
    $('#r-nome').value = '';
    $('#r-cargo').value = '';
    $('#r-nome').focus();
  });

  $('#resp-rows').addEventListener('change', e => {
    const inp = e.target.closest('[data-rf]');
    if(!inp) return;
    const id = inp.closest('tr').dataset.id;
    const r = view.responsaveis.find(x => x.id === id);
    if(!r) return;
    const f = inp.dataset.rf;
    const v = inp.value.trim();
    if(f === 'nome'){
      if(!v){ inp.value = r.nome; return; }
      if(view.responsaveis.some(x => x.id !== id && norm(x.nome) === norm(v))){
        inp.value = r.nome;
        avisar('Já existe um responsável com esse nome.');
        return;
      }
      // renomear também atualiza as baixas já lançadas com o nome antigo
      const ops = [{t:'set', c:'responsaveis', id, patch:{nome: v}}];
      view.baixas.filter(b => norm(b.responsavel) === norm(r.nome))
        .forEach(b => ops.push({t:'set', c:'baixas', id: b.id, patch:{responsavel: v}}));
      commit(ops);
    } else {
      commit([{t:'set', c:'responsaveis', id, patch:{[f]: v}}]);
    }
  });

  $('#resp-rows').addEventListener('click', async e => {
    const btn = e.target.closest('[data-rdel]');
    if(!btn) return;
    const id = btn.closest('tr').dataset.id;
    const r = view.responsaveis.find(x => x.id === id);
    if(!r) return;
    if(!await confirmar(`Remover ${r.nome} do cadastro? As baixas já lançadas com este nome são mantidas.`, 'Remover', true)) return;
    commit([{t:'del', c:'responsaveis', id}]);
  });

  // ---------- Baixas ----------
  const form = $('#form');
  $('#responsavel').addEventListener('change', updateTurnoInfo);

  form.addEventListener('submit', e => {
    e.preventDefault();
    const sku  = $('#sku').value.trim().toUpperCase();
    const qtd  = parseInt($('#quantidade').value, 10);
    const nome = $('#responsavel').value;
    if(!sku){ $('#sku').focus(); return; }
    if(!(qtd > 0)){ $('#quantidade').focus(); return; }
    if(!nome){
      if(!view.responsaveis.length){
        avisar('Cadastre os responsáveis na aba "Cadastro de responsáveis" antes de lançar baixas.').then(() => showTab('resp'));
      } else {
        $('#responsavel').focus();
      }
      return;
    }
    const r = findResp(nome);
    commit([{t:'add', c:'baixas', rec:{
      id: uid(),
      sku,
      quantidade: qtd,
      origem: $('#origem').value.trim(),
      skuReingresso: $('#skuReingresso').value.trim().toUpperCase(),
      responsavel: r ? r.nome : nome,
      turno: r ? r.turno : '',
      data: $('#data').value || todayISO()
    }}]);
    // origem e responsável continuam preenchidos; só o que muda a cada lançamento é limpo
    $('#sku').value = '';
    $('#quantidade').value = '';
    $('#skuReingresso').value = '';
    $('#sku').focus();
  });

  $('#rows').addEventListener('change', e => {
    const inp = e.target.closest('[data-f]');
    if(!inp) return;
    const id = inp.closest('tr').dataset.id;
    const b = view.baixas.find(x => x.id === id);
    if(!b) return;
    const f = inp.dataset.f;
    let v = inp.value;
    if(f === 'quantidade'){
      v = parseInt(v, 10);
      if(!(v > 0)){ inp.value = b.quantidade; return; }
    } else if(f === 'sku' || f === 'skuReingresso'){
      v = v.trim().toUpperCase();
    } else if(f === 'data'){
      if(!v){ inp.value = b.data; return; }
    } else {
      v = v.trim();
    }
    const patch = {[f]: v};
    if(f === 'responsavel'){ const r = findResp(v); patch.turno = r ? r.turno : ''; }
    commit([{t:'set', c:'baixas', id, patch}]);
    if(f === 'origem' || f === 'responsavel') refreshSelects();
  });

  $('#rows').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del]');
    if(!btn) return;
    const id = btn.closest('tr').dataset.id;
    const b = view.baixas.find(x => x.id === id);
    if(!b) return;
    if(!await confirmar(`Remover a baixa de ${b.sku} (${b.quantidade} un.)?`, 'Remover', true)) return;
    commit([{t:'del', c:'baixas', id}]);
  });

  // ---------- filtros ----------
  function readFilters(){
    F.de     = $('#f-de').value;
    F.ate    = $('#f-ate').value;
    F.turno  = $('#f-turno').value;
    F.sku    = $('#f-sku').value.trim().toLowerCase();
    F.origem = $('#f-origem').value;
    F.nome   = $('#f-nome').value;
    renderBaixas();
  }
  ['#f-de','#f-ate','#f-turno','#f-sku','#f-origem','#f-nome'].forEach(id => {
    $(id).addEventListener('input', readFilters);
    $(id).addEventListener('change', readFilters);
  });
  $('#btn-limpar-filtros').addEventListener('click', () => {
    ['#f-de','#f-ate','#f-sku','#f-turno','#f-origem','#f-nome'].forEach(id => $(id).value = '');
    readFilters();
  });

  // ---------- nome do time ----------
  $('#teamName').addEventListener('change', e => {
    const v = e.target.value.trim();
    if(v !== view.teamName) commit([{t:'root', teamName: v}]);
  });

  // ---------- ações ----------
  $('#btn-limpar').addEventListener('click', async () => {
    if(!view.baixas.length) return;
    if(!await confirmar(`Apagar TODAS as ${view.baixas.length} baixas deste controle? O cadastro de responsáveis é mantido.`, 'Apagar tudo', true)) return;
    commit(view.baixas.map(b => ({t:'del', c:'baixas', id: b.id})));
  });

  $('#btn-csv').addEventListener('click', () => {
    const list = view.baixas.filter(matches);
    const head = ['SKU','QUANTIDADE','ORIGEM','SKU REINGRESSO','RESPONSÁVEL','TURNO','DATA'];
    const cell = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = [head.map(cell).join(';')].concat(
      list.map(b => [b.sku, b.quantidade, b.origem, b.skuReingresso, b.responsavel, turnoOf(b), fmtBR(b.data)].map(cell).join(';'))
    );
    downloadBlob(new Blob(['﻿' + lines.join('\r\n')], {type:'text/csv;charset=utf-8'}), `controle-rq-${todayISO()}.csv`);
  });

  // backup no mesmo formato do JSON base (controle-rq-dados.json)
  $('#btn-backup').addEventListener('click', () => {
    const data = {teamName: view.teamName, responsaveis: view.responsaveis, baixas: view.baixas};
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}), `controle-rq-backup-${todayISO()}.json`);
  });

  function downloadBlob(blob, name){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#btn-importar').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    let data;
    try{ data = JSON.parse(await file.text()); }
    catch(err){ await avisar('Arquivo inválido: não é um JSON.'); return; }
    if(!data || !Array.isArray(data.responsaveis) || !Array.isArray(data.baixas)){
      await avisar('Arquivo inválido: precisa ter as listas "responsaveis" e "baixas" (mesmo formato do backup).');
      return;
    }
    if(!await confirmar(`Substituir TODOS os dados deste controle pelos ${data.baixas.length} lançamentos e ${data.responsaveis.length} responsáveis do arquivo?`, 'Substituir', true)) return;
    commit([{t:'replace', root: {teamName: String(data.teamName || ''), responsaveis: data.responsaveis, baixas: data.baixas}}]);
  });

  // ---------- início ----------
  $('#data').value = todayISO();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) poll(); });
  renderAll();
  showTab('baixas', false);
  loadWithRetry();
})();
