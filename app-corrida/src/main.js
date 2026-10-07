import * as Engine from "./engine.js"
import * as Storage from "./storage.js"

// ═══════════════════════════════════════
//  CONSTANTES
// ═══════════════════════════════════════
var TASKS  = ["Contagem","Inbound Audit","Stock Audit","Busca Lost","Transfer"];
var TC     = ["#185FA5","#3B6D11","#854F0B","#993556","#0F6E56"];
var AVC    = ["#185FA5","#3B6D11","#854F0B","#993556","#534AB7","#0F6E56","#993C1D","#0C447C"];
var MESES  = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
var MEDALS = ["🥇","🥈","🥉"];

// ═══════════════════════════════════════
//  ESTADO
// ═══════════════════════════════════════
var S = { mes:"",ano:"",reps:[],ranking:[],rankingREP:[],rankingOP:[],hlArrays:[],hlArraysOP:[],rankingOPFull:[],entries:[],years:[],updated:"",editId:null };
var SD = { historico:[] };

// ═══════════════════════════════════════
//  API — motor local (engine.js) + armazenamento (storage.js)
// ═══════════════════════════════════════
var READS  = { getData:Engine.getData, getEntries:Engine.getEntries, getDestaques:Engine.getDestaques, debug:Engine.debugInfo };
var WRITES = { save:Engine.saveEntry, del:Engine.deleteEntry, addRep:Engine.addRep, delRep:Engine.delRep, editRep:Engine.editRep,
               period:Engine.setPeriod, calcDestaque:Engine.calcDestaque, delDestaque:Engine.delDestaque };

function callApi(action, payload, onOk, onErr) {
  var p = payload || {};
  var run;
  if (READS[action])       run = Storage.read().then(function(db){ return READS[action](db, p); });
  else if (WRITES[action]) run = Storage.mutate(function(db){ return WRITES[action](db, p); });
  else { if (onErr) onErr("Ação desconhecida: "+action); return; }
  run.then(function(r){
    if (!r) { if (onErr) onErr("Sem resposta."); return; }
    if (r.ok === false) { if (onErr) onErr(r.error || "Erro."); return; }
    if (onOk) onOk(r);
  }).catch(function(e){
    var msg = (e && e.message) ? e.message : "Falha ao acessar os dados.";
    if (onErr) onErr(msg); else toast("⚠ "+msg);
  });
}

// confirm() é bloqueado no iframe sandbox do GRID; usamos um diálogo próprio.
function askConfirm(msg, onYes) {
  var ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900;display:flex;align-items:center;justify-content:center;padding:16px";
  var box = document.createElement("div");
  box.className = "modal";
  var t = document.createElement("div");
  t.className = "modal-title"; t.textContent = msg;
  var f = document.createElement("div");
  f.className = "modal-footer";
  var no = document.createElement("button"); no.className = "btn"; no.textContent = "Cancelar";
  var yes = document.createElement("button"); yes.className = "btn btn-p"; yes.textContent = "Confirmar";
  no.onclick = function(){ document.body.removeChild(ov); };
  yes.onclick = function(){ document.body.removeChild(ov); onYes(); };
  f.appendChild(no); f.appendChild(yes); box.appendChild(t); box.appendChild(f); ov.appendChild(box);
  document.body.appendChild(ov);
}

// ═══════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════
function ini(n){ return ((n||"?").split(" ").map(function(w){return w[0]||"";}).slice(0,2).join("").toUpperCase())||"?"; }
function avc(i){ return AVC[i%AVC.length]; }
function avci(nome){
  for(var i=0;i<S.reps.length;i++) if(S.reps[i].nome===nome) return avc(i);
  return avc(0);
}
function repTipo(nome){
  for(var i=0;i<S.reps.length;i++) if(S.reps[i].nome===nome) return S.reps[i].tipo||"REP";
  return "REP";
}
var ESCALAS = ["A","B","C","D"];
function escRank(e){ if(!e) return 1000; var i=ESCALAS.indexOf(e); return i>-1?i:100; }
function sortReps(list){
  return list.slice().sort(function(a,b){
    var ea=a.escala||"", eb=b.escala||"", ra=escRank(ea), rb=escRank(eb);
    if(ra!==rb) return ra-rb;
    if(ra===100 && ea!==eb) return ea.localeCompare(eb,"pt-BR");
    return String(a.nome).localeCompare(String(b.nome),"pt-BR",{sensitivity:"base"});
  });
}
function psTag(classe){
  if(classe==="PS Operações") return '<span class="type-tag tag-ps-op">PS Operações</span>';
  if(classe==="PS ICQA") return '<span class="type-tag tag-ps-icqa">PS ICQA</span>';
  return classe?'<span class="type-tag tag-esc">'+classe+'</span>':"";
}
function setSel(id,val){
  var el=document.getElementById(id); val=val||"";
  var ok=false; for(var i=0;i<el.options.length;i++){ if(el.options[i].value===val){ok=true;break;} }
  if(!ok){ var o=document.createElement("option"); o.value=val; o.textContent=val; el.appendChild(o); }
  el.value=val;
}
function ballSvg(c){
  return '<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="14" r="12" fill="white" stroke="#ccc" stroke-width=".5"/>'
    +'<polygon points="14,4 17.5,9 13,12.5 9.5,9" fill="'+c+'" opacity=".92"/>'
    +'<polygon points="14,24 10.5,19 15,15.5 18.5,19" fill="'+c+'" opacity=".92"/>'
    +'<polygon points="4,10 8.5,9 10,13.5 5.5,15.5" fill="'+c+'" opacity=".92"/>'
    +'<polygon points="24,10 19.5,9 18,13.5 22.5,15.5" fill="'+c+'" opacity=".92"/></svg>';
}

// ═══════════════════════════════════════
//  LOADING & TOAST & ALERTS
// ═══════════════════════════════════════
function showLoad(m){ document.getElementById("ovl-msg").textContent=m||"Carregando…"; document.getElementById("ovl").classList.add("on"); }
function hideLoad(){ document.getElementById("ovl").classList.remove("on"); }
var _tt;
function toast(m){ var el=document.getElementById("toast"); el.textContent=m; el.classList.add("on"); clearTimeout(_tt); _tt=setTimeout(function(){el.classList.remove("on");},2800); }
function showAlt(id,m,t){ var el=document.getElementById(id); if(!el)return; var ic={ok:"✓",err:"⚠",info:"ℹ"}; el.className="alt a-"+t+" on"; el.innerHTML=(ic[t]||"")+" "+m; if(t!=="info")setTimeout(function(){hideAlt(id);},4000); }
function hideAlt(id){ var el=document.getElementById(id); if(el){el.className="alt";el.innerHTML="";} }

// ═══════════════════════════════════════
//  CARREGAR DADOS
// ═══════════════════════════════════════
function onData(d) {
  S.mes=d.mes; S.ano=d.ano; S.reps=d.reps;
  S.ranking=d.ranking; S.rankingREP=d.rankingREP; S.rankingOP=d.rankingOP;
  S.hlArrays=d.hlArrays||[];
  S.hlArraysOP=d.hlArraysOP||[];
  S.rankingOPFull=d.rankingOPFull||[];
  S.years=d.years; S.updated=d.updated;
  callApi("getEntries", {}, function(de){
    hideLoad();
    S.entries = de.entries || [];
    render();
  }, function(e){ hideLoad(); toast("⚠ Histórico: "+e); render(); });
}

function loadData() {
  showLoad("Carregando dados…");
  callApi("getData", {}, onData, function(e){ hideLoad(); toast("⚠ "+e); });
}

// ═══════════════════════════════════════
//  SELECTORS
// ═══════════════════════════════════════
function initSels() {
  var years = S.years && S.years.length ? S.years : [String(new Date().getFullYear())];
  ["hdr-mes","f-mes","dest-mes"].forEach(function(id){
    var el=document.getElementById(id); if(!el)return;
    var cur=el.value||S.mes;
    el.innerHTML=MESES.map(function(m){return '<option value="'+m+'"'+(m===cur?" selected":"")+'>'+m+'</option>';}).join("");
  });
  ["hdr-ano","f-ano","dest-ano"].forEach(function(id){
    var el=document.getElementById(id); if(!el)return;
    var cur=el.value||S.ano;
    el.innerHTML=years.map(function(y){return '<option value="'+y+'"'+(y===cur?" selected":"")+'>'+y+'</option>';}).join("");
  });
  // Filtros do histórico
  var histMesEl=document.getElementById("hist-fmes");
  var histAnoEl=document.getElementById("hist-fano");
  if(histMesEl){
    var curHM=histMesEl.value||"todos";
    histMesEl.innerHTML='<option value="todos">Todos os meses</option>'+MESES.map(function(m){return '<option value="'+m+'"'+(m===curHM?' selected':'')+'>'+m+'</option>';}).join("");
  }
  if(histAnoEl){
    var years2=S.years&&S.years.length?S.years:[String(new Date().getFullYear())];
    var curHA=histAnoEl.value||"todos";
    histAnoEl.innerHTML='<option value="todos">Todos os anos</option>'+years2.map(function(y){return '<option value="'+y+'"'+(y===curHA?' selected':'')+'>'+y+'</option>';}).join("");
  }
  var repEl=document.getElementById("f-rep");
  var curRep=repEl.value;
  var repsNorm=(S.reps||[]).map(function(r){
    if(typeof r==="string") return {nome:r,tipo:"REP",escala:"",classe:""};
    return {nome:(r&&r.nome)||"",tipo:(r&&r.tipo)||"REP",escala:(r&&r.escala)||"",classe:(r&&r.classe)||""};
  }).filter(function(r){ return r.nome; });
  repsNorm=sortReps(repsNorm);
  if(!repsNorm.length){
    repEl.innerHTML='<option value="" disabled selected>Nenhum REP cadastrado</option>';
  } else {
    repEl.innerHTML=repsNorm.map(function(r){
      var extra=(r.escala?" · Escala "+r.escala:"")+(r.classe?" · "+r.classe:"");
      return '<option value="'+r.nome+'">'+r.nome+' ('+r.tipo+extra+')</option>';
    }).join("");
    if(curRep){ for(var i=0;i<repsNorm.length;i++){ if(repsNorm[i].nome===curRep){repEl.value=curRep;break;} } }
  }
}

function buildTaskGrid(){
  document.getElementById("tgrid").innerHTML=TASKS.map(function(t,i){
    return '<div class="tinp"><div class="tlbl" style="color:'+TC[i]+'">'+t+'</div><input type="number" min="0" id="ti-'+i+'" placeholder="0"></div>';
  }).join("");
}

// ═══════════════════════════════════════
//  RENDERS
// ═══════════════════════════════════════
function renderKPIs(){
  var r=S.ranking||[],leader=r[0];
  var cnt=(S.entries||[]).filter(function(e){return e.mes===S.mes&&String(e.ano)===String(S.ano);}).length;
  var kpisEl=document.getElementById("kpis"); if(!kpisEl) return;
  kpisEl.innerHTML=
    '<div class="kpi ky"><div class="kl">Líder geral</div><div class="kv" style="font-size:18px">'+(leader?leader.nome.split(" ")[0]:"—")+'</div><div class="kh">'+(leader&&leader.total?leader.total+" pts":"sem dados")+'</div></div>'
   +'<div class="kpi kbl"><div class="kl">REPs</div><div class="kv">'+(S.rankingREP||[]).length+'</div><div class="kh">participantes</div></div>'
   +'<div class="kpi kgr"><div class="kl">Operadores</div><div class="kv">'+(S.rankingOP||[]).length+'</div><div class="kh">participantes</div></div>'
   +'<div class="kpi kam"><div class="kl">Lançamentos</div><div class="kv">'+cnt+'</div><div class="kh">no período</div></div>';
}

function buildPodium(list,cid){
  var el=document.getElementById(cid); if(!el) return;
  if(!list||!list.length){ el.innerHTML='<div class="podium-empty">Sem dados.</div>'; return; }
  var order=[list[1]||null, list[0]||null, list[2]||null];
  var pos=[2,1,3], bCls=["b2","b1","b3"], sz=[46,54,42];
  var html='<div class="podium">';
  for(var i=0;i<3;i++){
    var r=order[i],p=pos[i],s=sz[i];
    if(!r){ html+='<div class="podium-item"><div style="height:'+(s+20)+'px"></div><div class="podium-base '+bCls[i]+'">'+p+'º</div></div>'; continue; }
    var col=avci(r.nome),isOp=r.tipo==="Operador de Máquina";
    html+='<div class="podium-item"><div style="font-size:20px">'+MEDALS[p-1]+'</div>'
      +'<div class="podium-avatar p'+p+'" style="background:'+col+';width:'+s+'px;height:'+s+'px;font-size:'+(s*.28)+'px">'+ini(r.nome)+'</div>'
      +'<div class="podium-name">'+r.nome+'</div>'
      +'<span class="type-tag '+(isOp?"tag-op":"tag-rep")+'">'+(isOp?"Operador":"REP")+'</span>'
      +'<div class="podium-score">'+r.total+' pts</div>'
      +'<div class="podium-base '+bCls[i]+'">'+p+'º</div>'
      +'</div>';
  }
  html+='</div>';
  if(list.length>3){
    html+='<div style="display:flex;flex-direction:column;gap:6px;margin-top:12px">';
    for(var j=3;j<list.length;j++){
      var r2=list[j],col2=avci(r2.nome);
      html+='<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;background:var(--surf);border-radius:var(--r2);border:1px solid var(--bor)">'
        +'<div style="font-size:14px;min-width:26px;text-align:center;color:var(--t2)">'+(j+1)+'º</div>'
        +'<div class="av" style="background:'+col2+'">'+ini(r2.nome)+'</div>'
        +'<div style="flex:1;font-size:13px;font-weight:500">'+r2.nome+'</div>'
        +'<div style="font-family:\'Space Mono\',monospace;font-size:13px;font-weight:700;color:var(--bl)">'+r2.total+'</div>'
        +'</div>';
    }
    html+='</div>';
  }
  el.innerHTML=html;
  // Force browser reflow so animation fires even if already rendered once
  el.querySelectorAll(".podium-item").forEach(function(item,i){
    item.style.animation="none";
    item.offsetHeight; // trigger reflow
    item.style.animation="";
    item.style.animationDelay=(i*0.12)+"s";
  });
}

function renderPodio(){
  document.getElementById("podio-per").textContent=S.mes+" "+S.ano+" · Turno "+Storage.getTurno();
  buildPodium(S.ranking,"podio-geral");
  buildPodium(S.rankingREP,"podio-rep");
  buildPodium(S.rankingOP,"podio-op");
}

function renderDestaques(){
  document.getElementById("dest-sub").textContent =
    "Top 3 — "+ S.mes +" "+ S.ano +" · todos os participantes";
  document.getElementById("op-rank-sub").textContent =
    "Produtividade acumulada (melhor semana) — "+ S.mes +" "+ S.ano;

  var COLS = ["#185FA5","#3B6D11","#854F0B","#993556","#0F6E56"];
  var BGLT = ["#E6F1FB","#EAF3DE","#FAEEDA","#FCEBEB","#E6F6F0"];
  var ICONS= ["📦","📥","📦","🔍","✈️"];

  // ── helper que gera grid de cards ──────────────────────────────
  function buildHlGrid(arrOfArrays, containerId) {
    var html = "";
    TASKS.forEach(function(t, ti){
      var list = (arrOfArrays && arrOfArrays[ti]) ? arrOfArrays[ti] : [];
      var col  = COLS[ti] || "#444";
      var bg   = BGLT[ti] || "#F5F5F5";

      html += '<div class="hl-card" style="animation-delay:'+(ti*0.08)+'s">';
      // Header com cor da tarefa
      html += '<div class="hl-hdr" style="background:'+col+'">'+ ICONS[ti] +' '+ t +'</div>';
      html += '<div class="hl-body">';

      if (!list.length) {
        html += '<div class="hl-empty">Sem dados para este período</div>';
      } else {
        list.forEach(function(r, i){
          var rCol = avci(r.nome);
          var pct  = list[0].val > 0 ? Math.round(r.val / list[0].val * 100) : 0;
          var isOp = r.tipo === "Operador de Máquina";
          html += '<div class="hl-row" style="animation:hlRowIn .35s ease '+(i*0.07)+'s both">';
          html += '<div class="hl-pos">'+ MEDALS[i] +'</div>';
          html += '<div class="hl-av" style="background:'+rCol+'">'+ ini(r.nome) +'</div>';
          html += '<div class="hl-info">';
          html += '<div class="hl-name">'+ r.nome +'</div>';
          html += '<div class="hl-sem">';
          html += '<span class="type-tag '+(isOp?"tag-op":"tag-rep")+'">'+(isOp?"Op.":"REP")+'</span>';
          if (r.cargo) html += ' · <span style="font-size:10px;font-weight:600;color:var(--am)">'+r.cargo+'</span>';
          if (r.bestSem) html += ' S'+r.bestSem;
          html += '</div>';
          // Mini progress bar inside row
          html += '<div style="height:2px;background:var(--bor);border-radius:1px;margin-top:4px;overflow:hidden">';
          html += '<div style="height:100%;width:'+pct+'%;background:'+col+';border-radius:1px;transition:width .8s ease"></div>';
          html += '</div>';
          html += '</div>';
          html += '<div class="hl-score" style="color:'+col+'">'+ r.val +'</div>';
          html += '</div>'; // hl-row
        });
      }

      html += '</div>'; // hl-body
      html += '</div>'; // hl-card
    });

    document.getElementById(containerId).innerHTML = html;
    // Trigger reflow for animations
    document.querySelectorAll("#"+containerId+" .hl-card").forEach(function(el){
      el.offsetHeight;
    });
  }

  // Geral
  buildHlGrid(S.hlArrays,   "hl-grid");
  // Operadores
  buildHlGrid(S.hlArraysOP, "hl-grid-op");

  // ── Ranking de Operadores ─────────────────────────────────────
  var ops = S.rankingOPFull || [];
  var opEl = document.getElementById("op-rank-list");
  if (!ops.length) {
    opEl.innerHTML = '<div class="empty"><div class="empi">🔧</div><p>Nenhum Operador de Máquina cadastrado<br>ou sem dados neste período.</p></div>';
  } else {
    var maxOP = Math.max.apply(null, [1].concat(ops.map(function(r){ return r.total; })));
    var html  = '<div style="display:flex;flex-direction:column;gap:9px">';
    ops.forEach(function(r, i){
      var col  = avci(r.nome);
      var pct  = Math.round(r.total / maxOP * 100);
      var cls  = i===0?"op1":i===1?"op2":i===2?"op3":"";
      var tags = TASKS.map(function(t, ti){
        return '<span class="ttag" style="border-color:'+COLS[ti]+'55;color:'+COLS[ti]+'">'+ t +': '+(r[t]||0)+'</span>';
      }).join("");

      html += '<div class="op-rank-row '+cls+'" style="animation-delay:'+(i*0.07)+'s">';
      html += '<div class="op-rank-pos">'+(MEDALS[i]||(i+1)+"º")+'</div>';
      html += '<div class="av" style="background:'+col+';flex-shrink:0">'+ ini(r.nome) +'</div>';
      html += '<div class="op-rank-info">';
      html += '<div class="op-rank-name">'+ r.nome +'</div>';
      if(r.cargo){ html += '<div style="font-size:10px;font-weight:600;color:var(--am);margin-top:1px">'+r.cargo+'</div>'; }
      html += '<div class="op-rank-tasks">'+ tags +'</div>';
      html += '<div class="op-rank-bar-w"><div class="op-rank-bar" style="width:'+pct+'%"></div></div>';
      html += '</div>';
      html += '<div>';
      html += '<div class="op-rank-score">'+ r.total +'</div>';
      html += '<div class="op-rank-pts">pts</div>';
      if (r.bestSem) html += '<div style="font-size:10px;color:var(--t3)">S'+r.bestSem+'</div>';
      html += '</div>';
      html += '</div>'; // op-rank-row
    });
    html += '</div>';
    opEl.innerHTML = html;
  }
}

function buildRkTable(list,tbId){
  var el=document.getElementById(tbId); if(!el) return;
  if(!list||!list.length){ el.innerHTML='<tbody><tr><td colspan="'+(TASKS.length+4)+'" style="padding:18px;text-align:center;color:var(--t3)">Sem dados.</td></tr></tbody>'; return; }
  var maxV=Math.max.apply(null,[1].concat(list.map(function(r){return r.total;})));
  var html='<thead><tr><th>Pos.</th><th>Nome</th>'+TASKS.map(function(t){return '<th>'+t+'</th>';}).join('')+'<th>Melhor S.</th><th>Total</th></tr></thead><tbody>';
  list.forEach(function(r,i){
    var col=avci(r.nome),pct=Math.round(r.total/maxV*100);
    var cls=i===0?"rk1":i===1?"rk2":i===2?"rk3":"";
    html+='<tr class="'+cls+'"><td class="rk-pos">'+(MEDALS[i]||(i+1)+"º")+'</td>'
      +'<td><div class="rk-rep"><div class="av" style="background:'+col+'">'+ini(r.nome)+'</div>'
        +'<div><div>'+r.nome+'</div>'+(r.cargo?'<div style="font-size:10px;color:var(--am);font-weight:600">'+r.cargo+'</div>':'')+'</div>'
        +'</div></td>'
      +TASKS.map(function(t){return '<td style="font-family:\'Space Mono\',monospace;font-size:12px">'+(r[t]||0)+'</td>';}).join('')
      +'<td style="color:var(--t2);font-size:12px">'+(r.bestSem?"S"+r.bestSem:"—")+'</td>'
      +'<td class="rk-score">'+r.total+'<span class="rk-bar-w"><span class="rk-bar" style="width:'+pct+'%;background:'+col+'"></span></span></td>'
      +'</tr>';
  });
  document.getElementById(tbId).innerHTML=html+'</tbody>';
}

function renderRanking(){
  document.getElementById("rank-per").textContent=S.mes+" "+S.ano;
  buildRkTable(S.ranking,"rk-all");
  buildRkTable(S.rankingREP,"rk-rep");
  buildRkTable(S.rankingOP,"rk-op");
  // Stagger animation for all rows
  document.querySelectorAll(".rk-table tbody tr").forEach(function(row,i){
    row.style.animation="none"; row.offsetHeight;
    row.style.animation="up .35s ease "+(i*0.05)+"s both";
  });
}

function renderHist(){
  var all=(S.entries||[]).slice().reverse();
  // Filtro de período
  var fMes=document.getElementById("hist-fmes") ? document.getElementById("hist-fmes").value : "todos";
  var fAno=document.getElementById("hist-fano") ? document.getElementById("hist-fano").value : "todos";
  var rows = all.filter(function(e){
    if(fMes!=="todos" && e.mes!==fMes) return false;
    if(fAno!=="todos" && String(e.ano)!==fAno) return false;
    return true;
  });
  document.getElementById("hist-sub").textContent=rows.length+" de "+all.length+" registro"+(all.length!==1?"s":"");
  if(!rows.length){ document.getElementById("htbl").innerHTML='<tbody><tr><td colspan="'+(TASKS.length+4)+'" style="padding:28px;text-align:center;color:var(--t3)">Nenhum lançamento.</td></tr></tbody>'; return; }
  var html='<thead><tr><th>REP</th><th>Tipo</th><th>Período</th><th>Sem.</th>'+TASKS.map(function(t){return '<th>'+t+'</th>';}).join('')+'<th>Total</th><th></th></tr></thead><tbody>';
  rows.forEach(function(e){
    var tot=TASKS.reduce(function(s,t){ var v=parseInt(e[t]); return s+(isNaN(v)?0:v); },0),tipo=repTipo(e.rep);
    html+='<tr><td><strong>'+e.rep+'</strong></td><td><span class="type-tag '+(tipo==="Operador de Máquina"?"tag-op":"tag-rep")+'">'+( tipo==="Operador de Máquina"?"Op.":"REP")+'</span></td><td>'+e.mes+' '+e.ano+'</td><td>S'+e.sem+'</td>'
      +TASKS.map(function(t){ var v=parseInt(e[t]); return '<td>'+(isNaN(v)?0:v)+'</td>'; }).join('')
      +'<td><strong>'+tot+'</strong></td>'
      +'<td style="white-space:nowrap"><button class="tbi ted" data-click="editEntry(\''+e.id+'\')">✏</button><button class="tbi tdl" data-click="delEntry(\''+e.id+'\')">🗑</button></td></tr>';
  });
  document.getElementById("htbl").innerHTML=html+'</tbody>';
}

function renderReps(){
  var reps=S.reps||[];
  var el=document.getElementById("rmgr");
  if(!el) return;  // guard: element not in DOM yet
  var rcEl = document.getElementById("reps-count");
  if(rcEl) rcEl.textContent =
    reps.length + " membro" + (reps.length!==1?"s":"") + " cadastrado" + (reps.length!==1?"s":"");

  if(!reps.length){
    el.innerHTML='<div class="empty"><div class="empi">👥</div><p>Nenhum REP cadastrado ainda.<br>Use o formulário abaixo para adicionar.</p></div>';
    return;
  }

  var sorted=sortReps(reps), groups=[], gi={};
  sorted.forEach(function(r){
    var k=r.escala||"";
    if(!(k in gi)){ gi[k]=groups.length; groups.push({k:k,list:[]}); }
    groups[gi[k]].list.push(r);
  });

  var html='<div style="display:flex;flex-direction:column;gap:10px">';
  groups.forEach(function(g){
    html += '<div class="esc-head">'+(g.k?"Escala "+g.k:"Sem escala")+' <span class="esc-n">· '+g.list.length+' '+(g.list.length!==1?"membros":"membro")+'</span></div>';
    g.list.forEach(function(r){
      var isOp = r.tipo==="Operador de Máquina";
      var col  = avci(r.nome);
      var tagCls = isOp?"tag-op":"tag-rep";
      var tagTxt = isOp?"Operador de Máquina":"REP";

      html += '<div class="rep-card">';
      html += '<div class="av" style="background:'+col+';width:44px;height:44px;font-size:14px;flex-shrink:0">'+ini(r.nome)+'</div>';
      html += '<div class="rep-card-info">';
      html += '<div class="rep-card-name">'+r.nome+'</div>';
      html += '<div class="rep-card-meta">';
      html += '<span class="type-tag '+tagCls+'">'+tagTxt+'</span>';
      html += psTag(r.classe);
      if(r.cargo){
        html += '<span class="rep-card-cargo">'+r.cargo+'</span>';
      }
      html += '</div>';
      html += '</div>';
      html += '<div style="display:flex;gap:6px;flex-shrink:0">';
      html += '<button class="btn btn-sm" style="font-size:12px" data-click="openEditModal(\''+r.nome.replace(/\'/g,"\\'")+'\')" title="Editar">✏️ Editar</button>';
      html += '<button class="btn btn-d btn-sm" data-click="removeRep(\''+r.nome.replace(/\'/g,"\\'")+'\')">🗑</button>';
      html += '</div>';
      html += '</div>'; // rep-card
    });
  });
  html += '</div>';
  el.innerHTML = html;
}

// ═══════════════════════════════════════
//  DESTAQUE DO MÊS
// ═══════════════════════════════════════
function loadDestaques(){
  callApi("getDestaques", {}, function(d){
    SD.historico=d.historico||[];
    renderHistDest();
  }, function(e){ toast("⚠ "+e); });
}

function calcDestaque(){
  var mes=document.getElementById("dest-mes").value;
  var ano=document.getElementById("dest-ano").value;
  var obs=document.getElementById("dest-obs").value;
  if(!mes||!ano){ showAlt("dest-alt","Selecione mês e ano.","err"); return; }
  var btn=document.getElementById("btn-calc"); btn.disabled=true;
  showLoad("Calculando destaque de "+mes+"/"+ano+"…");
  callApi("calcDestaque",{mes:mes,ano:ano,observacao:obs},
    function(r){ btn.disabled=false; hideLoad(); showAlt("dest-alt","✓ "+r.msg,"ok"); toast("🌟 Destaque salvo!"); renderDestiquePreview(r.registro); loadDestaques(); },
    function(e){ btn.disabled=false; hideLoad(); showAlt("dest-alt","⚠ "+e,"err"); }
  );
}

function renderDestiquePreview(reg){
  var el=document.getElementById("dest-preview");
  if(!reg||!reg.geral){ el.innerHTML=""; return; }
  el.innerHTML='<div class="card">'+buildRegHTML(reg,true)+'</div>';
}

function buildRegHTML(reg,isPreview){
  if(!reg) return "";
  var g=reg.geral, colG=g?avci(g.nome):"#888";
  var html='';
  // Hero
  html+='<div class="dest-hero">';
  html+='<div class="dest-hero-lbl">🏆 Destaque Geral — '+reg.mes+' '+reg.ano+'</div>';
  if(g){
    html+='<div class="dest-hero-name">'+g.nome+'</div>';
    html+='<div class="dest-hero-sub">'+(g.tipo==="Operador de Máquina"?"Operador de Máquina":"REP")+'</div>';
    html+='<div class="dest-hero-score">'+g.vitorias+'</div>';
    html+='<div class="dest-hero-score-lbl">vitórias de tarefa · total: '+g.total+' pts</div>';
    html+='<div class="dest-trophy">🏆</div>';
  } else { html+='<div class="dest-hero-name" style="color:rgba(255,255,255,.4)">Sem dados</div>'; }
  html+='</div>';
  // Tipo
  html+='<div class="dest-type-row">';
  var tipos=[{k:"destREP",lbl:"🏅 Melhor REP",cls:"tag-rep"},{k:"destOP",lbl:"🏅 Melhor Operador",cls:"tag-op"}];
  tipos.forEach(function(typ){
    var r=reg[typ.k];
    html+='<div class="dest-type-card"><div class="dest-type-title">'+typ.lbl+'</div>';
    if(r){
      var col=avci(r.nome);
      html+='<div class="dest-type-winner"><div class="av" style="background:'+col+';width:36px;height:36px">'+ini(r.nome)+'</div>'
        +'<div><div style="font-size:13px;font-weight:600">'+r.nome+'</div>'
        +'<div style="font-family:\'Space Mono\',monospace;font-size:16px;font-weight:700;color:var(--bl)">'+r.total+' <span style="font-size:10px;font-weight:400;color:var(--t3)">pts</span></div></div></div>';
    } else { html+='<div style="font-size:12px;color:var(--t3);padding:8px 0">Sem participantes</div>'; }
    html+='</div>';
  });
  html+='</div>';
  // Por tarefa
  html+='<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--t2);margin-bottom:10px">⭐ Destaques por Tarefa</div>';
  html+='<div class="dest-tasks-grid">';
  var tcBg=["#E6F1FB","#EAF3DE","#FAEEDA","#FCEBEB","#E6F6F0"];
  var tcCol=["#185FA5","#3B6D11","#854F0B","#993556","#0F6E56"];
  var icons=["📦","📥","📦","🔍","✈️"];
  TASKS.forEach(function(t,ti){
    var w=(reg.porTarefa&&Array.isArray(reg.porTarefa))?reg.porTarefa[ti]:(reg.porTarefa&&reg.porTarefa[t]);
    html+='<div class="dest-tc" style="background:'+tcBg[ti]+';border-color:'+tcCol[ti]+'33">'
      +'<div class="dest-tc-lbl" style="color:'+tcCol[ti]+'">'+icons[ti]+' '+t+'</div>';
    if(w){
      var col=avci(w.nome);
      html+='<div class="dest-tc-row"><div class="av" style="background:'+col+';width:26px;height:26px;font-size:9px;flex-shrink:0">'+ini(w.nome)+'</div>'
        +'<div class="dest-tc-name">'+w.nome+'</div>'
        +'<div class="dest-tc-score" style="color:'+tcCol[ti]+'">'+w.vitorias+'x</div></div>'
        +'<div style="font-size:10px;color:var(--t3);margin-top:2px">'+w.vitorias+' semana'+(w.vitorias!==1?'s':'')+' em 1º lugar</div>';
    } else { html+='<div style="font-size:12px;color:var(--t3)">Sem dados</div>'; }
    html+='</div>';
  });
  html+='</div>';
  // Top 10
  var ranking=reg.ranking||[];
  if(ranking.length){
    html+='<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--t2);margin-bottom:10px">📊 Top '+Math.min(10,ranking.length)+'</div>';
    html+='<div class="top-mini">';
    ranking.forEach(function(r,i){
      var col=avci(r.nome);
      html+='<div class="top-mini-row"><div class="top-mini-pos">'+(MEDALS[i]||(i+1)+'º')+'</div>'
        +'<div class="av" style="background:'+col+';width:24px;height:24px;font-size:8px;flex-shrink:0">'+ini(r.nome)+'</div>'
        +'<div class="top-mini-name">'+r.nome+'</div>'
        +'<span class="type-tag '+(r.tipo==="Operador de Máquina"?"tag-op":"tag-rep")+'" style="flex-shrink:0">'+(r.tipo==="Operador de Máquina"?"Op.":"REP")+'</span>'
        +'<div class="top-mini-score">'+r.vitorias+'x</div></div>';
    });
    html+='</div>';
  }
  if(reg.observacao){ html+='<div class="hist-obs" style="margin-top:14px">💬 '+reg.observacao+'</div>'; }
  html+='<div class="hist-gen" style="margin-top:8px">Gerado em: '+reg.geradoEm+' · '+reg.totalReps+' participante'+(reg.totalReps!==1?'s':'')+'</div>';
  if(!isPreview){
    html+='<div style="margin-top:10px"><button class="btn btn-d btn-sm" data-click="delDestaque(\''+reg.id+'\')">🗑 Remover do histórico</button></div>';
  }
  return html;
}

function renderHistDest(){
  var hist=SD.historico||[];
  document.getElementById("dest-hist-sub").textContent=hist.length+" registro"+(hist.length!==1?"s":"")+" (últimos 24 meses)";
  if(!hist.length){ document.getElementById("dest-hist-list").innerHTML='<div class="empty"><div class="empi">🌟</div><p>Nenhum destaque salvo ainda.<br>Use o painel acima para gerar.</p></div>'; return; }
  var html="";
  hist.forEach(function(reg,idx){
    var g=reg.geral,col=g?avci(g.nome):"#888";
    html+='<div class="hist-card"><div class="hist-hdr" data-click="toggleHist(\'hb-'+idx+'\')">'
      +'<div style="font-size:20px">🌟</div><div class="hist-month">'+reg.mes+' '+reg.ano+'</div>';
    if(g){ html+='<div class="hist-chip"><div class="av" style="background:'+col+'">'+ini(g.nome)+'</div><div class="hist-chip-name">'+g.nome+'</div></div>'; }
    html+='<div style="font-size:12px;color:var(--t2);margin-left:8px">▾</div>'
      +'</div><div class="hist-body" id="hb-'+idx+'">'+buildRegHTML(reg,false)+'</div></div>';
  });
  document.getElementById("dest-hist-list").innerHTML=html;
  var first=document.getElementById("hb-0"); if(first) first.classList.add("open");
}

function toggleHist(id){ var el=document.getElementById(id); if(el) el.classList.toggle("open"); }

function delDestaque(id){
  askConfirm("Remover este destaque do histórico?", function(){
    showLoad("Removendo…");
    callApi("delDestaque",{id:id},
      function(){ hideLoad(); toast("Removido."); loadDestaques(); },
      function(e){ hideLoad(); toast("⚠ "+e); }
    );
  });
}

// ═══════════════════════════════════════
//  RENDER PRINCIPAL
// ═══════════════════════════════════════
function render(){
  initSels(); renderKPIs(); renderPodio(); renderDestaques(); renderRanking(); renderHist(); renderReps();
  document.getElementById("upd-bar") && (document.getElementById("upd-bar").textContent="Atualizado: "+(S.updated||"—")+" · Turno "+Storage.getTurno()+" · Dados: "+Storage.info().mode);
  if(Storage.info().notice && !window.__noticeShown){ window.__noticeShown=true; showAlt("bk-alt",Storage.info().notice,"err"); toast("⚠ Dados salvos só neste navegador. Veja a aba Backup."); }
}

// ═══════════════════════════════════════
//  NAVEGAÇÃO
// ═══════════════════════════════════════
function goTab(id,el){
  document.querySelectorAll(".sec").forEach(function(s){s.classList.remove("on");});
  document.querySelectorAll(".tb").forEach(function(b){b.classList.remove("on");});
  document.getElementById("sec-"+id).classList.add("on"); el.classList.add("on");
  window.scrollTo({top:0,behavior:"smooth"});
  if(id==="podio")   { renderPodio(); }
  if(id==="dest")    { renderDestaques(); }
  if(id==="ranking") { renderRanking(); }
  if(id==="hist")    { renderHist(); }
  if(id==="reps")    { renderReps(); }
  if(id==="destmes") { loadDestaques(); }
}

function changeTurno(){
  var t=document.getElementById("hdr-turno").value;
  Storage.setTurno(t);
  // cada turno tem o seu próprio período e reps: limpa os seletores para recarregar do turno
  ["hdr-mes","f-mes","dest-mes","hdr-ano","f-ano","dest-ano","f-rep"].forEach(function(id){ var el=document.getElementById(id); if(el) el.innerHTML=""; });
  S.entries=[]; S.reps=[];
  showLoad("Carregando turno "+t+"…");
  loadData();
}

function changePeriod(){
  var mes=document.getElementById("hdr-mes").value,ano=document.getElementById("hdr-ano").value;
  document.getElementById("f-mes").value=mes; document.getElementById("f-ano").value=ano;
  showLoad("Mudando período…");
  callApi("period",{mes:mes,ano:ano},function(){ loadData(); },function(e){ hideLoad(); toast("⚠ "+e); });
}

// ═══════════════════════════════════════
//  FORM
// ═══════════════════════════════════════
function saveEntry(){
  var rep=document.getElementById("f-rep").value,mes=document.getElementById("f-mes").value;
  var ano=document.getElementById("f-ano").value,sem=document.getElementById("f-sem").value;
  if(!rep){ showAlt("falt","Selecione um REP.","err"); return; }
  var p={rep:rep,mes:mes,ano:ano,sem:sem};
  if(S.editId) p.id=S.editId;
  TASKS.forEach(function(t,i){ p["t"+i]=parseInt(document.getElementById("ti-"+i).value)||0; });
  var tot=TASKS.reduce(function(s,t,i){return s+(parseInt(p["t"+i])||0);},0);
  if(!tot&&!S.editId){ showAlt("falt","Insira ao menos uma tarefa.","err"); return; }
  var btn=document.getElementById("btn-sv"); btn.disabled=true;
  showLoad("Salvando…");
  callApi("save",p,
    function(r){ btn.disabled=false; hideLoad(); S.editId=null; document.getElementById("ftitle").textContent="Lançar produtividade"; clearForm(); showAlt("falt","✓ "+r.msg,"ok"); toast("✓ Salvo!"); loadData(); },
    function(e){ btn.disabled=false; hideLoad(); showAlt("falt","⚠ "+e,"err"); }
  );
}

function editEntry(id){
  var e=(S.entries||[]).filter(function(x){return x.id===id;})[0]; if(!e) return;
  S.editId=id;
  document.getElementById("f-rep").value=e.rep; document.getElementById("f-mes").value=e.mes;
  document.getElementById("f-ano").value=e.ano; document.getElementById("f-sem").value=e.sem;
  TASKS.forEach(function(t,i){ var el=document.getElementById("ti-"+i); if(el) el.value=e[t]||""; });
  document.getElementById("ftitle").textContent="✏ Editando lançamento";
  goTab("inserir",document.querySelectorAll(".tb")[4]);
  showAlt("falt","Edite os valores e salve.","info");
}

function delEntry(id){
  askConfirm("Remover este lançamento?", function(){
    showLoad("Removendo…");
    callApi("del",{id:id},function(){ hideLoad(); toast("Removido."); loadData(); },function(e){ hideLoad(); toast("⚠ "+e); });
  });
}

function clearForm(){
  S.editId=null;
  TASKS.forEach(function(_,i){ var el=document.getElementById("ti-"+i); if(el) el.value=""; });
  document.getElementById("ftitle").textContent="Lançar produtividade"; hideAlt("falt");
}

// ═══════════════════════════════════════
//  REPS
// ═══════════════════════════════════════
function addRep(){
  var nome=document.getElementById("new-rep").value.trim();
  var tipo=document.getElementById("new-tipo").value;
  var cargo=(document.getElementById("new-cargo")||{}).value||"";
  cargo=cargo.trim();
  var escala=document.getElementById("new-escala").value;
  var classe=document.getElementById("new-classe").value;
  if(!nome){ showAlt("ralt","Digite um nome.","err"); return; }
  showLoad("Adicionando…");
  callApi("addRep",{nome:nome,tipo:tipo,cargo:cargo,escala:escala,classe:classe},
    function(){
      hideLoad();
      document.getElementById("new-rep").value="";
      if(document.getElementById("new-cargo")) document.getElementById("new-cargo").value="";
      toast(nome+" adicionado! ✓"); loadData();
    },
    function(e){ hideLoad(); showAlt("ralt","⚠ "+e,"err"); }
  );
}

function removeRep(nome){
  askConfirm("Remover \""+nome+"\"?", function(){
    showLoad("Removendo…"); callApi("delRep",{nome:nome},function(){ hideLoad(); toast(nome+" removido."); loadData(); },function(e){ hideLoad(); toast("⚠ "+e); });
  });
}

function toggleTipo(nome,novoTipo){
  showLoad("Atualizando…");
  callApi("editRep",{nome:nome,tipo:novoTipo},
    function(){ hideLoad(); toast(nome+" → "+novoTipo); loadData(); },
    function(e){ hideLoad(); toast("⚠ "+e); }
  );
}

// ── Modal de edição ──────────────────────────────────────────────
var _editNomeAtual = "";

function openEditModal(nome){
  // Encontra o REP nos dados
  var rep = null;
  (S.reps||[]).forEach(function(r){ if(r.nome===nome) rep=r; });
  if(!rep){ toast("REP não encontrado."); return; }

  _editNomeAtual = nome;
  document.getElementById("edit-nome").value  = rep.nome;
  document.getElementById("edit-tipo").value  = rep.tipo || "REP";
  document.getElementById("edit-cargo").value = rep.cargo || "";
  setSel("edit-escala", rep.escala);
  setSel("edit-classe", rep.classe);

  hideAlt("modal-alert");
  document.getElementById("modal-overlay").classList.add("on");
  setTimeout(function(){ document.getElementById("edit-nome").focus(); }, 120);
}

function closeModal(e){
  if(e && e.target !== document.getElementById("modal-overlay")) return;
  closeModalBtn();
}
function closeModalBtn(){
  document.getElementById("modal-overlay").classList.remove("on");
  hideAlt("modal-alert");
  _editNomeAtual = "";
}

function saveEditRep(){
  var novoNome  = document.getElementById("edit-nome").value.trim();
  var novoTipo  = document.getElementById("edit-tipo").value;
  var novoCargo = document.getElementById("edit-cargo").value.trim();
  var novaEscala = document.getElementById("edit-escala").value;
  var novaClasse = document.getElementById("edit-classe").value;
  if(!novoNome){ showAlt("modal-alert","Digite um nome.","err"); return; }

  var btn = document.getElementById("btn-modal-save");
  btn.disabled = true;
  showLoad("Salvando…");
  callApi("editRep",{nome:_editNomeAtual, novoNome:novoNome, tipo:novoTipo, cargo:novoCargo, escala:novaEscala, classe:novaClasse},
    function(){
      btn.disabled=false; hideLoad();
      closeModalBtn();
      toast("✓ "+novoNome+" atualizado!");
      loadData();
    },
    function(e){ btn.disabled=false; hideLoad(); showAlt("modal-alert","⚠ "+e,"err"); }
  );
}

// ═══════════════════════════════════════
//  DEBUG
// ═══════════════════════════════════════
function runDebug(){
  var box=document.getElementById("debug-box");
  box.style.display="block";
  box.textContent="Consultando servidor...";
  callApi("debug",{},
    function(r){
      box.textContent = "repCount: "+r.repCount
        +"\nentryCount: "+r.entryCount
        +"\nrankingCount: "+r.rankingCount
        +"\nhighlights: "+JSON.stringify(r.highlightKeys)
        +"\nperiodo: "+r.periodo
        +"\n\nS.ranking length: "+(S.ranking||[]).length
        +"\nS.highlights keys: "+JSON.stringify(Object.keys(S.highlights||{}))
        +"\nS.entries length: "+(S.entries||[]).length
        +"\nprimeiro entry: "+JSON.stringify(r.primeiroEntry);
    },
    function(e){ box.textContent="ERRO: "+e; }
  );
}

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
//  BACKUP
// ═══════════════════════════════════════
function backupGerar(){
  Storage.read().then(function(db){
    document.getElementById("bk-text").value = JSON.stringify(db, null, 2);
    showAlt("bk-alt","Backup gerado abaixo. Copie o texto e guarde em um arquivo.","ok");
  }).catch(function(e){ showAlt("bk-alt","Erro: "+e.message,"err"); });
}
function backupBaixar(){
  Storage.read().then(function(db){
    try {
      var blob = new Blob([JSON.stringify(db, null, 2)], {type:"application/json"});
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "corrida-produtividade-backup-"+Storage.getTurno()+".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showAlt("bk-alt","Se o download não iniciar, use \"Gerar backup\" e copie o texto.","info");
    } catch(e) { showAlt("bk-alt","Download bloqueado aqui. Use \"Gerar backup\" e copie o texto.","err"); }
  });
}
function backupRestaurar(){
  var parsed;
  try { parsed = JSON.parse(document.getElementById("bk-text").value); } catch(e) { showAlt("bk-alt","Texto inválido: cole um JSON.","err"); return; }
  if (!parsed || !parsed.meta || !Array.isArray(parsed.entries)) { showAlt("bk-alt","Formato esperado: {\"meta\":{...},\"entries\":[...]}","err"); return; }
  askConfirm("Substituir TODOS os dados do turno "+Storage.getTurno()+" por este backup?", function(){
    showLoad("Restaurando…");
    Storage.replaceAll(Engine.normalizeDb(parsed)).then(function(){
      hideLoad(); showAlt("bk-alt","Backup restaurado.","ok"); loadData();
    }).catch(function(e){ hideLoad(); showAlt("bk-alt","Erro: "+e.message,"err"); });
  });
}

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════

// ═══════════════════════════════════════
//  EVENTOS (delegados; sem JS inline no HTML)
// ═══════════════════════════════════════
function parseArgs(str, el, ev){
  var out=[], i=0, n=str.length;
  while(i<n){
    while(i<n && /[\s,]/.test(str[i])) i++;
    if(i>=n) break;
    if(str[i]==="'" || str[i]==='"'){
      var q=str[i++], v="";
      while(i<n && str[i]!==q){ if(str[i]==="\\" && i+1<n){ v+=str[i+1]; i+=2; } else { v+=str[i++]; } }
      i++; out.push(v);
    } else {
      var tok=str.slice(i).match(/^[^,\s]+/)[0]; i+=tok.length;
      out.push(tok==="this"?el:(tok==="event"?ev:tok));
    }
  }
  return out;
}
function runHandler(expr, el, ev){
  var m=String(expr).match(/^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/);
  if(!m || typeof window[m[1]]!=="function") return;
  window[m[1]].apply(null, parseArgs(m[2], el, ev));
}
document.addEventListener("click", function(e){ var el=e.target.closest("[data-click]"); if(el) runHandler(el.getAttribute("data-click"), el, e); });
document.addEventListener("change", function(e){ var el=e.target.closest("[data-change]"); if(el) runHandler(el.getAttribute("data-change"), el, e); });
document.addEventListener("keydown", function(e){ var el=e.target.closest("[data-enter]"); if(el && e.key==="Enter") runHandler(el.getAttribute("data-enter"), el, e); });

buildTaskGrid();
loadData();
setInterval(loadData, 60000);

Object.assign(window, { changeTurno, addRep, askConfirm, avc, avci, backupBaixar, backupGerar, backupRestaurar, ballSvg, buildPodium, buildRegHTML, buildRkTable, buildTaskGrid, calcDestaque, callApi, changePeriod, clearForm, closeModal, closeModalBtn, delDestaque, delEntry, editEntry, goTab, hideAlt, hideLoad, ini, initSels, loadData, loadDestaques, onData, openEditModal, parseArgs, removeRep, render, renderDestaques, renderDestiquePreview, renderHist, renderHistDest, renderKPIs, renderPodio, renderRanking, renderReps, repTipo, runDebug, runHandler, saveEditRep, saveEntry, showAlt, showLoad, toast, toggleHist, toggleTipo });
