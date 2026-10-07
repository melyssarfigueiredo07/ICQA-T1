(function(){
  "use strict";

  // ---------- window.GRID.state: armazenamento nativo do Grid, compartilhado e ao vivo ----------
  var DEFAULT_STATE = { teamName:"", reps:[], tasks:[], pontos:[], lost:[], escalaModo:"folga" };
  var state = { teamName:"", reps:[], tasks:[], pontos:[], lost:[], escalaModo:"folga" };
  var editing = { rep:null, ponto:null, lost:null, task:null };
  var pollTimer = null;
  var saveTimer = null;
  var lastUpdatedAt = null;

  var VIEWS = [
    {key:"equipe", label:"Equipe"},
    {key:"dimensionamento", label:"Dimensionamento"},
    {key:"pontos", label:"Pontos alinhados"},
    {key:"lost", label:"Controle de Lost"}
  ];

  var Cal = window.EscalaCal;
  var STATUS_LABEL = {ativo:"Ativo", folga:"Folga", ferias:"Férias", licenca:"Licença", afastado:"Afastado"};
  var STATUS_TAG = {ativo:"tag-green", folga:"tag-folga", ferias:"tag-ferias", licenca:"tag-licenca", afastado:"tag-rust"};
  var ESC_COR = {A:"var(--rust)", B:"var(--escB)", C:"var(--escC)", D:"var(--escD)"};
  var dimDate = null, dimFollow = true, dimFiltro = "todos", lastToday = null;
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
  // Situação do rep em uma data: férias/licença (dentro do período), afastado, ou conforme a escala (ativo/folga).
  function effStatus(r, iso){
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
  function statusNote(r, iso){
    var st = effStatus(r, iso);
    if(st==="ativo") return "";
    var fim = (st==="ferias"||st==="licenca") ? afastFim(r) : "";
    return STATUS_LABEL[st] + (fim ? " até "+fmtDate(fim) : "");
  }
  // Tarefas com área fixa: só reps dessa Área entram no dimensionamento (nome sem acento/maiúscula).
  var TAREFA_AREA_FIXA = {
    "internas":"qualidade", "qp":"qualidade", "rk":"qualidade", "pdd":"qualidade", "pd":"qualidade", "cem":"qualidade",
    "inbound":"qualidade",
    "inbound audit":"inventario"
  };
  function normNome(s){
    return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function areaFixa(nome){ return TAREFA_AREA_FIXA[normNome(nome)] || ""; }
  function tarefaArea(t){ return areaFixa(t.nome) || t.categoria || "inventario"; }
  function repEhPS(r){ return repClasse(r)==="ps" || String(r.categoria||"").indexOf("ps_")===0; }
  // PS não participa de nenhuma tarefa. Em tarefa de área fixa, só reps daquela Área.
  function repElegivel(t, r){
    if(repEhPS(r)) return false;
    var f = areaFixa(t.nome);
    return !f || r.categoria===f;
  }
  function repMotivoFora(r){ return repEhPS(r) ? "PS não considerado" : "fora da área"; }
  function migrateTasks(){
    var ps = {};
    (state.reps||[]).forEach(function(r){ if(repEhPS(r)){ ps[r.id] = true; if((r.skills||[]).length) r.skills = []; } });
    (state.tasks||[]).forEach(function(t){
      var f = areaFixa(t.nome); if(f) t.categoria = f;
      if((t.repIds||[]).some(function(rid){return ps[rid];})) t.repIds = t.repIds.filter(function(rid){return !ps[rid];});
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
  function persist(){
    window.GRID.state.set(state, lastUpdatedAt).then(function(res){
      lastUpdatedAt = res.updated_at;
    }).catch(function(err){
      console.error("Falha ao salvar no Grid:", err);
    });
  }
  function startPolling(){
    if(pollTimer) return;
    pollTimer = setInterval(function(){
      window.GRID.state.get().then(function(res){
        if(res.updated_at !== lastUpdatedAt){
          lastUpdatedAt = res.updated_at;
          state = Object.assign({}, DEFAULT_STATE, res.state||{});
          migrateReps();
          migrateTasks();
          document.getElementById("teamNameInput").value = state.teamName || "";
          renderAll();
        }
      }).catch(function(){});
    }, 5000);
  }
  function loadAndRender(){
    window.GRID.state.get().then(function(res){
      lastUpdatedAt = res.updated_at;
      state = Object.assign({}, DEFAULT_STATE, res.state||{});
      migrateReps();
      migrateTasks();
      document.getElementById("teamNameInput").value = state.teamName || "";
      renderAll();
      startPolling();
    }).catch(function(err){
      console.error("Falha ao carregar do Grid:", err);
      renderAll();
      startPolling();
    });
  }

  // ---------- nav ----------
  function buildNav(){
    var nav = document.getElementById("navList");
    VIEWS.forEach(function(v, i){
      var el = document.createElement("div");
      el.className = "tab-item" + (i===0 ? " active" : "");
      el.dataset.view = v.key;
      el.textContent = v.label;
      el.addEventListener("click", function(){ showView(v.key); });
      nav.appendChild(el);
    });
  }
  function showView(key){
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
      (function(){ var eff = effStatus(r, todayISO()); return '<span class="tag '+STATUS_TAG[eff]+'">'+STATUS_LABEL[eff]+'</span>'; })();
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
      row("Situação hoje", STATUS_LABEL[effHoje]) +
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

    var c = {ativo:0, folga:0, ferias:0, licenca:0, afastado:0};
    state.reps.filter(function(r){return !repEhPS(r);}).forEach(function(r){ c[effStatus(r, dimDate)]++; });
    document.getElementById("dimStrip").innerHTML =
      stripCell("Trabalhando", c.ativo, "green", "green", "Ativos na data") +
      stripCell("Folga", c.folga, "folga", "folga", "Pela escala") +
      stripCell("Férias", c.ferias, "ferias", "ferias", "Em férias") +
      stripCell("Licença", c.licenca, "licenca", "licenca", "Em licença") +
      stripCell("Afastados", c.afastado, "rust", "rust", "Afastados");

    var dias = [];
    for(var i=-3;i<=3;i++) dias.push(Cal.addDays(dimDate, i));
    var hoje = todayISO();
    var html = '<table><thead><tr><th></th>' + dias.map(function(d){
      return '<th>'+dimDiaLabel(d)+(d===hoje?'<br>hoje':'')+'</th>';
    }).join("") + '</tr></thead><tbody>';
    ESCALAS.forEach(function(e){
      var membros = state.reps.filter(function(r){return r.escala===e && !repEhPS(r);});
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
      }).join("") + '<span class="hint">· Escala marcada nos calendários = '+(state.escalaModo==="trabalho"?"dia de trabalho":"folga")+' · PS não entram no dimensionamento</span>';

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
    return '<span class="nm st-'+st+'">'+esc(r.nome)+'</span>' + (st!=="ativo" ? ' <small>('+esc(statusNote(r, dimDate))+')</small>' : "");
  }
  function renderTasks(){
    document.getElementById("taskMeta").textContent = state.tasks.length + " tarefa(s)";
    var grid = document.getElementById("taskGrid");
    var empty = document.getElementById("taskEmpty");
    if(state.tasks.length===0){
      grid.innerHTML = "";
      empty.style.display = "block";
      renderResumo();
      return;
    }
    empty.style.display = "none";
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
        return '<label class="rep-box st-'+st+(isResp?' is-resp':'')+'"><input type="checkbox" class="task-rep-toggle" data-task="'+t.id+'" data-rep="'+r.id+'" '+(isResp?"checked":"")+'>'+
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

  // ---------- render all ----------
  function renderAll(){
    renderEquipe();
    renderDim();
    renderTasks();
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

  document.addEventListener("click", function(e){
    var btn = e.target.closest("[data-act]");
    if(!btn) return;
    var act = btn.dataset.act, id = btn.dataset.id;
    if(act==="dim-dia"){ setDimDate(btn.dataset.iso); return; }
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
  showView(VIEWS[0].key);
  resetRepForm();
  resetTaskForm();
  resetPontoForm();
  resetLostForm();
  tickClock();
  setInterval(tickClock, 1000);
  loadAndRender();

})();