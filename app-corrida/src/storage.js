import { emptyDb, normalizeDb, TURNOS } from "./engine.js"

// Estrutura no GRID: { turnos: { T1: {meta, entries}, T2: {...}, T3: {...} } }
// Dados antigos (sem turnos: { meta, entries } na raiz) são lidos como T1 e
// migrados para turnos.T1 na primeira gravação.
//
// Proteções contra "dados que somem e voltam":
//  - leituras mais antigas que a última versão conhecida (cache atrasado do GRID) são ignoradas;
//  - leitura vazia/falha depois de já ter carregado dados não substitui os dados na tela;
//  - sem conexão, o app NÃO grava (nada de sobrescrever com dados vazios);
//  - gravações são feitas uma de cada vez (fila).
const state = { mode: "memória (não salva)", notice: "" }
const memory = {}
let turno = TURNOS[0]
let cache = null // { raw, updatedAt }: último estado confirmado do GRID
let gravando = 0

export function getTurno() { return turno }
export function setTurno(t) { if (TURNOS.indexOf(t) > -1) turno = t }
export function ocupado() { return gravando > 0 }

const clone = (o) => JSON.parse(JSON.stringify(o))

async function sdk() {
  for (let i = 0; i < 20; i++) {
    const g = window.GRID
    if (g && g.state && typeof g.state.get === "function" && typeof g.state.set === "function") return g.state
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

function isConflict(e) {
  return !!e && (e.status === 409 || e.conflict === true || /409|conflict|stale|updated_at/i.test(String(e.message || e)))
}

function ts(v) { const n = Date.parse(v); return isNaN(n) ? null : n }
function maisAntigo(a, b) { const x = ts(a), y = ts(b); return x !== null && y !== null && x < y }
function semDados(raw) { return !raw || (!raw.turnos && !raw.meta) }

// Mapa de turnos do estado cru, incluindo o formato antigo (meta/entries na raiz = T1).
function turnosDe(raw) {
  const map = Object.assign({}, raw && raw.turnos && typeof raw.turnos === "object" ? raw.turnos : {})
  if (raw && raw.meta && !map[TURNOS[0]]) map[TURNOS[0]] = { meta: raw.meta, entries: raw.entries }
  return map
}

// Lê o estado do GRID aplicando as proteções acima. Devolve { raw, updatedAt, offline }.
async function lerCru(st) {
  let out
  try {
    out = await st.get()
  } catch (e) {
    if (cache) return { raw: clone(cache.raw), updatedAt: cache.updatedAt, offline: true }
    throw e
  }
  const raw = out.state || {}
  if (cache && (maisAntigo(out.updated_at, cache.updatedAt) || (semDados(raw) && !semDados(cache.raw)))) {
    return { raw: clone(cache.raw), updatedAt: cache.updatedAt, offline: false }
  }
  cache = { raw: clone(raw), updatedAt: out.updated_at }
  return { raw, updatedAt: out.updated_at, offline: false }
}

async function load(t) {
  const st = await sdk()
  if (st) {
    try {
      const { raw, updatedAt, offline } = await lerCru(st)
      const turnos = turnosDe(raw)
      state.mode = offline ? "GRID (sem conexão — mostrando o último dado)" : "GRID (compartilhado)"
      state.notice = ""
      const db = turnos[t] && turnos[t].meta ? normalizeDb(turnos[t]) : emptyDb(t)
      return { st, db, raw, turnos, updatedAt, offline }
    } catch {
      state.notice = "Não foi possível ler o armazenamento do GRID. Os dados ficam só em memória; use a aba Backup."
    }
  } else {
    state.notice = "Armazenamento do GRID indisponível. Os dados ficam só em memória; use a aba Backup."
  }
  state.mode = "memória (não salva)"
  if (!memory[t]) memory[t] = emptyDb(t)
  return { st: null, db: memory[t], raw: {}, turnos: {}, updatedAt: "", offline: false }
}

export async function read() {
  return (await load(turno)).db
}

async function gravar(t, fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { st, db, raw, turnos, updatedAt, offline } = await load(t)
    if (offline) throw new Error("Sem conexão com o GRID. Nada foi salvo; tente novamente em instantes.")
    const result = fn(db)
    if (result && result.ok === false) return result
    if (!st) { memory[t] = db; return result }
    const rest = Object.assign({}, raw)
    delete rest.meta; delete rest.entries
    const novo = { ...rest, turnos: { ...turnos, [t]: { meta: db.meta, entries: db.entries } } }
    try {
      const res = await st.set(novo, updatedAt)
      cache = res && res.updated_at ? { raw: clone(novo), updatedAt: res.updated_at } : null
      return result
    } catch (e) {
      cache = null // o GRID tem uma versão mais nova: a próxima leitura é a verdadeira
      if (isConflict(e) && attempt < 3) { await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); continue }
      throw e
    }
  }
  throw new Error("Conflito de edição. Tente novamente.")
}

// Gravações em fila: duas ao mesmo tempo nunca disputam a mesma versão.
let fila = Promise.resolve()
export function mutate(fn) {
  const t = turno
  gravando++
  const p = fila.then(() => gravar(t, fn))
  fila = p.then(() => {}, () => {})
  return p.finally(() => { gravando-- })
}

export async function replaceAll(db) {
  return mutate((cur) => { cur.meta = db.meta; cur.entries = db.entries; return { ok: true } })
}

export function info() {
  return state
}
