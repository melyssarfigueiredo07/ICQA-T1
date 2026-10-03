import { emptyDb, normalizeDb } from "./engine.js"

const state = { mode: "memória (não salva)", notice: "" }
let memoryDb = null

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

async function load() {
  const st = await sdk()
  if (st) {
    try {
      const out = await st.get()
      const raw = out.state || {}
      state.mode = "GRID (compartilhado)"
      return { st, db: raw.meta ? normalizeDb(raw) : emptyDb(), raw, updatedAt: out.updated_at }
    } catch {
      state.notice = "Não foi possível ler o armazenamento do GRID. Os dados ficam só em memória; use a aba Backup."
    }
  } else {
    state.notice = "Armazenamento do GRID indisponível. Os dados ficam só em memória; use a aba Backup."
  }
  state.mode = "memória (não salva)"
  if (!memoryDb) memoryDb = emptyDb()
  return { st: null, db: memoryDb, raw: {}, updatedAt: "" }
}

export async function read() {
  return (await load()).db
}

export async function mutate(fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { st, db, raw, updatedAt } = await load()
    const result = fn(db)
    if (result && result.ok === false) return result
    if (!st) { memoryDb = db; return result }
    try {
      await st.set({ ...raw, meta: db.meta, entries: db.entries }, updatedAt)
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
