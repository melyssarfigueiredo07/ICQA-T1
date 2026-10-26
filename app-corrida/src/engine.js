export const TASKS = ["Contagem", "Inbound Audit", "Stock Audit", "Busca Lost", "Transfer"]
export const TURNOS = ["T1", "T2", "T3"]
export const ESCALAS = ["A", "B", "C", "D"]
export const CLASSES = ["PS Operações", "PS ICQA"]
export const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]

function newId() {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

function nowSP(withSeconds) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date())
  const g = (t) => parts.find((p) => p.type === t).value
  const base = `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`
  return withSeconds ? `${base}:${g("second")}` : base
}

export function defaultMeta() {
  const now = new Date()
  return {
    reps: [
      { nome: "Ana Lima", tipo: "REP", cargo: "" },
      { nome: "Bruno Costa", tipo: "REP", cargo: "" },
      { nome: "Carla Dias", tipo: "REP", cargo: "" },
    ],
    mes: MESES[now.getMonth()],
    ano: String(now.getFullYear()),
    destaques: [],
  }
}

export function normalizeDb(db) {
  const meta = (db && db.meta) || defaultMeta()
  meta.reps = (meta.reps || [])
    .map((r) => (typeof r === "string"
      ? { nome: r, tipo: "REP", cargo: "", escala: "", classe: "" }
      : { nome: r.nome || "", tipo: r.tipo || "REP", cargo: r.cargo || "", escala: r.escala || "", classe: r.classe || "" }))
    .filter((r) => r.nome)
  if (!meta.destaques) meta.destaques = []
  if (!meta.mes) meta.mes = MESES[new Date().getMonth()]
  if (!meta.ano) meta.ano = String(new Date().getFullYear())
  return { meta, entries: Array.isArray(db && db.entries) ? db.entries : [] }
}

export function emptyDb(turno) {
  const db = { meta: defaultMeta(), entries: [] }
  // turnos novos começam sem reps de exemplo (só o T1 original mantém o padrão)
  if (turno && turno !== TURNOS[0]) db.meta.reps = []
  return db
}

function trimEntries(db) {
  if (db.entries.length > 600) db.entries = db.entries.slice(-600)
}

export function getData(db, p) {
  const { meta, entries } = db
  const mes = p && p.mes ? p.mes : meta.mes
  const ano = String(p && p.ano ? p.ano : meta.ano)
  const period = entries.filter((e) => e.mes === mes && String(e.ano) === ano)

  const repStats = meta.reps.map((rep) => {
    const re = period.filter((e) => e.rep === rep.nome)
    const bestTask = {}
    TASKS.forEach((t) => { bestTask[t] = 0 })
    let bestTotal = 0, bestSem = null
    const sems = {}
    re.forEach((e) => { sems[e.sem] = true })
    Object.keys(sems).forEach((sem) => {
      const rows = re.filter((e) => e.sem === sem)
      let sTotal = 0
      const sT = {}
      TASKS.forEach((t) => { sT[t] = 0 })
      rows.forEach((e) => {
        TASKS.forEach((t) => {
          let v = parseInt(e[t]); if (isNaN(v)) v = 0
          sT[t] += v; sTotal += v
        })
      })
      if (sTotal > bestTotal) { bestTotal = sTotal; bestSem = sem }
      TASKS.forEach((t) => { if (sT[t] > bestTask[t]) bestTask[t] = sT[t] })
    })
    const row = { nome: rep.nome, tipo: rep.tipo || "REP", cargo: rep.cargo || "", escala: rep.escala || "", classe: rep.classe || "", total: bestTotal, bestSem }
    TASKS.forEach((t) => { row[t] = bestTask[t] })
    return row
  })

  const ranking = repStats.slice().sort((a, b) => b.total - a.total)
  const top3 = (list, t) => list.slice().sort((a, b) => b[t] - a[t]).slice(0, 3)
    .filter((r) => r[t] > 0).map((r) => ({ nome: r.nome, tipo: r.tipo, val: r[t], bestSem: r.bestSem }))
  const ops = repStats.filter((r) => r.tipo === "Operador de Máquina")
  const yMap = {}
  entries.forEach((e) => { yMap[e.ano] = true })
  yMap[String(new Date().getFullYear())] = true

  return {
    ok: true, mes, ano,
    reps: meta.reps,
    ranking,
    rankingREP: ranking.filter((r) => r.tipo === "REP"),
    rankingOP: ranking.filter((r) => r.tipo === "Operador de Máquina"),
    hlArrays: TASKS.map((t) => top3(repStats, t)),
    hlArraysOP: TASKS.map((t) => top3(ops, t)),
    rankingOPFull: ops.slice().sort((a, b) => b.total - a.total),
    years: Object.keys(yMap).sort(),
    updated: nowSP(true),
  }
}

export function getEntries(db) {
  return { ok: true, entries: db.entries }
}

export function saveEntry(db, p) {
  const rep = (p.rep || "").trim()
  const mes = (p.mes || "").trim()
  const ano = String(p.ano || "").trim()
  const sem = String(p.sem || "").trim()
  if (!rep || !mes || !ano || !sem) return { ok: false, error: "Campos obrigatórios faltando." }

  const entry = { id: p.id || newId(), rep, mes, ano, sem }
  TASKS.forEach((t, i) => { const v = parseInt(p["t" + i]); entry[t] = isNaN(v) ? 0 : v })

  if (p.id) {
    const idx = db.entries.findIndex((e) => e.id === p.id)
    if (idx >= 0) db.entries[idx] = entry
    else db.entries.push(entry)
  } else {
    const dup = db.entries.find((e) => e.rep === rep && e.mes === mes && String(e.ano) === ano && String(e.sem) === sem)
    if (dup) TASKS.forEach((t, i) => { const v = parseInt(p["t" + i]); dup[t] = isNaN(v) ? 0 : v })
    else db.entries.push(entry)
  }
  trimEntries(db)
  return { ok: true, msg: "Salvo!" }
}

export function deleteEntry(db, p) {
  if (!p.id) return { ok: false, error: "ID não informado." }
  const before = db.entries.length
  db.entries = db.entries.filter((e) => e.id !== p.id)
  if (db.entries.length === before) return { ok: false, error: "Não encontrado." }
  return { ok: true }
}

export function addRep(db, p) {
  const nome = (p.nome || "").trim()
  const tipo = (p.tipo || "REP").trim()
  const cargo = (p.cargo || "").trim()
  const escala = (p.escala || "").trim()
  const classe = (p.classe || "").trim()
  if (!nome) return { ok: false, error: "Nome inválido." }
  if (db.meta.reps.some((r) => r.nome === nome)) return { ok: false, error: "REP já existe." }
  db.meta.reps.push({ nome, tipo, cargo, escala, classe })
  return { ok: true }
}

export function delRep(db, p) {
  const nome = (p.nome || "").trim()
  db.meta.reps = db.meta.reps.filter((r) => r.nome !== nome)
  return { ok: true }
}

export function editRep(db, p) {
  const nomeAtual = (p.nome || "").trim()
  const novoNome = (p.novoNome || "").trim() || nomeAtual
  if (novoNome !== nomeAtual && db.meta.reps.some((r) => r.nome === novoNome)) {
    return { ok: false, error: "Já existe um REP com esse nome." }
  }
  db.meta.reps.forEach((r) => {
    if (r.nome === nomeAtual) {
      r.nome = novoNome
      r.tipo = (p.tipo || r.tipo || "REP").trim()
      r.cargo = (p.cargo !== undefined ? p.cargo : r.cargo || "").trim()
      r.escala = (p.escala !== undefined ? p.escala : r.escala || "").trim()
      r.classe = (p.classe !== undefined ? p.classe : r.classe || "").trim()
    }
  })
  if (novoNome !== nomeAtual) db.entries.forEach((e) => { if (e.rep === nomeAtual) e.rep = novoNome })
  return { ok: true }
}

export function setPeriod(db, p) {
  if (p.mes) db.meta.mes = p.mes
  if (p.ano) db.meta.ano = String(p.ano)
  return { ok: true }
}

export function getDestaques(db) {
  return { ok: true, historico: db.meta.destaques || [] }
}

export function delDestaque(db, p) {
  if (!p.id) return { ok: false, error: "ID não informado." }
  db.meta.destaques = (db.meta.destaques || []).filter((d) => d.id !== p.id)
  return { ok: true }
}

export function calcDestaque(db, p) {
  const mes = (p.mes || "").trim(), ano = String(p.ano || "").trim()
  if (!mes || !ano) return { ok: false, error: "Mês e ano obrigatórios." }
  const { meta, entries } = db
  const period = entries.filter((e) => e.mes === mes && String(e.ano) === ano)
  if (!period.length) return { ok: false, error: "Nenhum dado para " + mes + "/" + ano + "." }

  const semMap = {}
  period.forEach((e) => {
    if (!semMap[e.rep]) semMap[e.rep] = {}
    if (!semMap[e.rep][e.sem]) { semMap[e.rep][e.sem] = {}; TASKS.forEach((t) => { semMap[e.rep][e.sem][t] = 0 }) }
    TASKS.forEach((t) => { const v = parseInt(e[t]); semMap[e.rep][e.sem][t] += isNaN(v) ? 0 : v })
  })

  const sems = {}
  period.forEach((e) => { sems[e.sem] = true })

  const todosReps = {}
  period.forEach((e) => { todosReps[e.rep] = true })
  meta.reps.forEach((r) => { todosReps[r.nome] = true })

  const vitorias = {}, acumulado = {}, vitTarefa = {}
  Object.keys(todosReps).forEach((nome) => {
    vitorias[nome] = 0; acumulado[nome] = 0
    vitTarefa[nome] = TASKS.map(() => 0)
  })

  Object.keys(semMap).forEach((rep) => {
    Object.keys(semMap[rep]).forEach((sem) => {
      TASKS.forEach((t) => { acumulado[rep] = (acumulado[rep] || 0) + (semMap[rep][sem][t] || 0) })
    })
  })

  Object.keys(sems).forEach((sem) => {
    TASKS.forEach((t, ti) => {
      let bestVal = -1, bestRep = null
      Object.keys(semMap).forEach((rep) => {
        const v = (semMap[rep][sem] && semMap[rep][sem][t]) || 0
        if (v > bestVal) { bestVal = v; bestRep = rep }
      })
      if (bestRep && bestVal > 0) {
        vitorias[bestRep] = (vitorias[bestRep] || 0) + 1
        vitTarefa[bestRep][ti] = (vitTarefa[bestRep][ti] || 0) + 1
      }
    })
  })

  const tipoRep = (nome) => { const r = meta.reps.find((x) => x.nome === nome); return r ? r.tipo || "REP" : "REP" }

  const porTarefa = TASKS.map((t, ti) => {
    let melhor = null, melhorV = -1
    Object.keys(vitTarefa).forEach((rep) => {
      const v = vitTarefa[rep][ti] || 0
      if (v > melhorV || (v === melhorV && melhor && (acumulado[rep] || 0) > (acumulado[melhor] || 0))) { melhorV = v; melhor = rep }
    })
    if (!melhor || melhorV <= 0) return null
    return { nome: melhor, tipo: tipoRep(melhor), vitorias: melhorV, total: acumulado[melhor] || 0 }
  })

  const tops = Object.keys(vitorias)
    .map((nome) => ({ nome, tipo: tipoRep(nome), vitorias: vitorias[nome] || 0, total: acumulado[nome] || 0 }))
    .filter((r) => r.vitorias > 0 || r.total > 0)
    .sort((a, b) => (b.vitorias !== a.vitorias ? b.vitorias - a.vitorias : b.total - a.total))

  const registro = {
    id: newId(), mes, ano,
    geradoEm: nowSP(false),
    observacao: (p.observacao || "").trim(),
    geral: tops[0] || null,
    porTarefa,
    destREP: tops.filter((r) => r.tipo === "REP")[0] || null,
    destOP: tops.filter((r) => r.tipo === "Operador de Máquina")[0] || null,
    ranking: tops.slice(0, 10),
    semanas: Object.keys(sems).length,
    totalReps: tops.length,
  }

  meta.destaques = (meta.destaques || []).filter((d) => !(d.mes === mes && String(d.ano) === ano))
  meta.destaques.push(registro)
  meta.destaques.sort((a, b) => new Date(b.ano, MESES.indexOf(b.mes)) - new Date(a.ano, MESES.indexOf(a.mes)))
  if (meta.destaques.length > 24) meta.destaques = meta.destaques.slice(0, 24)
  return { ok: true, registro, msg: "Destaque de " + mes + "/" + ano + " salvo!" }
}

export function debugInfo(db) {
  const data = getData(db, {})
  return {
    ok: true,
    repCount: db.meta.reps.length,
    entryCount: db.entries.length,
    rankingCount: data.ranking.length,
    highlightKeys: data.hlArrays.map((a) => a.length),
    periodo: data.mes + "/" + data.ano,
    primeiroEntry: db.entries[0] || null,
  }
}
