(function(){
  "use strict";

  // ---------- window.GRID.state: armazenamento nativo do Grid, compartilhado e ao vivo ----------
  var DEFAULT_STATE = { teamName:"", reps:[], tasks:[], pontos:[], lost:[] };
  var state = { teamName:"", reps:[], tasks:[], pontos:[], lost:[] };
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

  var STATUS_LABEL = {ativo:"Ativo", ferias:"Férias", afastado:"Afastado"};
  var STATUS_TAG = {ativo:"tag-green", ferias:"tag-amber", afastado:"tag-mute"};
  var CATEGORIA_LABEL = {inventario:"Inventário", qualidade:"Qualidade"};
  var CLASSE_LABEL = {ps_operacoes:"PS Operações", ps_icqa:"PS ICQA"};
  var CLASSE_TAG = {ps_operacoes:"tag-ps-op", ps_icqa:"tag-ps-icqa"};
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
  function classeOptions(selected){
    return '<option value="">Sem classificação</option>' +
      Object.keys(CLASSE_LABEL).map(function(k){
        return '<option value="'+k+'"'+(selected===k?' selected':'')+'>'+CLASSE_LABEL[k]+'</option>';
      }).join("");
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
    var ativos = state.reps.filter(function(r){return r.status==="ativo";}).length;
    var inv = state.reps.filter(function(r){return r.categoria==="inventario";}).length;
    var qlt = state.reps.filter(function(r){return r.categoria==="qualidade";}).length;
    strip.innerHTML =
      stripCell("Total HC", state.reps.length, "", "teal", "Reps cadastrados") +
      stripCell("Ativos", ativos, "green", "green", "Em atividade agora") +
      stripCell("Inventário", inv, "", "teal", "Reps na área") +
      stripCell("Qualidade", qlt, "", "amber", "Reps na área") +
      stripCell("PS Operações", state.reps.filter(function(r){return r.classe==="ps_operacoes";}).length, "amber", "amber", "Classificados") +
      stripCell("PS ICQA", state.reps.filter(function(r){return r.classe==="ps_icqa";}).length, "teal", "teal", "Classificados");

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
      if(!filtro) return true;
      if(filtro==="__none") return !r.classe;
      return r.classe===filtro;
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
      out += (function(r){
      var skillChips = (r.skills||[]).map(function(tid){
        var t = state.tasks.find(function(x){return x.id===tid;});
        return t ? '<span class="chip">'+esc(t.nome)+'</span>' : "";
      }).join("") || '<span class="hint">Nenhuma marcada</span>';
      var escCls = ["A","B","C","D"].indexOf(r.escala)>-1 ? " esc-"+r.escala.toLowerCase() : "";
      return '<div class="card'+escCls+'">' +
        '<div class="card-head">' +
          '<div class="card-title">'+esc(r.nome)+'</div>' +
          '<div class="row-actions">' +
            '<button class="btn-ghost" data-act="edit-rep" data-id="'+r.id+'">Editar</button>' +
            '<button class="btn-ghost" data-act="del-rep" data-id="'+r.id+'">Excluir</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-tags">' +
          '<span class="tag tag-dark">'+CATEGORIA_LABEL[r.categoria]+'</span>' +
          (CLASSE_LABEL[r.classe] ? '<span class="tag '+CLASSE_TAG[r.classe]+'">'+CLASSE_LABEL[r.classe]+'</span>' : "") +
          '<span class="tag '+STATUS_TAG[r.status]+'">'+STATUS_LABEL[r.status]+'</span>' +
        '</div>' +
        '<div class="classe-quick"><select class="rep-classe-select" data-id="'+r.id+'" title="Classificação">'+classeOptions(r.classe||"")+'</select></div>' +
        '<div class="card-body">' +
          '<div class="card-field"><span class="card-field-label">Escala</span><span>'+esc(r.escala||"—")+'</span></div>' +
          '<div class="card-field"><span class="card-field-label">Admissão</span><span class="num">'+fmtDate(r.admissao)+'</span></div>' +
          '<div class="card-field"><span class="card-field-label">Acesso ao HV</span><span>'+(r.acessoHV==="sim"?"Sim":"Não")+'</span></div>' +
          '<div class="card-field"><span class="card-field-label">3ª contagem</span><span>'+(r.terceiraContagem==="sim"?"Sim":"Não")+'</span></div>' +
          '<div class="card-field"><span class="card-field-label">Máquina</span><span>'+(r.maquina==="sim"?"Sim":"Não")+'</span></div>' +
        '</div>' +
        '<div class="card-section">' +
          '<div class="card-section-label">Dados pessoais e contato</div>' +
          '<div class="card-body" style="margin-bottom:0;">' +
            '<div class="card-field"><span class="card-field-label">CPF</span><span class="num">'+esc(r.cpf||"—")+'</span></div>' +
            '<div class="card-field"><span class="card-field-label">Aniversário</span><span class="num">'+fmtDate(r.aniversario)+'</span></div>' +
            '<div class="card-field"><span class="card-field-label">LDAP</span><span>'+esc(r.ldap||"—")+'</span></div>' +
            '<div class="card-field"><span class="card-field-label">RE</span><span class="num">'+esc(r.re||"—")+'</span></div>' +
            '<div class="card-field"><span class="card-field-label">Email</span><span>'+esc(r.email||"—")+'</span></div>' +
            '<div class="card-field"><span class="card-field-label">Endereço</span><span>'+esc(r.endereco||"—")+'</span></div>' +
            '<div class="card-field"><span class="card-field-label">Telefone</span><span class="num">'+esc(r.telefone||"—")+'</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="card-section">' +
          '<div class="card-section-label">Tarefas que sabe realizar</div>' +
          skillChips +
        '</div>' +
      '</div>';
      })(r);
    });
    grid.innerHTML = out;
  }

  function startRepEdit(rep){
    editing.rep = rep.id;
    document.getElementById("repFormTitle").textContent = "Editar rep";
    document.getElementById("repNome").value = rep.nome;
    document.getElementById("repEscala").value = rep.escala||"";
    document.getElementById("repClasse").value = rep.classe||"";
    document.getElementById("repAdmissao").value = rep.admissao||"";
    document.getElementById("repAcessoHV").value = rep.acessoHV||"nao";
    document.getElementById("repTerceiraContagem").value = rep.terceiraContagem||"nao";
    document.getElementById("repMaquina").value = rep.maquina||"nao";
    document.getElementById("repCategoria").value = rep.categoria||"inventario";
    document.getElementById("repStatus").value = rep.status;
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
    document.getElementById("repClasse").value = "";
    document.getElementById("repAdmissao").value = "";
    document.getElementById("repAcessoHV").value = "nao";
    document.getElementById("repTerceiraContagem").value = "nao";
    document.getElementById("repMaquina").value = "nao";
    document.getElementById("repCategoria").value = "inventario";
    document.getElementById("repStatus").value = "ativo";
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
      cpf: document.getElementById("repCpf").value.trim(),
      aniversario: document.getElementById("repAniversario").value,
      ldap: document.getElementById("repLdap").value.trim(),
      re: document.getElementById("repRe").value.trim(),
      email: document.getElementById("repEmail").value.trim(),
      endereco: document.getElementById("repEndereco").value.trim(),
      telefone: document.getElementById("repTelefone").value.trim(),
      skills: getCheckedRepSkills()
    };
    if(editing.rep){
      var rep = state.reps.find(function(r){return r.id===editing.rep;});
      if(rep){ Object.assign(rep, data); }else{ data.id = uid(); state.reps.push(data); }
    }else{
      data.id = uid();
      state.reps.push(data);
    }
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
      var repChecks = state.reps.length ? sortReps(state.reps).map(function(r){
        var checked = (t.repIds||[]).indexOf(r.id)>-1 ? "checked" : "";
        return '<label><input type="checkbox" class="task-rep-toggle" data-task="'+t.id+'" data-rep="'+r.id+'" '+checked+'>'+esc(r.nome)+'</label>';
      }).join("") : '<span class="hint">Cadastre reps na aba Equipe.</span>';
      return '<div class="card">' +
        '<div class="card-head">' +
          '<div class="card-title">'+esc(t.nome)+'</div>' +
          '<div class="row-actions">' +
            '<button class="btn-ghost" data-act="edit-task" data-id="'+t.id+'">Editar</button>' +
            '<button class="btn-ghost" data-act="del-task" data-id="'+t.id+'">Excluir</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-tags"><span class="tag tag-dark">'+(CATEGORIA_LABEL[t.categoria]||"—")+'</span></div>' +
        '<div class="card-section-label">Reps responsáveis</div>' +
        '<div class="check-list">'+repChecks+'</div>' +
      '</div>';
    }).join("");

    renderResumo();
  }
  function renderResumo(){
    var wrap = document.getElementById("resumoGrid");
    var icons = {inventario:"📋", qualidade:"✅"};

    var invTasks = state.tasks.filter(function(t){ return t.categoria==="inventario"; });
    var invItems = invTasks.map(function(t){
      var names = (t.repIds||[]).map(repName).join(", ") || "—";
      return '<div class="resumo-item"><span class="dot">•</span><div><b>'+esc(t.nome)+':</b> '+esc(names)+'</div></div>';
    }).join("") || '<div class="hint">Nenhuma tarefa nessa área ainda.</div>';

    var qltTasks = state.tasks.filter(function(t){ return t.categoria==="qualidade"; });
    var repTaskMap = {};
    qltTasks.forEach(function(t){
      (t.repIds||[]).forEach(function(rid){
        if(!repTaskMap[rid]) repTaskMap[rid] = [];
        repTaskMap[rid].push(t.nome);
      });
    });
    var qltRepIds = Object.keys(repTaskMap).sort(function(a,b){ return repName(a).localeCompare(repName(b)); });
    var qltItems = qltRepIds.map(function(rid){
      return '<div class="resumo-item"><span class="dot check">✓</span><div><b>'+esc(repName(rid))+':</b> '+esc(repTaskMap[rid].join(", "))+'</div></div>';
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
  function startTaskEdit(t){
    editing.task = t.id;
    document.getElementById("taskFormTitle").textContent = "Editar tarefa";
    document.getElementById("taskNome").value = t.nome;
    document.getElementById("taskCategoria").value = t.categoria||"inventario";
    document.getElementById("taskSaveBtn").textContent = "Salvar";
    document.getElementById("taskCancelBtn").style.display = "inline-block";
    document.getElementById("taskNome").focus();
  }
  function resetTaskForm(){
    editing.task = null;
    document.getElementById("taskFormTitle").textContent = "Adicionar tarefa";
    document.getElementById("taskNome").value = "";
    document.getElementById("taskCategoria").value = "inventario";
    document.getElementById("taskSaveBtn").textContent = "Adicionar";
    document.getElementById("taskCancelBtn").style.display = "none";
  }
  function saveTask(){
    var nome = document.getElementById("taskNome").value.trim();
    if(!nome){ document.getElementById("taskNome").focus(); return; }
    var categoria = document.getElementById("taskCategoria").value;
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
    if(act==="edit-rep"){ startRepEdit(state.reps.find(function(r){return r.id===id;})); }
    else if(act==="del-rep"){ pendingDelete(btn, deleteRep, id); }
    else if(act==="edit-task"){ startTaskEdit(state.tasks.find(function(t){return t.id===id;})); }
    else if(act==="del-task"){ pendingDelete(btn, deleteTask, id); }
    else if(act==="edit-ponto"){ startPontoEdit(state.pontos.find(function(p){return p.id===id;})); }
    else if(act==="del-ponto"){ pendingDelete(btn, deletePonto, id); }
    else if(act==="edit-lost"){ startLostEdit(state.lost.find(function(l){return l.id===id;})); }
    else if(act==="del-lost"){ pendingDelete(btn, deleteLost, id); }
  });

  document.addEventListener("change", function(e){
    if(e.target.classList.contains("rep-classe-select")){
      var rep = state.reps.find(function(r){return r.id===e.target.dataset.id;});
      if(rep){ rep.classe = e.target.value; scheduleSave(); renderAll(); }
      return;
    }
    if(e.target.id==="repFiltroClasse"){ renderEquipe(); return; }
    if(e.target.classList.contains("task-rep-toggle")){
      toggleTaskRep(e.target.dataset.task, e.target.dataset.rep);
    }
  });

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