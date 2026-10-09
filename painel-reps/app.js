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
    {key:"harley", nome:"Time Harley", areaFixa:{}, views:["equipe","dimensionamento","calendario"],
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
    {key:"calendario", label:"Calendário"},
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
    if(feriasDe(r, iso)) return "ferias"; // férias agendadas no Calendário
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
  //               { id, repId, tipo:"ferias", data, dias, obs } → férias de `data` por `dias` dias (fim = data + dias − 1)
  // O efeito é sempre calculado sobre a situação pela escala (nunca soma/subtrai "no escuro"): folga extra só
  // vale em dia de trabalho e a troca só vale em dia de folga; fora disso o agendamento fica "sem efeito".
  var folgaIgnorar = ""; // id ignorado ao simular (edição/prévia no formulário)
  // Férias agendadas: fim inclusivo = início + dias − 1 (mesma regra das férias do cadastro do rep).
  function feriasFim(f){
    var n = Math.floor(Number(f && f.dias));
    return (f && isoOk(f.data) && n>=1) ? Cal.addDays(f.data, n-1) : "";
  }
  function feriasDe(r, iso){
    var L = state.folgas || [];
    for(var i=0;i<L.length;i++){
      var f = L[i];
      if(!f || f.tipo!=="ferias" || f.repId!==r.id || f.id===folgaIgnorar) continue;
      var fim = feriasFim(f);
      if(fim && iso>=f.data && iso<=fim) return f;
    }
    return null;
  }
  function ajusteAplicado(r, iso, base){
    var L = state.folgas || [];
    for(var i=0;i<L.length;i++){
      var f = L[i], tipo = null;
      if(!f || f.repId!==r.id || f.id===folgaIgnorar) continue;
      if(f.tipo==="troca"){
        if(iso===f.dataFolga) tipo = "troca-folga";
        else if(iso===f.dataTrabalho) tipo = "troca-trabalho";
      }else if(f.tipo==="banco" && f.data && iso>=f.data && iso<=(f.dataFim||f.data)){
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
    var fim = "";
    if(st==="ferias"){ var fa = feriasDe(r, iso); fim = fa ? feriasFim(fa) : afastFim(r); }
    else if(st==="licenca"){ fim = afastFim(r); }
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
  var AREA_MINI = {inventario:"Inv", qualidade:"Qual", ps_operacoes:"Op", ps_icqa:"ICQA", outra:"Out"}; // rótulo dos blocos pequenos do calendário
  function areaDe(r){ return AREAS_PRESENCA.indexOf(r.categoria)>-1 ? r.categoria : "outra"; }
  function areaNome(k){ return k==="outra" ? "Sem área" : (CATEGORIA_LABEL[k]||k); }
  function areaEhPS(k){ return k.indexOf("ps_")===0; }
  // Cada área tem uma cor própria em todo o painel (classe a-inv, a-qual, a-psop, a-psicqa, a-outra).
  var AREA_ID = {inventario:"inv", qualidade:"qual", ps_operacoes:"psop", ps_icqa:"psicqa"};
  function areaCls(k){ return "a-"+(AREA_ID[k]||"outra"); }
  function areaCor(k){ return "var(--"+areaCls(k)+")"; }
  // Pessoas em um dia, TODAS as classes (rep e PS), com a quebra por Área cadastrada:
  // pela escala, folgas extras, trocas e total. Invariante: total = base − banco − trocaFolga + trocaTrab.
  // areas[k] = {key, cad (cadastrados), ps (quantos são PS), base, total (presentes)}.
  function contagemDia(iso){
    var c = {iso:iso, base:0, total:0, banco:[], trocaFolga:[], trocaTrab:[], ausentes:[], areas:{}};
    sortReps(state.reps).forEach(function(r){
      var k = areaDe(r), a = c.areas[k] || (c.areas[k] = {key:k, cad:0, ps:0, base:0, total:0});
      a.cad++; if(repEhPS(r)) a.ps++;
      var b = baseStatus(r, iso);
      var ex = (b==="ativo" || b==="folga") ? ajusteAplicado(r, iso, b) : null;
      if(b==="ativo"){ c.base++; a.base++; }
      if(b==="ferias" || b==="licenca") c.ausentes.push({r:r, tipo:b});
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

  // ---------- feedback visual: aviso rápido, estado da gravação e destaque do que mudou ----------
  var toastTimer = null;
  function toast(msg, tipo){
    var el = document.getElementById("toast");
    if(!el) return;
    el.textContent = msg;
    el.className = "toast show" + (tipo ? " "+tipo : "");
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); }, 2800);
  }
  var saveEstadoTimer = null;
  function setSaveState(s){ // "pend" (salvando) | "ok" | "err" | "idle" (escondido)
    var el = document.getElementById("saveState");
    if(!el) return;
    el.dataset.s = s;
    el.querySelector(".ss-txt").textContent = s==="pend" ? "Salvando…" : (s==="err" ? "Não salvo" : "Salvo");
    if(saveEstadoTimer){ clearTimeout(saveEstadoTimer); saveEstadoTimer = null; }
    if(s==="ok") saveEstadoTimer = setTimeout(function(){ el.dataset.s = "idle"; }, 4000);
  }
  function reduzMov(){ return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function alturaNav(){ var n = document.getElementById("subnav"); return n ? n.offsetHeight : 0; }
  // Rola até o item (se estiver fora da tela) e pisca para mostrar o que acabou de mudar.
  function destacar(chave, rolar){
    var el = null;
    try{ el = document.querySelector('[data-key="'+String(chave).replace(/["\\]/g, "\\$&")+'"]'); }catch(e){}
    if(!el) return;
    if(rolar){
      var r = el.getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if(r.top < alturaNav()+16 || r.bottom > vh-24) el.scrollIntoView({block:"center", behavior: reduzMov() ? "auto" : "smooth"});
    }
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }

  // ---------- formulários recolhíveis (mesmo padrão nas 5 abas) ----------
  // Abrem sozinhos só quando a lista está vazia (primeiro uso); depois valem a escolha da pessoa.
  // "Editar" abre o formulário e, ao salvar ou cancelar, ele volta a ficar como estava.
  var FORMS = {
    rep:   {painel:"repFormPanel",   foco:"repNome",    lista:function(){ return state.reps; }},
    task:  {painel:"taskFormPanel",  foco:"taskNome",   lista:function(){ return state.tasks; }},
    folga: {painel:"folgaFormPanel", foco:"folgaRep",   lista:function(){ return state.folgas||[]; }},
    ponto: {painel:"pontoFormPanel", foco:"pontoTexto", lista:function(){ return state.pontos; }},
    lost:  {painel:"lostFormPanel",  foco:"lostMu",     lista:function(){ return state.lost; }}
  };
  var formAberto = {}; // escolha atual de cada formulário (true = aberto); ausente = ainda não decidido
  var formAntes = {};  // como o formulário estava antes de abrir só para editar
  function aplicarForm(k){
    var p = document.getElementById(FORMS[k].painel);
    if(!p) return;
    var aberto = !!formAberto[k], b = p.querySelector(".form-head");
    p.classList.toggle("collapsed", !aberto);
    b.setAttribute("aria-expanded", aberto ? "true" : "false");
    b.querySelector(".fh-state").textContent = aberto ? "Ocultar" : "Abrir";
  }
  function aplicarForms(){ Object.keys(FORMS).forEach(aplicarForm); }
  function formPadrao(){
    Object.keys(FORMS).forEach(function(k){ if(formAberto[k]===undefined) formAberto[k] = FORMS[k].lista().length===0; });
    aplicarForms();
  }
  function abrirForm(k, foco){
    formAberto[k] = true; aplicarForm(k);
    if(!foco) return;
    var el = document.getElementById(FORMS[k].foco), p = document.getElementById(FORMS[k].painel);
    if(el && el.focus) el.focus({preventScroll:true});
    if(p && p.scrollIntoView){
      var rr = p.getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if(rr.top < alturaNav() || rr.top > vh-140) p.scrollIntoView({block:"start", behavior: reduzMov() ? "auto" : "smooth"});
    }
  }
  function alternarForm(k){
    if(formAberto[k]){ formAberto[k] = false; aplicarForm(k); }
    else abrirForm(k, true);
  }
  function abrirParaEditar(k){
    if(formAntes[k]===undefined) formAntes[k] = !!formAberto[k];
    abrirForm(k, true);
  }
  function fecharAposEditar(k){
    if(formAntes[k]===undefined) return;
    formAberto[k] = formAntes[k]; delete formAntes[k]; aplicarForm(k);
  }

  function scheduleSave(){
    if(saveTimer) clearTimeout(saveTimer);
    setSaveState("pend");
    saveTimer = setTimeout(function(){ saveTimer = null; persist(); }, 250);
  }
  var lido = false; // só grava depois de ter lido o estado do Grid com sucesso (senão sobrescreveria com vazio)
  function aviso(msg){
    var el = document.getElementById("avisoGrid");
    if(!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }
  var gravando = 0; // gravações em andamento (o "Salvo" só aparece quando não resta nenhuma)
  function persist(){
    if(!lido){ setSaveState("err"); aviso("Sem conexão com o Grid: a alteração NÃO foi salva. Aguarde a reconexão e repita."); return; }
    var contado = true;
    function fim(){ if(contado){ contado = false; gravando--; } }
    gravando++; setSaveState("pend");
    window.GRID.state.set(root, lastUpdatedAt).then(function(res){
      fim();
      lastUpdatedAt = res.updated_at;
      aviso("");
      if(!gravando && !saveTimer) setSaveState("ok");
    }).catch(function(err){
      fim();
      setSaveState("err");
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
    toast("Backup restaurado");
  }
  function trocarTime(key){
    if(key===timeAtual) return;
    timeAtual = key;
    dimUndo = null; dimMsg = "";
    limparFiltros();
    formAberto = {}; formAntes = {};
    usarDados(root);
    resetRepForm(); resetTaskForm(); resetPontoForm(); resetLostForm(); resetFolgaForm();
    formPadrao();
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
      document.body.classList.remove("is-loading");
      formPadrao();
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
  var VIEW_ICONS = {
    equipe: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c0-3.4 2.8-6 6.2-6s6.2 2.6 6.2 6"/><circle cx="17.4" cy="9.2" r="2.6"/><path d="M17.6 14.2c2.4.3 4.2 2.3 4.2 4.8"/></svg>',
    dimensionamento: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M14 17h6.5M17.2 13.7v6.6"/></svg>',
    calendario: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    pontos: '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17.5" rx="2.2"/><path d="M8 9.5l1.6 1.6L12.5 8M8 15.5l1.6 1.6 2.9-3M14.5 10h2.5M14.5 16h2.5"/></svg>',
    lost: '<svg viewBox="0 0 24 24"><path d="M12 3.5l9 16H3z"/><path d="M12 10v4.2M12 17.2v.1"/></svg>'
  };
  function buildNav(){
    var nav = document.getElementById("navList");
    nav.innerHTML = "";
    viewsDoTime().forEach(function(v){
      var el = document.createElement("button");
      var ativa = v.key===viewAtual;
      el.type = "button";
      el.className = "tab-item" + (ativa ? " active" : "");
      el.dataset.view = v.key;
      el.id = "tab-"+v.key;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-controls", "view-"+v.key);
      el.setAttribute("aria-selected", ativa ? "true" : "false");
      el.tabIndex = ativa ? 0 : -1;
      el.innerHTML = '<span class="tab-ico" aria-hidden="true">'+(VIEW_ICONS[v.key]||"")+'</span><span class="tab-label">'+v.label+'</span><span class="tab-badge" hidden></span>';
      el.addEventListener("click", function(){ showView(v.key); });
      nav.appendChild(el);
    });
    medirNav();
  }
  // Contadores nas abas: o que importa ver sem abrir a aba (pendências em âmbar).
  function renderNavBadges(){
    var hoje = todayISO();
    var semCob = state.tasks.filter(function(t){ return coberturaTarefa(t).sem; }).length;
    var pend = state.pontos.filter(function(p){ return p.status!=="concluido"; }).length;
    var agend = (state.folgas||[]).filter(function(f){ return f && typeof f==="object" && folgaFim(f) && folgaFim(f)>=hoje; }).length;
    var info = {
      equipe:{n:state.reps.length, tip:state.reps.length+" pessoa(s) cadastrada(s)"},
      dimensionamento:{n:state.tasks.length, warn:semCob>0, tip:state.tasks.length+" tarefa(s)"+(semCob ? " · "+semCob+" sem cobertura na data" : "")},
      calendario:{n:agend, tip:agend+" agendamento(s) em andamento ou futuros"},
      pontos:{n:pend, warn:pend>0, tip:pend+" ponto(s) pendente(s)"},
      lost:{n:state.lost.length, tip:state.lost.length+" registro(s)"}
    };
    Array.prototype.forEach.call(document.querySelectorAll(".tab-item"), function(el){
      var i = info[el.dataset.view], b = el.querySelector(".tab-badge");
      if(!i || !b) return;
      b.hidden = !i.n;
      b.textContent = i.n;
      b.classList.toggle("warn", !!i.warn);
      el.title = i.tip;
    });
  }
  // A barra de abas fica fixa no topo; guardamos a altura dela para o índice do Calendário grudar logo abaixo.
  function medirNav(){
    var h = alturaNav();
    if(h) document.documentElement.style.setProperty("--nav-h", h+"px");
  }
  function showView(key){
    var mudou = key!==viewAtual;
    viewAtual = key;
    Array.prototype.forEach.call(document.querySelectorAll(".view"), function(v){
      var on = v.dataset.view===key;
      v.classList.toggle("active", on);
      if(on && mudou){ v.classList.remove("enter"); void v.offsetWidth; v.classList.add("enter"); }
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab-item"), function(n){
      var on = n.dataset.view===key;
      n.classList.toggle("active", on);
      n.setAttribute("aria-selected", on ? "true" : "false");
      n.tabIndex = on ? 0 : -1;
    });
    if(key==="calendario" && calSujo){ calSujo = false; renderDim(); renderMes(); }
    if(mudou && window.pageYOffset>0) window.scrollTo(0, 0);
    atualizarScroll();
  }
  function tickClock(){
    var d = new Date();
    document.getElementById("clockFoot").textContent = d.toLocaleDateString("pt-BR", {weekday:"short", day:"2-digit", month:"short", year:"numeric"});
    document.getElementById("equipeMeta").textContent = d.toLocaleDateString("pt-BR", {weekday:"short", day:"2-digit", month:"short"}) + " · " + d.toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"});
    var t = todayISO();
    if(lastToday!==null && t!==lastToday){
      lastToday = t;
      if(dimFollow){ dimDate = t; folgasMes = t.slice(0,7); }
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

  // Card de apresentação da equipe: quem está presente hoje (reps e PS), por situação, por Área e por escala.
  function renderTeamCard(){
    var el = document.getElementById("equipeStrip");
    var hoje = todayISO(), reps = state.reps, n = reps.length;
    var nome = state.teamName || timeDef().nome;
    var dia = new Date().toLocaleDateString("pt-BR", {weekday:"long", day:"2-digit", month:"long"});
    el.removeAttribute("aria-busy");
    if(!n){
      el.innerHTML = '<div class="tc-head"><div><div class="tc-name">'+esc(nome)+'</div><div class="tc-sub">Nenhuma pessoa cadastrada ainda · '+esc(dia)+'</div></div></div>';
      return;
    }
    var c = {ativo:0, folga:0, ferias:0, licenca:0, afastado:0};
    reps.forEach(function(r){ c[effStatus(r, hoje)]++; });
    var cd = contagemDia(hoje), areas = areasDoDia(cd), nPS = reps.filter(repEhPS).length;
    var extras = cd.banco.length + cd.trocaFolga.length, trocas = cd.trocaTrab.length;
    var porEsc = {};
    reps.forEach(function(r){
      var k = ESCALAS.indexOf(r.escala)>-1 ? r.escala : "", o = porEsc[k] || (porEsc[k] = {cad:0, pres:0});
      o.cad++; if(effStatus(r, hoje)==="ativo") o.pres++;
    });
    var escKeys = ESCALAS.filter(function(e){ return porEsc[e]; }).concat(porEsc[""] ? [""] : []);
    function linha(rotulo, pres, cad, cor){
      var pct = cad ? Math.round(pres/cad*100) : 0;
      return '<div class="tc-row"><span class="tc-lbl">'+rotulo+'</span><span class="tc-mini"><i style="width:'+pct+'%; background:'+cor+'"></i></span><b class="num">'+pres+'/'+cad+'</b></div>';
    }
    var seg = ["ativo","folga","ferias","licenca","afastado"].filter(function(k){ return c[k]>0; }).map(function(k){
      return '<i class="tc-s-'+k+'" style="width:'+(c[k]/n*100).toFixed(2)+'%" title="'+STATUS_LABEL[k]+' '+c[k]+'"></i>';
    }).join("");
    var pills = ["ativo","folga","ferias","licenca","afastado"].map(function(k){
      return '<span class="tc-pill tc-p-'+k+(c[k]?'':' zero')+'"><b>'+c[k]+'</b> '+(k==="ativo" ? "Presentes" : STATUS_LABEL[k]+(k==="afastado"?"s":""))+'</span>';
    }).join("");
    el.innerHTML =
      '<div class="tc-head">' +
        '<div><div class="tc-name">'+esc(nome)+'</div>' +
        '<div class="tc-sub">'+n+' pessoa'+(n>1?'s':'')+' cadastrada'+(n>1?'s':'')+(nPS ? ' · '+nPS+' PS' : '')+' · '+esc(dia)+'</div></div>' +
        '<div class="tc-big"><b>'+c.ativo+'</b><span>de '+n+' presentes hoje</span></div>' +
      '</div>' +
      '<div class="tc-seg" role="img" aria-label="Situação da equipe hoje">'+seg+'</div>' +
      '<div class="tc-pills">'+pills+'</div>' +
      ((extras || trocas) ? '<div class="tc-extra">Hoje: '+(extras ? plural(extras, "folga extra", "folgas extras") : "")+(extras && trocas ? " · " : "")+(trocas ? plural(trocas, "pessoa trabalhando em troca de folga", "pessoas trabalhando em troca de folga") : "")+'</div>' : '') +
      '<div class="tc-cols">' +
        '<div class="tc-col"><div class="tc-col-title">Presentes por área</div>' +
          areas.map(function(ar){ return linha('<span class="esc-dot" style="background:'+areaCor(ar.key)+'"></span>'+esc(areaNome(ar.key)), ar.total, ar.cad, areaCor(ar.key)); }).join("") +
        '</div>' +
        '<div class="tc-col"><div class="tc-col-title">Presentes por escala</div>' +
          escKeys.map(function(k){ return linha(k ? '<span class="esc-dot" style="background:'+ESC_COR[k]+'"></span>Escala '+k : 'Sem escala', porEsc[k].pres, porEsc[k].cad, k ? ESC_COR[k] : 'var(--text-faint)'); }).join("") +
        '</div>' +
      '</div>';
  }
  // Busca e filtros rápidos da Equipe (valem só nesta tela; voltam ao padrão ao trocar de time).
  var repFiltro = "todos", repBusca = "";
  var REP_CHIPS = [["todos","Todos"], ["presentes","Presentes hoje"], ["ausentes","Fora hoje"], ["rep","Reps"], ["ps","PS"]];
  function repPassa(r, hoje, q){
    var st = effStatus(r, hoje);
    if(repFiltro==="presentes" && st!=="ativo") return false;
    if(repFiltro==="ausentes" && st==="ativo") return false;
    if(repFiltro==="rep" && repClasse(r)!=="rep") return false;
    if(repFiltro==="ps" && repClasse(r)!=="ps") return false;
    if(q){
      var alvo = normNome([r.nome, r.ldap, r.re, r.email, CATEGORIA_LABEL[r.categoria], r.escala ? "escala "+r.escala : "", repSkillNames(r).join(" ")].join(" "));
      if(alvo.indexOf(q)<0) return false;
    }
    return true;
  }
  function limparFiltros(){
    repFiltro = "todos"; repBusca = ""; pontoFiltro = "todos"; pontoBusca = "";
    ["repBusca","pontoBusca"].forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ""; });
  }
  function renderEquipe(){
    renderTeamCard();
    if(!editing.rep) renderRepSkillsChecklist(getCheckedRepSkills());
    renderRepGrid();
  }
  function renderRepGrid(){
    var grid = document.getElementById("repGrid");
    var empty = document.getElementById("repEmpty");
    var bar = document.getElementById("repToolbar");
    if(state.reps.length===0){
      grid.innerHTML = "";
      empty.style.display = "block";
      bar.style.display = "none";
      return;
    }
    empty.style.display = "none";
    bar.style.display = "";
    var hoje = todayISO(), q = normNome(repBusca);
    var cont = {todos:state.reps.length, presentes:0, ausentes:0, rep:0, ps:0};
    state.reps.forEach(function(r){
      if(effStatus(r, hoje)==="ativo") cont.presentes++; else cont.ausentes++;
      cont[repClasse(r)]++;
    });
    document.getElementById("repChips").innerHTML = REP_CHIPS.map(function(c){
      var on = repFiltro===c[0];
      return '<button type="button" class="fchip'+(on?' on':'')+(cont[c[0]]?'':' zero')+'" data-act="rep-filtro" data-v="'+c[0]+'" aria-pressed="'+(on?'true':'false')+'">'+c[1]+'<b>'+cont[c[0]]+'</b></button>';
    }).join("");
    var visiveis = sortReps(state.reps.filter(function(r){ return repPassa(r, hoje, q); }));
    if(visiveis.length===0){
      grid.innerHTML = '<div class="hint" style="grid-column:1/-1;padding:14px 4px;">Nenhum rep encontrado com esse filtro ou busca. <button type="button" class="btn-ghost" data-act="rep-limpar">Limpar filtros</button></div>';
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
  function feriasAgendadas(r){
    return (state.folgas||[]).filter(function(f){ return f && f.tipo==="ferias" && f.repId===r.id && feriasFim(f); })
      .sort(function(x,y){ return x.data.localeCompare(y.data); });
  }
  function repCardHTML(r){
    var escCls = ESCALAS.indexOf(r.escala)>-1 ? " esc-"+r.escala.toLowerCase() : "";
    var eff = effStatus(r, todayISO());
    var stCls = (eff==="ferias"||eff==="licenca"||eff==="folga") ? " st-"+eff : "";
    var afastado = (r.status==="ferias"||r.status==="licenca") ? periodoTexto(r) : "";
    var rows = qrow("Escala", r.escala) +
      qrow("Admissão", r.admissao ? fmtDate(r.admissao) : "", "num") +
      qrow("Tempo de casa", tempoCasaTexto(r, true)) +
      qrow(r.status==="licenca" ? "Licença" : "Férias", afastado, "num") +
      (function(){
        var prox = feriasAgendadas(r).filter(function(f){ return feriasFim(f)>=todayISO(); })[0];
        return prox ? qrow("Férias agendadas", diaMes(prox.data)+" → "+diaMes(feriasFim(prox)), "num") : "";
      })();
    var flags = repFlags(r);
    var skills = repSkillNames(r);
    var tarefas = skills.length ? skills.slice(0,2).join(", ") + (skills.length>2 ? " +"+(skills.length-2) : "") : "";
    return '<div class="card rep-card'+escCls+stCls+'" data-key="rep:'+esc(r.id)+'">' +
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
    var feriasSec = feriasAgendadas(r).map(function(f){
      return row(fmtDate(f.data)+" → "+fmtDate(feriasFim(f)), plural(Math.floor(Number(f.dias)), "dia", "dias")+(f.obs ? " · "+f.obs : ""), "num");
    }).join("");
    var flags = repFlags(r);
    var contato = row("CPF", r.cpf, "num") + row("Aniversário", r.aniversario ? fmtDate(r.aniversario) : "", "num") +
      row("LDAP", r.ldap) + row("RE", r.re, "num") + row("Email", r.email) + row("Telefone", r.telefone, "num") + row("Endereço", r.endereco);
    var skills = repSkillNames(r);
    document.getElementById("fichaBox").innerHTML =
      '<div class="ficha-head"><div class="rep-avatar">'+esc(repInitials(r.nome))+'</div><div><div class="ficha-name">'+esc(r.nome)+'</div><div class="card-tags" style="margin:6px 0 0;padding:0;border:0;">'+repTags(r)+'</div></div></div>' +
      sec("Trabalho", trabalho) +
      sec("Férias agendadas", feriasSec) +
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
    if(!rep) return;
    abrirParaEditar("rep");
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
  }
  function resetRepForm(){
    editing.rep = null;
    fecharAposEditar("rep");
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
    var editou = !!editing.rep, idSalvo;
    if(editing.rep){
      var rep = state.reps.find(function(r){return r.id===editing.rep;});
      if(rep){ Object.assign(rep, data); idSalvo = rep.id; }else{ data.id = uid(); idSalvo = data.id; state.reps.push(data); }
    }else{
      data.id = uid();
      idSalvo = data.id;
      state.reps.push(data);
    }
    migrateTasks();
    resetRepForm();
    scheduleSave();
    renderAll();
    toast((editou ? "Atualizado: " : "Adicionado: ")+nome);
    destacar("rep:"+idSalvo, editou);
    if(!editou){ var campo = document.getElementById("repNome"); if(campo.offsetParent) campo.focus({preventScroll:true}); }
  }
  function deleteRep(id){
    var alvo = state.reps.find(function(r){return r.id===id;});
    state.reps = state.reps.filter(function(r){return r.id!==id;});
    state.pontos.forEach(function(p){ p.repIds = (p.repIds||[]).filter(function(rid){return rid!==id;}); });
    state.lost = state.lost.filter(function(l){return l.repId!==id;});
    state.tasks.forEach(function(t){ t.repIds = (t.repIds||[]).filter(function(rid){return rid!==id;}); });
    state.folgas = (state.folgas||[]).filter(function(f){return f.repId!==id;});
    if(editing.rep===id) resetRepForm();
    scheduleSave();
    renderAll();
    toast("Excluído: "+(alvo ? alvo.nome : "rep"));
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
  // Painel do dia (aba Calendário) só é desenhado com a aba aberta; ao abri-la, showView desenha o que ficou pendente.
  var calSujo = false;
  function calAtiva(){ return viewAtual==="calendario"; }
  function renderDim(){
    if(!dimDate) dimDate = todayISO();
    document.querySelectorAll(".dim-data-input").forEach(function(inp){ if(inp.value!==dimDate) inp.value = dimDate; });
    document.getElementById("escalaModo").value = state.escalaModo==="trabalho" ? "trabalho" : "folga";

    // barra da aba Dimensionamento: presentes na data (todos, PS incluídos) por área
    var cdDia = contagemDia(dimDate), areasDia = areasDoDia(cdDia);
    document.getElementById("dimBarInfo").textContent = (state.reps.length ? cdDia.total+" de "+state.reps.length+" presentes · "+areasDia.map(function(ar){ return AREA_CURTA[ar.key]+" "+ar.total; }).join(" · ") : "Nenhum rep cadastrado");
    if(!calAtiva()){ calSujo = true; return; }

    // contadores do dia com TODOS (reps e PS); os presentes por área ficam nos blocos por área (renderMes)
    var c = {ativo:0, folga:0, ferias:0, licenca:0, afastado:0};
    state.reps.forEach(function(r){ c[effStatus(r, dimDate)]++; });
    var extraFolga = cdDia.banco.length + cdDia.trocaFolga.length;
    document.getElementById("dimStrip").innerHTML =
      stripCell("Trabalhando", c.ativo, "green", "green", "Presentes na data" + (cdDia.trocaTrab.length ? " · "+cdDia.trocaTrab.length+" em troca" : "")) +
      stripCell("Folga", c.folga, "folga", "folga", extraFolga ? "Escala + "+extraFolga+" folga"+(extraFolga>1?"s":"")+" extra"+(extraFolga>1?"s":"") : "Pela escala") +
      stripCell("Férias", c.ferias, "ferias", "ferias", "Em férias") +
      stripCell("Licença", c.licenca, "licenca", "licenca", "Em licença") +
      stripCell("Afastados", c.afastado, "rust", "rust", "Afastados");

    // escalas A–D na semana em torno da data (quem a escala manda trabalhar); contagens por dia e por área ficam no calendário
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
    document.getElementById("dimSemana").innerHTML = html + '</tbody></table>';

    document.getElementById("dimLegenda").innerHTML =
      ['ativo','folga','ferias','licenca','afastado'].map(function(k){
        return '<span class="tag '+STATUS_TAG[k]+'">'+STATUS_LABEL[k]+'</span>';
      }).join("") + '<span class="hint">· Escala marcada nos calendários = '+(state.escalaModo==="trabalho"?"dia de trabalho":"folga")+' · PS contam nos presentes (separados por área), mas não entram nas tarefas · o total do dia já desconta banco de horas e trocas de folga</span>';

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
  // Responsáveis elegíveis da tarefa e quantos estão disponíveis na data de referência.
  // sem = tem responsáveis, mas ninguém trabalha na data (cobertura zerada); semResp = ninguém marcado ainda.
  function coberturaTarefa(t){
    var ids = t.repIds||[];
    var resp = state.reps.filter(function(r){ return ids.indexOf(r.id)>-1 && repElegivel(t, r); });
    var disp = resp.filter(function(r){ return effStatus(r, dimDate)==="ativo"; }).length;
    return {resp:resp, disp:disp, semResp:resp.length===0, sem:resp.length>0 && disp===0};
  }
  function renderTasks(){
    var cobs = state.tasks.map(coberturaTarefa);
    var nSem = cobs.filter(function(c){ return c.sem; }).length, nSemResp = cobs.filter(function(c){ return c.semResp; }).length;
    var metaEl = document.getElementById("taskMeta");
    metaEl.textContent = state.tasks.length + " tarefa(s)" + (nSem ? " · "+nSem+" sem cobertura na data" : "") + (nSemResp ? " · "+nSemResp+" sem responsáveis" : "");
    metaEl.classList.toggle("warn", nSem>0);
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
      var cb = coberturaTarefa(t), resp = cb.resp, disp = cb.disp;
      var fora = state.reps.filter(function(r){return ids.indexOf(r.id)>-1 && !repElegivel(t, r);});
      var alerta = cb.semResp ? '<span class="tag tag-amber" title="Marque abaixo quem é responsável por esta tarefa">Sem responsáveis</span>' :
        (cb.sem ? '<span class="tag tag-rust" title="Os responsáveis não estão disponíveis em '+fmtDate(dimDate)+'">Sem cobertura na data</span>' : '');
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
      return '<div class="card" data-key="task:'+esc(t.id)+'">' +
        '<div class="card-head">' +
          '<div class="card-title">'+esc(t.nome)+'</div>' +
          '<div class="row-actions">' +
            '<button class="btn-ghost" data-act="edit-task" data-id="'+t.id+'">Editar</button>' +
            '<button class="btn-ghost" data-act="del-task" data-id="'+t.id+'">Excluir</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-tags"><span class="tag tag-dark">'+(CATEGORIA_LABEL[area]||"—")+'</span>' +
          (fixa ? '<span class="tag tag-folga">só reps de '+CATEGORIA_LABEL[fixa]+' (sem PS)</span>' : '') + alerta + '</div>' +
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
    if(!t) return;
    abrirParaEditar("task");
    editing.task = t.id;
    document.getElementById("taskFormTitle").textContent = "Editar tarefa";
    document.getElementById("taskNome").value = t.nome;
    document.getElementById("taskCategoria").value = t.categoria||"inventario";
    syncTaskAreaLock();
    document.getElementById("taskSaveBtn").textContent = "Salvar";
    document.getElementById("taskCancelBtn").style.display = "inline-block";
  }
  function resetTaskForm(){
    editing.task = null;
    fecharAposEditar("task");
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
    var editou = !!editing.task, idSalvo;
    if(editing.task){
      var t = state.tasks.find(function(x){return x.id===editing.task;});
      if(t){ t.nome = nome; t.categoria = categoria; idSalvo = t.id; }
      else{ idSalvo = uid(); state.tasks.push({id:idSalvo, nome:nome, categoria:categoria, repIds:[]}); }
    }else{
      idSalvo = uid();
      state.tasks.push({id:idSalvo, nome:nome, categoria:categoria, repIds:[]});
    }
    resetTaskForm();
    scheduleSave();
    renderAll();
    toast((editou ? "Tarefa atualizada: " : "Tarefa adicionada: ")+nome);
    destacar("task:"+idSalvo, editou);
    if(!editou){ var campo = document.getElementById("taskNome"); if(campo.offsetParent) campo.focus({preventScroll:true}); }
  }
  function deleteTask(id){
    var alvo = state.tasks.find(function(t){return t.id===id;});
    state.tasks = state.tasks.filter(function(t){return t.id!==id;});
    state.reps.forEach(function(r){ r.skills = (r.skills||[]).filter(function(tid){return tid!==id;}); });
    if(editing.task===id) resetTaskForm();
    scheduleSave();
    renderAll();
    toast("Tarefa excluída: "+(alvo ? alvo.nome : ""));
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
  // Filtro e busca da lista de pontos (valem só nesta tela).
  var pontoFiltro = "todos", pontoBusca = "";
  var PONTO_CHIPS = [["todos","Todos"], ["pendentes","Pendentes"], ["concluidos","Concluídos"]];
  function renderPontos(){
    var hoje = todayISO(), tot = state.pontos.length;
    var pend = state.pontos.filter(function(p){ return p.status!=="concluido"; });
    var conc = tot - pend.length;
    document.getElementById("pontosMeta").textContent = tot + " registro(s)";
    if(!editing.ponto) renderPontoRepsChecklist(getCheckedPontoReps());

    var maisAntigo = pend.reduce(function(m, p){ return (isoOk(p.data) && (!m || p.data<m.data)) ? p : m; }, null);
    var diasParado = maisAntigo ? Math.max(0, Cal.diasDesdeEpoch(hoje) - Cal.diasDesdeEpoch(maisAntigo.data)) : 0;
    document.getElementById("pontosStrip").innerHTML =
      stripCell("Registros", tot, "", "teal", "Pontos alinhados") +
      stripCell("Pendentes", pend.length, pend.length ? "amber" : "", "amber", pend.length ? "ainda a resolver" : "nada pendente") +
      stripCell("Concluídos", conc, conc ? "green" : "", "green", tot ? Math.round(conc/tot*100)+"% do total" : "—") +
      stripCell("Pendente mais antigo", maisAntigo ? plural(diasParado, "dia", "dias") : "—", maisAntigo && diasParado>14 ? "rust" : "", maisAntigo && diasParado>14 ? "rust" : "", maisAntigo ? esc(fmtDate(maisAntigo.data)+" · "+(CATEGORIA_LABEL[maisAntigo.categoria]||"")) : "Sem pendências");
    document.getElementById("pontoToolbar").style.display = tot ? "" : "none";
    var cont = {todos:tot, pendentes:pend.length, concluidos:conc};
    document.getElementById("pontoChips").innerHTML = PONTO_CHIPS.map(function(c){
      var on = pontoFiltro===c[0];
      return '<button type="button" class="fchip'+(on?' on':'')+(cont[c[0]]?'':' zero')+'" data-act="ponto-filtro" data-v="'+c[0]+'" aria-pressed="'+(on?'true':'false')+'">'+c[1]+'<b>'+cont[c[0]]+'</b></button>';
    }).join("");

    var body = document.getElementById("pontoTableBody");
    var empty = document.getElementById("pontoEmpty");
    // pendentes primeiro; dentro de cada grupo, os mais recentes no topo
    var q = normNome(pontoBusca);
    var list = state.pontos.filter(function(p){
      if(pontoFiltro==="pendentes" && p.status==="concluido") return false;
      if(pontoFiltro==="concluidos" && p.status!=="concluido") return false;
      if(q && normNome(p.texto+" "+(p.repIds||[]).map(repName).join(" ")+" "+(CATEGORIA_LABEL[p.categoria]||"")).indexOf(q)<0) return false;
      return true;
    }).sort(function(a,b){
      var ga = a.status==="concluido" ? 1 : 0, gb = b.status==="concluido" ? 1 : 0;
      return (ga-gb) || (b.data||"").localeCompare(a.data||"");
    });
    if(tot===0){ body.innerHTML=""; empty.style.display="block"; return; }
    empty.style.display = "none";
    if(list.length===0){
      body.innerHTML = '<tr><td colspan="6" class="hint" style="padding:14px 12px;">Nenhum ponto neste filtro ou busca.</td></tr>';
      return;
    }
    body.innerHTML = list.map(function(p){
      var concl = p.status==="concluido";
      var statusCls = concl ? "tag-green" : "tag-amber";
      var statusLabel = concl ? "Concluído" : "Pendente";
      var nomes = (p.repIds||[]).map(repName).join(", ") || "—";
      return '<tr data-key="ponto:'+esc(p.id)+'">' +
        '<td class="num">'+fmtDate(p.data)+'</td>' +
        '<td><span class="tag tag-dark">'+(CATEGORIA_LABEL[p.categoria]||"—")+'</span></td>' +
        '<td>'+esc(nomes)+'</td>' +
        '<td>'+esc(p.texto)+'</td>' +
        '<td><button type="button" class="tag tag-btn '+statusCls+'" data-act="toggle-ponto" data-id="'+esc(p.id)+'" title="'+(concl ? 'Clique para reabrir (volta a pendente)' : 'Clique para marcar como concluído')+'">'+statusLabel+'</button></td>' +
        '<td class="row-actions">' +
          '<button class="btn-ghost" data-act="edit-ponto" data-id="'+p.id+'">Editar</button>' +
          '<button class="btn-ghost" data-act="del-ponto" data-id="'+p.id+'">Excluir</button>' +
        '</td>' +
      '</tr>';
    }).join("");
  }
  function togglePonto(id){
    var p = state.pontos.find(function(x){return x.id===id;});
    if(!p) return;
    p.status = p.status==="concluido" ? "pendente" : "concluido";
    scheduleSave();
    renderAll();
    toast(p.status==="concluido" ? "Ponto concluído" : "Ponto reaberto: voltou para pendente");
    destacar("ponto:"+p.id, true);
  }
  function startPontoEdit(p){
    if(!p) return;
    abrirParaEditar("ponto");
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
    fecharAposEditar("ponto");
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
    var editou = !!editing.ponto, idSalvo;
    if(editing.ponto){
      var p = state.pontos.find(function(p){return p.id===editing.ponto;});
      if(p){ Object.assign(p, data); idSalvo = p.id; }else{ data.id = uid(); idSalvo = data.id; state.pontos.push(data); }
    }else{
      data.id = uid();
      idSalvo = data.id;
      state.pontos.push(data);
    }
    resetPontoForm();
    scheduleSave();
    renderAll();
    toast(editou ? "Ponto atualizado" : "Ponto registrado");
    destacar("ponto:"+idSalvo, editou);
    if(!editou){ var campo = document.getElementById("pontoTexto"); if(campo.offsetParent) campo.focus({preventScroll:true}); }
  }
  function deletePonto(id){
    state.pontos = state.pontos.filter(function(p){return p.id!==id;});
    if(editing.ponto===id) resetPontoForm();
    scheduleSave();
    renderAll();
    toast("Ponto excluído");
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
    var muRows = computeLostByMU(), muTop = muRows[0];
    var strip = document.getElementById("lostStrip");
    strip.innerHTML =
      stripCell("Registros", state.lost.length, "", "", "Lost registrados") +
      stripCell("Valor total perdido", fmtMoney(total), "rust", "rust", "Somado de todos os MU") +
      stripCell("MU mais crítico", muTop ? esc(muTop.mu) : "—", "rust", "rust", muTop ? fmtMoney(muTop.valor)+" · "+(total>0 ? Math.round(muTop.valor/total*100) : 0)+"% do total" : "Sem registros ainda") +
      stripCell("Rep ofensor", offender ? esc(repName(offender.repId)) : "—", "rust", "rust", offender ? fmtMoney(offender.valor)+" acumulado" : "Sem registros ainda");

    document.getElementById("lostMeta").textContent = state.lost.length + " registro(s)";

    // barra de cada MU proporcional à maior perda (valor; se não houver valor, quantidade)
    var maxV = muRows.reduce(function(m, x){ return Math.max(m, x.valor); }, 0), maxQ = muRows.reduce(function(m, x){ return Math.max(m, x.quantidade); }, 0);
    document.getElementById("lostMuTableBody").innerHTML = muRows.length ? muRows.map(function(m){
      var pct = maxV>0 ? m.valor/maxV*100 : (maxQ>0 ? m.quantidade/maxQ*100 : 0);
      return '<tr><td>'+esc(m.mu)+'<span class="minibar" title="Proporção da maior perda"><i style="width:'+pct.toFixed(1)+'%"></i></span></td><td class="num">'+m.quantidade+'</td><td class="num" style="text-align:right;">'+fmtMoney(m.valor)+'</td></tr>';
    }).join("") : '<tr><td colspan="3" class="hint" style="padding:14px 12px;">Sem registros ainda.</td></tr>';

    var body = document.getElementById("lostTableBody");
    var empty = document.getElementById("lostEmpty");
    if(state.lost.length===0){ body.innerHTML=""; empty.style.display="block"; return; }
    empty.style.display = "none";
    body.innerHTML = state.lost.slice().reverse().map(function(l){
      return '<tr data-key="lost:'+esc(l.id)+'">' +
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
    if(!l) return;
    abrirParaEditar("lost");
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
    fecharAposEditar("lost");
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
    var editou = !!editing.lost, idSalvo;
    if(editing.lost){
      var l = state.lost.find(function(l){return l.id===editing.lost;});
      if(l){ Object.assign(l, data); idSalvo = l.id; }else{ data.id = uid(); idSalvo = data.id; state.lost.push(data); }
    }else{
      data.id = uid();
      idSalvo = data.id;
      state.lost.push(data);
    }
    resetLostForm();
    scheduleSave();
    renderAll();
    toast(editou ? "Lost atualizado" : "Lost registrado: "+mu);
    destacar("lost:"+idSalvo, editou);
    if(!editou){ var campo = document.getElementById("lostMu"); if(campo.offsetParent) campo.focus({preventScroll:true}); }
  }
  function deleteLost(id){
    state.lost = state.lost.filter(function(l){return l.id!==id;});
    if(editing.lost===id) resetLostForm();
    scheduleSave();
    renderAll();
    toast("Lost excluído");
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
  function ehFimDeSemana(iso){
    if(!isoOk(iso)) return false;
    var p = iso.split("-"), d = new Date(Date.UTC(+p[0], +p[1]-1, +p[2])).getUTCDay();
    return d===0 || d===6;
  }
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
    if(f.tipo==="ferias") return [f.data, feriasFim(f)].filter(isoOk).sort();
    return (f.tipo==="troca" ? [f.dataFolga, f.dataTrabalho] : [f.data, f.dataFim||f.data]).filter(isoOk).sort();
  }
  var TIPO_ROTULO = {banco:"Banco de horas", troca:"Troca de folga", ferias:"Férias"};
  var TIPO_TAG = {banco:"tag-teal", troca:"tag-amber", ferias:"tag-ferias"};
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
    var tipo = g("folgaTipo");
    return {tipo: (tipo==="troca" || tipo==="ferias") ? tipo : "banco", repId:g("folgaRep"), data:g("folgaData"), dataFim:g("folgaDataFim"),
            trabalha:g("folgaTrabalha"), folgaEm:g("folgaFolgaEm"), feriasIni:g("folgaFeriasIni"), feriasDias:g("folgaFeriasDias"), obs:g("folgaObs").trim()};
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
      }else if(d.tipo==="ferias"){
        if(!isoOk(d.feriasIni)){ res.erro = "Informe o início das férias."; res.incompleto = true; return res; }
        var nDias = Math.floor(Number(d.feriasDias));
        if(!(nDias>=1)){ res.erro = "Informe a duração das férias, em dias."; res.incompleto = true; return res; }
        if(nDias>90){ res.erro = "As férias podem ter no máximo 90 dias."; return res; }
        var fimF = Cal.addDays(d.feriasIni, nDias-1), trab = 0, folg = 0, aus = 0, perdem = 0, menor = null, sobrepoe = null;
        for(i=0;i<nDias;i++){
          iso = Cal.addDays(d.feriasIni, i);
          var outra = feriasDe(r, iso);
          if(outra && !sobrepoe) sobrepoe = outra;
          base = baseStatus(r, iso);
          if(base==="ativo") trab++; else if(base==="folga") folg++; else aus++;
          if(effStatus(r, iso)==="ativo"){
            perdem++;
            var tot = contagemDia(iso).total - 1;
            if(menor===null || tot<menor.v) menor = {iso:iso, v:tot};
          }
        }
        if(sobrepoe){ res.erro = r.nome+" já tem férias agendadas de "+fmtDate(sobrepoe.data)+" a "+fmtDate(feriasFim(sobrepoe))+"."; return res; }
        if(!trab && !folg){ res.erro = "Sem efeito: "+r.nome+" já está ausente (férias, licença ou afastamento) em todo o período."; return res; }
        res.linhas.push({cls:"ok", texto:"Férias de "+fmtDate(d.feriasIni)+" ("+diaSemana(d.feriasIni)+") a "+fmtDate(fimF)+" ("+diaSemana(fimF)+") · "+plural(nDias, "dia", "dias")+" · retorno em "+fmtDate(Cal.addDays(fimF, 1))});
        if(perdem) res.linhas.push({cls:"ok", texto:"Pessoas trabalhando cai 1 em "+plural(perdem, "dia", "dias")+" · menor dia: "+diaMes(menor.iso)+" com "+menor.v});
        if(folg) res.linhas.push({cls:"mute", texto:plural(folg, "dia", "dias")+" caem em folga pela escala (viram férias, sem mudar a presença)"});
        if(aus) res.linhas.push({cls:"mute", texto:plural(aus, "dia", "dias")+" já eram férias, licença ou afastamento pelo cadastro"});
        var dentro = (state.folgas||[]).filter(function(f){
          return f.repId===r.id && f.id!==editing.folga && (f.tipo==="banco" || f.tipo==="troca") && folgaDatas(f).some(function(x){ return x>=d.feriasIni && x<=fimF; });
        }).length;
        if(dentro) res.linhas.push({cls:"warn", texto:plural(dentro, "agendamento", "agendamentos")+" de banco de horas/troca dentro do período deixa(m) de ter efeito (a pessoa já estará de férias)"});
        res.ok = true;
        res.entry = {tipo:"ferias", repId:r.id, data:d.feriasIni, dias:nDias, obs:d.obs};
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
        if(l.texto!==undefined) return '<div class="fp-line '+l.cls+'">'+esc(l.texto)+'</div>';
        if(l.cls==="ok"){
          var rot = l.rot==="trabalha" ? "Trabalha" : "Folga";
          return '<div class="fp-line ok"><b>'+fmtDate(l.iso)+'</b> <span>'+esc(diaSemana(l.iso))+'</span> · '+rot+' · pessoas trabalhando: '+l.antes+' → <b>'+l.depois+'</b></div>';
        }
        return '<div class="fp-line mute"><b>'+fmtDate(l.iso)+'</b> <span>'+esc(diaSemana(l.iso))+'</span> · '+esc(l.txt)+'</div>';
      }).join("");
      if(av.linhas.length>max) html += '<div class="fp-line mute">… e mais '+(av.linhas.length-max)+' dia(s)</div>';
    }else if(av.incompleto){
      html = '<div class="fp-line mute">'+(d.tipo==="banco" ? "Escolha a pessoa e a data para ver quantas pessoas trabalham no dia." : d.tipo==="ferias" ? "Escolha a pessoa, o início e a duração para ver o impacto na contagem." : "Escolha a pessoa e os dois dias para ver o impacto na contagem.")+'</div>';
    }
    // antes de a pessoa mexer no formulário o aviso fica discreto (a data de hoje vem preenchida por padrão)
    if(av.erro && !av.incompleto) html += '<div class="fp-line '+(folgaTocado ? 'bad' : 'mute')+'">'+esc(av.erro)+'</div>';
    box.innerHTML = html;
  }
  function folgaFormMudou(){
    var tipo = document.getElementById("folgaTipo").value;
    if(tipo!=="troca" && tipo!=="ferias") tipo = "banco";
    document.querySelectorAll("[data-folga]").forEach(function(el){
      el.style.display = el.dataset.folga===tipo ? "" : "none";
    });
    var iniF = document.getElementById("folgaFeriasIni").value, diasF = Math.floor(Number(document.getElementById("folgaFeriasDias").value)) || 0;
    var fimCalc = (isoOk(iniF) && diasF>=1 && diasF<=366) ? Cal.addDays(iniF, diasF-1) : "";
    document.getElementById("folgaFeriasFim").textContent = fimCalc ? fmtDate(fimCalc)+" · retorno em "+fmtDate(Cal.addDays(fimCalc, 1)) : "—";
    clearFormError("folgaFormError");
    folgaPreview();
  }
  function resetFolgaForm(){
    editing.folga = null;
    fecharAposEditar("folga");
    document.getElementById("folgaFormTitle").textContent = "Agendar";
    document.getElementById("folgaTipo").value = "banco";
    document.getElementById("folgaData").value = todayISO();
    document.getElementById("folgaDataFim").value = "";
    document.getElementById("folgaTrabalha").value = "";
    document.getElementById("folgaFolgaEm").value = "";
    document.getElementById("folgaFeriasIni").value = "";
    document.getElementById("folgaFeriasDias").value = "30";
    document.getElementById("folgaObs").value = "";
    document.getElementById("folgaSaveBtn").textContent = "Agendar";
    document.getElementById("folgaCancelBtn").style.display = "none";
    folgaTocado = false;
    folgaFormMudou();
  }
  function startFolgaEdit(f){
    if(!f) return;
    var r = repPorId(f.repId);
    if(!r){ toast("Esse agendamento é de uma pessoa que não está mais cadastrada. Exclua-o.", "warn"); return; }
    abrirParaEditar("folga");
    editing.folga = f.id;
    document.getElementById("folgaFormTitle").textContent = "Editar agendamento";
    document.getElementById("folgaTipo").value = (f.tipo==="troca" || f.tipo==="ferias") ? f.tipo : "banco";
    fillFolgaRepSelect();
    document.getElementById("folgaRep").value = f.repId;
    document.getElementById("folgaData").value = f.tipo==="ferias" ? "" : (f.data || "");
    document.getElementById("folgaDataFim").value = f.dataFim || "";
    document.getElementById("folgaFeriasIni").value = f.tipo==="ferias" ? (f.data || "") : "";
    document.getElementById("folgaFeriasDias").value = f.tipo==="ferias" ? (f.dias || "") : "30";
    document.getElementById("folgaTrabalha").value = f.dataTrabalho || "";
    document.getElementById("folgaFolgaEm").value = f.dataFolga || "";
    document.getElementById("folgaObs").value = f.obs || "";
    document.getElementById("folgaSaveBtn").textContent = "Salvar";
    document.getElementById("folgaCancelBtn").style.display = "inline-block";
    folgaTocado = true;
    folgaFormMudou();
  }
  function saveFolga(){
    var av = folgaAvaliar(folgaLerForm());
    if(!av.ok){ showFormError("folgaFormError", av.erro || "Revise os dados."); return; }
    clearFormError("folgaFormError");
    var entry = av.entry, editou = !!editing.folga;
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
    toast((editou ? "Agendamento atualizado: " : "Agendado: ")+(TIPO_ROTULO[entry.tipo]||"")+" · "+repName(entry.repId));
    destacar("cal:"+folgaIni(entry), false);
    destacar("dia:"+folgaIni(entry), false);
    destacar("folga:"+entry.id, editou);
  }
  function deleteFolga(id){
    state.folgas = (state.folgas||[]).filter(function(f){return f.id!==id;});
    if(editing.folga===id) resetFolgaForm();
    scheduleSave();
    renderAll();
    toast("Agendamento excluído");
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
    if(f.tipo==="ferias"){
      var fimFe = feriasFim(f), nFe = Math.floor(Number(f.dias));
      if(!fimFe) return {tags:[{cls:"tag-rust", txt:"datas inválidas"}], det:[]};
      var tr = 0, fo = 0, au = 0, antigoIgn = folgaIgnorar;
      folgaIgnorar = f.id; // o que a pessoa seria sem estas férias
      try{
        for(var q=0;q<nFe && q<400;q++){
          var bq = baseStatus(r, Cal.addDays(f.data, q));
          if(bq==="ativo") tr++; else if(bq==="folga") fo++; else au++;
        }
      }finally{ folgaIgnorar = antigoIgn; }
      if(!tr && !fo) tags.push({cls:"tag-rust", txt:"sem efeito"});
      else tags.push({cls:"tag-ferias", txt: tr ? plural(tr, "dia de trabalho", "dias de trabalho")+" em férias" : "só dias de folga"});
      if(fo && tr) det.push("inclui "+plural(fo, "dia", "dias")+" de folga pela escala");
      if(au) det.push("já ausente (férias/licença/afastado) em "+plural(au, "dia", "dias"));
      return {tags:tags, det:det};
    }
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
    if(f.tipo==="ferias"){
      var fimT = feriasFim(f);
      return (isoOk(f.data) && fimT) ? '<b>'+diaMes(f.data)+'</b> a <b>'+fmtDate(fimT)+'</b> · '+plural(Math.floor(Number(f.dias)), "dia", "dias") : "—";
    }
    if(f.tipo==="troca") return 'Trabalha <b>'+(isoOk(f.dataTrabalho)?diaMes(f.dataTrabalho):"—")+'</b> → Folga <b>'+(isoOk(f.dataFolga)?diaMes(f.dataFolga):"—")+'</b>';
    if(!isoOk(f.data)) return "—";
    if(isoOk(f.dataFim) && f.dataFim!==f.data) return '<b>'+diaMes(f.data)+'</b> a <b>'+fmtDate(f.dataFim)+'</b> · '+diasEntre(f.data, f.dataFim)+' dias';
    return '<b>'+fmtDate(f.data)+'</b> · '+esc(diaSemana(f.data));
  }

  // =====================================================================
  // PESSOAS TRABALHANDO POR DIA (blocos por área, calendário de blocos, detalhe do dia e tabela)
  // =====================================================================
  var mesView = "blocos"; // "blocos" (calendário com um bloco por dia) | "tabela" (dia a dia detalhado)
  function aplicarMesView(){
    var p = document.getElementById("sec-dia");
    p.dataset.mesview = mesView;
    Array.prototype.forEach.call(p.querySelectorAll("[data-act='mes-view']"), function(b){
      var on = b.dataset.mode===mesView;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function diaLongo(iso){
    var p = iso.split("-");
    var t = new Date(Date.UTC(+p[0], +p[1]-1, +p[2])).toLocaleDateString("pt-BR", {weekday:"long", day:"2-digit", month:"long", timeZone:"UTC"});
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function nomesLista(l){ return l.map(function(x){ return x.r.nome; }).join(", "); }
  // Texto curto de um dia (dica ao passar o mouse e leitura por leitor de tela).
  function resumoDia(cd){
    return diaSemana(cd.iso)+" "+diaMes(cd.iso)+": "+cd.total+" trabalhando"+(cd.base!==cd.total ? " (pela escala "+cd.base+")" : "")+" · "+
      areasDoDia(cd).map(function(a){ return AREA_CURTA[a.key]+" "+a.total; }).join(" · ");
  }

  // Um bloco por área: quantas pessoas trabalham no dia em foco (número exato), menor/maior dia do mês e uma barra por dia (clicável).
  function blocosAreaHTML(dias, sel, hoje){
    var ym = dias[0].iso.slice(0,7);
    var ref = sel || (hoje.slice(0,7)===ym ? hoje : dias[0].iso); // dia em foco: o escolhido; senão hoje (se for deste mês); senão o dia 1
    return areasDoDia(dias[0]).map(function(a0){
      var k = a0.key, cad = a0.cad, min = Infinity, max = -1, diaMin = dias[0].iso, diaMax = dias[0].iso, alterados = 0;
      var h = function(n){ return (cad ? n/cad*100 : 0).toFixed(1)+"%"; };
      var barras = dias.map(function(cd){
        var a = cd.areas[k], ok = Math.min(a.total, a.base), perdeu = Math.max(0, a.base-a.total), ganhou = Math.max(0, a.total-a.base);
        if(a.total<min){ min = a.total; diaMin = cd.iso; } if(a.total>max){ max = a.total; diaMax = cd.iso; } if(a.total!==a.base) alterados++;
        var dica = diaSemana(cd.iso)+" "+diaMes(cd.iso)+": "+a.total+" de "+cad+(a.total!==a.base ? " (pela escala "+a.base+")" : "");
        return '<button type="button" class="ab-bar'+(ehFimDeSemana(cd.iso)?' fds':'')+(cd.iso===hoje?' hoje':'')+(cd.iso===sel?' sel':'')+'" data-act="dim-dia" data-iso="'+cd.iso+'" title="'+esc(dica)+'" aria-label="'+esc(areaNome(k)+", "+dica)+'">' +
          '<span class="bs"><i class="b-ok" style="height:'+h(ok)+'"></i>'+(perdeu ? '<i class="b-lost" style="height:'+h(perdeu)+'"></i>' : '')+(ganhou ? '<i class="b-gain" style="height:'+h(ganhou)+'"></i>' : '')+'</span></button>';
      }).join("");
      var aRef = dias[Number(ref.slice(8))-1].areas[k], dlRef = aRef.total - aRef.base, subs = [];
      if(aRef.ps && !areaEhPS(k)) subs.push(aRef.ps+" PS");
      if(dlRef) subs.push('<span class="dn">'+(dlRef<0 ? "−" : "+")+Math.abs(dlRef)+" por folga extra/troca</span>");
      return '<div class="area-block '+areaCls(k)+'" data-area="'+k+'">' +
        '<div class="ab-head"><span class="ab-dot"></span>'+esc(areaNome(k))+'<span class="ab-cad">'+plural(cad, "cadastrado", "cadastrados")+'</span></div>' +
        '<div class="ab-main"><b>'+aRef.total+'</b><span>de '+cad+' trabalhando em '+esc(diaSemana(ref)+" "+diaMes(ref))+'</span></div>' +
        (subs.length ? '<div class="ab-sub">'+subs.join(" · ")+'</div>' : '') +
        '<div class="ab-bars">'+barras+'</div>' +
        '<div class="ab-foot"><span>Menor: <b>'+min+'</b> · '+esc(diaSemana(diaMin)+" "+diaMes(diaMin))+'</span><span>Maior: <b>'+max+'</b> · '+esc(diaSemana(diaMax)+" "+diaMes(diaMax))+'</span></div>' +
        (alterados ? '<div class="ab-foot"><span class="dn">'+plural(alterados, "dia", "dias")+' com folga extra ou troca na área</span></div>' : '') +
      '</div>';
    }).join("");
  }
  function legendaAreasHTML(dias){
    return areasDoDia(dias[0]).map(function(a){
      return '<span class="lgA '+areaCls(a.key)+'"><i></i>'+esc(areaNome(a.key))+' <small>('+AREA_MINI[a.key]+')</small></span>';
    }).join("") +
      '<span class="lgA nota">Número grande = pessoas trabalhando no dia · cada bloco colorido = quantas por área · selo cinza = férias/licença <span class="pt dn"></span>a área perdeu gente por folga extra ou troca <span class="pt up"></span>a área ganhou alguém em troca de folga <span class="pt zx"></span>ninguém na área, embora a escala previsse</span>';
  }
  // Um bloco por dia: total, quantos por área (cores) e o que mexeu na contagem.
  function celulaDia(cd, ctx){
    var iso = cd.iso, fds = ehFimDeSemana(iso), dl = cd.total - cd.base;
    var neg = cd.banco.length + cd.trocaFolga.length, pos = cd.trocaTrab.length;
    var chips = areasDoDia(cd).map(function(a){
      var zx = a.total===0 && a.base>0, z0 = a.total===0 && a.base===0, dn = a.total<a.base, up = a.total>a.base;
      var tip = areaNome(a.key)+": "+a.total+" de "+a.cad+(a.total!==a.base ? " (pela escala "+a.base+")" : "")+(zx ? " · ninguém na área" : "");
      return '<span class="ac '+areaCls(a.key)+(zx?' zx':'')+(z0?' z0':'')+(dn?' dn':'')+(up?' up':'')+'" title="'+esc(tip)+'"><small>'+AREA_MINI[a.key]+'</small><b>'+a.total+'</b></span>';
    }).join("");
    var flags = "";
    if(neg) flags += '<span class="fl neg" title="'+esc("Folga extra: "+nomesLista(cd.banco.concat(cd.trocaFolga)))+'">−'+plural(neg, "folga extra", "folgas extras")+'</span>';
    if(pos) flags += '<span class="fl pos" title="'+esc("Trabalha em troca de folga: "+nomesLista(cd.trocaTrab))+'">+'+plural(pos, "troca", "trocas")+'</span>';
    if(cd.ausentes.length) flags += '<span class="fl aus" title="'+esc(cd.ausentes.map(function(x){ return x.r.nome+" ("+(x.tipo==="licenca" ? "licença" : "férias")+")"; }).join(", "))+'">'+cd.ausentes.length+' férias/licença</span>';
    var dica = resumoDia(cd);
    return '<button type="button" class="cal-day'+(fds?' fds':'')+(iso===ctx.hoje?' hoje':'')+(iso===ctx.sel?' sel':'')+(ctx.min!==null && cd.total===ctx.min ? ' min' : '')+(dl<0?' dn':'')+(dl>0?' up':'')+'" data-act="dim-dia" data-iso="'+iso+'" data-key="cal:'+iso+'" aria-pressed="'+(iso===ctx.sel?'true':'false')+'" title="'+esc(dica)+'" aria-label="'+esc(diaLongo(iso)+": "+cd.total+" pessoas trabalhando")+'">' +
      '<span class="cd-top"><b class="cd-n">'+iso.slice(8)+'</b>'+(iso===ctx.hoje?'<em>hoje</em>':'')+'<span class="cd-tot num" title="Pessoas trabalhando no dia">'+cd.total+(dl ? '<small class="'+(dl<0?'neg':'pos')+'">'+(dl<0?'−':'+')+Math.abs(dl)+'</small>' : '')+'</span></span>' +
      '<span class="cd-areas">'+chips+'</span>' +
      (flags ? '<span class="cd-flags">'+flags+'</span>' : '') +
    '</button>';
  }
  // Grade do mês (domingo a sábado). O detalhe do dia escolhido abre logo abaixo da semana dele, apontando para a coluna.
  function calendarioHTML(dias, ym, ctx, detalhe){
    var p = ym.split("-"), vazios = new Date(Date.UTC(+p[0], +p[1]-1, 1)).getUTCDay(), cells = [], i;
    for(i=0;i<vazios;i++) cells.push('<span class="cal-blank" aria-hidden="true"></span>');
    dias.forEach(function(cd){ cells.push(celulaDia(cd, ctx)); });
    if(detalhe){
      var pos = vazios + detalhe.idx, fimSemana = Math.min(cells.length, (Math.floor(pos/7)+1)*7);
      cells.splice(fimSemana, 0, '<div class="mes-detalhe" id="mesDetalhe" style="--col:'+(pos%7)+'">'+detalhe.html+'</div>');
    }
    return cells.join("");
  }
  // Quem trabalha e quem está fora em cada área, em uma data.
  function pessoasDoDia(iso){
    var por = {};
    sortReps(state.reps).forEach(function(r){
      var k = areaDe(r), g = por[k] || (por[k] = {trab:[], fora:[]}), st = effStatus(r, iso);
      (st==="ativo" ? g.trab : g.fora).push({r:r, st:st, ex:extraDe(r, iso), nota:statusNote(r, iso)});
    });
    return por;
  }
  function chipPessoa(x){
    var cls = "who st-"+x.st+(x.ex ? (x.ex.tipo==="troca-trabalho" ? " ex-trab" : " ex-folga") : "");
    var sub = x.st==="ativo" ? (x.ex ? x.nota : (x.r.escala ? "Escala "+x.r.escala : "")) : (x.nota || STATUS_LABEL[x.st]);
    return '<span class="'+cls+'" title="'+esc(x.r.nome+(x.nota ? " · "+x.nota : ""))+'">'+esc(x.r.nome)+(sub ? ' <i>'+esc(sub)+'</i>' : '')+'</span>';
  }
  function detalheDiaHTML(iso, cd, hoje){
    var por = pessoasDoDia(iso), neg = cd.banco.length + cd.trocaFolga.length, pos = cd.trocaTrab.length, dl = cd.total - cd.base;
    var nota = "pela escala "+cd.base+(neg ? " · −"+plural(neg, "folga extra", "folgas extras") : "")+(pos ? " · +"+plural(pos, "troca", "trocas") : "");
    var blocos = areasDoDia(cd).map(function(a){
      var g = por[a.key] || {trab:[], fora:[]};
      return '<div class="dd-area '+areaCls(a.key)+'" data-area="'+a.key+'">' +
        '<div class="dda-head"><span class="ab-dot"></span>'+esc(areaNome(a.key))+'<span class="dda-n"><b>'+a.total+'</b> de '+a.cad+'</span></div>' +
        '<div class="dda-sec"><div class="dda-lbl">Trabalhando ('+g.trab.length+')</div><div class="dda-chips">'+(g.trab.length ? g.trab.map(chipPessoa).join("") : '<span class="hint">Ninguém nesta área</span>')+'</div></div>' +
        (g.fora.length ? '<div class="dda-sec"><div class="dda-lbl">Fora ('+g.fora.length+')</div><div class="dda-chips">'+g.fora.map(chipPessoa).join("")+'</div></div>' : '') +
      '</div>';
    }).join("");
    return '<div class="dd-head">' +
        '<div class="dd-title"><b>'+esc(diaLongo(iso))+'</b>'+(iso===hoje?'<em>hoje</em>':'')+'</div>' +
        '<div class="dd-sum"><b>'+cd.total+'</b> trabalhando<span>'+esc(nota)+'</span></div>' +
        '<div class="dd-nav"><button type="button" class="btn" data-act="mes-dia" data-d="-1" title="Dia anterior">‹</button><button type="button" class="btn" data-act="mes-dia" data-d="1" title="Próximo dia">›</button></div>' +
      '</div>' +
      '<div class="dd-areas">'+blocos+'</div>' +
      '<div class="hint" style="margin-top:10px;">Clicar num dia também muda a data de referência do Painel do dia e do Dimensionamento.</div>';
  }

  function mostrarDetalheDia(centralizar){
    var d = document.getElementById("mesDetalhe");
    if(!d || !d.scrollIntoView) return;
    var r = d.getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if(centralizar || r.top < alturaNav()+8 || r.bottom > vh-8) d.scrollIntoView({block: centralizar ? "center" : "nearest", behavior: reduzMov() ? "auto" : "smooth"});
  }
  function renderMes(){
    if(!calAtiva()){ calSujo = true; return; } // ao abrir a aba, showView desenha
    var hoje = todayISO();
    if(!/^\d{4}-\d{2}$/.test(folgasMes)) folgasMes = hoje.slice(0,7);
    var ym = folgasMes, nd = diasDoMes(ym);
    document.getElementById("mesSub").innerHTML = 'Mês · '+esc(mesLabel(ym))+' <small>folgas extras, trocas e férias já descontadas</small>';
    var inpMes = document.getElementById("folgasMesInput");
    if(inpMes.value!==ym) inpMes.value = ym;
    aplicarMesView();
    // o clique num dia redesenha o calendário: devolve o foco ao mesmo botão (uso pelo teclado)
    var ae = document.activeElement, foco = null;
    if(ae && ae.closest && ae.dataset){
      if(ae.closest("#calGrid") && ae.dataset.iso) foco = "#calGrid [data-iso='"+ae.dataset.iso+"']";
      else if(ae.dataset.act==="mes-dia" && ae.closest("#mesDetalhe")) foco = "#mesDetalhe [data-act='mes-dia'][data-d='"+ae.dataset.d+"']";
    }

    var equipe = state.reps.length;
    var wrap = document.getElementById("folgasDias"), strip = document.getElementById("folgasStrip");
    var blocos = document.getElementById("mesBlocos"), areasBox = document.getElementById("mesAreasBox");
    if(!equipe){
      wrap.innerHTML = '<div class="hint" style="padding:10px 2px;">Cadastre reps na aba Equipe para ver quantas pessoas trabalham em cada dia.</div>';
      wrap.style.display = "block"; blocos.style.display = "none"; areasBox.style.display = "none";
      strip.innerHTML = ""; document.getElementById("mesAreas").innerHTML = ""; document.getElementById("calGrid").innerHTML = "";
    }else{
      wrap.style.display = ""; blocos.style.display = ""; areasBox.style.display = "";
      var dias = [], nBanco = 0, nTF = 0, nTT = 0, menor = null, maior = null, feriasPessoas = {}, feriasPD = 0;
      for(var d=1; d<=nd; d++){
        var iso = ym+"-"+String(d).padStart(2,"0"), cd = contagemDia(iso);
        dias.push(cd);
        nBanco += cd.banco.length; nTF += cd.trocaFolga.length; nTT += cd.trocaTrab.length;
        cd.ausentes.forEach(function(x){ if(x.tipo==="ferias"){ feriasPessoas[x.r.id] = true; feriasPD++; } });
        if(menor===null || cd.total<menor.total) menor = cd;
        if(maior===null || cd.total>maior.total) maior = cd;
      }
      strip.innerHTML =
        stripCell("Equipe", equipe, "", "teal", areasDoDia(dias[0]).map(function(ar){ return '<span class="kp '+areaCls(ar.key)+'"><i></i>'+AREA_CURTA[ar.key]+" "+ar.cad+'</span>'; }).join(" · ")) +
        stripCell("Folgas extras", nBanco+nTF, nBanco+nTF ? "rust" : "", "rust", "banco "+nBanco+" · troca "+nTF+" (pessoa-dias)") +
        stripCell("Trabalham em troca", nTT, nTT ? "green" : "", "green", "dias de trabalho extra") +
        stripCell("Em férias", Object.keys(feriasPessoas).length, Object.keys(feriasPessoas).length ? "ferias" : "", "ferias", "pessoas no mês · "+feriasPD+" pessoa-dias") +
        stripCell("Menor dia", menor.total, "amber", "amber", diaSemana(menor.iso)+" "+diaMes(menor.iso)) +
        stripCell("Maior dia", maior.total, "teal", "teal", diaSemana(maior.iso)+" "+diaMes(maior.iso));

      // ----- blocos por área, calendário de blocos e detalhe do dia -----
      var sel = (dimDate && dimDate.slice(0,7)===ym) ? dimDate : "";
      document.getElementById("mesAreas").innerHTML = blocosAreaHTML(dias, sel, hoje);
      if(mesView==="blocos"){
        document.getElementById("mesLegAreas").innerHTML = legendaAreasHTML(dias);
        var ctx = {hoje:hoje, sel:sel, min:(menor.total<maior.total ? menor.total : null)};
        document.getElementById("calGrid").innerHTML = calendarioHTML(dias, ym, ctx, sel ? {idx:Number(sel.slice(8))-1, html:detalheDiaHTML(sel, dias[Number(sel.slice(8))-1], hoje)} : null);
        document.getElementById("mesDica").style.display = sel ? "none" : "block";
        wrap.innerHTML = ""; // a tabela só é montada quando a visão Tabela está escolhida
      }else{
      document.getElementById("calGrid").innerHTML = ""; document.getElementById("mesLegAreas").innerHTML = "";

      // ----- tabela dia a dia -----
      function chips(lista, rotulo){
        return lista.map(function(x){
          return '<span class="fd-chip" title="'+esc((x.f.obs ? x.f.obs+" · " : "")+rotulo)+'">'+esc(x.r.nome)+' <i>'+rotulo+'</i></span>';
        }).join("");
      }
      function chipsAus(lista){
        return lista.map(function(x){
          return '<span class="fd-chip fer" title="'+esc(x.tipo==="licenca" ? "licença" : "férias")+'">'+esc(x.r.nome)+' <i>'+(x.tipo==="licenca" ? "licença" : "férias")+'</i></span>';
        }).join("");
      }
      var linhas = dias.map(function(cd){
        var dl = cd.total - cd.base, neg = cd.banco.length + cd.trocaFolga.length, pos = cd.trocaTrab.length, areasCd = areasDoDia(cd);
        var pct = function(v){ return Math.max(0, Math.min(100, v/equipe*100)).toFixed(1)+"%"; };
        // barra do dia: um trecho por área (cor da área) + trecho listrado de quem a escala previa e ficou de folga extra
        var barra = '<div class="fd-bar" title="Total '+cd.total+' de '+equipe+'">' +
          areasCd.filter(function(ar){ return ar.total>0; }).map(function(ar){ return '<i class="'+areaCls(ar.key)+'" style="width:'+pct(ar.total)+'" title="'+esc(areaNome(ar.key)+" "+ar.total)+'"></i>'; }).join("") +
          (dl<0 ? '<i class="fd-lost" style="width:'+pct(cd.base-cd.total)+'"></i>' : '') + '</div>';
        return '<tr class="fd-row'+(cd.iso===hoje?' fd-hoje':'')+(ehFimDeSemana(cd.iso)?' fd-fds':'')+'" data-key="dia:'+cd.iso+'">' +
          '<td class="fd-dia"><b>'+cd.iso.slice(8)+'</b> <span>'+esc(diaSemana(cd.iso))+'</span>'+(cd.iso===hoje?' <em>hoje</em>':'')+'</td>' +
          '<td class="num fd-n">'+cd.base+'</td>' +
          '<td class="fd-neg">'+(neg ? '<b>−'+neg+'</b> '+chips(cd.banco,"banco")+chips(cd.trocaFolga,"troca") : '<span class="fd-nada">—</span>')+'</td>' +
          '<td class="fd-pos">'+(pos ? '<b>+'+pos+'</b> '+chips(cd.trocaTrab,"troca") : '<span class="fd-nada">—</span>')+'</td>' +
          '<td class="fd-fer">'+(cd.ausentes.length ? '<b>'+cd.ausentes.length+'</b> '+chipsAus(cd.ausentes) : '<span class="fd-nada">—</span>')+'</td>' +
          '<td class="fd-total"><div class="fd-tot-n"><b>'+cd.total+'</b>'+(dl ? ' <small class="'+(dl<0?'neg':'pos')+'">'+(dl<0?'−':'+')+Math.abs(dl)+'</small>' : '')+'</div>'+barra+
            '<div class="fd-areas" title="Presentes por área: '+esc(areasCd.map(function(ar){ return areaNome(ar.key)+" "+ar.total; }).join(" · "))+'">'+
              areasCd.map(function(ar){ return '<span class="am '+areaCls(ar.key)+(ar.total ? '' : ' z0')+'">'+AREA_CURTA[ar.key]+' <b>'+ar.total+'</b></span>'; }).join("")+'</div></td>' +
        '</tr>';
      }).join("");
      wrap.innerHTML = '<table class="fd-table"><thead><tr><th>Dia</th><th title="Pessoas com dia de trabalho pela escala (sem férias, licença e afastados)">Pela escala</th><th>Folgas extras</th><th>Trabalham em troca</th><th title="Pessoas em férias ou licença no dia (já fora da contagem pela escala)">Férias / licença</th><th>Pessoas trabalhando <span class="fd-th-sub">(por área)</span></th></tr></thead><tbody>'+linhas+'</tbody></table>';
      }
    }
    document.getElementById("folgasLegenda").innerHTML =
      '<span class="hint"><b>'+esc(mesLabel(ym))+'</b> · Pela escala = reps com dia de trabalho (já sem férias/licença/afastados) · − folga extra (banco de horas ou troca) · + trabalha em dia de folga (troca) · férias agendadas saem da contagem pela escala · PS incluídos, separados por área (Inv, Qual, PS Op, PS ICQA)</span>';
    var hint = document.getElementById("folgasHint");
    if(Cal.foraDosCalendarios(ym+"-01") || Cal.foraDosCalendarios(ym+"-"+String(nd).padStart(2,"0"))){
      hint.textContent = "Mês fora dos calendários enviados (set–dez/2026): a escala é projetada pelo ciclo de 52 semanas deduzido deles.";
      hint.style.display = "block";
    }else{
      hint.style.display = "none";
    }
    if(foco){ var alvo = document.querySelector(foco); if(alvo && alvo.focus) alvo.focus({preventScroll:true}); }
  }

  function renderFolgas(){
    var hoje = todayISO();
    if(!/^\d{4}-\d{2}$/.test(folgasMes)) folgasMes = hoje.slice(0,7);
    var ym = folgasMes;
    document.getElementById("folgasMeta").textContent = (state.folgas||[]).length + " agendamento(s)";
    document.getElementById("calIdxN").textContent = (state.folgas||[]).length || "";
    fillFolgaRepSelect();
    fillFolgaFiltroRep();
    renderMes();

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
        return '<tr class="'+(passado?'fd-passado':'')+'" data-key="folga:'+esc(f.id)+'">' +
          '<td>'+nome+'</td>' +
          '<td><span class="tag '+(TIPO_TAG[f.tipo]||'tag-teal')+'">'+esc(TIPO_ROTULO[f.tipo]||'Banco de horas')+'</span></td>' +
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
    renderNavBadges();
  }

  // ---------- Calendário: índice das seções (fica visível ao rolar e marca onde você está) ----------
  var SEC_IDS = {"sec-dia":"sec-dia", "sec-agendar":"folgaFormPanel", "sec-lista":"sec-lista"};
  function secAtiva(key){
    Array.prototype.forEach.call(document.querySelectorAll("#calIndex .fchip"), function(c){ c.classList.toggle("on", c.dataset.sec===key); });
  }
  var calSpyTrava = false, calSpyTimer = null;
  function irParaSecao(key){
    var el = document.getElementById(SEC_IDS[key]);
    if(!el) return;
    calSpyTrava = true; if(calSpyTimer) clearTimeout(calSpyTimer);
    calSpyTimer = setTimeout(function(){ calSpyTrava = false; }, 900); // a rolagem do próprio clique não troca a seção marcada
    if(key==="sec-agendar") abrirForm("folga", false);
    el.scrollIntoView({block:"start", behavior: reduzMov() ? "auto" : "smooth"});
    secAtiva(key);
  }
  function calSpy(){
    if(viewAtual!=="calendario" || calSpyTrava) return;
    var idx = document.getElementById("calIndex"), limite = alturaNav() + (idx ? idx.offsetHeight : 0) + 36, atual = "sec-dia";
    Object.keys(SEC_IDS).forEach(function(k){
      var el = document.getElementById(SEC_IDS[k]);
      if(el && el.getBoundingClientRect().top <= limite) atual = k;
    });
    var de = document.documentElement;
    if(window.pageYOffset>0 && window.innerHeight + window.pageYOffset >= de.scrollHeight - 4) atual = "sec-lista";
    secAtiva(atual);
  }
  // Sombra na barra de abas quando há conteúdo rolando por baixo dela + seção ativa do Calendário.
  var rafScroll = 0;
  function atualizarScroll(){
    var nav = document.getElementById("subnav");
    if(nav) nav.classList.toggle("stuck", nav.getBoundingClientRect().top<=0 && window.pageYOffset>0);
    calSpy();
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
    if(act==="dim-prev"){ setDimDate(Cal.addDays(dimDate, -1)); }
    else if(act==="dim-next"){ setDimDate(Cal.addDays(dimDate, 1)); }
    else if(act==="dim-hoje"){ setDimDate(todayISO()); }
    else if(act==="goto-view"){ if(viewsDoTime().some(function(v){ return v.key===btn.dataset.view; })) showView(btn.dataset.view); }
    else if(act==="dim-view"){ dimView = btn.dataset.mode==="matriz" ? "matriz" : "cards"; renderTasks(); }
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
    if(act==="dim-dia"){
      // (a posição do clique é lida antes: setDimDate redesenha a seção e o botão clicado sai da página)
      var naSecao = !!btn.closest("#mesAreas, #calGrid"), nasBarras = !!btn.closest("#mesAreas");
      setDimDate(btn.dataset.iso);
      if(naSecao) mostrarDetalheDia(nasBarras); // vindo das barras (no alto da seção) centraliza; vindo do calendário só garante que apareça
      return;
    }
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
    else if(act==="toggle-form"){ if(FORMS[btn.dataset.form]) alternarForm(btn.dataset.form); }
    else if(act==="open-form"){ if(FORMS[btn.dataset.form]) abrirForm(btn.dataset.form, true); }
    else if(act==="rep-filtro"){ repFiltro = btn.dataset.v; renderRepGrid(); }
    else if(act==="rep-limpar"){ repFiltro = "todos"; repBusca = ""; document.getElementById("repBusca").value = ""; renderRepGrid(); }
    else if(act==="ponto-filtro"){ pontoFiltro = btn.dataset.v; renderPontos(); }
    else if(act==="toggle-ponto"){ togglePonto(id); }
    else if(act==="goto-sec"){ irParaSecao(btn.dataset.sec); }
    else if(act==="mes-view"){ mesView = btn.dataset.mode==="tabela" ? "tabela" : "blocos"; renderMes(); }
    else if(act==="mes-dia"){ setDimDate(Cal.addDays(dimDate, Number(btn.dataset.d)||0)); }
    else if(act==="edit-folga"){ startFolgaEdit((state.folgas||[]).find(function(f){return f.id===id;})); }
    else if(act==="del-folga"){ pendingDelete(btn, deleteFolga, id); }
    else if(act==="backup-open"){ backupAbrir(); }
    else if(act==="backup-close"){ backupFechar(); }
    else if(act==="backup-gerar"){ backupGerar(); }
    else if(act==="backup-baixar"){ backupBaixar(); }
    else if(act==="backup-restaurar"){ pendingAction(btn, backupRestaurar); }
  });

  document.getElementById("fichaOverlay").addEventListener("click", function(e){ if(e.target.id==="fichaOverlay") closeFicha(); });
  document.getElementById("backupOverlay").addEventListener("click", function(e){ if(e.target.id==="backupOverlay") backupFechar(); });
  var CANCELAR_EDICAO = {rep:function(){ resetRepForm(); }, task:function(){ resetTaskForm(); }, ponto:function(){ resetPontoForm(); }, lost:function(){ resetLostForm(); }, folga:function(){ resetFolgaForm(); }};
  document.addEventListener("keydown", function(e){
    var t = e.target, painel = (t && t.closest) ? t.closest(".form-panel[data-form]") : null;
    if(e.key==="Escape"){
      closeFicha(); backupFechar();
      // Esc dentro de um formulário em edição cancela a edição
      if(painel && editing[painel.dataset.form]) CANCELAR_EDICAO[painel.dataset.form]();
      return;
    }
    // Enter num campo de texto/data/número do formulário = salvar (nos campos de várias linhas, Enter quebra a linha)
    if(e.key==="Enter" && !e.shiftKey && !e.isComposing && painel && t.tagName==="INPUT" && t.type!=="checkbox" && t.type!=="button"){
      var salvar = painel.querySelector(".fbody .btn-primary");
      if(salvar){ e.preventDefault(); salvar.click(); }
    }
  });
  // Setas, Home e End percorrem as abas
  document.getElementById("navList").addEventListener("keydown", function(e){
    var k = e.key;
    if(k!=="ArrowRight" && k!=="ArrowLeft" && k!=="Home" && k!=="End") return;
    var abas = viewsDoTime(), i = 0;
    abas.forEach(function(v, n){ if(v.key===viewAtual) i = n; });
    var j = k==="Home" ? 0 : k==="End" ? abas.length-1 : (i + (k==="ArrowRight" ? 1 : -1) + abas.length) % abas.length;
    e.preventDefault();
    showView(abas[j].key);
    var alvo = document.querySelector('.tab-item[data-view="'+abas[j].key+'"]');
    if(alvo) alvo.focus();
  });
  window.addEventListener("scroll", function(){
    if(rafScroll) return;
    rafScroll = window.requestAnimationFrame(function(){ rafScroll = 0; atualizarScroll(); });
  }, {passive:true});
  window.addEventListener("resize", function(){ medirNav(); atualizarScroll(); });
  // se a pessoa rolar por conta própria logo depois de clicar numa seção do índice, a marcação volta a acompanhar a rolagem
  ["wheel","touchstart","keydown"].forEach(function(ev){ window.addEventListener(ev, function(){ calSpyTrava = false; }, {passive:true}); });
  document.getElementById("repBusca").addEventListener("input", function(e){ repBusca = e.target.value; renderRepGrid(); });
  document.getElementById("pontoBusca").addEventListener("input", function(e){ pontoBusca = e.target.value; renderPontos(); });

  document.addEventListener("change", function(e){
    if(e.target.classList.contains("dim-data-input")){ setDimDate(e.target.value); return; }
    if(e.target.classList.contains("task-rep-toggle")){
      toggleTaskRep(e.target.dataset.task, e.target.dataset.rep);
    }
  });

  function setDimDate(iso){
    if(!iso) return;
    dimDate = iso;
    dimFollow = (iso===todayISO());
    folgasMes = iso.slice(0,7); // o painel é um só: mudar a data de referência leva o calendário para o mês dela
    renderDim();
    renderTasks();
    renderMes();
  }
  // (botões ‹ › Hoje e o campo de data existem no Calendário e no Dimensionamento: tratados por data-act / classe)
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

  ["folgaTipo","folgaRep","folgaData","folgaDataFim","folgaTrabalha","folgaFolgaEm","folgaFeriasIni","folgaFeriasDias","folgaObs"].forEach(function(id){
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
    renderTeamCard();
    scheduleSave();
  });

  // ---------- init ----------
  dimDate = todayISO();
  Array.prototype.forEach.call(document.querySelectorAll(".view"), function(v){
    v.id = "view-"+v.dataset.view;
    v.setAttribute("role", "tabpanel");
    v.setAttribute("aria-labelledby", "tab-"+v.dataset.view);
  });
  buildNav();
  buildTimeSel();
  showView(VIEWS[0].key);
  resetRepForm();
  resetTaskForm();
  resetPontoForm();
  resetLostForm();
  resetFolgaForm();
  aplicarForms();
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(medirNav);
  tickClock();
  setInterval(tickClock, 1000);
  loadAndRender();

})();