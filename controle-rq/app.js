(() => {
  'use strict';

  // ---------- configuração ----------
  const POLL_MS = 10000;   // leitura periódica do Grid (só com a aba visível): 6 req/min por aba
  const SAVE_MS = 1500;    // alterações agrupadas: no máximo ~40 gravações/min por aba (limite do Grid: 60/min)
  const TURNOS = ['T1', 'T2', 'T3', 'T4'];
  const CARGOS = ['Operador', 'Conferente', 'Líder', 'Supervisor', 'Coordenador', 'Gerente'];
  const TURNO_CLS = { T1: 't-t1', T2: 't-t2', T3: 't-t3', T4: 't-t4' };

  // Motivos: label = nome curto na tela; nome = texto completo; reason = texto exato do modelo de chamado (Baja de RQ)
  const MOTIVOS = {
    saldo: {
      label: 'Saldo sistêmico',
      nome: 'Saldo Sistêmico Incorreto',
      reason: 'Entrada sistémica mayor que física. Problem ID #13966888'
    },
    sku: {
      label: 'Meli SKU invertida',
      nome: 'Meli SKU Invertida',
      reason: 'Meli SKU Invertida: Cada SKU tiene un EAN diferente. Problem ID #10637539'
    },
    cx: {
      label: 'CX',
      nome: 'CX',
      reason: ''
    }
  };

  // Modelo da planilha de solicitação de baixa (Baja de RQ): só estas colunas; warehouse e endereço são fixos
  const TEMPLATE_HEAD = ['sku', 'quantity', 'warehouse_id', 'address_id', 'reason'];
  const TEMPLATE_LARG = [16, 12, 16, 24, 80];
  const WAREHOUSE_FIXO = 'BRRJ02';
  const RQ_FIXO = 'RQ-0-005-000-00-00';
  const EMAIL_SUPORTE = 'soporteME@mercadolibre.com';

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
  const hasData = s => !!s && ((Array.isArray(s.baixas) && s.baixas.length > 0) || (Array.isArray(s.responsaveis) && s.responsaveis.length > 0));

  const pad = n => String(n).padStart(2, '0');
  const fmtDataHora = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR'); };
  const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'sem-nome';
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  };

  // ---------- armazenamento: window.GRID.state (compartilhado e ao vivo) ----------
  // Fora do Grid (prévia local) não existe estado compartilhado: usa uma cópia só em memória.
  const preview = !(window.GRID && window.GRID.state);
  let memDoc = { state: {}, updated_at: null };
  const store = preview ? {
    get: () => Promise.resolve(JSON.parse(JSON.stringify(memDoc))),
    set: data => { memDoc = { state: JSON.parse(JSON.stringify(data)), updated_at: new Date().toISOString() }; return Promise.resolve(JSON.parse(JSON.stringify(memDoc))); }
  } : window.GRID.state;

  // ---------- modelo de dados ----------
  // { responsaveis:[{id,nome,turno,cargo}],
  //   baixas:[{id,sku,quantidade,origemReingresso,skuReingresso,responsavel,turno,data,motivo}],
  //   rascunhos:[{id,sku,quantidade,origemReingresso,skuReingresso,motivo,data}],
  //   planilhas:[{id,arquivo,tipo,criadaEm,responsaveis,baixas,compartilhada,compartilhadaEm}] }
  //   origemReingresso = texto livre por baixa;  motivo = '' | 'saldo' | 'sku'
  //   warehouse e endereço RQ são fixos (WAREHOUSE_FIXO, RQ_FIXO); campos antigos desses dados ficam guardados, sem uso
  const emptyRoot = () => ({ responsaveis: [], baixas: [], rascunhos: [], planilhas: [] });
  const qtdBaixa = v => Number(v) || 0;
  const qtdRascunho = v => (v === '' || v == null) ? '' : (Number(v) || 0);
  // dados antigos guardavam uma lista de motivos (motivos: [...]); fica só o primeiro
  const motivoDe = r => {
    if (MOTIVOS[r.motivo]) return r.motivo;
    if (Array.isArray(r.motivos) && MOTIVOS[r.motivos[0]]) return r.motivos[0];
    return '';
  };
  const normBaixa = b => ({ ...b, quantidade: qtdBaixa(b.quantidade), origemReingresso: String(b.origemReingresso || ''), motivo: motivoDe(b), motivos: undefined });
  const normRasc = r => ({ ...r, quantidade: qtdRascunho(r.quantidade), origemReingresso: String(r.origemReingresso || ''), motivo: motivoDe(r), motivos: undefined });
  function normRoot(s) {
    s = s || {};
    return {
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

  // campos que faltam para a linha virar uma baixa do chamado
  function faltas(r) {
    const f = [];
    if (!r.sku) f.push('SKU');
    if (!(Number(r.quantidade) > 0)) f.push('quantidade');
    if (!MOTIVOS[r.motivo]) f.push('motivo');
    return f;
  }
  const completa = r => faltas(r).length === 0;
  // linha sem nada digitado: origem de reingresso e data podem vir copiados da linha anterior
  const vazia = r => !r.sku && !(Number(r.quantidade) > 0) && !r.motivo && !r.skuReingresso;

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
    $('#tab-relatorio').hidden = t !== 'relatorio';
    $('#tab-resp').hidden = t !== 'resp';
    if (focus) { const alvo = { baixas: '#massa-add', resp: '#r-nome' }[t]; $(alvo)?.focus(); }
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
    renderRelatorio();
    renderPlanilhas();
  }

  function setOptions(sel, html, value) {
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    if (value !== undefined && [...sel.options].some(o => o.value === value)) sel.value = value;
  }
  function refreshSelects() {
    const origens = uniq(view.baixas.map(b => b.origemReingresso));
    const nomes = uniq([...view.responsaveis.map(r => r.nome), ...view.baixas.map(b => b.responsavel)]);
    setOptions($('#f-origem'), '<option value="">Todos</option>' + origens.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''), F.origem);
    setOptions($('#f-nome'), '<option value="">Todos</option>' + nomes.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''), F.nome);
    $('#dl-origem').innerHTML = origens.map(v => `<option value="${esc(v)}">`).join('');
    F.origem = $('#f-origem').value;
    F.nome = $('#f-nome').value;
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
      : '<tr><td colspan="4" class="empty">Nenhum responsável cadastrado ainda.</td></tr>';
    $('#st-resp').textContent = `${list.length} ${list.length === 1 ? 'responsável' : 'responsáveis'}`;
  }

  function turnoHTML(t) { return t ? `<span class="turno ${TURNO_CLS[t] || 't-none'}">${esc(t)}</span>` : '<span class="turno t-none">—</span>'; }
  function respOpts(sel) {
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    if (sel && !nomes.some(n => norm(n) === norm(sel))) nomes.unshift(sel);
    return nomes.map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  function motivoSelect(atual, attrs) {
    const opts = [['', '— motivo —'], ...Object.keys(MOTIVOS).map(k => [k, MOTIVOS[k].label])];
    return `<select ${attrs}>${opts.map(([v, t]) => `<option value="${v}" ${v === (atual || '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  }
  function rowHTML(b) {
    return `
      <td><input data-f="sku" class="sku" value="${esc(b.sku)}"></td>
      <td><input data-f="quantidade" type="number" min="1" step="1" value="${esc(b.quantidade)}"></td>
      <td><input data-f="origemReingresso" list="dl-origem" value="${esc(b.origemReingresso)}"></td>
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
    if (F.origem && norm(b.origemReingresso) !== norm(F.origem)) return false;
    if (F.nome && norm(b.responsavel) !== norm(F.nome)) return false;
    return true;
  }
  function renderBaixas(flashId) {
    const list = view.baixas.filter(matches);
    const tb = $('#rows');
    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="9" class="empty">${view.baixas.length ? 'Nenhuma baixa corresponde aos filtros.'
        : 'Nenhuma baixa salva ainda. Lance as baixas no bloco de cima e clique em Salvar.'}</td></tr>`;
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

  // ---------- lançamento em grade (rascunho guardado no Grid) ----------
  function novaLinha(ref) {
    return {
      id: uid(), sku: '', quantidade: '', origemReingresso: ref ? ref.origemReingresso : '',
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
        <td><input data-m="quantidade" type="number" min="1" step="1" value="${esc(r.quantidade)}"></td>
        <td><input data-m="origemReingresso" list="dl-origem" value="${esc(r.origemReingresso)}" autocomplete="off"></td>
        <td>${motivoSelect(r.motivo, 'data-m="motivo"')}</td>
        <td><input data-m="skuReingresso" class="sku" value="${esc(r.skuReingresso)}" autocomplete="off"></td>
        <td><input data-m="data" type="date" value="${esc(r.data)}"></td>
        <td class="actions"><button class="btn-danger" data-mdel title="Remover linha">✕</button></td>
      </tr>`).join('')
      : '<tr><td colspan="8" class="empty">Nenhuma linha. Clique em "+ Linha" para começar.</td></tr>';
    if (focusId) tb.querySelector(`tr[data-id="${focusId}"] [data-m="sku"]`)?.focus();
    updateMassaStats();
  }
  function updateMassaStats() {
    const linhas = view.rascunhos;
    const ok = linhas.filter(completa).length;
    $('#massa-stats').textContent = `${linhas.length} ${linhas.length === 1 ? 'linha' : 'linhas'} · ${ok} completa${ok === 1 ? '' : 's'}`;
  }

  // ---------- relatório: quanto cada responsável fez, origem com mais reingressos e resumo por turno ----------
  const R = { de: '', ate: '', turno: '' };
  const ABERTOS = new Set();   // responsáveis com o detalhe aberto (mantido entre os redesenhos)
  const ORIGEM_VAZIA = '(sem origem)';
  const casaRelatorio = b => (!R.de || b.data >= R.de) && (!R.ate || b.data <= R.ate) && (!R.turno || turnoOf(b) === R.turno);
  const ordemTurno = t => (TURNOS.indexOf(t) >= 0 ? TURNOS.indexOf(t) : TURNOS.length);
  const numPt = (v, casas) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const pctDe = (parte, total) => (total ? Math.round(parte / total * 100) : 0);
  // origens de reingresso: reingressos (baixas), unidades, responsáveis e SKUs distintos; a de mais unidades vem primeiro
  function rankingOrigens(lista) {
    const m = new Map();
    lista.forEach(b => {
      const txt = String(b.origemReingresso || '').trim();
      const k = norm(txt);
      if (!m.has(k)) m.set(k, { origem: txt || ORIGEM_VAZIA, vazia: !txt, n: 0, un: 0, resp: new Set(), skus: new Set() });
      const g = m.get(k);
      g.n += 1;
      g.un += Number(b.quantidade) || 0;
      g.resp.add(norm(b.responsavel));
      g.skus.add(norm(b.sku));
    });
    return [...m.values()]
      .map(g => ({ origem: g.origem, vazia: g.vazia, n: g.n, un: g.un, resp: g.resp.size, skus: g.skus.size }))
      .sort((a, b) => (a.vazia - b.vazia) || (b.un - a.un) || (b.n - a.n) || a.origem.localeCompare(b.origem, 'pt-BR'));
  }
  function renderRelatorio() {
    const lista = view.baixas.filter(casaRelatorio);
    const soma = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const unidades = b => Number(b.quantidade) || 0;
    const totN = lista.length;
    const totUn = soma(lista, unidades);
    // quem entra: cadastrados (no turno deles, mesmo sem baixa) e quem aparece nas baixas sem cadastro (no turno da baixa)
    const pessoas = new Map();
    view.responsaveis.forEach(r => pessoas.set(norm(r.nome), { nome: r.nome, cargo: r.cargo || '', turno: TURNOS.includes(r.turno) ? r.turno : '' }));
    lista.forEach(b => {
      const k = norm(b.responsavel);
      if (k && !pessoas.has(k)) pessoas.set(k, { nome: b.responsavel, cargo: '', turno: TURNOS.includes(b.turno) ? b.turno : '' });
    });
    const pes = [...pessoas.values()]
      .filter(p => !R.turno || p.turno === R.turno)
      .map(p => {
        const mine = lista.filter(b => norm(b.responsavel) === norm(p.nome));
        const datas = mine.map(b => b.data).filter(Boolean).sort();
        return {
          ...p,
          n: mine.length,
          un: soma(mine, unidades),
          saldo: mine.filter(b => b.motivo === 'saldo').length,
          sku: mine.filter(b => b.motivo === 'sku').length,
          cx: mine.filter(b => b.motivo === 'cx').length,
          ultima: datas[datas.length - 1] || '',
          itens: mine.slice().sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(a.sku).localeCompare(String(b.sku)))
        };
      })
      .sort((a, b) => b.un - a.un || ordemTurno(a.turno) - ordemTurno(b.turno) || a.nome.localeCompare(b.nome, 'pt-BR'));
    let pos = 0;
    pes.forEach(p => { p.pos = p.n ? ++pos : null; });
    const detalhe = p => p.itens.map(b => `<div>${esc(b.sku)} · ${esc(b.quantidade)} un. · ${esc(MOTIVOS[b.motivo] ? MOTIVOS[b.motivo].label : 'sem motivo')} · origem: ${esc(String(b.origemReingresso || '').trim() || '—')} · SKU reingresso: ${esc(b.skuReingresso || '—')} · ${esc(b.data ? fmtBR(b.data) : '—')}</div>`).join('');
    const linhaResp = p => {
      const pct = pctDe(p.un, totUn);
      const aberto = p.n > 0 && ABERTOS.has(norm(p.nome));
      return `
        <tr class="resumo${p.n ? '' : ' zero'}${aberto ? ' aberto' : ''}" data-nome="${esc(p.nome)}">
          <td class="idx">${p.pos || '—'}</td>
          <td><strong>${esc(p.nome)}</strong></td>
          <td>${turnoHTML(p.turno)}</td>
          <td>${esc(p.cargo || '—')}</td>
          <td class="num">${p.n}</td>
          <td><div class="barra"><span class="bar-track"><i data-pct="${pct}"></i></span><b>${p.un}</b></div></td>
          <td class="num">${p.n ? pct + '%' : '—'}</td>
          <td class="num">${p.n ? numPt(p.un / p.n, 1) : '—'}</td>
          <td class="num">${p.saldo}</td>
          <td class="num">${p.sku}</td>
          <td class="num">${p.cx}</td>
          <td>${p.ultima ? esc(fmtBR(p.ultima)) : '—'}</td>
        </tr>${p.n ? `
        <tr class="det"${aberto ? '' : ' hidden'}><td colspan="12">${detalhe(p)}</td></tr>` : ''}`;
    };
    $('#rel-resp-rows').innerHTML = pes.length ? pes.map(linhaResp).join('') + `
        <tr class="total">
          <td></td><td>Total</td><td></td><td></td>
          <td class="num">${totN}</td>
          <td><b>${totUn}</b> un.</td>
          <td class="num">${totUn ? '100%' : '—'}</td>
          <td class="num">${totN ? numPt(totUn / totN, 1) : '—'}</td>
          <td class="num">${lista.filter(b => b.motivo === 'saldo').length}</td>
          <td class="num">${lista.filter(b => b.motivo === 'sku').length}</td>
          <td class="num">${lista.filter(b => b.motivo === 'cx').length}</td>
          <td></td>
        </tr>` : '<tr><td colspan="12" class="empty">Nenhum responsável com os filtros atuais.</td></tr>';
    $('#rel-resp-rows').querySelectorAll('[data-pct]').forEach(el => { el.style.width = el.dataset.pct + '%'; });
    // origem de reingresso com mais reingressos
    const origens = rankingOrigens(lista);
    const lider = origens.find(g => !g.vazia && g.n > 0);
    let posO = 0;
    $('#rel-origem-rows').innerHTML = origens.length ? origens.map(g => `
        <tr class="${lider && g === lider ? 'top' : ''}${g.vazia ? ' zero' : ''}">
          <td class="idx">${g.vazia ? '—' : ++posO}</td>
          <td><strong>${esc(g.origem)}</strong></td>
          <td class="num">${g.n}</td>
          <td class="num">${g.un}</td>
          <td class="num">${pctDe(g.un, totUn)}%</td>
          <td class="num">${g.resp}</td>
          <td class="num">${g.skus}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="empty">Nenhuma baixa com os filtros atuais.</td></tr>';
    // resumo por turno (com a origem líder de cada turno)
    const chaves = R.turno ? [R.turno] : [...TURNOS, ''];
    $('#rel-turno-rows').innerHTML = chaves.map(t => {
      const lt = lista.filter(b => turnoOf(b) === t);
      if (!TURNOS.includes(t) && !lt.length) return '';
      const un = soma(lt, unidades);
      const resp = new Set(lt.map(b => norm(b.responsavel)).filter(Boolean)).size;
      const l = rankingOrigens(lt).find(g => !g.vazia && g.n > 0);
      return `
        <tr>
          <td>${turnoHTML(t)}</td>
          <td class="num">${lt.length}</td>
          <td class="num">${un}</td>
          <td class="num">${pctDe(un, totUn)}%</td>
          <td class="num">${resp}</td>
          <td>${esc(l ? l.origem : '—')}</td>
        </tr>`;
    }).join('');
    const comBaixa = pes.filter(p => p.n > 0).length;
    $('#rel-baixas').textContent = `${totN} ${totN === 1 ? 'baixa' : 'baixas'}`;
    $('#rel-un').textContent = `${totUn} ${totUn === 1 ? 'unidade' : 'unidades'}`;
    $('#rel-resp').textContent = `${comBaixa} ${comBaixa === 1 ? 'responsável' : 'responsáveis'} com baixa`;
    $('#rel-origem').textContent = lider ? `Origem com mais reingressos: ${lider.origem} (${lider.un} un.)` : 'Origem com mais reingressos: —';
  }

  // ---------- planilha de solicitação de baixa (modelo Baja de RQ) e lembrete obrigatório de compartilhamento ----------
  // destinatários obrigatórios: o TL responsável pela baixa de cada responsável da planilha + o suporte
  function destinatarios(p) {
    const tls = (p.responsaveis || []).map(nome => `TL responsável pela baixa (responsável: ${nome})`);
    return [...tls, `Suporte: ${EMAIL_SUPORTE}`];
  }
  function renderPlanilhas() {
    const lista = view.planilhas;
    const pend = lista.filter(p => !p.compartilhada);
    $('#planilhas-list').innerHTML = lista.length ? lista.map(p => `
      <tr class="${p.compartilhada ? 'ok' : 'pend'}" data-id="${esc(p.id)}">
        <td class="arq" title="${esc(p.arquivo)}">${esc(p.arquivo)}</td>
        <td>${esc(fmtDataHora(p.criadaEm))}</td>
        <td class="num">${p.baixas}</td>
        <td>${esc((p.responsaveis || []).join(', '))}</td>
        <td class="status">
          ${p.compartilhada
            ? `<span class="ok-txt">Compartilhada em ${esc(fmtDataHora(p.compartilhadaEm))}</span>`
            : `<span class="pend-txt">OBRIGATÓRIO: ${esc(destinatarios(p).join(' + '))}</span>`}
          <button class="btn-ghost small" data-pl-toggle>${p.compartilhada ? 'Desfazer' : 'Marcar compartilhada'}</button>
        </td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="empty">Nenhuma planilha gerada ainda.</td></tr>';
    $('#lembrete').hidden = pend.length === 0;
    $('#lembrete-txt').textContent = `${pend.length} planilha(s) ainda não compartilhada(s). Compartilhe obrigatoriamente com o TL responsável e com ${EMAIL_SUPORTE}.`;
  }

  // ---------- planilha .xlsx do modelo (gerada aqui, sem bibliotecas externas) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder();
  const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  // estilos: 0 = travado (warehouse_id e address_id), 1 = cabeçalho, 2 = destravado (sku, quantity e reason)
  const STYLES_TEMPLATE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9EAD3"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  // o .xlsx no formato padrão do Excel: textos em sharedStrings, propriedades do arquivo e uma aba "Template";
  // a aba é protegida sem senha, com warehouse_id e address_id travados e a lista suspensa do motivo
  function xlsxTemplate(header, rows, widths) {
    const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const textos = [];
    const indice = new Map();
    let refs = 0;
    const textoRef = s => {
      refs++;
      if (!indice.has(s)) { indice.set(s, textos.length); textos.push(s); }
      return indice.get(s);
    };
    const todas = [header, ...rows];
    const celula = (v, ref, estilo) => {
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}" s="${estilo}"><v>${v}</v></c>`;
      if (v === '' || v == null) return `<c r="${ref}" s="${estilo}"/>`;
      return `<c r="${ref}" s="${estilo}" t="s"><v>${textoRef(String(v))}</v></c>`;
    };
    const linhas = todas.map((linha, i) => `<row r="${i + 1}" spans="1:${linha.length}">${linha.map((v, j) => celula(v, colName(j) + (i + 1), i === 0 ? 1 : (j === 2 || j === 3 ? 0 : 2))).join('')}</row>`).join('');
    const colunas = `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
    const motivos = [MOTIVOS.saldo.reason, MOTIVOS.sku.reason].map(esc).join(',');
    const validacao = `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Motivo" error="Escolha um dos motivos do modelo." sqref="E2:E1000"><formula1>"${motivos}"</formula1></dataValidation></dataValidations>`;
    const planilha = XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:${colName(header.length - 1)}${todas.length}"/>` +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' + colunas +
      `<sheetData>${linhas}</sheetData>` +
      '<sheetProtection sheet="1" objects="1" scenarios="1"/>' + validacao +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
    const sst = XML + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${refs}" uniqueCount="${textos.length}">` +
      textos.map(t => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('') + '</sst>';
    const agora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const files = {};
    files['[Content_Types].xml'] = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
    files['_rels/.rels'] = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
    files['docProps/core.xml'] = XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>Solicitação de baixa RQ</dc:title><dc:creator>Controle de RQ</dc:creator>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${agora}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${agora}</dcterms:modified></cp:coreProperties>`;
    files['docProps/app.xml'] = XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Controle de RQ</Application></Properties>';
    files['xl/workbook.xml'] = XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews>' +
      '<sheets><sheet name="Template" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>';
    files['xl/_rels/workbook.xml.rels'] = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
    files['xl/styles.xml'] = STYLES_TEMPLATE;
    files['xl/sharedStrings.xml'] = sst;
    files['xl/worksheets/sheet1.xml'] = planilha;
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

  // linhas do modelo: sku, quantity, warehouse_id e address_id fixos, reason com o texto do motivo (CX não tem texto no modelo)
  const templateLinha = b => [b.sku, Number(b.quantidade) || 0, WAREHOUSE_FIXO, RQ_FIXO, MOTIVOS[b.motivo] ? MOTIVOS[b.motivo].reason : ''];

  // gera SEMPRE uma planilha nova do lote, com as colunas do modelo, e registra o lembrete de compartilhamento
  async function gerarPlanilha(lista, nomeBase, nomes) {
    const arquivo = `controle-rq-lote-${nomeBase}-${stamp()}.xlsx`;
    baixar(xlsxTemplate(TEMPLATE_HEAD, lista.map(templateLinha), TEMPLATE_LARG), arquivo);
    const p = {
      id: uid(), arquivo, tipo: 'lote', criadaEm: new Date().toISOString(), responsaveis: nomes,
      baixas: lista.length, compartilhada: false, compartilhadaEm: ''
    };
    commit([{ t: 'add', c: 'planilhas', rec: p }]);
    flushNow();
    return p;
  }
  async function lembreteModal(p, resumo) {
    await avisar(`${resumo}\nPlanilha gerada: ${p.arquivo}\n\nLEMBRETE OBRIGATÓRIO: compartilhe esta planilha com:\n- ${destinatarios(p).join('\n- ')}\n\nEla fica na lista de planilhas geradas (nesta tela) até você marcar como compartilhada.`);
  }

  // ---------- Salvar lote ----------
  // grava tudo que está pendente antes de uma operação atômica
  async function gravarPendencias() {
    for (let i = 0; i < 6 && (pending.length || inFlight); i++) {
      if (inFlight) { await sleep(150); continue; }
      await flush();
    }
    return pending.length === 0;
  }
  // Salvar lote: grava as linhas escolhidas numa única alteração do Grid, condicionada à versão lida.
  // Se outra pessoa gravou antes, relê o estado e recalcula o lote: linhas já salvas por ela não entram de novo.
  async function salvarLote(ids, nome, turno) {
    if (!(await gravarPendencias())) return { erro: 'pendente' };
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      let lido;
      try { lido = await store.get(); }
      catch (err) { return { erro: 'rede' }; }
      takeServer(lido);
      const ok = view.rascunhos.filter(r => ids.includes(r.id) && completa(r));
      const ignoradas = ids.length - ok.length;
      if (!ok.length) return { lote: [], ignoradas };
      const lote = ok.map(c => ({
        id: uid(), sku: c.sku, quantidade: Number(c.quantidade), origemReingresso: c.origemReingresso,
        skuReingresso: c.skuReingresso, responsavel: nome, turno, motivo: c.motivo, data: c.data || todayISO()
      }));
      const limpar = view.rascunhos.filter(r => ids.includes(r.id) || vazia(r));
      const ops = [
        ...lote.map(rec => ({ t: 'add', c: 'baixas', rec })),
        ...limpar.map(l => ({ t: 'del', c: 'rascunhos', id: l.id })),
        { t: 'add', c: 'rascunhos', rec: novaLinha(lote[lote.length - 1]) }
      ];
      const next = applyOps(serverRoot, ops);
      try {
        const res = serverAt ? await store.set(next, serverAt) : await store.set(next);
        serverRoot = next;
        serverAt = res.updated_at || serverAt;
        view = applyOps(serverRoot, pending);
        renderSoon();
        return { lote, ignoradas };
      } catch (err) {
        // conflito: outra pessoa gravou antes; relê o estado e recalcula o lote
        if (err && err.error === 'state_conflict') continue;
        // outra falha (rede): não dá para saber se gravou. Não tenta de novo aqui; quem clicar de novo relê o Grid antes
        return { erro: 'rede' };
      }
    }
    return { erro: 'conflito' };
  }

  $('#massa-add').addEventListener('click', () => {
    const last = view.rascunhos[view.rascunhos.length - 1];
    const linha = novaLinha(last);
    commit([{ t: 'add', c: 'rascunhos', rec: linha }]);
    renderMassa(linha.id);
  });
  $('#massa-limpar').addEventListener('click', async () => {
    if (!view.rascunhos.length) return;
    if (!await confirmar(`Apagar as ${view.rascunhos.length} linha(s) do lançamento?`, 'Apagar', true)) return;
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
    if (!ok.length) { await avisar('Nenhuma linha preenchida. Preencha SKU, quantidade e motivo.'); return; }
    if (!view.responsaveis.length) { await avisar('Cadastre os responsáveis antes de salvar.'); showTab('resp'); return; }
    const nomes = view.responsaveis.slice().sort(byNome).map(r => r.nome);
    const escolhido = await escolher(`Quem é o responsável por este lote (${ok.length} baixa(s))?`, nomes.map(n => ({ value: n, label: n })), 'Salvar lote');
    if (!escolhido) return;
    const r = findResp(escolhido);
    const nome = r ? r.nome : escolhido;
    const turno = r ? r.turno : '';
    const cx = ok.filter(c => c.motivo === 'cx').length;
    if (cx && !await confirmar(`${cx} baixa(s) com motivo CX: o modelo da planilha ainda não tem o texto desse motivo, então a coluna reason fica em branco nessas linhas. Salvar e gerar a planilha mesmo assim?`, 'Gerar mesmo assim', true)) return;
    const res = await salvarLote(ok.map(c => c.id), nome, turno);
    if (res.erro) {
      const msgs = {
        pendente: 'Não foi possível gravar as alterações pendentes. Tente de novo em instantes.',
        conflito: 'Outra pessoa está salvando ao mesmo tempo. Tente de novo.',
        rede: 'Não foi possível confirmar o salvamento no Grid. Confira "Baixas salvas" antes de tentar de novo, para não lançar a mesma baixa duas vezes.'
      };
      await avisar(msgs[res.erro]);
      return;
    }
    if (!res.lote.length) { await avisar('Essas linhas já foram salvas por outra pessoa ou deixaram de estar completas. A tela foi atualizada.'); return; }
    // cada salvamento gera uma planilha nova, só com as colunas do modelo
    const p = await gerarPlanilha(res.lote, slug(nome), [nome]);
    const extra = res.ignoradas ? ` ${res.ignoradas} linha(s) não entraram (já salvas por outra pessoa ou deixaram de estar completas).` : '';
    await lembreteModal(p, `${res.lote.length} baixa(s) salvas para ${nome}.${extra}`);
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
      else if (f === 'sku' || f === 'skuReingresso') v = v.trim().toUpperCase();
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
      if (!vazia(r) && !await confirmar('Remover esta linha do lançamento?', 'Remover', true)) return;
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
      // renomear também atualiza as baixas já salvas com o nome antigo
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
    if (!await confirmar(`Remover ${r.nome} do cadastro? As baixas já salvas com este nome são mantidas.`, 'Remover', true)) return;
    commit([{ t: 'del', c: 'responsaveis', id }]);
  });

  // ---------- Baixas salvas (edição direta na tabela) ----------
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
    } else if (f === 'sku' || f === 'skuReingresso') {
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
    if (f === 'origemReingresso' || f === 'responsavel') refreshSelects();
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

  // ---------- exportações ----------
  function baixar(blob, nome) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // backup no mesmo formato do JSON base (inclui rascunho e planilhas)
  $('#btn-backup').addEventListener('click', () => {
    const data = { responsaveis: view.responsaveis, baixas: view.baixas, rascunhos: view.rascunhos, planilhas: view.planilhas };
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
      responsaveis: data.responsaveis,
      baixas: data.baixas,
      rascunhos: Array.isArray(data.rascunhos) ? data.rascunhos : [],
      planilhas: Array.isArray(data.planilhas) ? data.planilhas : []
    } }]);
  });

  $('#btn-limpar').addEventListener('click', async () => {
    if (!view.baixas.length) return;
    if (!await confirmar(`Apagar TODAS as ${view.baixas.length} baixas salvas? O cadastro de responsáveis é mantido.`, 'Apagar tudo', true)) return;
    commit(view.baixas.map(b => ({ t: 'del', c: 'baixas', id: b.id })));
  });

  // ---------- relatório: filtros próprios (período e turno) e detalhe por responsável ----------
  function lerRelatorio() {
    R.de = $('#rel-de').value;
    R.ate = $('#rel-ate').value;
    R.turno = $('#rel-turno').value;
    renderRelatorio();
  }
  ['#rel-de', '#rel-ate', '#rel-turno'].forEach(id => {
    $(id).addEventListener('input', lerRelatorio);
    $(id).addEventListener('change', lerRelatorio);
  });
  $('#rel-limpar').addEventListener('click', () => {
    $('#rel-de').value = '';
    $('#rel-ate').value = '';
    $('#rel-turno').value = '';
    lerRelatorio();
  });
  // clique num responsável abre ou fecha o detalhe das baixas dele
  $('#rel-resp-rows').addEventListener('click', e => {
    const tr = e.target.closest('tr.resumo');
    const det = tr && tr.nextElementSibling;
    if (!det || !det.classList.contains('det')) return;
    const k = norm(tr.dataset.nome);
    if (ABERTOS.has(k)) ABERTOS.delete(k); else ABERTOS.add(k);
    const aberto = ABERTOS.has(k);
    tr.classList.toggle('aberto', aberto);
    det.hidden = !aberto;
  });

  // ---------- planilhas geradas: marcar como compartilhada ----------
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
    $('#planilhas-card')?.scrollIntoView({ behavior: 'smooth' });
  });

  // ---------- início ----------
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); else poll(); });
  window.addEventListener('pagehide', flushNow);
  // se ainda há alterações não gravadas, avisa antes de fechar a página
  window.addEventListener('beforeunload', e => { if (pending.length || inFlight) { e.preventDefault(); e.returnValue = ''; } });
  renderAll();
  showTab('baixas', false);
  loadWithRetry();
})();
