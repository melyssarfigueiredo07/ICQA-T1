(() => {
  'use strict';

  // ---------- configuração ----------
  const POLL_MS = 10000;   // leitura periódica do Grid (só com a aba visível): 6 req/min por aba
  const SAVE_MS = 1500;    // alterações agrupadas: no máximo ~40 gravações/min por aba (limite do Grid: 60/min)
  const TURNOS = ['T1', 'T2', 'T3', 'T4'];
  const CARGOS = ['Operador', 'Conferente', 'Líder', 'Supervisor', 'Coordenador', 'Gerente'];
  const TURNO_CLS = { T1: 't-t1', T2: 't-t2', T3: 't-t3', T4: 't-t4' };
  const TODOS = '__todos__';
  const RQ_RE = /^RQ-/i;
  const EMAIL_SUPORTE = 'soporteME@mercadolibre.com';

  // Motivos. O modelo de chamado de baixa (Baja de RQ) aceita um motivo por linha, com este texto exato.
  const MOTIVOS = {
    saldo: {
      label: 'Saldo Sistêmico Incorreto',
      reason: 'Entrada sistémica mayor que física. Problem ID #13966888'
    },
    sku: {
      label: 'Meli SKU Invertida',
      reason: 'Meli SKU Invertida: Cada SKU tiene un EAN diferente. Problem ID #10637539'
    }
  };
  // Modelo "Template" do chamado: uma linha por baixa
  const TEMPLATE_HEAD = ['sku', 'quantity', 'warehouse_id', 'address_id', 'reason'];
  const TEMPLATE_LARG = [16, 12, 16, 24, 80];
  // Guia de painel (interna)
  const PAINEL_NOME = 'Painel';
  const PAINEL_HEAD = ['SKU', 'QUANTIDADE', 'WAREHOUSE', 'ENDEREÇO RQ', 'MOTIVO', 'SKU REINGRESSO', 'RESPONSÁVEL', 'TURNO', 'DATA'];
  const PAINEL_LARG = [16, 12, 14, 24, 30, 18, 24, 10, 14];
  // Guia de saldo por responsável (interna)
  const SALDO_NOME = 'Saldo por responsável';
  const SALDO_HEAD = ['RESPONSÁVEL', 'TURNO', 'CARGO', 'SOLICITAÇÕES', 'UNIDADES', 'SALDO SIST. INCORRETO (SOLIC.)', 'SALDO SIST. INCORRETO (UN.)', 'MELI SKU INVERTIDA (SOLIC.)', 'MELI SKU INVERTIDA (UN.)', 'PRIMEIRA DATA', 'ÚLTIMA DATA'];
  const SALDO_LARG = [26, 10, 14, 14, 12, 28, 26, 26, 24, 16, 16];

  // ---------- utilidades ----------
  const $ = s => document.querySelector(s);
  const norm = s => String(s ?? '').trim().toLowerCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hhmm = () => new Date().toTimeString().slice(0, 5);
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fmtBR = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const uniq = arr => [...new Set(arr.map(v => String(v ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const byNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
  const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'sem-nome';
  const hasData = s => !!s && ((Array.isArray(s.baixas) && s.baixas.length > 0) || (Array.isArray(s.responsaveis) && s.responsaveis.length > 0));
  const dataCel = iso => iso ? { dt: iso } : '';

  // ---------- armazenamento: window.GRID.state (compartilhado e ao vivo) ----------
  // Fora do Grid (prévia local) não existe estado compartilhado: usa uma cópia só em memória.
  const preview = !(window.GRID && window.GRID.state);
  let memDoc = { state: {}, updated_at: null };
  const store = preview ? {
    get: () => Promise.resolve(JSON.parse(JSON.stringify(memDoc))),
    set: data => { memDoc = { state: JSON.parse(JSON.stringify(data)), updated_at: new Date().toISOString() }; return Promise.resolve(JSON.parse(JSON.stringify(memDoc))); }
  } : window.GRID.state;

  // ---------- modelo de dados ----------
  // { teamName, responsaveis:[{id,nome,turno,cargo}],
  //   baixas:[{id,sku,quantidade,warehouse,origem,skuReingresso,responsavel,turno,data,motivo}],
  //   rascunhos:[{id,sku,quantidade,warehouse,origem,skuReingresso,motivo,data}] }
  //   origem = endereço RQ (address_id);  motivo = '' | 'saldo' | 'sku'
  const emptyRoot = () => ({ teamName: '', responsaveis: [], baixas: [], rascunhos: [], planilhas: [] });
  const qtdBaixa = v => Number(v) || 0;
  const qtdRascunho = v => (v === '' || v == null) ? '' : (Number(v) || 0);
  // dados antigos guardavam uma lista de motivos (motivos: [...]); fica só o primeiro
  const motivoDe = r => {
    if (MOTIVOS[r.motivo]) return r.motivo;
    if (Array.isArray(r.motivos) && MOTIVOS[r.motivos[0]]) return r.motivos[0];
    return '';
  };
  const normBaixa = b => ({ ...b, quantidade: qtdBaixa(b.quantidade), warehouse: String(b.warehouse || ''), origem: String(b.origem || ''), motivo: motivoDe(b), motivos: undefined });
  const normRasc = r => ({ ...r, quantidade: qtdRascunho(r.quantidade), warehouse: String(r.warehouse || ''), origem: String(r.origem || ''), motivo: motivoDe(r), motivos: undefined });
  function normRoot(s) {
    s = s || {};
    return {
      teamName: String(s.teamName || ''),
      responsaveis: Array.isArray(s.responsaveis) ? s.responsaveis.slice() : [],
      baixas: (Array.isArray(s.baixas) ? s.baixas : []).map(normBaixa),
      rascunhos: (Array.isArray(s.rascunhos) ? s.rascunhos : []).map(normRasc),
      planilhas: Array.isArray(s.planilhas) ? s.planilhas.slice() : []
    };
  }
  // Cada alteração local é uma operação. Ao gravar, as operações são reaplicadas sobre o estado do Grid,
  // então a gravação de outra pessoa não apaga as nossas (e vice-versa).
  function applyOps(base, ops) {
    let r = normRoot(base);
    for (const op of ops) {
      if (op.t === 'replace') { r = normRoot(op.root); continue; }
      if (op.t === 'root') { r.teamName = op.teamName; continue; }
      const list = r[op.c];
      const i = list.findIndex(x => x.id === (op.t === 'add' ? op.rec.id : op.id));
      if (op.t === 'add') {
        if (i >= 0) list[i] = { ...op.rec };
        else if (op.c === 'rascunhos') list.push({ ...op.rec });
        else list.unshift({ ...op.rec });
      }
      else if (op.t === 'set' && i >= 0) list[i] = { ...list[i], ...op.patch };
      else if (op.t === 'del' && i >= 0) list.splice(i, 1);
    }
    return r;
  }

  // ---------- estado ----------
  let serverRoot = emptyRoot(), serverAt = null, loaded = false; // último estado confirmado pelo Grid
  let pending = [], view = emptyRoot();                          // alterações ainda não gravadas e o que aparece na tela
  let timer = null, inFlight = false, needRender = false;
  const F = { de: '', ate: '', turno: '', sku: '', origem: '', nome: '' };

  const findResp = nome => { const n = norm(nome); return n ? view.responsaveis.find(r => norm(r.nome) === n) : undefined; };
  const turnoOf = b => { const r = findResp(b.responsavel); return r ? r.turno : (b.turno || ''); };
  const gridFocused = () => { const ae = document.activeElement; return !!(ae && ae.closest && ae.closest('#rows,#resp-rows,#massa-rows')); };

  // campos que faltam para a linha virar uma linha do chamado
  function faltas(r) {
    const f = [];
    if (!r.sku) f.push('SKU');
    if (!(Number(r.quantidade) > 0)) f.push('quantidade');
    if (!r.warehouse) f.push('warehouse');
    if (!r.origem) f.push('endereço RQ');
    else if (!RQ_RE.test(r.origem)) f.push('endereço RQ (deve começar com RQ-)');
    if (!MOTIVOS[r.motivo]) f.push('motivo');
    return f;
  }
  const completa = r => faltas(r).length === 0;
  // linha sem nada digitado: warehouse, endereço e data podem vir copiados da linha anterior
  const vazia = r => !r.sku && !(Number(r.quantidade) > 0) && !r.motivo && !r.skuReingresso;
  const resumoFaltas = lista => lista.slice(0, 5).map(b => `${b.sku || 'sem SKU'} (${faltas(b).join(', ')})`).join('; ') + (lista.length > 5 ? '…' : '');

  // ---------- status, avisos e diálogos ----------
  function setStatus(txt, cls) { const el = $('#sync'); el.textContent = txt; el.className = 'sync ' + (cls || ''); }
  function banner(msg) { const el = $('#banner'); el.textContent = msg || ''; el.hidden = !msg; }

  // diálogos próprios: as janelas nativas do navegador são bloqueadas dentro do iframe do Grid
  function dialog(msg, ok, cancel, danger) {
    return new Promise(resolve => {
      const m = $('#modal'), okB = $('#modal-ok'), noB = $('#modal-no'), sel = $('#modal-sel');
      $('#modal-msg').textContent = msg;
      sel.hidden = true;
      okB.textContent = ok;
      okB.className = danger ? 'btn-danger-solid' : 'btn-add';
      noB.hidden = !cancel;
      noB.textContent = cancel || '';
      m.hidden = false;
      okB.focus();
      const done = v => { m.hidden = true; okB.onclick = noB.onclick = m.onkeydown = null; resolve(v); };
      okB.onclick = () => done(true);
      noB.onclick = () => done(false);
      m.onkeydown = e => { if (e.key === 'Escape' && cancel) done(false); };
    });
  }
  const confirmar = (msg, ok, danger = false) => dialog(msg, ok, 'Cancelar', danger);
  const avisar = msg => dialog(msg, 'Entendi', null, false);
  // escolha de uma opção da lista (ex.: responsável do lote); devolve o valor ou null
  function escolher(msg, opcoes, ok) {
    return new Promise(resolve => {
      const m = $('#modal'), okB = $('#modal-ok'), noB = $('#modal-no'), sel = $('#modal-sel');
      $('#modal-msg').textContent = msg;
      sel.innerHTML = opcoes.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
      sel.hidden = false;
      okB.textContent = ok;
      okB.className = 'btn-add';
      noB.hidden = false;
      noB.textContent = 'Cancelar';
      m.hidden = false;
      sel.focus();
      const done = v => { m.hidden = true; sel.hidden = true; okB.onclick = noB.onclick = m.onkeydown = null; resolve(v); };
      okB.onclick = () => done(sel.value);
      noB.onclick = () => done(null);
      m.onkeydown = e => { if (e.key === 'Escape') done(null); };
    });
  }

  // ---------- sincronização com o Grid ----------
  function takeServer(res) {
    serverRoot = normRoot(res.state);
    serverAt = res.updated_at || null;
    loaded = true;
    view = applyOps(serverRoot, pending);
  }
  // leitura periódica: ignora uma resposta mais antiga do que a que já temos
  function adoptIfNewer(res) {
    const novo = Date.parse(res.updated_at), atual = Date.parse(serverAt);
    if (serverAt && !isNaN(novo) && !isNaN(atual) && novo < atual) return false;
    takeServer(res);
    return true;
  }
  function scheduleFlush(ms) { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, ms); }
  function flushNow() { if (timer) { clearTimeout(timer); timer = null; } flush(); }
  function commit(ops) {
    pending.push(...ops);
    view = applyOps(serverRoot, pending);
    renderSoon();
    setStatus(loaded ? 'Salvando…' : 'Carregando…', 'busy');
    scheduleFlush(SAVE_MS);
  }

  async function flush() {
    if (!loaded || !pending.length) return;     // nunca grava antes de ler o estado do Grid
    if (inFlight) { scheduleFlush(300); return; }
    inFlight = true;
    const n = pending.length;
    const next = applyOps(serverRoot, pending.slice(0, n));
    try {
      const res = serverAt ? await store.set(next, serverAt) : await store.set(next);
      serverRoot = next;
      serverAt = res.updated_at || serverAt;
      pending.splice(0, n);
      view = applyOps(serverRoot, pending);
      if (pending.length) { setStatus('Salvando…', 'busy'); scheduleFlush(SAVE_MS); }
      else setStatus(preview ? 'Prévia · não salvo fora do Grid' : `Salvo · ${hhmm()}`, preview ? 'warn' : 'ok');
      renderSoon();
    } catch (err) {
      if (err && err.error === 'state_conflict') {
        // outra pessoa gravou antes: pega o estado atual e refaz as nossas alterações por cima
        try {
          takeServer(await store.get());
          renderSoon();
          setStatus('Atualizado por outra pessoa · reaplicando…', 'warn');
          scheduleFlush(0);
        } catch (e) {
          setStatus('Sem conexão com o Grid — alterações mantidas nesta tela', 'err');
          scheduleFlush(5000);
        }
      } else {
        setStatus('Sem conexão com o Grid — tentando de novo…', 'err');
        scheduleFlush(5000);
      }
    } finally {
      inFlight = false;
    }
  }

  async function poll() {
    if (preview || !loaded || inFlight || document.hidden) return;
    try {
      const res = await store.get();
      if (res.updated_at !== serverAt) {
        if (adoptIfNewer(res)) { if (!pending.length) setStatus(`Atualizado · ${hhmm()}`, 'ok'); renderSoon(); }
      } else if (!pending.length) {
        setStatus(`Sincronizado · ${hhmm()}`, 'ok');
      }
    } catch (e) {
      setStatus('Sem conexão com o Grid — exibindo a última cópia', 'err');
    }
  }

  async function load() {
    let res = await store.get();
    // um documento novo pode voltar vazio por um instante: tenta mais duas vezes antes de aceitar
    for (let i = 0; i < 2 && !hasData(res.state); i++) { await sleep(700); res = await store.get(); }
    takeServer(res);
    banner(preview ? 'Prévia fora do Grid: as alterações não são salvas. Abra o documento no Grid para usar de verdade.' : '');
    renderAll();
    setStatus(preview ? 'Prévia · não salvo fora do Grid' : `Sincronizado · ${hhmm()}`, preview ? 'warn' : 'ok');
    if (pending.length) scheduleFlush(0);
  }
  async function loadWithRetry() {
    try { await load(); }
    catch (err) {
      setStatus('Não foi possível ler o Grid — nada será gravado até a conexão voltar', 'err');
      banner('Sem leitura do Grid. Tentando de novo em instantes…');
      setTimeout(loadWithRetry, 3000);
    }
  }

  // ---------- abas ----------
  function showTab(t, focus = true) {
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    $('#tab-baixas').hidden = t !== 'baixas';
    $('#tab-massa').hidden = t !== 'massa';
    $('#tab-resp').hidden = t !== 'resp';
    if (focus) { const alvo = { baixas: '#sku', massa: '#massa-add', resp: '#r-nome' }[t]; $(alvo)?.focus(); }
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- render ----------
  // Não redesenha a grid enquanto alguém edita uma célula (o foco se perderia).
  function renderSoon() {
    if (gridFocused()) { needRender = true; updateStats(); updateMassaStats(); return; }
    renderAll();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (needRender && !gridFocused()) renderAll(); }, 0));

  function renderAll() {
    needRender = false;
    refreshSelects();
    renderResp();
    renderBaixas();
    renderMassa();
    renderPlanilhas();
    if (document.activeElement !== $('#teamName')) $('#teamName').value = view.teamName;
  }

  function setOptions(sel, html, value) {
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    if (value !== undefined && [...sel.options].some(o => o.value === value)) sel.value = value;
  }
  function refreshSelects() {
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    const origens = uniq(view.baixas.map(b => b.origem));
    const warehouses = uniq(view.baixas.map(b => b.warehouse));
    const pessoas = uniq([...nomes, ...view.baixas.map(b => b.responsavel)]);
    setOptions($('#responsavel'),
      (nomes.length ? '<option value="">Selecione…</option>' : '<option value="">Cadastre um responsável primeiro</option>') +
      nomes.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join(''), $('#responsavel').value);
    setOptions($('#f-origem'), '<option value="">Todos</option>' + origens.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''), F.origem);
    setOptions($('#f-nome'), '<option value="">Todos</option>' + pessoas.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''), F.nome);
    $('#dl-origem').innerHTML = origens.map(v => `<option value="${esc(v)}">`).join('');
    $('#dl-warehouse').innerHTML = warehouses.map(v => `<option value="${esc(v)}">`).join('');
    F.origem = $('#f-origem').value;
    F.nome = $('#f-nome').value;
    updateTurnoInfo();
  }
  function updateTurnoInfo() {
    const r = findResp($('#responsavel').value);
    $('#turno-info').textContent = r ? `Turno: ${r.turno}` : '';
  }

  function renderResp() {
    const list = view.responsaveis.slice().sort(byNome);
    $('#resp-rows').innerHTML = list.length ? list.map(r => {
      const opts = (!r.turno || TURNOS.includes(r.turno)) ? TURNOS : [...TURNOS, r.turno];
      return `
        <tr data-id="${esc(r.id)}">
          <td><input data-rf="nome" value="${esc(r.nome)}"></td>
          <td><select data-rf="turno">${opts.map(t => `<option ${t === r.turno ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></td>
          <td><input data-rf="cargo" list="dl-cargo" value="${esc(r.cargo)}"></td>
          <td class="actions"><button class="btn-danger" data-rdel title="Remover">✕</button></td>
        </tr>`;
    }).join('')
      : '<tr><td colspan="4" class="empty">Nenhum responsável cadastrado ainda. Cadastre acima para liberar os lançamentos.</td></tr>';
    $('#st-resp').textContent = `${list.length} ${list.length === 1 ? 'responsável' : 'responsáveis'}`;
  }

  function turnoHTML(t) { return t ? `<span class="turno ${TURNO_CLS[t] || 't-none'}">${esc(t)}</span>` : '<span class="turno t-none">—</span>'; }
  function respOpts(sel) {
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    if (sel && !nomes.some(n => norm(n) === norm(sel))) nomes.unshift(sel);
    return nomes.map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  function motivoSelect(atual, attrs) {
    const opts = [['', '— sem motivo —'], ['saldo', MOTIVOS.saldo.label], ['sku', MOTIVOS.sku.label]];
    return `<select ${attrs}>${opts.map(([v, t]) => `<option value="${v}" ${v === (atual || '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  }
  function rowHTML(b) {
    return `
      <td><input data-f="sku" class="sku" value="${esc(b.sku)}"></td>
      <td class="num"><input data-f="quantidade" type="number" min="1" step="1" value="${esc(b.quantidade)}"></td>
      <td><input data-f="warehouse" class="sku" value="${esc(b.warehouse)}"></td>
      <td><input data-f="origem" class="sku" value="${esc(b.origem)}"></td>
      <td><select data-f="responsavel">${respOpts(b.responsavel)}</select></td>
      <td data-turno>${turnoHTML(turnoOf(b))}</td>
      <td>${motivoSelect(b.motivo, 'data-f="motivo"')}</td>
      <td><input data-f="skuReingresso" class="sku" value="${esc(b.skuReingresso)}"></td>
      <td><input data-f="data" type="date" value="${esc(b.data)}"></td>
      <td class="actions"><button class="btn-danger" data-del title="Remover">✕</button></td>`;
  }
  function matches(b) {
    if (F.de && b.data < F.de) return false;
    if (F.ate && b.data > F.ate) return false;
    if (F.turno && turnoOf(b) !== F.turno) return false;
    if (F.sku && !String(b.sku).toLowerCase().includes(F.sku)) return false;
    if (F.origem && norm(b.origem) !== norm(F.origem)) return false;
    if (F.nome && norm(b.responsavel) !== norm(F.nome)) return false;
    return true;
  }
  function renderBaixas(flashId) {
    const list = view.baixas.filter(matches);
    const tb = $('#rows');
    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="10" class="empty">${view.baixas.length ? 'Nenhuma baixa corresponde aos filtros.'
        : 'Nenhuma baixa ainda. Preencha o formulário acima e pressione Enter.'}</td></tr>`;
    } else {
      const frag = document.createDocumentFragment();
      list.forEach(b => {
        const tr = document.createElement('tr');
        tr.dataset.id = b.id;
        if (b.id === flashId) tr.classList.add('flash');
        tr.innerHTML = rowHTML(b);
        frag.appendChild(tr);
      });
      tb.replaceChildren(frag);
    }
    updateStats();
  }
  function updateStats() {
    const list = view.baixas.filter(matches);
    const units = list.reduce((s, x) => s + (Number(x.quantidade) || 0), 0);
    const filtrado = list.length !== view.baixas.length;
    $('#st-linhas').textContent = `${list.length} ${list.length === 1 ? 'baixa' : 'baixas'}${filtrado ? ` de ${view.baixas.length}` : ''}`;
    $('#st-qtd').textContent = `${units} ${units === 1 ? 'unidade' : 'unidades'}`;
  }

  // ---------- baixa em massa (rascunho guardado no Grid) ----------
  function novaLinha(ref) {
    return {
      id: uid(), sku: '', quantidade: '', warehouse: ref ? ref.warehouse : '', origem: ref ? ref.origem : '',
      skuReingresso: '', motivo: '', data: (ref && ref.data) || todayISO()
    };
  }
  function renderMassa(focusId) {
    const tb = $('#massa-rows');
    const rows = view.rascunhos;
    tb.innerHTML = rows.length ? rows.map((r, i) => `
      <tr data-id="${esc(r.id)}">
        <td class="idx">${i + 1}</td>
        <td><input data-m="sku" class="sku" value="${esc(r.sku)}" autocomplete="off"></td>
        <td class="num"><input data-m="quantidade" type="number" min="1" step="1" value="${esc(r.quantidade)}"></td>
        <td><input data-m="warehouse" class="sku" value="${esc(r.warehouse)}" autocomplete="off"></td>
        <td><input data-m="origem" class="sku" value="${esc(r.origem)}" autocomplete="off"></td>
        <td>${motivoSelect(r.motivo, 'data-m="motivo"')}</td>
        <td><input data-m="skuReingresso" class="sku" value="${esc(r.skuReingresso)}" autocomplete="off"></td>
        <td><input data-m="data" type="date" value="${esc(r.data)}"></td>
        <td class="actions"><button class="btn-danger" data-mdel title="Remover linha">✕</button></td>
      </tr>`).join('')
      : '<tr><td colspan="9" class="empty">Nenhuma linha. Clique em "+ Linha" para começar.</td></tr>';
    if (focusId) tb.querySelector(`tr[data-id="${focusId}"] [data-m="sku"]`)?.focus();
    updateMassaStats();
  }
  function updateMassaStats() {
    const linhas = view.rascunhos;
    const ok = linhas.filter(completa).length;
    $('#massa-stats').textContent = `${linhas.length} ${linhas.length === 1 ? 'linha' : 'linhas'} · ${ok} completa${ok === 1 ? '' : 's'}`;
  }

  // ---------- planilha .xlsx (gerada aqui, sem bibliotecas externas) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder();
  const xesc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const serialData = iso => { const [y, m, d] = iso.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000); };

  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function sheetXml(header, rows, widths) {
    const cell = (v, ref, bold) => {
      if (v && typeof v === 'object' && v.dt) return `<c r="${ref}" s="1"><v>${serialData(v.dt)}</v></c>`;
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (v === '' || v == null) return '';
      return `<c r="${ref}" t="inlineStr"${bold ? ' s="2"' : ''}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
    };
    const todas = [header, ...rows];
    const body = todas.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(v, colName(j) + (i + 1), i === 0)).join('')}</row>`).join('');
    const cols = `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
  }

  // sheets: [{name, header, rows, widths}]
  function xlsxBlob(sheets) {
    const usados = [];
    const nomeUnico = raw => {
      const base = String(raw || 'Planilha').replace(/[\\\/\?\*\[\]:]/g, '-').trim().slice(0, 31) || 'Planilha';
      let nm = base, k = 2;
      while (usados.some(x => x.toLowerCase() === nm.toLowerCase())) { const suf = ' (' + (k++) + ')'; nm = base.slice(0, 31 - suf.length) + suf; }
      usados.push(nm);
      return nm;
    };
    const nomes = sheets.map(s => nomeUnico(s.name));
    const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const files = {};
    files['[Content_Types].xml'] = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
    files['_rels/.rels'] = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    files['xl/workbook.xml'] = XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      nomes.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>';
    files['xl/_rels/workbook.xml.rels'] = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    files['xl/styles.xml'] = STYLES_XML;
    sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.header, s.rows, s.widths); });
    return zipBlob(files);
  }

  // zip sem compressão (método STORE), com CRC-32, como o .xlsx exige
  function zipBlob(files) {
    const partes = [], central = [];
    let offset = 0;
    const agora = new Date();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const entradas = Object.entries(files);
    for (const [nome, texto] of entradas) {
      const nomeB = enc.encode(nome), dados = enc.encode(texto), crc = crc32(dados);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, hora, true); lh.setUint16(12, data, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, dados.length, true); lh.setUint32(22, dados.length, true); lh.setUint16(26, nomeB.length, true); lh.setUint16(28, 0, true);
      partes.push(new Uint8Array(lh.buffer), nomeB, dados);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, hora, true); ch.setUint16(14, data, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, dados.length, true); ch.setUint32(24, dados.length, true); ch.setUint16(28, nomeB.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nomeB);
      offset += 30 + nomeB.length + dados.length;
    }
    const tamCentral = central.reduce((s, p) => s + p.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
    eocd.setUint16(8, entradas.length, true); eocd.setUint16(10, entradas.length, true);
    eocd.setUint32(12, tamCentral, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
    return new Blob([...partes, ...central, new Uint8Array(eocd.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // linhas das guias
  const templateLinha = b => [b.sku, Number(b.quantidade) || 0, b.warehouse, b.origem, MOTIVOS[b.motivo] ? MOTIVOS[b.motivo].reason : ''];
  const painelLinha = b => [b.sku, Number(b.quantidade) || 0, b.warehouse, b.origem, MOTIVOS[b.motivo] ? MOTIVOS[b.motivo].label : '',
    b.skuReingresso, b.responsavel, turnoOf(b), dataCel(b.data)];

  // guia de saldo: uma linha por responsável, com total no final (considera todas as baixas do documento)
  function saldoRows() {
    const nomes = uniq([...view.responsaveis.map(r => r.nome), ...view.baixas.map(b => b.responsavel)]);
    const un = l => l.reduce((s, b) => s + (Number(b.quantidade) || 0), 0);
    const linhas = nomes.map(nome => {
      const r = view.responsaveis.find(x => norm(x.nome) === norm(nome));
      const mine = view.baixas.filter(b => norm(b.responsavel) === norm(nome));
      const sal = mine.filter(b => b.motivo === 'saldo');
      const inv = mine.filter(b => b.motivo === 'sku');
      const datas = mine.map(b => b.data).filter(Boolean).sort();
      return [nome, r ? r.turno : (mine[0] ? turnoOf(mine[0]) : ''), r ? r.cargo : '', mine.length, un(mine),
        sal.length, un(sal), inv.length, un(inv), dataCel(datas[0]), dataCel(datas[datas.length - 1])];
    });
    const soma = i => linhas.reduce((s, l) => s + (Number(l[i]) || 0), 0);
    linhas.push(['TOTAL', '', '', soma(3), soma(4), soma(5), soma(6), soma(7), soma(8), '', '']);
    return linhas;
  }
  // baixas agrupadas por responsável (uma guia por responsável)
  function agrupar(lista) {
    const m = new Map();
    lista.forEach(b => { const k = b.responsavel || 'Sem responsável'; if (!m.has(k)) m.set(k, []); m.get(k).push(b); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  }

  // ---------- planilhas geradas e lembrete obrigatório de compartilhamento ----------
  const pad = n => String(n).padStart(2, '0');
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  };
  const fmtDataHora = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR'); };
  // destinatários obrigatórios: o TL de cada responsável da planilha + o suporte
  function destinatarios(p) {
    const tls = (p.responsaveis || []).map(nome => `TL responsável pela baixa (responsável: ${nome})`);
    return [...tls, `Suporte: ${EMAIL_SUPORTE}`];
  }
  // gera SEMPRE uma planilha nova, com a mesma configuração, e registra o lembrete de compartilhamento
  async function gerarPlanilha(tipo, lista, nomes, nomeBase) {
    const sheets = tipo === 'lote'
      ? [{ name: 'Template', header: TEMPLATE_HEAD, rows: lista.map(templateLinha), widths: TEMPLATE_LARG }]
      : agrupar(lista).map(([nome, itens]) => ({ name: nome, header: TEMPLATE_HEAD, rows: itens.map(templateLinha), widths: TEMPLATE_LARG }))
          .concat([{ name: PAINEL_NOME, header: PAINEL_HEAD, rows: lista.map(painelLinha), widths: PAINEL_LARG }]);
    sheets.push({ name: SALDO_NOME, header: SALDO_HEAD, rows: saldoRows(), widths: SALDO_LARG });
    const arquivo = `controle-rq-${tipo}-${nomeBase}-${stamp()}.xlsx`;
    baixar(xlsxBlob(sheets), arquivo);
    const p = {
      id: uid(), arquivo, tipo, criadaEm: new Date().toISOString(), responsaveis: nomes,
      baixas: lista.length, compartilhada: false, compartilhadaEm: ''
    };
    commit([{ t: 'add', c: 'planilhas', rec: p }]);
    flushNow();
    return p;
  }
  async function lembreteModal(p, resumo) {
    await avisar(`${resumo}\nPlanilha gerada: ${p.arquivo}\n\nLEMBRETE OBRIGATÓRIO: compartilhe esta planilha com:\n- ${destinatarios(p).join('\n- ')}\n\nEla fica na lista de planilhas pendentes (aba Baixa em massa) até você marcar como compartilhada.`);
  }
  function renderPlanilhas() {
    const lista = view.planilhas;
    const pend = lista.filter(p => !p.compartilhada);
    $('#planilhas-list').innerHTML = lista.length ? lista.map(p => `
      <div class="planilha ${p.compartilhada ? 'ok' : 'pend'}" data-id="${esc(p.id)}">
        <div class="pl-info">
          <strong>${esc(p.arquivo)}</strong>
          <span>Gerada em ${esc(fmtDataHora(p.criadaEm))} · ${p.baixas} baixa(s) · ${esc((p.responsaveis || []).join(', '))}</span>
        </div>
        <div class="pl-aviso">${p.compartilhada
          ? esc(`Compartilhada em ${fmtDataHora(p.compartilhadaEm)}.`)
          : 'OBRIGATÓRIO: compartilhar com\n- ' + destinatarios(p).map(esc).join('\n- ')}</div>
        <button class="btn-ghost" data-pl-toggle>${p.compartilhada ? 'Desmarcar' : 'Marcar como compartilhada'}</button>
      </div>`).join('')
      : '<p class="hint">Nenhuma planilha gerada ainda.</p>';
    $('#lembrete').hidden = pend.length === 0;
    $('#lembrete-txt').textContent = `${pend.length} planilha(s) ainda não compartilhada(s). Compartilhe obrigatoriamente com o TL responsável e com ${EMAIL_SUPORTE}.`;
  }

  // ---------- baixa em massa: salvar o lote ----------
  $('#massa-add').addEventListener('click', () => {
    const last = view.rascunhos[view.rascunhos.length - 1];
    const linha = novaLinha(last);
    commit([{ t: 'add', c: 'rascunhos', rec: linha }]);
    renderMassa(linha.id);
  });
  $('#massa-limpar').addEventListener('click', async () => {
    if (!view.rascunhos.length) return;
    if (!await confirmar(`Apagar as ${view.rascunhos.length} linha(s) do rascunho?`, 'Apagar', true)) return;
    commit(view.rascunhos.map(r => ({ t: 'del', c: 'rascunhos', id: r.id })));
  });
  $('#massa-salvar').addEventListener('click', async () => {
    const linhas = view.rascunhos;
    const ok = linhas.filter(completa);
    const incompletas = linhas.map((r, i) => ({ r, i })).filter(({ r }) => !vazia(r) && !completa(r));
    if (incompletas.length) {
      await avisar('Há linhas incompletas. Preencha o que falta ou apague a linha:\n' +
        incompletas.map(({ r, i }) => `linha ${i + 1}: falta ${faltas(r).join(', ')}`).join('\n'));
      return;
    }
    if (!ok.length) { await avisar('Nenhuma linha preenchida. Preencha SKU, quantidade, warehouse, endereço RQ e motivo.'); return; }
    if (!view.responsaveis.length) { await avisar('Cadastre os responsáveis antes de salvar o lote.'); showTab('resp'); return; }
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    const escolhido = await escolher(`Quem é o responsável por este lote (${ok.length} baixa(s))?`, nomes.map(n => ({ value: n, label: n })), 'Salvar lote');
    if (!escolhido) return;
    const r = findResp(escolhido);
    const nome = r ? r.nome : escolhido;
    const turno = r ? r.turno : '';
    const lote = ok.map(c => ({
      id: uid(), sku: c.sku, quantidade: Number(c.quantidade), warehouse: c.warehouse, origem: c.origem,
      skuReingresso: c.skuReingresso, responsavel: nome, turno, motivo: c.motivo, data: c.data || todayISO()
    }));
    const ultima = lote[lote.length - 1];
    commit([
      ...lote.map(rec => ({ t: 'add', c: 'baixas', rec })),
      ...linhas.map(l => ({ t: 'del', c: 'rascunhos', id: l.id })),
      { t: 'add', c: 'rascunhos', rec: novaLinha(ultima) }
    ]);
    // cada salvamento gera uma planilha nova, com a mesma configuração
    const p = await gerarPlanilha('lote', lote, [nome], slug(nome));
    await lembreteModal(p, `${lote.length} baixa(s) salvas para ${nome}.`);
  });
  massaEventos();
  function massaEventos() {
    const tb = $('#massa-rows');
    tb.addEventListener('input', e => {
      const inp = e.target.closest('[data-m]');
      if (!inp || inp.tagName === 'SELECT') return;
      const id = inp.closest('tr').dataset.id;
      const f = inp.dataset.m;
      let v = inp.value;
      if (f === 'quantidade') v = v === '' ? '' : (parseInt(v, 10) || 0);
      else if (f === 'sku' || f === 'skuReingresso' || f === 'warehouse' || f === 'origem') v = v.trim().toUpperCase();
      commit([{ t: 'set', c: 'rascunhos', id, patch: { [f]: v } }]);
    });
    tb.addEventListener('change', e => {
      const sel = e.target.closest('[data-m="motivo"]');
      if (!sel) return;
      const id = sel.closest('tr').dataset.id;
      commit([{ t: 'set', c: 'rascunhos', id, patch: { motivo: sel.value } }]);
    });
    tb.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const inp = e.target.closest('[data-m]');
      if (!inp) return;
      e.preventDefault();
      const id = inp.closest('tr').dataset.id;
      const idx = view.rascunhos.findIndex(x => x.id === id);
      const prox = view.rascunhos[idx + 1];
      if (prox) { tb.querySelector(`tr[data-id="${prox.id}"] [data-m="${inp.dataset.m}"]`)?.focus(); return; }
      const linha = novaLinha(view.rascunhos[idx]);
      commit([{ t: 'add', c: 'rascunhos', rec: linha }]);
      renderMassa(linha.id);
    });
    tb.addEventListener('click', async e => {
      const btn = e.target.closest('[data-mdel]');
      if (!btn) return;
      const id = btn.closest('tr').dataset.id;
      const r = view.rascunhos.find(x => x.id === id);
      if (!r) return;
      if (!vazia(r) && !await confirmar('Remover esta linha do lote?', 'Remover', true)) return;
      commit([{ t: 'del', c: 'rascunhos', id }]);
    });
  }

  // ---------- Responsáveis ----------
  $('#r-turno').innerHTML = TURNOS.map(t => `<option>${t}</option>`).join('');
  $('#r-turno').value = 'T1';
  $('#dl-cargo').innerHTML = CARGOS.map(c => `<option value="${esc(c)}">`).join('');

  $('#formResp').addEventListener('submit', e => {
    e.preventDefault();
    const nome = $('#r-nome').value.trim();
    const turno = $('#r-turno').value;
    const cargo = $('#r-cargo').value.trim();
    if (!nome) { $('#r-nome').focus(); return; }
    if (findResp(nome)) {
      avisar(`Já existe um responsável cadastrado como "${nome}".`).then(() => $('#r-nome').select());
      return;
    }
    commit([{ t: 'add', c: 'responsaveis', rec: { id: uid(), nome, turno, cargo } }]);
    $('#r-nome').value = '';
    $('#r-cargo').value = '';
    $('#r-nome').focus();
  });

  $('#resp-rows').addEventListener('change', e => {
    const inp = e.target.closest('[data-rf]');
    if (!inp) return;
    const id = inp.closest('tr').dataset.id;
    const r = view.responsaveis.find(x => x.id === id);
    if (!r) return;
    const f = inp.dataset.rf;
    const v = inp.value.trim();
    if (f === 'nome') {
      if (!v) { inp.value = r.nome; return; }
      if (view.responsaveis.some(x => x.id !== id && norm(x.nome) === norm(v))) {
        inp.value = r.nome;
        avisar('Já existe um responsável com esse nome.');
        return;
      }
      // renomear também atualiza as baixas já lançadas com o nome antigo
      const ops = [{ t: 'set', c: 'responsaveis', id, patch: { nome: v } }];
      view.baixas.filter(b => norm(b.responsavel) === norm(r.nome))
        .forEach(b => ops.push({ t: 'set', c: 'baixas', id: b.id, patch: { responsavel: v } }));
      commit(ops);
    } else {
      commit([{ t: 'set', c: 'responsaveis', id, patch: { [f]: v } }]);
    }
  });

  $('#resp-rows').addEventListener('click', async e => {
    const btn = e.target.closest('[data-rdel]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const r = view.responsaveis.find(x => x.id === id);
    if (!r) return;
    if (!await confirmar(`Remover ${r.nome} do cadastro? As baixas já lançadas com este nome são mantidas.`, 'Remover', true)) return;
    commit([{ t: 'del', c: 'responsaveis', id }]);
  });

  // ---------- Baixas (lançamento único) ----------
  const form = $('#form');
  $('#responsavel').addEventListener('change', updateTurnoInfo);

  form.addEventListener('submit', e => {
    e.preventDefault();
    const sku = $('#sku').value.trim().toUpperCase();
    const qtd = parseInt($('#quantidade').value, 10);
    const warehouse = $('#warehouse').value.trim().toUpperCase();
    const origem = $('#origem').value.trim().toUpperCase();
    const nome = $('#responsavel').value;
    const motivo = document.querySelector('input[name=motivo]:checked')?.value || '';
    if (!sku) { $('#sku').focus(); return; }
    if (!(qtd > 0)) { $('#quantidade').focus(); return; }
    if (!nome) {
      if (!view.responsaveis.length) {
        avisar('Cadastre os responsáveis na aba "Cadastro de responsáveis" antes de lançar baixas.').then(() => showTab('resp'));
      } else {
        $('#responsavel').focus();
      }
      return;
    }
    const falta = faltas({ sku, quantidade: qtd, warehouse, origem, motivo });
    if (falta.length) { avisar('Falta preencher: ' + falta.join(', ') + '.'); return; }
    const r = findResp(nome);
    commit([{ t: 'add', c: 'baixas', rec: {
      id: uid(),
      sku,
      quantidade: qtd,
      warehouse,
      origem,
      skuReingresso: $('#skuReingresso').value.trim().toUpperCase(),
      responsavel: r ? r.nome : nome,
      turno: r ? r.turno : '',
      motivo,
      data: $('#data').value || todayISO()
    } }]);
    // warehouse, endereço e responsável continuam preenchidos; o que muda a cada lançamento é limpo
    $('#sku').value = '';
    $('#quantidade').value = '';
    $('#skuReingresso').value = '';
    document.querySelectorAll('input[name=motivo]').forEach(x => { x.checked = false; });
    $('#sku').focus();
  });

  $('#rows').addEventListener('change', e => {
    const inp = e.target.closest('[data-f]');
    if (!inp) return;
    const id = inp.closest('tr').dataset.id;
    const b = view.baixas.find(x => x.id === id);
    if (!b) return;
    const f = inp.dataset.f;
    let v = inp.value;
    if (f === 'quantidade') {
      v = parseInt(v, 10);
      if (!(v > 0)) { inp.value = b.quantidade; return; }
    } else if (f === 'sku' || f === 'skuReingresso' || f === 'warehouse' || f === 'origem') {
      v = v.trim().toUpperCase();
    } else if (f === 'data') {
      if (!v) { inp.value = b.data; return; }
    } else if (f === 'motivo') {
      v = inp.value;
    } else {
      v = v.trim();
    }
    const patch = { [f]: v };
    if (f === 'responsavel') { const r = findResp(v); patch.turno = r ? r.turno : ''; }
    commit([{ t: 'set', c: 'baixas', id, patch }]);
    inp.value = v;
    if (f === 'origem' || f === 'responsavel') refreshSelects();
  });

  $('#rows').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const b = view.baixas.find(x => x.id === id);
    if (!b) return;
    if (!await confirmar(`Remover a baixa de ${b.sku} (${b.quantidade} un.)?`, 'Remover', true)) return;
    commit([{ t: 'del', c: 'baixas', id }]);
  });

  // ---------- filtros ----------
  function readFilters() {
    F.de = $('#f-de').value;
    F.ate = $('#f-ate').value;
    F.turno = $('#f-turno').value;
    F.sku = $('#f-sku').value.trim().toLowerCase();
    F.origem = $('#f-origem').value;
    F.nome = $('#f-nome').value;
    renderBaixas();
  }
  ['#f-de', '#f-ate', '#f-turno', '#f-sku', '#f-origem', '#f-nome'].forEach(id => {
    $(id).addEventListener('input', readFilters);
    $(id).addEventListener('change', readFilters);
  });
  $('#btn-limpar-filtros').addEventListener('click', () => {
    ['#f-de', '#f-ate', '#f-sku', '#f-turno', '#f-origem', '#f-nome'].forEach(id => { $(id).value = ''; });
    readFilters();
  });

  // ---------- nome do time ----------
  $('#teamName').addEventListener('change', e => {
    const v = e.target.value.trim();
    if (v !== view.teamName) commit([{ t: 'root', teamName: v }]);
  });

  // ---------- exportações ----------
  function baixar(blob, nome) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // planilha por responsável: uma guia por responsável (no formato do chamado) + guia de painel + guia de saldo
  $('#btn-export').addEventListener('click', async () => {
    const nomes = uniq([...view.responsaveis.map(r => r.nome), ...view.baixas.map(b => b.responsavel)]);
    if (!nomes.length) { await avisar('Não há responsáveis nem baixas para exportar.'); return; }
    const escolha = await escolher('Exportar a planilha de:', [{ value: TODOS, label: 'Todos os responsáveis' }, ...nomes.map(n => ({ value: n, label: n }))], 'Exportar');
    if (escolha === null) return;
    const lista = view.baixas.filter(matches).filter(b => escolha === TODOS || norm(b.responsavel) === norm(escolha));
    if (!lista.length) { await avisar('Nenhuma baixa corresponde aos filtros para esta escolha.'); return; }
    const incompletas = lista.filter(b => !completa(b));
    if (incompletas.length) {
      const ok = await confirmar(`${incompletas.length} baixa(s) estão incompletas: ${resumoFaltas(incompletas)}. Gerar a planilha mesmo assim? As linhas incompletas saem com esses campos vazios.`, 'Gerar mesmo assim', true);
      if (!ok) return;
    }
    const nomesLista = escolha === TODOS ? uniq(lista.map(b => b.responsavel)) : [escolha];
    // cada exportação gera uma planilha nova, com a mesma configuração
    const p = await gerarPlanilha('export', lista, nomesLista, escolha === TODOS ? 'todos' : slug(escolha));
    await lembreteModal(p, `Exportação com ${lista.length} baixa(s).`);
  });

  $('#btn-csv').addEventListener('click', () => {
    const list = view.baixas.filter(matches);
    const head = ['SKU', 'QUANTIDADE', 'WAREHOUSE', 'ENDEREÇO RQ', 'MOTIVO', 'SKU REINGRESSO', 'RESPONSÁVEL', 'TURNO', 'DATA'];
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(cell).join(';')].concat(
      list.map(b => [b.sku, b.quantidade, b.warehouse, b.origem, MOTIVOS[b.motivo] ? MOTIVOS[b.motivo].label : '', b.skuReingresso, b.responsavel, turnoOf(b), fmtBR(b.data)].map(cell).join(';'))
    );
    baixar(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `controle-rq-${todayISO()}.csv`);
  });

  // backup no mesmo formato do JSON base (inclui os rascunhos)
  $('#btn-backup').addEventListener('click', () => {
    const data = { teamName: view.teamName, responsaveis: view.responsaveis, baixas: view.baixas, rascunhos: view.rascunhos, planilhas: view.planilhas };
    baixar(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `controle-rq-backup-${todayISO()}.json`);
  });

  $('#btn-importar').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (err) { await avisar('Arquivo inválido: não é um JSON.'); return; }
    if (!data || !Array.isArray(data.responsaveis) || !Array.isArray(data.baixas)) {
      await avisar('Arquivo inválido: precisa ter as listas "responsaveis" e "baixas" (mesmo formato do backup).');
      return;
    }
    if (!await confirmar(`Substituir TODOS os dados deste controle pelos ${data.baixas.length} lançamentos e ${data.responsaveis.length} responsáveis do arquivo?`, 'Substituir', true)) return;
    commit([{ t: 'replace', root: {
      teamName: String(data.teamName || ''),
      responsaveis: data.responsaveis,
      baixas: data.baixas,
      rascunhos: Array.isArray(data.rascunhos) ? data.rascunhos : [],
      planilhas: Array.isArray(data.planilhas) ? data.planilhas : []
    } }]);
  });

  $('#btn-limpar').addEventListener('click', async () => {
    if (!view.baixas.length) return;
    if (!await confirmar(`Apagar TODAS as ${view.baixas.length} baixas deste controle? O cadastro de responsáveis é mantido.`, 'Apagar tudo', true)) return;
    commit(view.baixas.map(b => ({ t: 'del', c: 'baixas', id: b.id })));
  });

  $('#planilhas-list').addEventListener('click', async e => {
    const btn = e.target.closest('[data-pl-toggle]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    const p = view.planilhas.find(x => x.id === id);
    if (!p) return;
    if (!p.compartilhada) {
      const ok = await confirmar(`Confirma que a planilha ${p.arquivo} foi compartilhada com: ${destinatarios(p).join(', ')}?`, 'Sim, compartilhei');
      if (!ok) return;
      commit([{ t: 'set', c: 'planilhas', id, patch: { compartilhada: true, compartilhadaEm: new Date().toISOString() } }]);
    } else {
      commit([{ t: 'set', c: 'planilhas', id, patch: { compartilhada: false, compartilhadaEm: '' } }]);
    }
  });
  $('#lembrete-ver').addEventListener('click', () => {
    showTab('massa', false);
    $('#planilhas-card')?.scrollIntoView({ behavior: 'smooth' });
  });

  // ---------- início ----------
  $('#data').value = todayISO();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); else poll(); });
  window.addEventListener('pagehide', flushNow);
  // se ainda há alterações não gravadas, avisa antes de fechar a página
  window.addEventListener('beforeunload', e => { if (pending.length || inFlight) { e.preventDefault(); e.returnValue = ''; } });
  renderAll();
  showTab('baixas', false);
  loadWithRetry();
})();
