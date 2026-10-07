import { emptyDb, normalizeDb, TURNOS } from "./engine.js"

// Estrutura no GRID: { turnos: { T1: {meta, entries}, T2: {...}, T3: {...} } }
// Dados antigos (sem turnos: { meta, entries } na raiz) são lidos como T1 e
// migrados para turnos.T1 na primeira gravação.
const state = { mode: "memória (não salva)", notice: "" }
const memory = {}
let turno = TURNOS[0]

export function getTurno() { return turno }
export function setTurno(t) { if (TURNOS.indexOf(t) > -1) turno = t }

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

// Mapa de turnos do estado cru, incluindo o formato antigo (meta/entries na raiz = T1).
function turnosDe(raw) {
  const map = Object.assign({}, raw && raw.turnos && typeof raw.turnos === "object" ? raw.turnos : {})
  if (raw && raw.meta && !map[TURNOS[0]]) map[TURNOS[0]] = { meta: raw.meta, entries: raw.entries }
  return map
}

async function load(t) {
  const st = await sdk()
  if (st) {
    try {
      const out = await st.get()
      const raw = out.state || {}
      const turnos = turnosDe(raw)
      state.mode = "GRID (compartilhado)"
      const db = turnos[t] && turnos[t].meta ? normalizeDb(turnos[t]) : emptyDb(t)
      return { st, db, raw, turnos, updatedAt: out.updated_at }
    } catch {
      state.notice = "Não foi possível ler o armazenamento do GRID. Os dados ficam só em memória; use a aba Backup."
    }
  } else {
    state.notice = "Armazenamento do GRID indisponível. Os dados ficam só em memória; use a aba Backup."
  }
  state.mode = "memória (não salva)"
  if (!memory[t]) memory[t] = emptyDb(t)
  return { st: null, db: memory[t], raw: {}, turnos: {}, updatedAt: "" }
}

export async function read() {
  return (await load(turno)).db
}

export async function mutate(fn) {
  const t = turno
  for (let attempt = 0; attempt < 3; attempt++) {
    const { st, db, raw, turnos, updatedAt } = await load(t)
    const result = fn(db)
    if (result && result.ok === false) return result
    if (!st) { memory[t] = db; return result }
    try {
      const rest = Object.assign({}, raw)
      delete rest.meta; delete rest.entries
      await st.set({ ...rest, turnos: { ...turnos, [t]: { meta: db.meta, entries: db.entries } } }, updatedAt)
      return result
    } catch (e) {
      if (isConflict(e) && attempt < 2) continue
      throw e
    }
  }
  throw new Error("Conflito de edição. Tente novamente.")
}

export async function replaceAll(db) {
  return mutate((cur) => { cur.meta = db.meta; cur.entries = db.entries; return { ok: true } })
}

export function info() {
  return state
}
