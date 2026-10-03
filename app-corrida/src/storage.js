import { emptyDb, normalizeDb } from "./engine.js"

const KEY = "corrida_produtividade_v1"
const memory = {}
const state = { mode: "memória", notice: "" }

function docId() {
  const m = String(window.location.href).match(/\/d\/([0-9A-HJKMNP-TV-Z]{26})/)
  return m ? m[1] : null
}

function localGet() {
  try { return window.localStorage.getItem(KEY) } catch { return memory[KEY] ?? null }
}

function localSet(v) {
  try { window.localStorage.setItem(KEY, v) } catch { memory[KEY] = v }
}

function localAvailable() {
  try { window.localStorage.setItem("__t", "1"); window.localStorage.removeItem("__t"); return true } catch { return false }
}

async function remoteLoad(id) {
  const r = await fetch(`/api/v1/documents/${id}/state`, { credentials: "include" })
  if (!r.ok) throw new Error("state " + r.status)
  const j = await r.json()
  const st = j.state || {}
  return { db: st.meta ? normalizeDb(st) : emptyDb(), version: j.updated_at || "" }
}

async function remoteSave(id, db, version) {
  const r = await fetch(`/api/v1/documents/${id}/state`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: db, if_updated_at: version || "" }),
  })
  if (r.status === 409) { const e = new Error("conflict"); e.conflict = true; throw e }
  if (!r.ok) throw new Error("state " + r.status)
}

let remoteOk = null

async function load() {
  const id = docId()
  if (id && remoteOk !== false) {
    try {
      const out = await remoteLoad(id)
      if (remoteOk === null) { remoteOk = true; state.mode = "GRID (compartilhado)" }
      return { ...out, id }
    } catch {
      remoteOk = false
      state.mode = localAvailable() ? "local (este navegador)" : "memória (não salva)"
      state.notice = "Não foi possível usar o armazenamento compartilhado do GRID. Os dados ficam só neste navegador; use a aba Backup."
    }
  } else if (remoteOk === null) {
    remoteOk = false
    state.mode = localAvailable() ? "local (este navegador)" : "memória (não salva)"
  }
  const raw = localGet()
  let db
  try { db = raw ? normalizeDb(JSON.parse(raw)) : emptyDb() } catch { db = emptyDb() }
  return { db, version: "", id: null }
}

export async function read() {
  return (await load()).db
}

export async function mutate(fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { db, version, id } = await load()
    const result = fn(db)
    if (result && result.ok === false) return result
    try {
      if (id) await remoteSave(id, db, version)
      else localSet(JSON.stringify(db))
      return result
    } catch (e) {
      if (e.conflict) continue
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
