(function(root){
  "use strict";

  // Dias marcados nos calendários enviados (Vermelho=A, Amarelo=B, Azul=C, Roxo=D), set–dez/2026.
  var MARCADOS = {
    A:{"2026-09":[1,2,7,13,19,20,24,25,29,30],"2026-10":[5,11,17,18,22,23,27,28],"2026-11":[2,8,14,15,19,20,24,25,30],"2026-12":[6,12,13,17,18,22,23,28]},
    B:{"2026-09":[6,12,13,17,18,22,23,28],"2026-10":[4,10,11,15,16,20,21,26],"2026-11":[1,7,8,12,13,17,18,23,29],"2026-12":[5,6,10,11,15,16,21,27]},
    C:{"2026-09":[5,6,10,11,15,16,21,27],"2026-10":[3,4,8,9,13,14,19,25,31],"2026-11":[1,5,6,10,11,16,22,28,29],"2026-12":[3,4,8,9,14,20,26,27,31]},
    D:{"2026-09":[3,4,8,9,14,20,26,27],"2026-10":[1,2,6,7,12,18,24,25,29,30],"2026-11":[3,4,9,15,21,22,26,27],"2026-12":[1,2,7,13,19,20,24,25,29,30]}
  };

  // Os calendários se repetem a cada 52 semanas, e cada escala é o ciclo da anterior deslocado em 13 semanas:
  // escala E no dia t == escala D no dia t + OFFSET[E]. Isso permite calcular datas fora de set–dez/2026.
  var CICLO = 364;
  var OFFSET = {A:91, B:182, C:273, D:0};
  var EPOCH = Date.UTC(2026, 8, 1);
  var DAY = 86400000;
  var PRIMEIRO_MES = "2026-09", ULTIMO_MES = "2026-12";

  function mod(x, n){ return ((x % n) + n) % n; }
  function parseISO(iso){
    var p = String(iso||"").split("-");
    return Date.UTC(Number(p[0]), Number(p[1])-1, Number(p[2]));
  }
  function diasDesdeEpoch(iso){ return Math.round((parseISO(iso) - EPOCH) / DAY); }
  function toISO(ms){
    var d = new Date(ms);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth()+1).padStart(2,"0") + "-" + String(d.getUTCDate()).padStart(2,"0");
  }
  function addDays(iso, n){ return toISO(parseISO(iso) + n*DAY); }
  function diasNoMes(ano, mes){ return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); }

  var BASE = new Array(CICLO);
  var conflitos = [];
  Object.keys(MARCADOS).forEach(function(esc){
    Object.keys(MARCADOS[esc]).forEach(function(mk){
      var ano = Number(mk.slice(0,4)), mes = Number(mk.slice(5,7));
      for(var d=1; d<=diasNoMes(ano, mes); d++){
        var iso = mk + "-" + String(d).padStart(2,"0");
        var marcado = MARCADOS[esc][mk].indexOf(d) > -1;
        var idx = mod(diasDesdeEpoch(iso) + OFFSET[esc], CICLO);
        if(BASE[idx] !== undefined && BASE[idx] !== marcado) conflitos.push(esc + " " + iso);
        BASE[idx] = marcado;
      }
    });
  });

  function isMarcado(esc, iso){
    if(!(esc in OFFSET)) return false;
    return BASE[mod(diasDesdeEpoch(iso) + OFFSET[esc], CICLO)] === true;
  }
  function foraDosCalendarios(iso){
    var mk = String(iso).slice(0,7);
    return mk < PRIMEIRO_MES || mk > ULTIMO_MES;
  }

  root.EscalaCal = {
    ESCALAS: ["A","B","C","D"],
    isMarcado: isMarcado,
    foraDosCalendarios: foraDosCalendarios,
    addDays: addDays,
    diasDesdeEpoch: diasDesdeEpoch,
    _conflitos: conflitos,
    _base: BASE,
    _marcados: MARCADOS
  };
})(typeof window !== "undefined" ? window : globalThis);
