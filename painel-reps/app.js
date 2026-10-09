(function(){
  "use strict";

  // ---------- window.GRID.state: armazenamento nativo do Grid, compartilhado e ao vivo ----------
  // Estado vazio de um time. Sempre listas NOVAS: reaproveitar um objeto padrão faria times novos
  // compartilharem as mesmas listas (e o que se cadastra num aparece no outro).
  function novoEstado(){ return { teamName:"", reps:[], tasks:[], pontos:[], lost:[], folgas:[], escalaModo:"folga" }; }
  // O estado do Grid guarda um conjunto de dados por time: { times: { vinicius:{...}, harley:{...} } }.
  // Dados antigos (sem "times", direto na raiz) são lidos como Time Vinicius. `state` = dados do time ativo.
  var ICQA_AREA_FIXA = {
    "internas":"qualidade", "qp":"qualidade", "rk":"qualidade", "pdd":"qualidade", "pd":"qualidade", "cem":"qualidade",
    "inbound":"qualidade",
    "inbound audit":"inventario",
    "contagem":"inventario"
  };
  var TIMES = [
    {key:"vinicius", nome:"Time Vinicius", areaFixa:ICQA_AREA_FIXA},
    {key:"harley", nome:"Time Harley", areaFixa:{}, views:["equipe","dimensionamento","folgas"],
     seedTasks:["Contagem","Stock Audit","Lost","RR/ER","Hunter"]}
  ];
  var timeAtual = TIMES[0].key;
  var root = { times:{} };
  function timeDef(key){ return TIMES.filter(function(t){ return t.key===(key||timeAtual); })[0] || TIMES[0]; }
  var state = novoEstado();
  var editing = { rep:null, ponto:null, lost:null, task:null, folga:null };
  var pollTimer = null;
  var saveTimer = null;
  var lastUpdatedAt = null;

  var VIEWS = [
    {key:"equipe", label:"Equipe"},
    {key:"dimensionamento", label:"Dimensionamento"},
    {key:"folgas", label:"Folgas extras"},
    {key:"pontos", label:"Pontos alinhados"},
    {key:"lost", label:"Controle de Lost"}
  ];

  var Cal = window.EscalaCal;
  var STATUS_LABEL = {ativo:"Ativo", folga:"Folga", ferias:"Férias", licenca:"Licença", afastado:"Afastado"};
  var STATUS_TAG = {ativo:"tag-green", folga:"tag-folga", ferias:"tag-ferias", licenca:"tag-licenca", afastado:"tag-rust"};
  var ESC_COR = {A:"var(--rust)", B:"var(--escB)", C:"var(--escC)", D:"var(--escD)"};
  var dimDate = null, dimFollow = true, dimFiltro = "todos", lastToday = null;
  var dimView = "cards", dimUndo = null, dimMsg = "";
  var CATEGORIA_LABEL = {inventario:"Inventário", qualidade:"Qualidade", ps_operacoes:"PS Operações", ps_icqa:"PS ICQA"};
  var CLASSE_LABEL = {rep:"Rep", ps:"PS"};
  var CLASSE_TAG = {rep:"tag-teal", ps:"tag-amber"};
  var ESCALAS = ["A","B","C","D"];

  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function esc(s){
    return String(s==null?"":s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function fmtDate(d){
    if(!d) return "—";
    var parts = d.split("-");
    if(parts.length!==3) return d;
    return parts[2]+"/"+parts[1]+"/"+parts[0];
  }
  function fmtMoney(v){
    v = Number(v)||0;
    return "R$ " + v.toLocaleString("pt-BR", {minimumFractionDigits:2, maximumFractionDigits:2});
  }
  function todayISO(){
    var d = new Date();
    var m = String(d.getMonth()+1).padStart(2,"0");
    var day = String(d.getDate()).padStart(2,"0");
    return d.getFullYear()+"-"+m+"-"+day;
  }
  function escRank(e){
    if(!e) return 1000;
    var i = ESCALAS.indexOf(e);
    return i>-1 ? i : 100;
  }
  // Ordena sem alterar state.reps: escala A→D (outras, depois "sem escala"), depois ordem alfabética.
  function sortReps(list){
    return list.slice().sort(function(a,b){
      var ea = a.escala||"", eb = b.escala||"";
      var ra = escRank(ea), rb = escRank(eb);
      if(ra!==rb) return ra-rb;
      if(ra===100 && ea!==eb) return ea.localeCompare(eb, "pt-BR");
      return String(a.nome||"").localeCompare(String(b.nome||""), "pt-BR", {sensitivity:"base"});
    });
  }
  function repClasse(r){ return r && r.classe==="ps" ? "ps" : "rep"; }
  // Versão anterior gravava "PS Operações"/"PS ICQA" em `classe`; agora isso é a Área e `classe` é Rep/PS.
  function migrateReps(){
    (state.reps||[]).forEach(function(r){
      if(r.classe==="ps_operacoes" || r.classe==="ps_icqa"){ r.categoria = r.classe; r.classe = "ps"; }
    });
  }
  function repInitials(nome){
    var p = String(nome||"?").trim().split(/\s+/);
    return ((p[0]||"?")[0] + (p.length>1 ? p[p.length-1][0] : "")).toUpperCase();
  }
  function repFlags(r){
    var f = [];
    if(r.acessoHV==="sim") f.push("Acesso ao HV");
    if(r.terceiraContagem==="sim") f.push("3ª contagem");
    if(r.maquina==="sim") f.push("Máquina");
    return f;
  }
  function repSkillNames(r){
    if(repEhPS(r)) return [];
    return (r.skills||[]).map(function(tid){
      var t = state.tasks.find(function(x){return x.id===tid;});
      return t ? t.nome : "";
    }).filter(Boolean);
  }
  // Fim inclusivo: início + duração - 1 (ex.: 10/10 com 30 dias termina em 08/11; retorno em 09/11).
  function afastFim(r){
    if(!r || !r.afastInicio || !(Number(r.afastDias)>0)) return "";
    return Cal.addDays(r.afastInicio, Number(r.afastDias)-1);
  }
  function plural(n, um, varios){ return n + " " + (n===1 ? um : varios); }
  // Tempo de casa até hoje, pela data de admissão. curto=true mostra só as duas maiores unidades (card).
  function tempoCasaTexto(r, curto){
    if(!r.admissao) return "";
    var d = Cal.diferenca(r.admissao, todayISO());
    if(!d) return "";
    if(d.negativo) return "Começa em " + plural(d.totalDias, "dia", "dias");
    var p = [];
    if(d.anos>0) p.push(plural(d.anos, "ano", "anos"));
    if(d.meses>0) p.push(plural(d.meses, "mês", "meses"));
    if(d.dias>0) p.push(plural(d.dias, "dia", "dias"));
    if(p.length===0) return "Admitido hoje";
    if(curto) p = p.slice(0,2);
    return p.length>1 ? p.slice(0,-1).join(", ") + " e " + p[p.length-1] : p[0];
  }
  function diasDeCasaTexto(r){
    var d = r.admissao ? Cal.diferenca(r.admissao, todayISO()) : null;
    return d && !d.negativo ? d.totalDias.toLocaleString("pt-BR") + " dias" : "";
  }
  function periodoTexto(r){
    var fim = afastFim(r);
    return fim ? fmtDate(r.afastInicio)+" → "+fmtDate(fim)+" · "+Number(r.afastDias)+" d" : "";
  }
  // Situação PELA ESCALA em uma data: férias/licença (dentro do período), afastado, ou conforme a escala (ativo/folga).
  // Não considera as folgas extras (banco de horas / troca de folga): ver effStatus.
  function baseStatus(r, iso){
    var st = r.status || "ativo";
    if(st==="afastado") return "afastado";
    if(st==="ferias" || st==="licenca"){
      var fim = afastFim(r);
      if(!fim) return st;
      if(iso>=r.afastInicio && iso<=fim) return st;
    }
    if(ESCALAS.indexOf(r.escala)>-1){
      var marcado = Cal.isMarcado(r.escala, iso);
      var folga = state.escalaModo==="trabalho" ? !marcado : marcado;
      return folga ? "folga" : "ativo";
    }
    return "ativo";
  }
  // ---------- folgas extras: banco de horas e troca de folga ----------
  // state.folgas: { id, repId, tipo:"banco", data, dataFim?, obs }  → folga extra em [data, dataFim]
  //               { id, repId, tipo:"troca", dataFolga, dataTrabalho, obs } → trabalha em dataTrabalho (era folga)
  //                                                                            e folga em dataFolga (era dia de trabalho)
  // O efeito é sempre calculado sobre a situação pela escala (nunca soma/subtrai "no escuro"): folga extra só
  // vale em dia de trabalho e a troca só vale em dia de folga; fora disso o agendamento fica "sem efeito".
  var folgaIgnorar = ""; // id ignorado ao simular (edição/prévia no formulário)
  function ajusteAplicado(r, iso, base){
    var L = state.folgas || [];
    for(var i=0;i<L.length;i++){
      var f = L[i], tipo = null;
      if(f.repId!==r.id || f.id===folgaIgnorar) continue;
      if(f.tipo==="troca"){
        if(iso===f.dataFolga) tipo = "troca-folga";
        else if(iso===f.dataTrabalho) tipo = "troca-trabalho";
      }else if(f.data && iso>=f.data && iso<=(f.dataFim||f.data)){
        tipo = "banco";
      }
      if(!tipo) continue;
      if(tipo==="troca-trabalho" ? base==="folga" : base==="ativo") return {tipo:tipo, f:f};
    }
    return null;
  }
  // Ajuste extra que está valendo para o rep nessa data (ou null).
  function extraDe(r, iso){
    var base = baseStatus(r, iso);
    return (base==="ativo" || base==="folga") ? ajusteAplicado(r, iso, base) : null;
  }
  // Situação real em uma data: a da escala, já contando folga de banco de horas e troca de folga.
  function effStatus(r, iso){
    var base = baseStatus(r, iso);
    if(base!=="ativo" && base!=="folga") return base;
    var aj = ajusteAplicado(r, iso, base);
    if(!aj) return base;
    return aj.tipo==="troca-trabalho" ? "ativo" : "folga";
  }
  var EXTRA_NOTA = {"banco":"Folga extra · banco de horas", "troca-folga":"Folga extra · troca de folga", "troca-trabalho":"Trabalha · troca de folga"};
  function statusNote(r, iso){
    var ex = extraDe(r, iso);
    if(ex) return EXTRA_NOTA[ex.tipo];
    var st = effStatus(r, iso);
    if(st==="ativo") return "";
    var fim = (st==="ferias"||st==="licenca") ? afastFim(r) : "";
    return STATUS_LABEL[st] + (fim ? " até "+fmtDate(fim) : "");
  }
  // Rótulo curto da situação (tags): troca "Folga" por "Folga extra" / "Trabalha (troca)" quando for o caso.
  function statusRotulo(r, iso){
    var ex = extraDe(r, iso);
    if(ex) return ex.tipo==="troca-trabalho" ? "Trabalha (troca)" : "Folga extra";
    return STATUS_LABEL[effStatus(r, iso)];
  }
  // Áreas usadas para separar quem está presente (Área cadastrada do rep). Fora dessas quatro vai em "Sem área".
  var AREAS_PRESENCA = ["inventario","qualidade","ps_operacoes","ps_icqa"];
  var AREA_CURTA = {inventario:"Inv", qualidade:"Qual", ps_operacoes:"PS Op", ps_icqa:"PS ICQA", outra:"Outras"};
  function areaDe(r){ return AREAS_PRESENCA.indexOf(r.categoria)>-1 ? r.categoria : "outra"; }
  function areaNome(k){ return k==="outra" ? "Sem área" : (CATEGORIA_LABEL[k]||k); }
  function areaEhPS(k){ return k.indexOf("ps_")===0; }
  // Pessoas em um dia, TODAS as classes (rep e PS), com a quebra por Área cadastrada:
  // pela escala, folgas extras, trocas e total. Invariante: total = base − banco − trocaFolga + trocaTrab.
  // areas[k] = {key, cad (cadastrados), ps (quantos são PS), base, total (presentes)}.
  function contagemDia(iso){
    var c = {iso:iso, base:0, total:0, banco:[], trocaFolga:[], trocaTrab:[], areas:{}};
    sortReps(state.reps).forEach(function(r){
      var k = areaDe(r), a = c.areas[k] || (c.areas[k] = {key:k, cad:0, ps:0, base:0, total:0});
      a.cad++; if(repEhPS(r)) a.ps++;
      var b = baseStatus(r, iso);
      var ex = (b==="ativo" || b==="folga") ? ajusteAplicado(r, iso, b) : null;
      if(b==="ativo"){ c.base++; a.base++; }
      var eff = ex ? (ex.tipo==="troca-trabalho" ? "ativo" : "folga") : b;
      if(eff==="ativo"){ c.total++; a.total++; }
      if(ex) (ex.tipo==="banco" ? c.banco : ex.tipo==="troca-folga" ? c.trocaFolga : c.trocaTrab).push({r:r, f:ex.f});
    });
    return c;
  }
  // Áreas que têm gente cadastrada, na ordem de exibição.
  function areasDoDia(cd){
    return AREAS_PRESENCA.concat(["outra"]).filter(function(k){ return cd.areas[k]; }).map(function(k){ return cd.areas[k]; });
  }
  // Tarefas com área fixa: só reps dessa Área entram no dimensionamento (nome sem acento/maiúscula).

  function normNome(s){
    return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function areaFixa(nome){ return timeDef().areaFixa[normNome(nome)] || ""; }
  function tarefaArea(t){ return areaFixa(t.nome) || t.categoria || "inventario"; }
  function repEhPS(r){ return repClasse(r)==="ps" || String(r.categoria||"").indexOf("ps_")===0; }
  // PS não participa de nenhuma tarefa. Em tarefa de área fixa, só reps daquela Área.
  function repElegivel(t, r){
    if(repEhPS(r)) return false;
    var f = areaFixa(t.nome);
    return !f || r.categoria===f;
  }
  function repMotivoFora(r){ return repEhPS(r) ? "PS não considerado" : "fora da área"; }
  // Time novo: cria as tarefas iniciais uma única vez (ids fixos, então dois acessos simultâneos não duplicam).
  function seedTasks(){
    var seed = timeDef().seedTasks;
    if(!seed || state.seeded) return;
    state.seeded = true;
    if(!(state.tasks||[]).length){
      state.tasks = seed.map(function(nome){
        return {id:"seed-"+normNome(nome).replace(/[^a-z0-9]+/g,"-"), nome:nome, categoria:"inventario", repIds:[]};
      });
    }
  }
  function migrateTasks(){
    seedTasks();
    var ps = {}, byId = {};
    (state.reps||[]).forEach(function(r){ byId[r.id] = r; if(repEhPS(r)){ ps[r.id] = true; if((r.skills||[]).length) r.skills = []; } });
    (state.tasks||[]).forEach(function(t){
      var f = areaFixa(t.nome); if(f) t.categoria = f;
      if((t.repIds||[]).some(function(rid){return ps[rid];})) t.repIds = t.repIds.filter(function(rid){return !ps[rid];});
      // tarefa de área fixa: reps de outra área saem das marcações
      if(f && (t.repIds||[]).some(function(rid){ return byId[rid] && !repElegivel(t, byId[rid]); })){
        t.repIds = t.repIds.filter(function(rid){ return !byId[rid] || repElegivel(t, byId[rid]); });
      }
    });
  }
  function repName(id){
    var r = state.reps.find(function(x){return x.id===id;});
    return r ? r.nome : "(rep removido)";
  }
  function showFormError(id, msg){
    var el = document.getElementById(id);
    if(!el) return;
    el.textContent = msg;
    el.style.display = "block";
  }
  function clearFormError(id){
    var el = document.getElementById(id);
    if(!el) return;
    el.style.display = "none";
  }

  function scheduleSave(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  }
  var lido = false; // só grava depois de ter lido o estado do Grid com sucesso (senão sobrescreveria com vazio)
  function aviso(msg){
    var el = document.getElementById("avisoGrid");
    if(!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }
  function persist(){
    if(!lido){ aviso("Sem conexão com o Grid: a alteração NÃO foi salva. Aguarde a reconexão e repita."); return; }
    window.GRID.state.set(root, lastUpdatedAt).then(function(res){
      lastUpdatedAt = res.updated_at;
      aviso("");
    }).catch(function(err){
      console.error("Falha ao salvar no Grid:", err);
      aviso("Não foi possível salvar no Grid agora (outra pessoa pode ter alterado ao mesmo tempo). Recarregue a página antes de continuar.");
    });
  }
  // ---------- proteção contra leituras vazias/atrasadas do Grid ----------
  // O Grid às vezes devolve estado vazio (ou uma versão antiga) por um instante. Nunca adotamos isso
  // depois de já termos dados, e NADA é gravado por causa de uma leitura: só ações do usuário gravam.
  var teveDados = false;
  function temDados(r){
    if(!r) return false;
    var lista = r.times && typeof r.times==="object" ? Object.keys(r.times).map(function(k){ return r.times[k]; }) : [r];
    return lista.some(function(t){ return t && ((t.reps||[]).length || (t.tasks||[]).length || (t.pontos||[]).length || (t.lost||[]).length); });
  }
  function tempo(v){ var n = Date.parse(v); return isNaN(n) ? null : n; }
  function leituraValida(res){
    if(!teveDados) return true;
    var a = tempo(res.updated_at), b = tempo(lastUpdatedAt);
    if(a!==null && b!==null && a<b) return false;
    return temDados(res.state);
  }
  function lerGrid(tentativas){
    return window.GRID.state.get().then(function(res){
      if(!temDados(res.state) && tentativas>0){
        return new Promise(function(ok){ setTimeout(ok, 700); }).then(function(){ return lerGrid(tentativas-1); });
      }
      return res;
    });
  }
  function aplicarLeitura(res){
    lastUpdatedAt = res.updated_at;
    usarDados(res.state);
    if(temDados(res.state)) teveDados = true;
  }
  // Lê o estado cru do Grid (formato novo ou antigo) e deixa `state` apontando para os dados do time ativo.
  function usarDados(raw){
    raw = raw || {};
    if(raw.times && typeof raw.times==="object"){
      root = raw;
    }else{
      root = { times:{} };
      if(Object.keys(raw).length){ root.times[TIMES[0].key] = raw; }
    }
    state = root.times[timeAtual] = Object.assign(novoEstado(), root.times[timeAtual]||{});
    if(!Array.isArray(state.folgas)) state.folgas = [];
    if(!state.teamName) state.teamName = timeDef().nome;
    // (a estrutura nova só é gravada na próxima ação do usuário, nunca ao abrir)
    migrateReps();
    migrateTasks();
    document.getElementById("teamNameInput").value = state.teamName || "";
    var sel = document.getElementById("timeSel");
    if(sel && sel.value!==timeAtual) sel.value = timeAtual;
    ajustarAbas();
  }
  // ---------- backup / restauração (cópia fora do Grid) ----------
  function backupTexto(){ return JSON.stringify(root, null, 1); }
  function backupAbrir(){
    document.getElementById("backupText").value = "";
    document.getElementById("backupMsg").textContent = "";
    document.getElementById("backupOverlay").style.display = "flex";
  }
  function backupFechar(){ document.getElementById("backupOverlay").style.display = "none"; }
  function backupMsg(t){ document.getElementById("backupMsg").textContent = t; }
  function backupGerar(){
    var ta = document.getElementById("backupText");
    ta.value = backupTexto(); ta.select();
    backupMsg("Backup gerado (todos os times). Copie o texto e guarde num arquivo.");
  }
  function backupBaixar(){
    try{
      var blob = new Blob([backupTexto()], {type:"application/json"});
      var url = URL.createObjectURL(blob);
      var l = document.createElement("a");
      l.href = url; l.download = "painel-reps-backup.json";
      document.body.appendChild(l); l.click(); document.body.removeChild(l);
      URL.revokeObjectURL(url);
      backupMsg("Se o download não iniciar, use \"Gerar backup\" e copie o texto.");
    }catch(e){ backupMsg("Download bloqueado aqui. Use \"Gerar backup\" e copie o texto."); }
  }
  function backupRestaurar(){
    var dados;
    try{ dados = JSON.parse(document.getElementById("backupText").value); }catch(e){ backupMsg("Texto inválido: cole o JSON do backup."); return; }
    if(!dados || typeof dados!=="object" || !(dados.times || Array.isArray(dados.reps))){ backupMsg("Formato não reconhecido."); return; }
    if(!temDados(dados)){ backupMsg("Esse backup está vazio; nada foi restaurado."); return; }
    if(!lido){ backupMsg("Sem conexão com o Grid; tente de novo em instantes."); return; }
    usarDados(dados);
    teveDados = true;
    persist();
    resetRepForm(); resetTaskForm(); resetPontoForm(); resetLostForm(); resetFolgaForm();
    renderAll();
    backupMsg("Backup restaurado.");
  }
  function trocarTime(key){
    if(key===timeAtual) return;
    timeAtual = key;
    dimUndo = null; dimMsg = "";
    usarDados(root);
    resetRepForm(); resetTaskForm(); resetPontoForm(); resetLostForm(); resetFolgaForm();
    renderAll();
  }
  function buildTimeSel(){
    var sel = document.getElementById("timeSel");
    sel.innerHTML = TIMES.map(function(t){ return '<option value="'+t.key+'">'+t.nome+'</option>'; }).join("");
    sel.value = timeAtual;
    sel.addEventListener("change", function(e){ trocarTime(e.target.value); });
  }
  function startPolling(){
    if(pollTimer) return;
    pollTimer = setInterval(function(){
      window.GRID.state.get().then(function(res){
        if(res.updated_at !== lastUpdatedAt && leituraValida(res)){
          aplicarLeitura(res);
          renderAll();
        }
      }).catch(function(){});
    }, 5000);
  }
  function loadAndRender(){
    lerGrid(3).then(function(res){
      aplicarLeitura(res);
      lido = true;
      aviso("");
      renderAll();
      startPolling();
    }).catch(function(err){
      console.error("Falha ao carregar do Grid:", err);
      aviso("Não foi possível ler os dados do Grid. Nada será gravado até a conexão voltar; tentando de novo…");
      setTimeout(loadAndRender, 3000);
    });
  }

  // ---------- nav ----------
  // Abas disponíveis no time ativo (sem `views` = todas). Os dados das abas ocultas ficam guardados.
  var viewAtual = VIEWS[0].key, navTime = null;
  function viewsDoTime(){
    var permitidas = timeDef().views;
    return VIEWS.filter(function(v){ return !permitidas || permitidas.indexOf(v.key)>-1; });
  }
  function ajustarAbas(){
    if(navTime===timeAtual) return;
    navTime = timeAtual;
    buildNav();
    var ok = viewsDoTime().some(function(v){ return v.key===viewAtual; });
    showView(ok ? viewAtual : viewsDoTime()[0].key);
  }
  function buildNav(){
    var nav = document.getElementById("navList");
    nav.innerHTML = "";
    viewsDoTime().forEach(function(v){
      var el = document.createElement("div");
      el.className = "tab-item" + (v.key===viewAtual ? " active" : "");
      el.dataset.view = v.key;
      el.textContent = v.label;
      el.addEventListener("click", function(){ showView(v.key); });
      nav.appendChild(el);
    });
  }
  function showView(key){
    viewAtual = key;
    document.querySelectorAll(".view").forEach(function(v){
      v.classList.toggle("active", v.dataset.view===key);
    });
    document.querySelectorAll(".tab-item").forEach(function(n){
      n.classList.toggle("active", n.dataset.view===key);
    });
  }
  function tickClock(){
    var d = new Date();
    document.getElementById("clockFoot").textContent = d.toLocaleDateString("pt-BR", {weekday:"short", day:"2-digit", month:"short", year:"numeric"});
    document.getElementById("equipeMeta").textContent = d.toLocaleDateString("pt-BR", {weekday:"short", day:"2-digit", month:"short"}) + " · " + d.toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"});
    var t = todayISO();
    if(lastToday!==null && t!==lastToday){
      lastToday = t;
      if(dimFollow) dimDate = t;
      renderAll();
    }
    lastToday = t;
  }

  // =====================================================================
  // EQUIPE
  // =====================================================================
  function renderRepSkillsChecklist(selectedIds){
    var wrap = document.getElementById("repSkills");
    if(state.tasks.length===0){
      wrap.innerHTML = '<span class="hint">Cadastre tarefas na aba Dimensionamento para marcar aqui.</span>';
      return;
    }
    wrap.innerHTML = state.tasks.map(function(t){
      var checked = selectedIds && selectedIds.indexOf(t.id)>-1 ? "checked" : "";
      return '<label><input type="checkbox" class="rep-skill-check" value="'+t.id+'" '+checked+'>'+esc(t.nome)+'</label>';
    }).join("");
  }
  function getCheckedRepSkills(){
    return Array.prototype.slice.call(document.querySelectorAll(".rep-skill-check:checked")).map(function(c){return c.value;});
  }

  function stripCell(label, val, valCls, borderCls, caption){
    return '<div class="strip-cell'+(borderCls?' b-'+borderCls:'')+'">' +
      '<div class="strip-label">'+label+'</div>' +
      '<div class="strip-value'+(valCls?' '+valCls:'')+'">'+val+'</div>' +
      '<div class="strip-caption">'+caption+'</div>' +
    '</div>';
  }

  function renderEquipe(){
    var strip = document.getElementById("equipeStrip");
    var hoje = todayISO();
    var ativos = state.reps.filter(function(r){return effStatus(r, hoje)==="ativo";}).length;
    var inv = state.reps.filter(function(r){return r.categoria==="inventario";}).length;
    var qlt = state.reps.filter(function(r){return r.categoria==="qualidade";}).length;
    strip.innerHTML =
      stripCell("Total HC", state.reps.length, "", "teal", "Reps cadastrados") +
      stripCell("Ativos", ativos, "green", "green", "Trabalhando hoje") +
      stripCell("Inventário", inv, "", "teal", "Reps na área") +
      stripCell("Qualidade", qlt, "", "amber", "Reps na área") +
      stripCell("PS Operações", state.reps.filter(function(r){return r.categoria==="ps_operacoes";}).length, "amber", "amber", "Reps na área") +
      stripCell("PS ICQA", state.reps.filter(function(r){return r.categoria==="ps_icqa";}).length, "teal", "teal", "Reps na área");

    if(!editing.rep) renderRepSkillsChecklist([]);

    var grid = document.getElementById("repGrid");
    var empty = document.getElementById("repEmpty");
    if(state.reps.length===0){
      grid.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    var filtro = (document.getElementById("repFiltroClasse")||{}).value || "";
    var visiveis = sortReps(state.reps.filter(function(r){
      return !filtro || repClasse(r)===filtro;
    }));
    if(visiveis.length===0){
      grid.innerHTML = '<div class="hint" style="grid-column:1/-1;padding:14px 4px;">Nenhum rep nessa classificação.</div>';
      return;
    }
    var out = "", lastEsc = null;
    visiveis.forEach(function(r){
      var ge = r.escala||"";
      if(ge!==lastEsc){
        lastEsc = ge;
        var n = visiveis.filter(function(x){return (x.escala||"")===ge;}).length;
        out += '<div class="grp-head">'+(ge?"Escala "+esc(ge):"Sem escala")+' <span class="grp-n">· '+n+' rep'+(n!==1?"s":"")+'</span></div>';
      }
      out += repCardHTML(r);
    });
    grid.innerHTML = out;
  }

  function field(label, val, cls){
    return val ? '<div class="sq-field"><span class="sq-label">'+label+'</span><span class="sq-val'+(cls?' '+cls:'')+'">'+esc(val)+'</span></div>' : "";
  }
  function repTags(r){
    var cl = repClasse(r);
    return '<span class="tag '+CLASSE_TAG[cl]+'">'+CLASSE_LABEL[cl]+'</span>' +
      (CATEGORIA_LABEL[r.categoria] ? '<span class="tag tag-dark">'+CATEGORIA_LABEL[r.categoria]+'</span>' : "") +
      (function(){ var eff = effStatus(r, todayISO()); return '<span class="tag '+STATUS_TAG[eff]+'">'+statusRotulo(r, todayISO())+'</span>'; })();
  }
  function qrow(label, val, cls){
    return val ? '<div class="sq-row"><span>'+label+'</span><b class="'+(cls||"")+'">'+esc(val)+'</b></div>' : "";
  }
  function repCardHTML(r){
    var escCls = ESCALAS.indexOf(r.escala)>-1 ? " esc-"+r.escala.toLowerCase() : "";
    var eff = effStatus(r, todayISO());
    var stCls = (eff==="ferias"||eff==="licenca"||eff==="folga") ? " st-"+eff : "";
    var afastado = (r.status==="ferias"||r.status==="licenca") ? periodoTexto(r) : "";
    var rows = qrow("Escala", r.escala) +
      qrow("Admissão", r.admissao ? fmtDate(r.admissao) : "", "num") +
      qrow("Tempo de casa", tempoCasaTexto(r, true)) +
      qrow(r.status==="licenca" ? "Licença" : "Férias", afastado, "num");
    var flags = repFlags(r);
    var skills = repSkillNames(r);
    var tarefas = skills.length ? skills.slice(0,2).join(", ") + (skills.length>2 ? " +"+(skills.length-2) : "") : "";
    return '<div class="card rep-card'+escCls+stCls+'">' +
      '<div class="rep-top"><div class="rep-avatar">'+esc(repInitials(r.nome))+'</div><div class="rep-name">'+esc(r.nome)+'</div></div>' +
      '<div class="card-tags">'+repTags(r)+'</div>' +
      (rows ? '<div class="sq-rows">'+rows+'</div>' : "") +
      (flags.length ? '<div class="sq-flags">'+flags.map(function(f){return '<span class="flag">✓ '+f+'</span>';}).join("")+'</div>' : "") +
      (tarefas ? '<div class="sq-task-line" title="'+esc(skills.join(", "))+'"><span>Tarefas:</span> '+esc(tarefas)+'</div>' : "") +
      '<div class="sq-foot">' +
        '<button class="btn-ghost" data-act="ficha" data-id="'+r.id+'">Ver ficha</button>' +
        '<span class="row-actions">' +
          '<button class="btn-ghost" data-act="edit-rep" data-id="'+r.id+'">Editar</button>' +
          '<button class="btn-ghost" data-act="del-rep" data-id="'+r.id+'">Excluir</button>' +
        '</span>' +
      '</div>' +
    '</div>';
  }

  function openFicha(id){
    var r = state.reps.find(function(x){return x.id===id;});
    if(!r) return;
    function row(label, val, cls){ return val ? '<div class="ficha-row"><span>'+label+'</span><b class="'+(cls||"")+'">'+esc(val)+'</b></div>' : ""; }
    function sec(title, inner){ return inner ? '<div class="ficha-sec"><div class="ficha-sec-title">'+title+'</div>'+inner+'</div>' : ""; }
    var effHoje = effStatus(r, todayISO());
    var trabalho = row("Escala", r.escala) + row("Admissão", r.admissao ? fmtDate(r.admissao) : "", "num") +
      row("Tempo de casa", tempoCasaTexto(r, false)) + row("Total de dias de casa", diasDeCasaTexto(r), "num") +
      row("Situação hoje", statusRotulo(r, todayISO())) +
      ((r.status==="ferias"||r.status==="licenca") ? row(r.status==="licenca"?"Licença":"Férias", periodoTexto(r)) : "");
    var flags = repFlags(r);
    var contato = row("CPF", r.cpf, "num") + row("Aniversário", r.aniversario ? fmtDate(r.aniversario) : "", "num") +
      row("LDAP", r.ldap) + row("RE", r.re, "num") + row("Email", r.email) + row("Telefone", r.telefone, "num") + row("Endereço", r.endereco);
    var skills = repSkillNames(r);
    document.getElementById("fichaBox").innerHTML =
      '<div class="ficha-head"><div class="rep-avatar">'+esc(repInitials(r.nome))+'</div><div><div class="ficha-name">'+esc(r.nome)+'</div><div class="card-tags" style="margin:6px 0 0;padding:0;border:0;">'+repTags(r)+'</div></div></div>' +
      sec("Trabalho", trabalho) +
      sec("Habilitações", flags.length ? '<div class="sq-flags">'+flags.map(function(f){return '<span class="flag">✓ '+f+'</span>';}).join("")+'</div>' : "") +
      sec("Dados pessoais e contato", contato) +
      sec("Tarefas que sabe realizar", skills.length ? skills.map(function(n){return '<span class="chip">'+esc(n)+'</span>';}).join("") : "") +
      '<div class="ficha-foot"><button class="btn" data-act="close-ficha">Fechar</button></div>';
    document.getElementById("fichaOverlay").style.display = "flex";
  }
  function closeFicha(){ document.getElementById("fichaOverlay").style.display = "none"; }

  function updateSkillsVisibility(){
    var ps = document.getElementById("repClasse").value==="ps" || /^ps_/.test(document.getElementById("repCategoria").value);
    document.getElementById("repSkillsField").style.display = ps ? "none" : "";
  }
  function updatePeriodUI(){
    var st = document.getElementById("repStatus").value;
    var show = (st==="ferias" || st==="licenca");
    document.querySelectorAll(".period-field").forEach(function(el){ el.style.display = show ? "" : "none"; });
    document.getElementById("repAfastInicioLabel").textContent = st==="licenca" ? "Início da licença" : "Início das férias";
    var ini = document.getElementById("repAfastInicio").value;
    var dias = Number(document.getElementById("repAfastDias").value)||0;
    var fim = (ini && dias>0) ? Cal.addDays(ini, dias-1) : "";
    document.getElementById("repAfastFim").textContent = fim ? fmtDate(fim)+" · retorno em "+fmtDate(Cal.addDays(fim,1)) : "—";
    updateSkillsVisibility();
  }
  function startRepEdit(rep){
    editing.rep = rep.id;
    document.getElementById("repFormTitle").textContent = "Editar rep";
    document.getElementById("repNome").value = rep.nome;
    document.getElementById("repEscala").value = rep.escala||"";
    document.getElementById("repClasse").value = repClasse(rep);
    document.getElementById("repAdmissao").value = rep.admissao||"";
    document.getElementById("repAcessoHV").value = rep.acessoHV||"nao";
    document.getElementById("repTerceiraContagem").value = rep.terceiraContagem||"nao";
    document.getElementById("repMaquina").value = rep.maquina||"nao";
    document.getElementById("repCategoria").value = rep.categoria||"inventario";
    document.getElementById("repStatus").value = rep.status || "ativo";
    document.getElementById("repAfastInicio").value = rep.afastInicio || "";
    document.getElementById("repAfastDias").value = Number(rep.afastDias)>0 ? rep.afastDias : "";
    clearFormError("repFormError");
    updatePeriodUI();
    document.getElementById("repCpf").value = rep.cpf||"";
    document.getElementById("repAniversario").value = rep.aniversario||"";
    document.getElementById("repLdap").value = rep.ldap||"";
    document.getElementById("repRe").value = rep.re||"";
    document.getElementById("repEmail").value = rep.email||"";
    document.getElementById("repEndereco").value = rep.endereco||"";
    document.getElementById("repTelefone").value = rep.telefone||"";
    renderRepSkillsChecklist(rep.skills||[]);
    document.getElementById("repSaveBtn").textContent = "Salvar";
    document.getElementById("repCancelBtn").style.display = "inline-block";
    document.getElementById("repNome").focus();
  }
  function resetRepForm(){
    editing.rep = null;
    document.getElementById("repFormTitle").textContent = "Adicionar rep";
    document.getElementById("repNome").value = "";
    document.getElementById("repEscala").value = "A";
    document.getElementById("repClasse").value = "rep";
    document.getElementById("repAdmissao").value = "";
    document.getElementById("repAcessoHV").value = "nao";
    document.getElementById("repTerceiraContagem").value = "nao";
    document.getElementById("repMaquina").value = "nao";
    document.getElementById("repCategoria").value = "inventario";
    document.getElementById("repStatus").value = "ativo";
    document.getElementById("repAfastInicio").value = "";
    document.getElementById("repAfastDias").value = "";
    clearFormError("repFormError");
    updatePeriodUI();
    document.getElementById("repCpf").value = "";
    document.getElementById("repAniversario").value = "";
    document.getElementById("repLdap").value = "";
    document.getElementById("repRe").value = "";
    document.getElementById("repEmail").value = "";
    document.getElementById("repEndereco").value = "";
    document.getElementById("repTelefone").value = "";
    renderRepSkillsChecklist([]);
    document.getElementById("repSaveBtn").textContent = "Adicionar";
    document.getElementById("repCancelBtn").style.display = "none";
  }
  function saveRep(){
    var nome = document.getElementById("repNome").value.trim();
    if(!nome){ document.getElementById("repNome").focus(); return; }
    var data = {
      nome: nome,
      escala: document.getElementById("repEscala").value,
      classe: document.getElementById("repClasse").value,
      admissao: document.getElementById("repAdmissao").value,
      acessoHV: document.getElementById("repAcessoHV").value,
      terceiraContagem: document.getElementById("repTerceiraContagem").value,
      maquina: document.getElementById("repMaquina").value,
      categoria: document.getElementById("repCategoria").value,
      status: document.getElementById("repStatus").value,
      afastInicio: "",
      afastDias: 0,
      cpf: document.getElementById("repCpf").value.trim(),
      aniversario: document.getElementById("repAniversario").value,
      ldap: document.getElementById("repLdap").value.trim(),
      re: document.getElementById("repRe").value.trim(),
      email: document.getElementById("repEmail").value.trim(),
      endereco: document.getElementById("repEndereco").value.trim(),
      telefone: document.getElementById("repTelefone").value.trim(),
      skills: (document.getElementById("repClasse").value==="ps" || /^ps_/.test(document.getElementById("repCategoria").value)) ? [] : getCheckedRepSkills()
    };
    if(data.status==="ferias" || data.status==="licenca"){
      var ini = document.getElementById("repAfastInicio").value;
      var dias = Number(document.getElementById("repAfastDias").value)||0;
      if(!ini || dias<1){
        showFormError("repFormError", "Informe a data de início e a duração (em dias) "+(data.status==="ferias"?"das férias":"da licença")+", ou mude o status.");
        return;
      }
      data.afastInicio = ini;
      data.afastDias = dias;
    }
    clearFormError("repFormError");
    if(editing.rep){
      var rep = state.reps.find(function(r){return r.id===editing.rep;});
      if(rep){ Object.assign(rep, data); }else{ data.id = uid(); state.reps.push(data); }
    }else{
      data.id = uid();
      state.reps.push(data);
    }
    migrateTasks();
    resetRepForm();
    scheduleSave();
    renderAll();
  }
  function deleteRep(id){
    state.reps = state.reps.filter(function(r){return r.id!==id;});
    state.pontos.forEach(function(p){ p.repIds = (p.repIds||[]).filter(function(rid){return rid!==id;}); });
    state.lost = state.lost.filter(function(l){return l.repId!==id;});
    state.tasks.forEach(function(t){ t.repIds = (t.repIds||[]).filter(function(rid){return rid!==id;}); });
    state.folgas = (state.folgas||[]).filter(function(f){return f.repId!==id;});
    if(editing.rep===id) resetRepForm();
    scheduleSave();
    renderAll();
  }

  // =====================================================================
  // DIMENSIONAMENTO (cards por tarefa)
  // =====================================================================
  function dimDiaLabel(iso){
    var p = iso.split("-");
    return new Date(Date.UTC(+p[0], +p[1]-1, +p[2])).toLocaleDateString("pt-BR", {weekday:"short", day:"2-digit", month:"2-digit", timeZone:"UTC"});
  }
  function escalaTrabalha(esc, iso){
    var marcado = Cal.isMarcado(esc, iso);
    return state.escalaModo==="trabalho" ? marcado : !marcado;
  }
  function renderDim(){
    if(!dimDate) dimDate = todayISO();
    var inp = document.getElementById("dimData");
    if(inp.value!==dimDate) inp.value = dimDate;
    document.getElementById("escalaModo").value = state.escalaModo==="trabalho" ? "trabalho" : "folga";

    // Contadores com TODOS (reps e PS); logo abaixo, os presentes separados por Área cadastrada.
    var c = {ativo:0, folga:0, ferias:0, licenca:0, afastado:0};
    state.reps.forEach(function(r){ c[effStatus(r, dimDate)]++; });
    var cdDia = contagemDia(dimDate), extraFolga = cdDia.banco.length + cdDia.trocaFolga.length;
    document.getElementById("dimStrip").innerHTML =
      stripCell("Trabalhando", c.ativo, "green", "green", "Presentes na data" + (cdDia.trocaTrab.length ? " · "+cdDia.trocaTrab.length+" em troca" : "")) +
      stripCell("Folga", c.folga, "folga", "folga", extraFolga ? "Escala + "+extraFolga+" folga"+(extraFolga>1?"s":"")+" extra"+(extraFolga>1?"s":"") : "Pela escala") +
      stripCell("Férias", c.ferias, "ferias", "ferias", "Em férias") +
      stripCell("Licença", c.licenca, "licenca", "licenca", "Em licença") +
      stripCell("Afastados", c.afastado, "rust", "rust", "Afastados");
    var areasDia = areasDoDia(cdDia);
    document.getElementById("dimAreasTitle").textContent = areasDia.length ? "Presentes por área em "+fmtDate(dimDate)+" (quem está trabalhando, PS incluídos)" : "";
    document.getElementById("dimAreas").innerHTML = areasDia.map(function(a){
      var dl = a.total - a.base;
      var cap = "de "+a.cad+" cadastrado"+(a.cad>1?"s":"") + (a.ps && !areaEhPS(a.key) ? " · "+a.ps+" PS" : "") + (dl ? " · "+(dl<0?"−":"+")+Math.abs(dl)+" por folga extra/troca" : "");
      return stripCell(esc(areaNome(a.key)), a.total, "", areaEhPS(a.key) ? "amber" : "teal", cap);
    }).join("");

    var dias = [];
    for(var i=-3;i<=3;i++) dias.push(Cal.addDays(dimDate, i));
    var hoje = todayISO();
    var html = '<table><thead><tr><th></th>' + dias.map(function(d){
      return '<th>'+dimDiaLabel(d)+(d===hoje?'<br>hoje':'')+'</th>';
    }).join("") + '</tr></thead><tbody>';
    ESCALAS.forEach(function(e){
      var membros = state.reps.filter(function(r){return r.escala===e;});
      var disp = membros.filter(function(r){return effStatus(r, dimDate)==="ativo";}).length;
      html += '<tr><td class="lbl"><span class="esc-dot" style="background:'+ESC_COR[e]+'"></span>Escala '+e+
        ' <span class="hint">('+disp+'/'+membros.length+')</span></td>' + dias.map(function(d){
        var on = escalaTrabalha(e, d);
        return '<td class="d '+(on?'on':'off')+(d===dimDate?' sel':'')+'" data-act="dim-dia" data-iso="'+d+'">'+(on?'Trabalha':'Folga')+'</td>';
      }).join("") + '</tr>';
    });
    // Presentes por dia, separados por Área cadastrada (PS incluídos) e o total, já com banco de horas e trocas
    var cds = dias.map(contagemDia);
    var saldo = function(dl){ return dl ? ' <small class="'+(dl<0?'neg':'pos')+'">'+(dl<0?'−':'+')+Math.abs(dl)+'</small>' : ''; };
    var areasSemana = areasDoDia(cds[0]);
    if(areasSemana.length){
      html += '<tr class="sub-row"><td class="lbl sub" colspan="'+(dias.length+1)+'">Presentes por área</td></tr>';
      areasSemana.forEach(function(ar){
        html += '<tr class="area-row"><td class="lbl"><span class="esc-dot" style="background:'+(areaEhPS(ar.key)?'var(--amber)':'var(--teal)')+'"></span>'+esc(areaNome(ar.key))+
          ' <span class="hint">('+ar.cad+')</span></td>' + cds.map(function(cd){
          var a = cd.areas[ar.key];
          return '<td class="d area'+(cd.iso===dimDate?' sel':'')+'" data-act="dim-dia" data-iso="'+cd.iso+'"><b>'+a.total+'</b>'+saldo(a.total-a.base)+'</td>';
        }).join("") + '</tr>';
      });
    }
    html += '<tr class="tot-row"><td class="lbl">Pessoas trabalhando</td>' + cds.map(function(cd){
      var tip = "Pela escala "+cd.base+(cd.banco.length?" − "+cd.banco.length+" banco de horas":"")+(cd.trocaFolga.length?" − "+cd.trocaFolga.length+" troca (folga)":"")+(cd.trocaTrab.length?" + "+cd.trocaTrab.length+" troca (trabalha)":"")+" = "+cd.total+
        " · "+areasDoDia(cd).map(function(ar){ return AREA_CURTA[ar.key]+" "+ar.total; }).join(" · ");
      return '<td class="d tot'+(cd.iso===dimDate?' sel':'')+'" data-act="dim-dia" data-iso="'+cd.iso+'" title="'+esc(tip)+'"><b>'+cd.total+'</b>'+saldo(cd.total-cd.base)+'</td>';
    }).join("") + '</tr>';
    document.getElementById("dimSemana").innerHTML = html + '</tbody></table>';

    document.getElementById("dimLegenda").innerHTML =
      ['ativo','folga','ferias','licenca','afastado'].map(function(k){
        return '<span class="tag '+STATUS_TAG[k]+'">'+STATUS_LABEL[k]+'</span>';
      }).join("") + '<span class="hint">· Escala marcada nos calendários = '+(state.escalaModo==="trabalho"?"dia de trabalho":"folga")+' · PS contam nos presentes (separados por área), mas não entram nas tarefas · "Pessoas trabalhando" já desconta banco de horas e trocas de folga</span>';

    var hint = document.getElementById("dimHint");
    if(Cal.foraDosCalendarios(dimDate)){
      hint.textContent = "Data fora dos calendários enviados (set–dez/2026): a escala é projetada pelo ciclo de 52 semanas deduzido deles.";
      hint.style.display = "block";
    }else{
      hint.style.display = "none";
    }
  }
  function nmHTML(rid){
    var r = state.reps.find(function(x){return x.id===rid;});
    if(!r) return esc("(rep removido)");
    var st = effStatus(r, dimDate);
    var nota = statusNote(r, dimDate);
    return '<span class="nm st-'+st+'">'+esc(r.nome)+'</span>' + (nota ? ' <small>('+esc(nota)+')</small>' : "");
  }
  // ----- preenchimento dinâmico -----
  function elegiveis(t){ return sortReps(state.reps).filter(function(r){ return repElegivel(t, r); }); }
  function subconjunto(t, modo){
    var el = elegiveis(t);
    if(modo==="disp") return el.filter(function(r){ return effStatus(r, dimDate)==="ativo"; });
    if(modo.indexOf("esc:")===0) return el.filter(function(r){ return r.escala===modo.slice(4); });
    return el;
  }
  function todosMarcados(t, lista){
    var ids = t.repIds||[];
    return lista.length>0 && lista.every(function(r){ return ids.indexOf(r.id)>-1; });
  }
  function snapshotMarcacoes(){
    var m = {};
    state.tasks.forEach(function(t){ m[t.id] = (t.repIds||[]).slice(); });
    return m;
  }
  // Aplica uma alteração em massa guardando um nível de "Desfazer" (só se algo mudou).
  function mutarMarcacoes(label, fn){
    var antes = snapshotMarcacoes(), json = JSON.stringify(antes);
    var extra = fn();
    var mudou = JSON.stringify(snapshotMarcacoes()) !== json;
    if(mudou){
      dimUndo = {label:label, snap:antes};
      scheduleSave();
    }
    dimMsg = extra || (mudou ? label : "Nada a alterar.");
    renderTasks();
    return mudou;
  }
  function addIds(t, lista){
    t.repIds = t.repIds || [];
    lista.forEach(function(r){ if(t.repIds.indexOf(r.id)<0) t.repIds.push(r.id); });
  }
  function removeIds(t, lista){
    var rm = {}; lista.forEach(function(r){ rm[r.id] = true; });
    t.repIds = (t.repIds||[]).filter(function(rid){ return !rm[rid]; });
  }
  function fillTask(t, modo){
    var lista = subconjunto(t, modo);
    if(!lista.length) return;
    var nome = modo==="todos" ? "todos" : (modo==="disp" ? "disponíveis na data" : "Escala "+modo.slice(4));
    if(todosMarcados(t, lista)) mutarMarcacoes(t.nome+": "+nome+" desmarcados", function(){ removeIds(t, lista); });
    else mutarMarcacoes(t.nome+": "+nome+" marcados", function(){ addIds(t, lista); });
  }
  function clearTask(t){
    mutarMarcacoes(t.nome+": marcações limpas", function(){ t.repIds = []; });
  }
  function clearAll(){
    mutarMarcacoes("Todas as marcações limpas", function(){ state.tasks.forEach(function(t){ t.repIds = []; }); });
  }
  function fillBySkills(){
    var n = 0, ignoradas = 0;
    mutarMarcacoes("Preenchido pelas habilidades", function(){
      state.reps.forEach(function(r){
        if(repEhPS(r)) return;
        (r.skills||[]).forEach(function(tid){
          var t = state.tasks.find(function(x){ return x.id===tid; });
          if(!t) return;
          if(!repElegivel(t, r)){ ignoradas++; return; }
          t.repIds = t.repIds || [];
          if(t.repIds.indexOf(r.id)<0){ t.repIds.push(r.id); n++; }
        });
      });
      return n ? "Preenchido pelas habilidades: "+n+" marcação(ões) adicionada(s)"+(ignoradas?" ("+ignoradas+" fora da área ignorada(s))":"")+"." :
        "Nenhuma marcação nova: as habilidades já estão marcadas"+(ignoradas?" ou ficam fora da área":"")+".";
    });
  }
  function undoMarcacoes(){
    if(!dimUndo) return;
    var u = dimUndo; dimUndo = null;
    state.tasks.forEach(function(t){ if(u.snap[t.id]) t.repIds = u.snap[t.id].slice(); });
    scheduleSave();
    dimMsg = "Desfeito: "+u.label;
    renderTasks();
  }
  function taskTools(t){
    var ids = t.repIds||[];
    function b(modo, texto, lista){
      var on = todosMarcados(t, lista);
      return '<button class="chip-btn'+(on?' on':'')+'" data-act="task-fill" data-mode="'+modo+'" data-id="'+t.id+'"'+(lista.length?'':' disabled')+
        ' title="'+(on?'Desmarcar':'Marcar')+' '+esc(texto)+'">'+texto+' <small>'+lista.length+'</small></button>';
    }
    return '<div class="task-tools"><span class="tt-label">Marcar:</span>' +
      b("todos", "Todos", subconjunto(t, "todos")) +
      ESCALAS.map(function(e){
        return b("esc:"+e, '<span class="esc-dot" style="background:'+ESC_COR[e]+'"></span>'+e, subconjunto(t, "esc:"+e));
      }).join("") +
      b("disp", "Disponíveis", subconjunto(t, "disp")) +
      '<button class="chip-btn clear" data-act="task-clear" data-id="'+t.id+'"'+(ids.length?'':' disabled')+'>Limpar</button>' +
    '</div>';
  }
  function repVisivelNoFiltro(r){
    if(repEhPS(r)) return false;
    if(dimFiltro==="resp") return state.tasks.some(function(t){ return (t.repIds||[]).indexOf(r.id)>-1; });
    if(dimFiltro==="disp") return effStatus(r, dimDate)==="ativo";
    return true;
  }
  function renderMatriz(){
    var wrap = document.getElementById("taskMatrix");
    var reps = sortReps(state.reps).filter(repVisivelNoFiltro);
    if(!reps.length){
      wrap.innerHTML = '<div class="hint">Nenhum rep nesse filtro.</div>';
      return;
    }
    var head = '<tr><th class="mx-corner">Rep \\ Tarefa</th>' + state.tasks.map(function(t){
      var ids = t.repIds||[], fixa = areaFixa(t.nome);
      var resp = state.reps.filter(function(r){ return ids.indexOf(r.id)>-1 && repElegivel(t, r); });
      var disp = resp.filter(function(r){ return effStatus(r, dimDate)==="ativo"; }).length;
      return '<th class="mx-col"><button class="mx-colbtn" data-act="mx-col" data-id="'+t.id+'" title="Marcar/desmarcar todos os elegíveis de '+esc(t.nome)+'">'+
        esc(t.nome)+'<small>'+(CATEGORIA_LABEL[tarefaArea(t)]||"")+(fixa?" · fixa":"")+'</small><small class="mx-cnt">'+disp+'/'+resp.length+' disp.</small></button></th>';
    }).join("") + '</tr>';
    var body = reps.map(function(r){
      var st = effStatus(r, dimDate);
      var cells = state.tasks.map(function(t){
        if(!repElegivel(t, r)) return '<td class="mx-cell na" title="Fora da área desta tarefa">—</td>';
        var on = (t.repIds||[]).indexOf(r.id)>-1;
        return '<td class="mx-cell"><button class="mx-btn'+(on?' on st-'+st:'')+'" data-act="mx-cell" data-task="'+t.id+'" data-rep="'+r.id+'" aria-pressed="'+(on?"true":"false")+'">'+(on?'✓':'')+'</button></td>';
      }).join("");
      return '<tr><th class="mx-row st-'+st+'"><button class="mx-rowbtn" data-act="mx-row" data-id="'+r.id+'" title="Marcar/desmarcar todas as tarefas elegíveis deste rep">'+
        (r.escala?'<span class="esc-dot" style="background:'+ESC_COR[r.escala]+'"></span>':'')+esc(r.nome)+
        (statusNote(r, dimDate)?' <small>'+esc(statusNote(r, dimDate))+'</small>':'')+'</button></th>'+cells+'</tr>';
    }).join("");
    wrap.innerHTML = '<div class="mx-scroll"><table class="mx">'+'<thead>'+head+'</thead><tbody>'+body+'</tbody></table></div>' +
      '<div class="hint" style="margin-top:8px;">Clique numa célula para marcar/desmarcar · no nome da tarefa para marcar todos os elegíveis · no nome do rep para marcar todas as tarefas dele. “—” = fora da área; PS não aparecem.</div>';
  }
  function toggleMatrizCol(t){
    var lista = elegiveis(t);
    if(!lista.length) return;
    if(todosMarcados(t, lista)) mutarMarcacoes(t.nome+": todos desmarcados", function(){ removeIds(t, lista); });
    else mutarMarcacoes(t.nome+": todos marcados", function(){ addIds(t, lista); });
  }
  function toggleMatrizRow(r){
    var ts = state.tasks.filter(function(t){ return repElegivel(t, r); });
    if(!ts.length) return;
    var tudo = ts.every(function(t){ return (t.repIds||[]).indexOf(r.id)>-1; });
    mutarMarcacoes(r.nome+": "+(tudo?"desmarcado de todas":"marcado em todas")+" as tarefas", function(){
      ts.forEach(function(t){ if(tudo) removeIds(t, [r]); else addIds(t, [r]); });
    });
  }
  function renderDimToolbar(){
    Array.prototype.forEach.call(document.querySelectorAll("[data-act='dim-view']"), function(b){
      var on = b.dataset.mode===dimView;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.getElementById("dimUndoBtn").disabled = !dimUndo;
    document.getElementById("dimUndoBtn").title = dimUndo ? "Desfazer: "+dimUndo.label : "Nada para desfazer";
    document.getElementById("dimClearAll").disabled = !state.tasks.some(function(t){ return (t.repIds||[]).length; });
    var m = document.getElementById("dimMsg");
    m.textContent = dimMsg;
    m.style.display = dimMsg ? "inline" : "none";
  }
  function renderTasks(){
    document.getElementById("taskMeta").textContent = state.tasks.length + " tarefa(s)";
    var grid = document.getElementById("taskGrid");
    var empty = document.getElementById("taskEmpty");
    var matriz = document.getElementById("taskMatrix");
    renderDimToolbar();
    if(state.tasks.length===0){
      grid.innerHTML = "";
      matriz.innerHTML = "";
      empty.style.display = "block";
      renderResumo();
      return;
    }
    empty.style.display = "none";
    grid.style.display = dimView==="cards" ? "" : "none";
    matriz.style.display = dimView==="matriz" ? "block" : "none";
    if(dimView==="matriz"){ renderMatriz(); grid.innerHTML = ""; renderResumo(); return; }
    matriz.innerHTML = "";
    grid.innerHTML = state.tasks.map(function(t){
      var ids = t.repIds||[];
      var area = tarefaArea(t), fixa = areaFixa(t.nome);
      var resp = state.reps.filter(function(r){return ids.indexOf(r.id)>-1 && repElegivel(t, r);});
      var fora = state.reps.filter(function(r){return ids.indexOf(r.id)>-1 && !repElegivel(t, r);});
      var disp = resp.filter(function(r){return effStatus(r, dimDate)==="ativo";}).length;
      var cov;
      if(resp.length===0){
        cov = '<div class="cov"><div class="cov-head"><span>Sem responsáveis'+(fixa?' de '+CATEGORIA_LABEL[fixa]:'')+'</span></div></div>';
      }else{
        var pct = Math.round(disp/resp.length*100);
        var cls = disp===0 ? "cov-bad" : (pct<50 ? "cov-mid" : "cov-ok");
        cov = '<div class="cov"><div class="cov-head"><span>Disponíveis na data</span><b>'+disp+' de '+resp.length+'</b></div>' +
          '<div class="cov-bar"><div class="cov-fill '+cls+'" style="width:'+pct+'%"></div></div></div>';
      }
      var lista = sortReps(state.reps).filter(function(r){
        var elegivel = repElegivel(t, r), atribuido = ids.indexOf(r.id)>-1;
        if(!elegivel && !atribuido) return false;
        if(dimFiltro==="resp") return atribuido;
        if(dimFiltro==="disp") return elegivel && effStatus(r, dimDate)==="ativo";
        return true;
      });
      var repChecks = state.reps.length ? (lista.length ? lista.map(function(r){
        var isResp = ids.indexOf(r.id)>-1;
        var foraArea = !repElegivel(t, r);
        var st = foraArea ? "fora" : effStatus(r, dimDate);
        var nota = foraArea ? repMotivoFora(r) : [r.escala ? r.escala : "", statusNote(r, dimDate)].filter(Boolean).join(" · ");
        var exr = foraArea ? null : extraDe(r, dimDate);
        return '<label class="rep-box st-'+st+(isResp?' is-resp':'')+(exr ? (exr.tipo==="troca-trabalho" ? ' ex-trab' : ' ex-folga') : '')+'"><input type="checkbox" class="task-rep-toggle" data-task="'+t.id+'" data-rep="'+r.id+'" '+(isResp?"checked":"")+'>'+
          esc(r.nome)+(nota?' <small>'+esc(nota)+'</small>':'')+'</label>';
      }).join("") : '<span class="hint">Nenhum rep nesse filtro'+(fixa?' (só reps de '+CATEGORIA_LABEL[fixa]+', sem PS)':'')+'.</span>') : '<span class="hint">Cadastre reps na aba Equipe.</span>';
      return '<div class="card">' +
        '<div class="card-head">' +
          '<div class="card-title">'+esc(t.nome)+'</div>' +
          '<div class="row-actions">' +
            '<button class="btn-ghost" data-act="edit-task" data-id="'+t.id+'">Editar</button>' +
            '<button class="btn-ghost" data-act="del-task" data-id="'+t.id+'">Excluir</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-tags"><span class="tag tag-dark">'+(CATEGORIA_LABEL[area]||"—")+'</span>' +
          (fixa ? '<span class="tag tag-folga">só reps de '+CATEGORIA_LABEL[fixa]+' (sem PS)</span>' : '') + '</div>' +
        cov +
        taskTools(t) +
        '<div class="card-section-label">Reps responsáveis</div>' +
        '<div class="check-list">'+repChecks+'</div>' +
        (fora.length ? '<div class="hint" style="margin-top:8px;">'+fora.length+' rep(s) de outra área ou PS estão atribuídos e são ignorados no cálculo. Desmarque para limpar.</div>' : '') +
      '</div>';
    }).join("");

    renderResumo();
  }
  function renderResumo(){
    var wrap = document.getElementById("resumoGrid");
    var icons = {inventario:"📋", qualidade:"✅"};
    function repsDaTarefa(t){
      return (t.repIds||[]).filter(function(rid){
        var r = state.reps.find(function(x){return x.id===rid;});
        return r && repElegivel(t, r);
      });
    }

    var invTasks = state.tasks.filter(function(t){ return tarefaArea(t)==="inventario"; });
    var invItems = invTasks.map(function(t){
      var names = repsDaTarefa(t).map(nmHTML).join(", ") || "—";
      return '<div class="resumo-item"><span class="dot">•</span><div><b>'+esc(t.nome)+':</b> '+names+'</div></div>';
    }).join("") || '<div class="hint">Nenhuma tarefa nessa área ainda.</div>';

    var qltTasks = state.tasks.filter(function(t){ return tarefaArea(t)==="qualidade"; });
    var repTaskMap = {};
    qltTasks.forEach(function(t){
      repsDaTarefa(t).forEach(function(rid){
        if(!repTaskMap[rid]) repTaskMap[rid] = [];
        repTaskMap[rid].push(t.nome);
      });
    });
    var qltRepIds = Object.keys(repTaskMap).sort(function(a,b){ return repName(a).localeCompare(repName(b)); });
    var qltItems = qltRepIds.map(function(rid){
      return '<div class="resumo-item"><span class="dot check">✓</span><div><b>'+nmHTML(rid)+':</b> '+esc(repTaskMap[rid].join(", "))+'</div></div>';
    }).join("") || '<div class="hint">Nenhuma tarefa nessa área ainda.</div>';

    var cards = { inventario: invItems, qualidade: qltItems };

    wrap.innerHTML = ["inventario","qualidade"].map(function(cat){
      return '<div class="resumo-card">' +
        '<div class="resumo-head">' +
          '<div class="resumo-icon">'+icons[cat]+'</div>' +
          '<div class="resumo-title">'+CATEGORIA_LABEL[cat]+'</div>' +
        '</div>' +
        '<div class="resumo-list">'+cards[cat]+'</div>' +
      '</div>';
    }).join("");
  }
  function syncTaskAreaLock(){
    var f = areaFixa(document.getElementById("taskNome").value);
    var sel = document.getElementById("taskCategoria"), hint = document.getElementById("taskAreaHint");
    if(f){
      sel.value = f; sel.disabled = true;
      hint.textContent = "Área fixa desta tarefa: só reps de " + CATEGORIA_LABEL[f] + ", sem PS.";
      hint.style.display = "block";
    }else{
      sel.disabled = false;
      hint.style.display = "none";
    }
  }
  function startTaskEdit(t){
    editing.task = t.id;
    document.getElementById("taskFormTitle").textContent = "Editar tarefa";
    document.getElementById("taskNome").value = t.nome;
    document.getElementById("taskCategoria").value = t.categoria||"inventario";
    syncTaskAreaLock();
    document.getElementById("taskSaveBtn").textContent = "Salvar";
    document.getElementById("taskCancelBtn").style.display = "inline-block";
    document.getElementById("taskNome").focus();
  }
  function resetTaskForm(){
    editing.task = null;
    document.getElementById("taskFormTitle").textContent = "Adicionar tarefa";
    document.getElementById("taskNome").value = "";
    document.getElementById("taskCategoria").value = "inventario";
    syncTaskAreaLock();
    document.getElementById("taskSaveBtn").textContent = "Adicionar";
    document.getElementById("taskCancelBtn").style.display = "none";
  }
  function saveTask(){
    var nome = document.getElementById("taskNome").value.trim();
    if(!nome){ document.getElementById("taskNome").focus(); return; }
    var categoria = areaFixa(nome) || document.getElementById("taskCategoria").value;
    if(editing.task){
      var t = state.tasks.find(function(x){return x.id===editing.task;});
      if(t){ t.nome = nome; t.categoria = categoria; }
      else{ state.tasks.push({id:uid(), nome:nome, categoria:categoria, repIds:[]}); }
    }else{
      state.tasks.push({id:uid(), nome:nome, categoria:categoria, repIds:[]});
    }
    resetTaskForm();
    scheduleSave();
    renderAll();
  }
  function deleteTask(id){
    state.tasks = state.tasks.filter(function(t){return t.id!==id;});
    state.reps.forEach(function(r){ r.skills = (r.skills||[]).filter(function(tid){return tid!==id;}); });
    if(editing.task===id) resetTaskForm();
    scheduleSave();
    renderAll();
  }
  function toggleTaskRep(taskId, repId){
    var t = state.tasks.find(function(x){return x.id===taskId;});
    if(!t) return;
    var alvo = state.reps.find(function(x){return x.id===repId;});
    if(alvo && repEhPS(alvo)) return;
    t.repIds = t.repIds || [];
    var idx = t.repIds.indexOf(repId);
    if(idx>-1) t.repIds.splice(idx,1); else t.repIds.push(repId);
    dimMsg = "";
    scheduleSave();
    renderTasks();
  }

  // =====================================================================
  // PONTOS ALINHADOS
  // =====================================================================
  function pontoRepsForCategoria(cat){
    return sortReps(state.reps.filter(function(r){ return r.categoria===cat; }));
  }
  function renderPontoRepsChecklist(selectedIds){
    var cat = document.getElementById("pontoCategoria").value;
    var list = pontoRepsForCategoria(cat);
    var wrap = document.getElementById("pontoReps");
    if(list.length===0){
      wrap.innerHTML = '<span class="hint">Nenhum rep cadastrado nessa área ainda.</span>';
      return;
    }
    wrap.innerHTML = list.map(function(r){
      var checked = selectedIds && selectedIds.indexOf(r.id)>-1 ? "checked" : "";
      return '<label><input type="checkbox" class="ponto-rep-check" value="'+r.id+'" '+checked+'>'+esc(r.nome)+'</label>';
    }).join("");
  }
  function getCheckedPontoReps(){
    return Array.prototype.slice.call(document.querySelectorAll(".ponto-rep-check:checked")).map(function(c){return c.value;});
  }
  function renderPontos(){
    document.getElementById("pontosMeta").textContent = state.pontos.length + " registro(s)";
    if(!editing.ponto) renderPontoRepsChecklist([]);

    var body = document.getElementById("pontoTableBody");
    var empty = document.getElementById("pontoEmpty");
    var list = state.pontos.slice().sort(function(a,b){ return (b.data||"").localeCompare(a.data||""); });
    if(list.length===0){ body.innerHTML=""; empty.style.display="block"; return; }
    empty.style.display = "none";
    body.innerHTML = list.map(function(p){
      var statusCls = p.status==="concluido" ? "tag-green" : "tag-amber";
      var statusLabel = p.status==="concluido" ? "Concluído" : "Pendente";
      var nomes = (p.repIds||[]).map(repName).join(", ") || "—";
      return '<tr>' +
        '<td class="num">'+fmtDate(p.data)+'</td>' +
        '<td><span class="tag tag-dark">'+(CATEGORIA_LABEL[p.categoria]||"—")+'</span></td>' +
        '<td>'+esc(nomes)+'</td>' +
        '<td>'+esc(p.texto)+'</td>' +
        '<td><span class="tag '+statusCls+'">'+statusLabel+'</span></td>' +
        '<td class="row-actions">' +
          '<button class="btn-ghost" data-act="edit-ponto" data-id="'+p.id+'">Editar</button>' +
          '<button class="btn-ghost" data-act="del-ponto" data-id="'+p.id+'">Excluir</button>' +
        '</td>' +
      '</tr>';
    }).join("");
  }
  function startPontoEdit(p){
    editing.ponto = p.id;
    document.getElementById("pontoFormTitle").textContent = "Editar ponto";
    document.getElementById("pontoCategoria").value = p.categoria||"inventario";
    document.getElementById("pontoData").value = p.data;
    document.getElementById("pontoTexto").value = p.texto;
    document.getElementById("pontoStatus").value = p.status;
    renderPontoRepsChecklist(p.repIds||[]);
    document.getElementById("pontoSaveBtn").textContent = "Salvar";
    document.getElementById("pontoCancelBtn").style.display = "inline-block";
  }
  function resetPontoForm(){
    editing.ponto = null;
    document.getElementById("pontoFormTitle").textContent = "Registrar ponto";
    document.getElementById("pontoCategoria").value = "inventario";
    document.getElementById("pontoData").value = todayISO();
    document.getElementById("pontoTexto").value = "";
    document.getElementById("pontoStatus").value = "pendente";
    renderPontoRepsChecklist([]);
    document.getElementById("pontoSaveBtn").textContent = "Registrar";
    document.getElementById("pontoCancelBtn").style.display = "none";
  }
  function savePonto(){
    var texto = document.getElementById("pontoTexto").value.trim();
    var repIds = getCheckedPontoReps();
    if(!texto || repIds.length===0){ document.getElementById("pontoTexto").focus(); return; }
    var data = {
      categoria: document.getElementById("pontoCategoria").value,
      data: document.getElementById("pontoData").value || todayISO(),
      texto: texto,
      status: document.getElementById("pontoStatus").value,
      repIds: repIds
    };
    if(editing.ponto){
      var p = state.pontos.find(function(p){return p.id===editing.ponto;});
      if(p){ Object.assign(p, data); }else{ data.id = uid(); state.pontos.push(data); }
    }else{
      data.id = uid();
      state.pontos.push(data);
    }
    resetPontoForm();
    scheduleSave();
    renderAll();
  }
  function deletePonto(id){
    state.pontos = state.pontos.filter(function(p){return p.id!==id;});
    if(editing.ponto===id) resetPontoForm();
    scheduleSave();
    renderAll();
  }

  // =====================================================================
  // LOST
  // =====================================================================
  function fillRepSelect(sel){
    var current = sel.value;
    if(state.reps.length===0){
      sel.innerHTML = '<option value="">Nenhum rep cadastrado</option>';
      return;
    }
    sel.innerHTML = sortReps(state.reps).map(function(r){ return '<option value="'+r.id+'">'+esc(r.nome)+(r.escala?' · Escala '+esc(r.escala):'')+'</option>'; }).join("");
    if(current) sel.value = current;
  }
  function computeLostByMU(){
    var map = {};
    state.lost.forEach(function(l){
      var mu = (l.mu||"").trim() || "—";
      if(!map[mu]) map[mu] = {mu:mu, quantidade:0, valor:0};
      map[mu].quantidade += Number(l.quantidade)||0;
      map[mu].valor += Number(l.valor)||0;
    });
    return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return b.valor-a.valor;});
  }
  function computeLostByRep(){
    var map = {};
    state.lost.forEach(function(l){
      if(!map[l.repId]) map[l.repId] = {repId:l.repId, quantidade:0, valor:0};
      map[l.repId].quantidade += Number(l.quantidade)||0;
      map[l.repId].valor += Number(l.valor)||0;
    });
    return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return b.valor-a.valor;});
  }
  function renderLost(){
    fillRepSelect(document.getElementById("lostRep"));
    var total = state.lost.reduce(function(s,l){return s+(Number(l.valor)||0);}, 0);
    var byRep = computeLostByRep();
    var offender = byRep[0];
    var strip = document.getElementById("lostStrip");
    strip.innerHTML =
      stripCell("Registros", state.lost.length, "", "", "Lost registrados") +
      stripCell("Valor total perdido", fmtMoney(total), "rust", "rust", "Somado de todos os MU") +
      stripCell("Rep ofensor", offender ? esc(repName(offender.repId)) : "—", "rust", "rust", offender ? fmtMoney(offender.valor)+" acumulado" : "Sem registros ainda");

    document.getElementById("lostMeta").textContent = state.lost.length + " registro(s)";

    var muRows = computeLostByMU();
    document.getElementById("lostMuTableBody").innerHTML = muRows.length ? muRows.map(function(m){
      return '<tr><td>'+esc(m.mu)+'</td><td class="num">'+m.quantidade+'</td><td class="num" style="text-align:right;">'+fmtMoney(m.valor)+'</td></tr>';
    }).join("") : '<tr><td colspan="3" class="hint" style="padding:14px 12px;">Sem registros ainda.</td></tr>';

    var body = document.getElementById("lostTableBody");
    var empty = document.getElementById("lostEmpty");
    if(state.lost.length===0){ body.innerHTML=""; empty.style.display="block"; return; }
    empty.style.display = "none";
    body.innerHTML = state.lost.slice().reverse().map(function(l){
      return '<tr>' +
        '<td>'+esc(repName(l.repId))+'</td>' +
        '<td>'+esc(l.mu||"—")+'</td>' +
        '<td class="num">'+(Number(l.quantidade)||0)+'</td>' +
        '<td class="num" style="text-align:right;">'+fmtMoney(l.valor)+'</td>' +
        '<td class="row-actions">' +
          '<button class="btn-ghost" data-act="edit-lost" data-id="'+l.id+'">Editar</button>' +
          '<button class="btn-ghost" data-act="del-lost" data-id="'+l.id+'">Excluir</button>' +
        '</td>' +
      '</tr>';
    }).join("");
  }
  function startLostEdit(l){
    editing.lost = l.id;
    document.getElementById("lostFormTitle").textContent = "Editar lost";
    document.getElementById("lostRep").value = l.repId;
    document.getElementById("lostMu").value = l.mu||"";
    document.getElementById("lostQuantidade").value = l.quantidade;
    document.getElementById("lostValor").value = l.valor;
    document.getElementById("lostSaveBtn").textContent = "Salvar";
    document.getElementById("lostCancelBtn").style.display = "inline-block";
  }
  function resetLostForm(){
    editing.lost = null;
    document.getElementById("lostFormTitle").textContent = "Registrar lost";
    document.getElementById("lostMu").value = "";
    document.getElementById("lostQuantidade").value = "";
    document.getElementById("lostValor").value = "";
    document.getElementById("lostSaveBtn").textContent = "Registrar";
    document.getElementById("lostCancelBtn").style.display = "none";
  }
  function saveLost(){
    var repId = document.getElementById("lostRep").value;
    var mu = document.getElementById("lostMu").value.trim();
    if(!repId || !mu){ document.getElementById("lostMu").focus(); return; }
    var data = {
      repId: repId,
      mu: mu,
      quantidade: Number(document.getElementById("lostQuantidade").value)||0,
      valor: Number(document.getElementById("lostValor").value)||0
    };
    if(editing.lost){
      var l = state.lost.find(function(l){return l.id===editing.lost;});
      if(l){ Object.assign(l, data); }else{ data.id = uid(); state.lost.push(data); }
    }else{
      data.id = uid();
      state.lost.push(data);
    }
    resetLostForm();
    scheduleSave();
    renderAll();
  }
  function deleteLost(id){
    state.lost = state.lost.filter(function(l){return l.id!==id;});
    if(editing.lost===id) resetLostForm();
    scheduleSave();
    renderAll();
  }

  // =====================================================================
  // FOLGAS EXTRAS (banco de horas e troca de folga)
  // =====================================================================
  var folgasMes = "", folgaFiltroRep = "", folgaFiltroPer = "mes", folgaTocado = false;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isoOk(s){ return ISO_RE.test(String(s||"")); }
  function diasEntre(a, b){ return Cal.diasDesdeEpoch(b) - Cal.diasDesdeEpoch(a) + 1; } // inclusivo
  function diaSemana(iso){
    if(!isoOk(iso)) return "";
    var p = iso.split("-");
    return new Date(Date.UTC(+p[0], +p[1]-1, +p[2])).toLocaleDateString("pt-BR", {weekday:"short", timeZone:"UTC"});
  }
  function diaMes(iso){ if(!isoOk(iso)) return "—"; var p = iso.split("-"); return p[2]+"/"+p[1]; }
  function mesLabel(ym){
    var p = ym.split("-");
    var s = new Date(Date.UTC(+p[0], +p[1]-1, 1)).toLocaleDateString("pt-BR", {month:"long", year:"numeric", timeZone:"UTC"});
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function addMeses(ym, n){
    var p = ym.split("-"), m0 = (+p[1]-1) + n;
    var y = +p[0] + Math.floor(m0/12), m = ((m0%12)+12)%12;
    return y + "-" + String(m+1).padStart(2,"0");
  }
  function diasDoMes(ym){ var p = ym.split("-"); return new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate(); }
  function repPorId(id){ return state.reps.find(function(x){return x.id===id;}); }

  function folgaDatas(f){
    return (f.tipo==="troca" ? [f.dataFolga, f.dataTrabalho] : [f.data, f.dataFim||f.data]).filter(isoOk).sort();
  }
  function folgaIni(f){ return folgaDatas(f)[0] || ""; }
  function folgaFim(f){ var d = folgaDatas(f); return d[d.length-1] || ""; }

  // Por que um dia não muda nada (ou "" se muda).
  function motivoSemEfeito(r, iso, base){
    var n = r.nome;
    if(base==="folga") return n+" já está de folga em "+diaMes(iso)+" pela escala";
    if(base==="ferias") return n+" está de férias em "+diaMes(iso);
    if(base==="licenca") return n+" está de licença em "+diaMes(iso);
    if(base==="afastado") return n+" está afastado(a) em "+diaMes(iso);
    return n+" já trabalha em "+diaMes(iso)+" pela escala";
  }

  // Lê o formulário.
  function folgaLerForm(){
    var g = function(id){ return document.getElementById(id).value; };
    return {tipo: g("folgaTipo")==="troca" ? "troca" : "banco", repId:g("folgaRep"), data:g("folgaData"), dataFim:g("folgaDataFim"),
            trabalha:g("folgaTrabalha"), folgaEm:g("folgaFolgaEm"), obs:g("folgaObs").trim()};
  }
  // Avalia o agendamento contra a escala de hoje (ignorando o que está sendo editado) e monta a prévia do impacto.
  function folgaAvaliar(d){
    var res = {ok:false, erro:"", incompleto:false, linhas:[], entry:null};
    var r = repPorId(d.repId);
    if(!r){ res.erro = "Escolha a pessoa."; res.incompleto = true; return res; }
    folgaIgnorar = editing.folga || "";
    try{
      var i, iso, base, antes;
      if(d.tipo==="banco"){
        if(!isoOk(d.data)){ res.erro = "Informe a data da folga."; res.incompleto = true; return res; }
        var fim = isoOk(d.dataFim) ? d.dataFim : d.data;
        if(fim < d.data){ res.erro = "A data final não pode ser antes da data inicial."; return res; }
        var n = diasEntre(d.data, fim);
        if(n>31){ res.erro = "O período pode ter no máximo 31 dias."; return res; }
        var ef = 0, motivos = [];
        for(i=0;i<n;i++){
          iso = Cal.addDays(d.data, i); base = baseStatus(r, iso);
          if(base==="ativo"){
            if(ajusteAplicado(r, iso, "ativo")){
              motivos.push(r.nome+" já tem agendamento em "+diaMes(iso));
              res.linhas.push({iso:iso, cls:"mute", txt:"já tem agendamento — sem efeito"});
            }else{
              ef++; antes = contagemDia(iso).total;
              res.linhas.push({iso:iso, cls:"ok", antes:antes, depois:antes-1, rot:"folga"});
            }
          }else{
            motivos.push(motivoSemEfeito(r, iso, base));
            res.linhas.push({iso:iso, cls:"mute", txt:(base==="folga" ? "já é folga pela escala" : STATUS_LABEL[base].toLowerCase())+" — sem efeito"});
          }
        }
        if(!ef){
          res.erro = n===1 ? "Sem efeito: "+motivos[0]+"." : "Nenhum dia do período muda a contagem: "+motivos.slice(0,2).join("; ")+(motivos.length>2?"…":"")+".";
          return res;
        }
        res.ok = true;
        res.entry = {tipo:"banco", repId:r.id, data:d.data, dataFim: fim!==d.data ? fim : "", obs:d.obs};
      }else{
        if(!isoOk(d.trabalha) || !isoOk(d.folgaEm)){ res.erro = "Informe os dois dias da troca."; res.incompleto = true; return res; }
        if(d.trabalha===d.folgaEm){ res.erro = "Os dois dias da troca precisam ser diferentes."; return res; }
        var bT = baseStatus(r, d.trabalha), bF = baseStatus(r, d.folgaEm), erros = [];
        if(bT!=="folga") erros.push(motivoSemEfeito(r, d.trabalha, bT)+(bT==="ativo" ? " — escolha um dia que seria folga" : ""));
        else if(ajusteAplicado(r, d.trabalha, "folga")) erros.push(r.nome+" já tem agendamento em "+diaMes(d.trabalha));
        if(bF!=="ativo") erros.push(motivoSemEfeito(r, d.folgaEm, bF)+(bF==="folga" ? " — escolha um dia que seria de trabalho" : ""));
        else if(ajusteAplicado(r, d.folgaEm, "ativo")) erros.push(r.nome+" já tem agendamento em "+diaMes(d.folgaEm));
        var okT = !(bT!=="folga" || ajusteAplicado(r, d.trabalha, "folga")), okF = !(bF!=="ativo" || ajusteAplicado(r, d.folgaEm, "ativo"));
        if(okT){ antes = contagemDia(d.trabalha).total; res.linhas.push({iso:d.trabalha, cls:"ok", antes:antes, depois:antes+1, rot:"trabalha"}); }
        if(okF){ antes = contagemDia(d.folgaEm).total; res.linhas.push({iso:d.folgaEm, cls:"ok", antes:antes, depois:antes-1, rot:"folga"}); }
        if(erros.length){ res.erro = erros.join(". ")+"."; return res; }
        res.ok = true;
        res.entry = {tipo:"troca", repId:r.id, dataTrabalho:d.trabalha, dataFolga:d.folgaEm, obs:d.obs};
      }
    }finally{
      folgaIgnorar = "";
    }
    return res;
  }

  function folgaPreview(){
    var box = document.getElementById("folgaPreview");
    var d = folgaLerForm(), av = folgaAvaliar(d), html = "";
    if(av.linhas.length){
      var max = 8, mostra = av.linhas.slice(0, max);
      html = mostra.map(function(l){
        if(l.cls==="ok"){
          var rot = l.rot==="trabalha" ? "Trabalha" : "Folga";
          return '<div class="fp-line ok"><b>'+fmtDate(l.iso)+'</b> <span>'+esc(diaSemana(l.iso))+'</span> · '+rot+' · pessoas trabalhando: '+l.antes+' → <b>'+l.depois+'</b></div>';
        }
        return '<div class="fp-line mute"><b>'+fmtDate(l.iso)+'</b> <span>'+esc(diaSemana(l.iso))+'</span> · '+esc(l.txt)+'</div>';
      }).join("");
      if(av.linhas.length>max) html += '<div class="fp-line mute">… e mais '+(av.linhas.length-max)+' dia(s)</div>';
    }else if(av.incompleto){
      html = '<div class="fp-line mute">'+(d.tipo==="banco" ? "Escolha a pessoa e a data para ver quantas pessoas trabalham no dia." : "Escolha a pessoa e os dois dias para ver o impacto na contagem.")+'</div>';
    }
    // antes de a pessoa mexer no formulário o aviso fica discreto (a data de hoje vem preenchida por padrão)
    if(av.erro && !av.incompleto) html += '<div class="fp-line '+(folgaTocado ? 'bad' : 'mute')+'">'+esc(av.erro)+'</div>';
    box.innerHTML = html;
  }
  function folgaFormMudou(){
    var troca = document.getElementById("folgaTipo").value==="troca";
    document.querySelectorAll("[data-folga]").forEach(function(el){
      el.style.display = (el.dataset.folga==="troca")===troca ? "" : "none";
    });
    clearFormError("folgaFormError");
    folgaPreview();
  }
  function resetFolgaForm(){
    editing.folga = null;
    document.getElementById("folgaFormTitle").textContent = "Agendar folga";
    document.getElementById("folgaTipo").value = "banco";
    document.getElementById("folgaData").value = todayISO();
    document.getElementById("folgaDataFim").value = "";
    document.getElementById("folgaTrabalha").value = "";
    document.getElementById("folgaFolgaEm").value = "";
    document.getElementById("folgaObs").value = "";
    document.getElementById("folgaSaveBtn").textContent = "Agendar";
    document.getElementById("folgaCancelBtn").style.display = "none";
    folgaTocado = false;
    folgaFormMudou();
  }
  function startFolgaEdit(f){
    if(!f) return;
    var r = repPorId(f.repId);
    if(!r){ showFormError("folgaFormError", "Esse agendamento é de uma pessoa que não está mais cadastrada. Exclua-o."); return; }
    editing.folga = f.id;
    document.getElementById("folgaFormTitle").textContent = "Editar agendamento";
    document.getElementById("folgaTipo").value = f.tipo==="troca" ? "troca" : "banco";
    fillFolgaRepSelect();
    document.getElementById("folgaRep").value = f.repId;
    document.getElementById("folgaData").value = f.data || "";
    document.getElementById("folgaDataFim").value = f.dataFim || "";
    document.getElementById("folgaTrabalha").value = f.dataTrabalho || "";
    document.getElementById("folgaFolgaEm").value = f.dataFolga || "";
    document.getElementById("folgaObs").value = f.obs || "";
    document.getElementById("folgaSaveBtn").textContent = "Salvar";
    document.getElementById("folgaCancelBtn").style.display = "inline-block";
    folgaTocado = true;
    folgaFormMudou();
    var painel = document.getElementById("folgaFormPanel");
    if(painel.scrollIntoView) painel.scrollIntoView({block:"nearest"});
  }
  function saveFolga(){
    var av = folgaAvaliar(folgaLerForm());
    if(!av.ok){ showFormError("folgaFormError", av.erro || "Revise os dados."); return; }
    clearFormError("folgaFormError");
    var entry = av.entry;
    if(!Array.isArray(state.folgas)) state.folgas = [];
    if(editing.folga){
      var i = state.folgas.findIndex(function(x){return x.id===editing.folga;});
      entry.id = editing.folga;
      if(i>-1) state.folgas[i] = entry; else state.folgas.push(entry);
    }else{
      entry.id = uid();
      state.folgas.push(entry);
    }
    folgasMes = folgaIni(entry).slice(0,7) || folgasMes; // mostra o mês do agendamento para ver o efeito
    resetFolgaForm();
    scheduleSave();
    renderAll();
  }
  function deleteFolga(id){
    state.folgas = (state.folgas||[]).filter(function(f){return f.id!==id;});
    if(editing.folga===id) resetFolgaForm();
    scheduleSave();
    renderAll();
  }

  function fillFolgaRepSelect(){
    var sel = document.getElementById("folgaRep"), atual = sel.value;
    var lista = sortReps(state.reps);
    if(!lista.length){ sel.innerHTML = '<option value="">Nenhum rep cadastrado</option>'; return; }
    sel.innerHTML = lista.map(function(r){
      var ps = repEhPS(r) ? ' · '+(areaEhPS(areaDe(r)) ? areaNome(areaDe(r)) : 'PS') : '';
      return '<option value="'+esc(r.id)+'">'+esc(r.nome)+(r.escala?' · Escala '+esc(r.escala):'')+esc(ps)+'</option>';
    }).join("");
    if(atual && lista.some(function(r){return r.id===atual;})) sel.value = atual;
  }
  function fillFolgaFiltroRep(){
    var sel = document.getElementById("folgaFiltroRep");
    var lista = sortReps(state.reps);
    if(folgaFiltroRep && !lista.some(function(r){return r.id===folgaFiltroRep;})) folgaFiltroRep = "";
    sel.innerHTML = '<option value="">Todas as pessoas</option>' + lista.map(function(r){ return '<option value="'+esc(r.id)+'">'+esc(r.nome)+'</option>'; }).join("");
    sel.value = folgaFiltroRep;
    document.getElementById("folgaFiltroPer").value = folgaFiltroPer;
  }

  // O que o agendamento está fazendo hoje na contagem (tags + detalhe).
  function folgaEfeito(f){
    var r = repPorId(f.repId), tags = [], det = [];
    if(!r) return {tags:[{cls:"tag-rust", txt:"pessoa removida"}], det:[]};
    if(f.tipo==="troca"){
      if(!isoOk(f.dataTrabalho) || !isoOk(f.dataFolga)) return {tags:[{cls:"tag-rust", txt:"datas inválidas"}], det:[]};
      var bT = baseStatus(r, f.dataTrabalho), bF = baseStatus(r, f.dataFolga);
      var aT = bT==="folga" ? ajusteAplicado(r, f.dataTrabalho, "folga") : null, aF = bF==="ativo" ? ajusteAplicado(r, f.dataFolga, "ativo") : null;
      var okT = !!aT && aT.f===f, okF = !!aF && aF.f===f;
      tags.push({cls: okT?"tag-green":"tag-rust", txt: okT ? "+1 trabalha em "+diaMes(f.dataTrabalho) : "trabalha: sem efeito"});
      tags.push({cls: okF?"tag-green":"tag-rust", txt: okF ? "−1 folga em "+diaMes(f.dataFolga) : "folga: sem efeito"});
      if(!okT) det.push(aT ? "dia de trabalho já coberto por outro agendamento" : motivoSemEfeito(r, f.dataTrabalho, bT));
      if(!okF) det.push(aF ? "folga já coberta por outro agendamento" : motivoSemEfeito(r, f.dataFolga, bF));
      return {tags:tags, det:det};
    }
    var d0 = f.data, fimOk = !f.dataFim || isoOk(f.dataFim), n = (isoOk(d0) && fimOk) ? diasEntre(d0, f.dataFim||d0) : 0, ef = 0, ja = 0, aus = 0, cob = 0;
    if(!(n>0)) return {tags:[{cls:"tag-rust", txt:"datas inválidas"}], det:[]};
    for(var i=0;i<n && i<400;i++){
      var iso = Cal.addDays(d0, i), base = baseStatus(r, iso);
      if(base==="ativo"){ var aj = ajusteAplicado(r, iso, "ativo"); if(aj && aj.f===f) ef++; else cob++; }
      else if(base==="folga") ja++; else aus++;
    }
    if(ef===n && n>0) tags.push({cls:"tag-green", txt:"−1 em "+(n===1 ? "1 dia" : n+" dias")});
    else if(ef===0) tags.push({cls:"tag-rust", txt:"sem efeito"});
    else tags.push({cls:"tag-amber", txt:"−1 em "+ef+" de "+n+" dias"});
    if(ja) det.push("já é folga pela escala em "+plural(ja, "dia", "dias"));
    if(aus) det.push("ausente (férias/licença/afastado) em "+plural(aus, "dia", "dias"));
    if(cob) det.push("já agendado em outro registro em "+plural(cob, "dia", "dias"));
    return {tags:tags, det:det};
  }
  function folgaDatasTexto(f){
    if(f.tipo==="troca") return 'Trabalha <b>'+(isoOk(f.dataTrabalho)?diaMes(f.dataTrabalho):"—")+'</b> → Folga <b>'+(isoOk(f.dataFolga)?diaMes(f.dataFolga):"—")+'</b>';
    if(!isoOk(f.data)) return "—";
    if(isoOk(f.dataFim) && f.dataFim!==f.data) return '<b>'+diaMes(f.data)+'</b> a <b>'+fmtDate(f.dataFim)+'</b> · '+diasEntre(f.data, f.dataFim)+' dias';
    return '<b>'+fmtDate(f.data)+'</b> · '+esc(diaSemana(f.data));
  }

  function renderFolgas(){
    var hoje = todayISO();
    if(!/^\d{4}-\d{2}$/.test(folgasMes)) folgasMes = hoje.slice(0,7);
    var ym = folgasMes, nd = diasDoMes(ym);
    document.getElementById("folgasMeta").textContent = (state.folgas||[]).length + " agendamento(s)";
    fillFolgaRepSelect();
    fillFolgaFiltroRep();
    var inpMes = document.getElementById("folgasMesInput");
    if(inpMes.value!==ym) inpMes.value = ym;

    // ----- pessoas trabalhando por dia -----
    var equipe = state.reps.length;
    var wrap = document.getElementById("folgasDias"), strip = document.getElementById("folgasStrip");
    if(!equipe){
      wrap.innerHTML = '<div class="hint" style="padding:10px 2px;">Cadastre reps na aba Equipe para ver quantas pessoas trabalham em cada dia.</div>';
      strip.innerHTML = "";
    }else{
      var dias = [], nBanco = 0, nTF = 0, nTT = 0, menor = null, maior = null;
      for(var d=1; d<=nd; d++){
        var iso = ym+"-"+String(d).padStart(2,"0"), cd = contagemDia(iso);
        dias.push(cd);
        nBanco += cd.banco.length; nTF += cd.trocaFolga.length; nTT += cd.trocaTrab.length;
        if(menor===null || cd.total<menor.total) menor = cd;
        if(maior===null || cd.total>maior.total) maior = cd;
      }
      strip.innerHTML =
        stripCell("Equipe", equipe, "", "teal", areasDoDia(dias[0]).map(function(ar){ return AREA_CURTA[ar.key]+" "+ar.cad; }).join(" · ")) +
        stripCell("Folgas extras", nBanco+nTF, nBanco+nTF ? "rust" : "", "rust", "banco "+nBanco+" · troca "+nTF+" (pessoa-dias)") +
        stripCell("Trabalham em troca", nTT, nTT ? "green" : "", "green", "dias de trabalho extra") +
        stripCell("Menor dia", menor.total, "amber", "amber", diaSemana(menor.iso)+" "+diaMes(menor.iso)) +
        stripCell("Maior dia", maior.total, "teal", "teal", diaSemana(maior.iso)+" "+diaMes(maior.iso));
      function chips(lista, rotulo){
        return lista.map(function(x){
          return '<span class="fd-chip" title="'+esc((x.f.obs ? x.f.obs+" · " : "")+rotulo)+'">'+esc(x.r.nome)+' <i>'+rotulo+'</i></span>';
        }).join("");
      }
      var linhas = dias.map(function(cd){
        var dl = cd.total - cd.base, neg = cd.banco.length + cd.trocaFolga.length, pos = cd.trocaTrab.length;
        var pct = function(v){ return Math.max(0, Math.min(100, v/equipe*100)).toFixed(1)+"%"; };
        var barra = '<div class="fd-bar" title="Total '+cd.total+' de '+equipe+'"><i class="fd-ok" style="width:'+pct(Math.min(cd.total, cd.base))+'"></i>' +
          (dl<0 ? '<i class="fd-lost" style="width:'+pct(cd.base-cd.total)+'"></i>' : '') +
          (dl>0 ? '<i class="fd-gain" style="width:'+pct(cd.total-cd.base)+'"></i>' : '') + '</div>';
        return '<tr class="fd-row'+(cd.iso===hoje?' fd-hoje':'')+'">' +
          '<td class="fd-dia"><b>'+cd.iso.slice(8)+'</b> <span>'+esc(diaSemana(cd.iso))+'</span>'+(cd.iso===hoje?' <em>hoje</em>':'')+'</td>' +
          '<td class="num fd-n">'+cd.base+'</td>' +
          '<td class="fd-neg">'+(neg ? '<b>−'+neg+'</b> '+chips(cd.banco,"banco")+chips(cd.trocaFolga,"troca") : '<span class="fd-nada">—</span>')+'</td>' +
          '<td class="fd-pos">'+(pos ? '<b>+'+pos+'</b> '+chips(cd.trocaTrab,"troca") : '<span class="fd-nada">—</span>')+'</td>' +
          '<td class="fd-total"><div class="fd-tot-n"><b>'+cd.total+'</b>'+(dl ? ' <small class="'+(dl<0?'neg':'pos')+'">'+(dl<0?'−':'+')+Math.abs(dl)+'</small>' : '')+'</div>'+barra+
            '<div class="fd-areas" title="Presentes por área: '+esc(areasDoDia(cd).map(function(ar){ return areaNome(ar.key)+" "+ar.total; }).join(" · "))+'">'+
              areasDoDia(cd).map(function(ar){ return '<span class="'+(areaEhPS(ar.key)?'ps':'rep')+'">'+AREA_CURTA[ar.key]+' <b>'+ar.total+'</b></span>'; }).join("")+'</div></td>' +
        '</tr>';
      }).join("");
      wrap.innerHTML = '<table class="fd-table"><thead><tr><th>Dia</th><th title="Pessoas com dia de trabalho pela escala (sem férias, licença e afastados)">Pela escala</th><th>Folgas extras</th><th>Trabalham em troca</th><th>Pessoas trabalhando <span class="fd-th-sub">(por área)</span></th></tr></thead><tbody>'+linhas+'</tbody></table>';
    }
    document.getElementById("folgasLegenda").innerHTML =
      '<span class="hint"><b>'+esc(mesLabel(ym))+'</b> · Pela escala = reps com dia de trabalho (já sem férias/licença/afastados) · − folga extra (banco de horas ou troca) · + trabalha em dia de folga (troca) · PS incluídos, separados por área (Inv, Qual, PS Op, PS ICQA)</span>';
    var hint = document.getElementById("folgasHint");
    if(Cal.foraDosCalendarios(ym+"-01") || Cal.foraDosCalendarios(ym+"-"+String(nd).padStart(2,"0"))){
      hint.textContent = "Mês fora dos calendários enviados (set–dez/2026): a escala é projetada pelo ciclo de 52 semanas deduzido deles.";
      hint.style.display = "block";
    }else{
      hint.style.display = "none";
    }

    // ----- lista de agendamentos -----
    var todos = (state.folgas||[]).filter(function(f){
      if(folgaFiltroRep && f.repId!==folgaFiltroRep) return false;
      var ds = folgaDatas(f);
      if(!ds.length) return folgaFiltroPer==="todas";
      if(folgaFiltroPer==="mes") return f.tipo==="troca" ? ds.some(function(x){return x.slice(0,7)===ym;}) : (ds[0].slice(0,7)<=ym && ds[ds.length-1].slice(0,7)>=ym);
      if(folgaFiltroPer==="futuras") return ds[ds.length-1]>=hoje;
      return true;
    }).sort(function(a,b){ return folgaIni(a).localeCompare(folgaIni(b)) || repName(a.repId).localeCompare(repName(b.repId), "pt-BR"); });
    var body = document.getElementById("folgasLista"), vazio = document.getElementById("folgasEmpty");
    if(!todos.length){
      body.innerHTML = "";
      vazio.style.display = "block";
      vazio.innerHTML = (state.folgas||[]).length ? '<b>Nenhum agendamento nesse filtro</b>Mude o mês ou o filtro acima para ver os demais.' : '<b>Nenhuma folga agendada</b>Use o formulário acima para agendar uma folga de banco de horas ou uma troca de folga.';
    }else{
      vazio.style.display = "none";
      body.innerHTML = todos.map(function(f){
       try{
        var r = repPorId(f.repId), ef = folgaEfeito(f), passado = folgaFim(f) && folgaFim(f)<hoje;
        var nome = r ? '<span class="esc-dot" style="background:'+(ESC_COR[r.escala]||"var(--text-faint)")+'"></span>'+esc(r.nome) : '<span class="hint">(rep removido)</span>';
        return '<tr class="'+(passado?'fd-passado':'')+'">' +
          '<td>'+nome+'</td>' +
          '<td><span class="tag '+(f.tipo==="troca"?'tag-amber':'tag-teal')+'">'+(f.tipo==="troca"?'Troca de folga':'Banco de horas')+'</span></td>' +
          '<td class="num">'+folgaDatasTexto(f)+'</td>' +
          '<td>'+ef.tags.map(function(t){return '<span class="tag '+t.cls+'">'+esc(t.txt)+'</span>';}).join(" ")+(ef.det.length?'<div class="hint">'+esc(ef.det.join(" · "))+'</div>':'')+'</td>' +
          '<td>'+esc(f.obs||"")+'</td>' +
          '<td class="row-actions">' +
            '<button class="btn-ghost" data-act="edit-folga" data-id="'+esc(f.id)+'">Editar</button>' +
            '<button class="btn-ghost" data-act="del-folga" data-id="'+esc(f.id)+'">Excluir</button>' +
          '</td>' +
        '</tr>';
       }catch(e){
        // um registro com dados estranhos não pode apagar a lista inteira
        return '<tr><td colspan="5"><span class="hint">Registro com dados inválidos.</span></td><td class="row-actions"><button class="btn-ghost" data-act="del-folga" data-id="'+esc(f && f.id)+'">Excluir</button></td></tr>';
       }
      }).join("");
    }
    folgaPreview();
  }

  // ---------- render all ----------
  function renderAll(){
    renderEquipe();
    renderDim();
    renderTasks();
    renderFolgas();
    renderPontos();
    renderLost();
  }

  // ---------- events ----------
  function pendingDelete(btn, doDelete, id){
    if(btn.dataset.confirm){
      doDelete(id);
      return;
    }
    btn.dataset.confirm = "1";
    btn.textContent = "Confirmar?";
    btn.classList.add("btn-danger-confirm");
    setTimeout(function(){
      if(btn.isConnected){
        btn.dataset.confirm = "";
        btn.textContent = "Excluir";
        btn.classList.remove("btn-danger-confirm");
      }
    }, 2500);
  }

  // Botão de duas etapas (sem confirm(), que o iframe do Grid bloqueia).
  function pendingAction(btn, fn){
    function reset(){
      btn.dataset.confirm = "";
      if(btn.dataset.orig) btn.textContent = btn.dataset.orig;
      btn.classList.remove("btn-danger-confirm");
    }
    if(btn.dataset.confirm){ reset(); fn(); return; }
    btn.dataset.orig = btn.textContent;
    btn.dataset.confirm = "1";
    btn.textContent = "Confirmar?";
    btn.classList.add("btn-danger-confirm");
    setTimeout(function(){ if(btn.isConnected && btn.dataset.confirm) reset(); }, 2500);
  }
  function handleDimAct(act, btn){
    var t, r;
    if(act==="dim-view"){ dimView = btn.dataset.mode==="matriz" ? "matriz" : "cards"; renderTasks(); }
    else if(act==="fill-skills"){ fillBySkills(); }
    else if(act==="undo"){ undoMarcacoes(); }
    else if(act==="clear-all"){ pendingAction(btn, clearAll); }
    else if(act==="task-fill"){ t = state.tasks.find(function(x){return x.id===btn.dataset.id;}); if(t) fillTask(t, btn.dataset.mode); }
    else if(act==="task-clear"){ t = state.tasks.find(function(x){return x.id===btn.dataset.id;}); if(t) pendingAction(btn, function(){ clearTask(t); }); }
    else if(act==="mx-col"){ t = state.tasks.find(function(x){return x.id===btn.dataset.id;}); if(t) toggleMatrizCol(t); }
    else if(act==="mx-row"){ r = state.reps.find(function(x){return x.id===btn.dataset.id;}); if(r && !repEhPS(r)) toggleMatrizRow(r); }
    else if(act==="mx-cell"){ toggleTaskRep(btn.dataset.task, btn.dataset.rep); }
    else return false;
    return true;
  }

  document.addEventListener("click", function(e){
    var btn = e.target.closest("[data-act]");
    if(!btn) return;
    var act = btn.dataset.act, id = btn.dataset.id;
    if(act==="dim-dia"){ setDimDate(btn.dataset.iso); return; }
    if(handleDimAct(act, btn)) return;
    if(act==="ficha"){ openFicha(id); }
    else if(act==="close-ficha"){ closeFicha(); }
    else if(act==="edit-rep"){ startRepEdit(state.reps.find(function(r){return r.id===id;})); }
    else if(act==="del-rep"){ pendingDelete(btn, deleteRep, id); }
    else if(act==="edit-task"){ startTaskEdit(state.tasks.find(function(t){return t.id===id;})); }
    else if(act==="del-task"){ pendingDelete(btn, deleteTask, id); }
    else if(act==="edit-ponto"){ startPontoEdit(state.pontos.find(function(p){return p.id===id;})); }
    else if(act==="del-ponto"){ pendingDelete(btn, deletePonto, id); }
    else if(act==="edit-lost"){ startLostEdit(state.lost.find(function(l){return l.id===id;})); }
    else if(act==="del-lost"){ pendingDelete(btn, deleteLost, id); }
    else if(act==="edit-folga"){ startFolgaEdit((state.folgas||[]).find(function(f){return f.id===id;})); }
    else if(act==="del-folga"){ pendingDelete(btn, deleteFolga, id); }
    else if(act==="backup-open"){ backupAbrir(); }
    else if(act==="backup-close"){ backupFechar(); }
    else if(act==="backup-gerar"){ backupGerar(); }
    else if(act==="backup-baixar"){ backupBaixar(); }
    else if(act==="backup-restaurar"){ pendingAction(btn, backupRestaurar); }
  });

  document.getElementById("fichaOverlay").addEventListener("click", function(e){ if(e.target.id==="fichaOverlay") closeFicha(); });
  document.addEventListener("keydown", function(e){ if(e.key==="Escape") closeFicha(); });

  document.addEventListener("change", function(e){
    if(e.target.id==="repFiltroClasse"){ renderEquipe(); return; }
    if(e.target.classList.contains("task-rep-toggle")){
      toggleTaskRep(e.target.dataset.task, e.target.dataset.rep);
    }
  });

  function setDimDate(iso){
    if(!iso) return;
    dimDate = iso;
    dimFollow = (iso===todayISO());
    renderDim();
    renderTasks();
  }
  document.getElementById("dimPrev").addEventListener("click", function(){ setDimDate(Cal.addDays(dimDate, -1)); });
  document.getElementById("dimNext").addEventListener("click", function(){ setDimDate(Cal.addDays(dimDate, 1)); });
  document.getElementById("dimHoje").addEventListener("click", function(){ setDimDate(todayISO()); });
  document.getElementById("dimData").addEventListener("change", function(e){ setDimDate(e.target.value); });
  document.getElementById("dimFiltro").addEventListener("change", function(e){ dimFiltro = e.target.value; renderTasks(); });
  document.getElementById("escalaModo").addEventListener("change", function(e){
    state.escalaModo = e.target.value==="trabalho" ? "trabalho" : "folga";
    scheduleSave();
    renderAll();
  });
  ["repStatus","repAfastInicio","repAfastDias","repClasse","repCategoria"].forEach(function(id){
    document.getElementById(id).addEventListener("input", updatePeriodUI);
    document.getElementById(id).addEventListener("change", updatePeriodUI);
  });

  document.getElementById("taskNome").addEventListener("input", syncTaskAreaLock);
  document.getElementById("repSaveBtn").addEventListener("click", saveRep);
  document.getElementById("repCancelBtn").addEventListener("click", resetRepForm);
  document.getElementById("taskSaveBtn").addEventListener("click", saveTask);
  document.getElementById("taskCancelBtn").addEventListener("click", resetTaskForm);
  document.getElementById("pontoSaveBtn").addEventListener("click", savePonto);
  document.getElementById("pontoCancelBtn").addEventListener("click", resetPontoForm);
  document.getElementById("lostSaveBtn").addEventListener("click", saveLost);
  document.getElementById("lostCancelBtn").addEventListener("click", resetLostForm);

  ["folgaTipo","folgaRep","folgaData","folgaDataFim","folgaTrabalha","folgaFolgaEm","folgaObs"].forEach(function(id){
    document.getElementById(id).addEventListener("input", function(){ folgaTocado = true; folgaFormMudou(); });
    document.getElementById(id).addEventListener("change", function(){ folgaTocado = true; folgaFormMudou(); });
  });
  document.getElementById("folgaSaveBtn").addEventListener("click", saveFolga);
  document.getElementById("folgaCancelBtn").addEventListener("click", resetFolgaForm);
  function setFolgasMes(ym){ if(/^\d{4}-\d{2}$/.test(ym)){ folgasMes = ym; renderFolgas(); } }
  document.getElementById("folgasPrev").addEventListener("click", function(){ setFolgasMes(addMeses(folgasMes || todayISO().slice(0,7), -1)); });
  document.getElementById("folgasNext").addEventListener("click", function(){ setFolgasMes(addMeses(folgasMes || todayISO().slice(0,7), 1)); });
  document.getElementById("folgasHoje").addEventListener("click", function(){ setFolgasMes(todayISO().slice(0,7)); });
  document.getElementById("folgasMesInput").addEventListener("change", function(e){ setFolgasMes(e.target.value); });
  document.getElementById("folgaFiltroRep").addEventListener("change", function(e){ folgaFiltroRep = e.target.value; renderFolgas(); });
  document.getElementById("folgaFiltroPer").addEventListener("change", function(e){ folgaFiltroPer = e.target.value; renderFolgas(); });

  document.getElementById("pontoCategoria").addEventListener("change", function(){
    renderPontoRepsChecklist(editing.ponto ? getCheckedPontoReps() : []);
  });

  document.getElementById("teamNameInput").addEventListener("input", function(e){
    state.teamName = e.target.value;
    scheduleSave();
  });

  // ---------- init ----------
  dimDate = todayISO();
  buildNav();
  buildTimeSel();
  showView(VIEWS[0].key);
  resetRepForm();
  resetTaskForm();
  resetPontoForm();
  resetLostForm();
  resetFolgaForm();
  tickClock();
  setInterval(tickClock, 1000);
  loadAndRender();

})();