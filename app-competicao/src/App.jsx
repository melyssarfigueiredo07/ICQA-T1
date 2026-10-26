import { useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'icqa_competicao_mensal_v1'
const memoryStore = {}

const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return memoryStore[key] ?? null
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      memoryStore[key] = value
    }
  },
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MEDALHAS = ['🥇', '🥈', '🥉']

function uid() {
  return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function monthOf(date) {
  return date.slice(0, 7)
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  const nome = MESES[m - 1]
  return `${nome[0].toUpperCase()}${nome.slice(1)} de ${y}`
}

function buildSeed() {
  const hoje = todayStr()
  const p = [
    { id: uid(), nome: 'Exemplo A', equipe: 'Manhã' },
    { id: uid(), nome: 'Exemplo B', equipe: 'Tarde' },
    { id: uid(), nome: 'Exemplo C', equipe: 'Noite' },
  ]
  const c = [
    { id: uid(), nome: 'Auditoria de inventário concluída', pontos: 10 },
    { id: uid(), nome: 'Divergência corrigida', pontos: 5 },
    { id: uid(), nome: 'Dia sem lost em MU', pontos: 15 },
    { id: uid(), nome: 'Plano de ação concluído no prazo', pontos: 20 },
    { id: uid(), nome: 'Treinamento / participação', pontos: 8 },
  ]
  const l = [
    { id: uid(), data: hoje, participanteId: p[0].id, criterioId: c[0].id, quantidade: 3, obs: '' },
    { id: uid(), data: hoje, participanteId: p[1].id, criterioId: c[1].id, quantidade: 6, obs: '' },
    { id: uid(), data: hoje, participanteId: p[2].id, criterioId: c[2].id, quantidade: 1, obs: '' },
  ]
  return { mes: monthOf(hoje), participantes: p, criterios: c, lancamentos: l, premio: '' }
}

function loadState() {
  try {
    const raw = storage.get(STORAGE_KEY)
    if (!raw) return buildSeed()
    const s = JSON.parse(raw)
    if (!s.participantes || !s.criterios || !s.lancamentos) return buildSeed()
    return { premio: '', ...s, mes: s.mes || monthOf(todayStr()) }
  } catch {
    return buildSeed()
  }
}

const STYLES = `
  .cm { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #e5e7eb; min-height: 100vh; }
  .cm button, .cm input, .cm select, .cm textarea { font-family: inherit; font-size: 13px; }
  .cm-header { padding: 16px 24px; border-bottom: 1px solid #26262b; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .cm-header h1 { font-size: 18px; color: #f5f5f5; }
  .cm-sub { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .cm-month { display: flex; align-items: center; gap: 8px; }
  .cm-month .label { min-width: 150px; text-align: center; font-weight: 600; color: #f5f5f5; }
  .cm-tabs { display: flex; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid #26262b; overflow-x: auto; }
  .cm-tabs button { border: none; background: transparent; padding: 10px 14px; cursor: pointer; color: #9ca3af; border-bottom: 2px solid transparent; white-space: nowrap; }
  .cm-tabs button.active { color: #60a5fa; border-bottom-color: #60a5fa; font-weight: 600; }
  .cm-main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .btn { padding: 8px 12px; border-radius: 8px; border: 1px solid #33333a; background: #1f1f23; color: #e5e7eb; cursor: pointer; }
  .btn:hover { background: #27272c; }
  .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.danger { color: #f87171; border-color: #5b2323; }
  .btn.small { padding: 4px 8px; font-size: 12px; }
  .cm input, .cm select, .cm textarea { padding: 8px 10px; border: 1px solid #33333a; border-radius: 8px; background: #18181b; color: #e5e7eb; }
  .cm input:focus, .cm select:focus, .cm textarea:focus { outline: none; border-color: #60a5fa; }
  .cm select option { background: #18181b; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #141416; border: 1px solid #26262b; border-radius: 10px; padding: 16px; }
  .kpi .value { font-size: 26px; font-weight: 700; color: #f5f5f5; }
  .kpi .label { font-size: 12px; color: #9ca3af; margin-top: 4px; }
  .podium { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .podium .card { text-align: center; }
  .podium .medal { font-size: 36px; }
  .podium .name { font-size: 16px; font-weight: 700; color: #f5f5f5; margin-top: 6px; }
  .podium .team { font-size: 12px; color: #9ca3af; }
  .podium .pts { font-size: 24px; font-weight: 700; color: #60a5fa; margin-top: 8px; }
  .podium .first { border-color: #fbbf24; }
  .section-title { font-size: 14px; font-weight: 600; color: #f5f5f5; margin: 20px 0 10px; }
  .prize { background: #3a2c05; color: #fbbf24; border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
  .wrap { background: #141416; border: 1px solid #26262b; border-radius: 10px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; background: #1a1a1d; border-bottom: 1px solid #26262b; color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; }
  td { padding: 8px 12px; border-bottom: 1px solid #202024; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: #26262b; border-radius: 4px; min-width: 120px; }
  .bar > div { height: 100%; background: #2563eb; border-radius: 4px; }
  .form { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin-bottom: 14px; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #9ca3af; }
  .empty { padding: 24px; text-align: center; color: #9ca3af; font-size: 13px; }
  .msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; background: #062a4a; color: #60a5fa; font-size: 13px; }
  .cm textarea.backup { width: 100%; min-height: 220px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .row-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .inline-edit { width: 100%; min-width: 80px; }
`

function useInjectedStyles() {
  useEffect(() => {
    const el = document.createElement('style')
    el.textContent = STYLES
    document.head.appendChild(el)
    return () => document.head.removeChild(el)
  }, [])
}

function DeleteButton({ onConfirm }) {
  const [armed, setArmed] = useState(false)
  if (!armed) return <button className="btn small danger" onClick={() => setArmed(true)}>Excluir</button>
  return (
    <span className="row-actions">
      <button className="btn small danger" onClick={() => { setArmed(false); onConfirm() }}>Confirmar</button>
      <button className="btn small" onClick={() => setArmed(false)}>Cancelar</button>
    </span>
  )
}

function Ranking({ state, setState, ranking, equipes, lancMes }) {
  const total = ranking.reduce((s, r) => s + r.pontos, 0)
  const lider = ranking[0]
  const max = lider ? lider.pontos : 0
  const top = ranking.slice(0, 3)
  const maxEquipe = equipes[0] ? equipes[0].pontos : 0

  return (
    <div>
      <div className="kpis">
        <div className="card kpi"><div className="value">{total}</div><div className="label">Pontos no mês</div></div>
        <div className="card kpi"><div className="value">{state.participantes.length}</div><div className="label">Participantes</div></div>
        <div className="card kpi"><div className="value">{lancMes.length}</div><div className="label">Lançamentos no mês</div></div>
        <div className="card kpi"><div className="value">{lider && lider.pontos > 0 ? lider.nome : '—'}</div><div className="label">Líder do mês</div></div>
      </div>

      <div className="form">
        <label style={{ flex: 1, minWidth: 220 }}>Prêmio / descrição da competição
          <input value={state.premio} placeholder="Ex.: o 1º colocado ganha..." onChange={(e) => setState((s) => ({ ...s, premio: e.target.value }))} />
        </label>
      </div>
      {state.premio && <div className="prize">🏆 {state.premio}</div>}

      {top.length > 0 && top[0].pontos > 0 && (
        <div className="podium">
          {top.map((r, i) => (
            <div key={r.id} className={'card' + (i === 0 ? ' first' : '')}>
              <div className="medal">{MEDALHAS[i]}</div>
              <div className="name">{r.nome}</div>
              <div className="team">{r.equipe || 'Sem equipe'}</div>
              <div className="pts">{r.pontos} pts</div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">Ranking individual</div>
      <div className="wrap">
        {ranking.length === 0 ? <div className="empty">Cadastre participantes na aba Participantes.</div> : (
          <table>
            <thead><tr><th>#</th><th>Participante</th><th>Equipe</th><th className="num">Lançamentos</th><th className="num">Pontos</th><th>Progresso</th></tr></thead>
            <tbody>
              {ranking.map((r, i) => (
                <tr key={r.id}>
                  <td>{i < 3 && r.pontos > 0 ? MEDALHAS[i] : i + 1}</td>
                  <td>{r.nome}</td>
                  <td>{r.equipe}</td>
                  <td className="num">{r.qtd}</td>
                  <td className="num"><strong>{r.pontos}</strong></td>
                  <td><div className="bar"><div style={{ width: max > 0 ? `${(r.pontos / max) * 100}%` : '0%' }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {equipes.length > 0 && (
        <>
          <div className="section-title">Ranking por equipe</div>
          <div className="wrap">
            <table>
              <thead><tr><th>#</th><th>Equipe</th><th className="num">Participantes</th><th className="num">Pontos</th><th>Progresso</th></tr></thead>
              <tbody>
                {equipes.map((e, i) => (
                  <tr key={e.equipe}>
                    <td>{i + 1}</td>
                    <td>{e.equipe}</td>
                    <td className="num">{e.membros}</td>
                    <td className="num"><strong>{e.pontos}</strong></td>
                    <td><div className="bar"><div style={{ width: maxEquipe > 0 ? `${(e.pontos / maxEquipe) * 100}%` : '0%' }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function Lancamentos({ state, setState, lancMes }) {
  const mes = state.mes
  const [form, setForm] = useState({ data: '', participanteId: '', criterioId: '', quantidade: 1, obs: '' })
  const defaultDate = todayStr().startsWith(mes) ? todayStr() : `${mes}-01`
  const data = form.data && monthOf(form.data) === mes ? form.data : defaultDate
  const participanteId = form.participanteId || state.participantes[0]?.id || ''
  const criterioId = form.criterioId || state.criterios[0]?.id || ''
  const pronto = participanteId && criterioId && Number(form.quantidade) > 0

  function add() {
    if (!pronto) return
    setState((s) => ({
      ...s,
      lancamentos: [...s.lancamentos, { id: uid(), data, participanteId, criterioId, quantidade: Number(form.quantidade), obs: form.obs.trim() }],
    }))
    setForm((f) => ({ ...f, quantidade: 1, obs: '' }))
  }

  const nomeP = (id) => state.participantes.find((p) => p.id === id)?.nome || '(removido)'
  const crit = (id) => state.criterios.find((c) => c.id === id)
  const ordenados = [...lancMes].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0))

  return (
    <div>
      {state.participantes.length === 0 || state.criterios.length === 0 ? (
        <div className="msg">Cadastre ao menos um participante e um critério antes de lançar pontos.</div>
      ) : (
        <div className="form">
          <label>Data<input type="date" value={data} min={`${mes}-01`} max={`${mes}-31`} onChange={(e) => setForm({ ...form, data: e.target.value })} /></label>
          <label>Participante
            <select value={participanteId} onChange={(e) => setForm({ ...form, participanteId: e.target.value })}>
              {state.participantes.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </label>
          <label>Critério
            <select value={criterioId} onChange={(e) => setForm({ ...form, criterioId: e.target.value })}>
              {state.criterios.map((c) => <option key={c.id} value={c.id}>{c.nome} (+{c.pontos})</option>)}
            </select>
          </label>
          <label>Qtd.<input type="number" min="1" style={{ width: 70 }} value={form.quantidade} onChange={(e) => setForm({ ...form, quantidade: e.target.value })} /></label>
          <label style={{ flex: 1, minWidth: 160 }}>Observação<input value={form.obs} onChange={(e) => setForm({ ...form, obs: e.target.value })} /></label>
          <button className="btn primary" disabled={!pronto} onClick={add}>+ Lançar pontos</button>
        </div>
      )}
      <div className="wrap">
        {ordenados.length === 0 ? <div className="empty">Nenhum lançamento em {monthLabel(mes).toLowerCase()}.</div> : (
          <table>
            <thead><tr><th>Data</th><th>Participante</th><th>Critério</th><th className="num">Qtd.</th><th className="num">Pontos</th><th>Obs.</th><th></th></tr></thead>
            <tbody>
              {ordenados.map((l) => {
                const c = crit(l.criterioId)
                return (
                  <tr key={l.id}>
                    <td>{l.data.split('-').reverse().join('/')}</td>
                    <td>{nomeP(l.participanteId)}</td>
                    <td>{c ? c.nome : '(removido)'}</td>
                    <td className="num">{l.quantidade}</td>
                    <td className="num"><strong>{c ? c.pontos * l.quantidade : 0}</strong></td>
                    <td>{l.obs}</td>
                    <td><DeleteButton onConfirm={() => setState((s) => ({ ...s, lancamentos: s.lancamentos.filter((x) => x.id !== l.id) }))} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Participantes({ state, setState }) {
  const [nome, setNome] = useState('')
  const [equipe, setEquipe] = useState('')

  function add() {
    if (!nome.trim()) return
    setState((s) => ({ ...s, participantes: [...s.participantes, { id: uid(), nome: nome.trim(), equipe: equipe.trim() }] }))
    setNome('')
  }

  function update(id, campo, valor) {
    setState((s) => ({ ...s, participantes: s.participantes.map((p) => (p.id === id ? { ...p, [campo]: valor } : p)) }))
  }

  function remove(id) {
    setState((s) => ({
      ...s,
      participantes: s.participantes.filter((p) => p.id !== id),
      lancamentos: s.lancamentos.filter((l) => l.participanteId !== id),
    }))
  }

  return (
    <div>
      <div className="form">
        <label>Nome<input value={nome} onChange={(e) => setNome(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} /></label>
        <label>Equipe / turno<input value={equipe} onChange={(e) => setEquipe(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} /></label>
        <button className="btn primary" onClick={add}>+ Adicionar</button>
      </div>
      <div className="wrap">
        {state.participantes.length === 0 ? <div className="empty">Nenhum participante.</div> : (
          <table>
            <thead><tr><th>Nome</th><th>Equipe</th><th></th></tr></thead>
            <tbody>
              {state.participantes.map((p) => (
                <tr key={p.id}>
                  <td><input className="inline-edit" value={p.nome} onChange={(e) => update(p.id, 'nome', e.target.value)} /></td>
                  <td><input className="inline-edit" value={p.equipe} onChange={(e) => update(p.id, 'equipe', e.target.value)} /></td>
                  <td><DeleteButton onConfirm={() => remove(p.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="section-title" style={{ color: '#9ca3af', fontWeight: 400 }}>Excluir um participante também remove os lançamentos dele.</div>
    </div>
  )
}

function Criterios({ state, setState }) {
  const [nome, setNome] = useState('')
  const [pontos, setPontos] = useState(10)

  function add() {
    if (!nome.trim() || !(Number(pontos) > 0)) return
    setState((s) => ({ ...s, criterios: [...s.criterios, { id: uid(), nome: nome.trim(), pontos: Number(pontos) }] }))
    setNome('')
  }

  function update(id, campo, valor) {
    setState((s) => ({ ...s, criterios: s.criterios.map((c) => (c.id === id ? { ...c, [campo]: valor } : c)) }))
  }

  function remove(id) {
    setState((s) => ({
      ...s,
      criterios: s.criterios.filter((c) => c.id !== id),
      lancamentos: s.lancamentos.filter((l) => l.criterioId !== id),
    }))
  }

  return (
    <div>
      <div className="form">
        <label style={{ flex: 1, minWidth: 200 }}>Critério<input value={nome} onChange={(e) => setNome(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} /></label>
        <label>Pontos por unidade<input type="number" min="1" style={{ width: 120 }} value={pontos} onChange={(e) => setPontos(e.target.value)} /></label>
        <button className="btn primary" onClick={add}>+ Adicionar</button>
      </div>
      <div className="wrap">
        {state.criterios.length === 0 ? <div className="empty">Nenhum critério.</div> : (
          <table>
            <thead><tr><th>Critério</th><th className="num">Pontos / unidade</th><th></th></tr></thead>
            <tbody>
              {state.criterios.map((c) => (
                <tr key={c.id}>
                  <td><input className="inline-edit" value={c.nome} onChange={(e) => update(c.id, 'nome', e.target.value)} /></td>
                  <td className="num"><input className="inline-edit" type="number" min="1" style={{ width: 90, textAlign: 'right' }} value={c.pontos} onChange={(e) => update(c.id, 'pontos', Number(e.target.value) || 0)} /></td>
                  <td><DeleteButton onConfirm={() => remove(c.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="section-title" style={{ color: '#9ca3af', fontWeight: 400 }}>Alterar os pontos de um critério recalcula todos os lançamentos já feitos com ele. Excluir um critério remove os lançamentos dele.</div>
    </div>
  )
}

function Dados({ state, setState }) {
  const [texto, setTexto] = useState('')
  const [msg, setMsg] = useState('')

  function gerar() {
    setTexto(JSON.stringify(state, null, 2))
    setMsg('Backup gerado abaixo. Copie o texto e guarde em um arquivo.')
  }

  function baixar() {
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'competicao-mensal-backup.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setMsg('Se o download não iniciar, use "Gerar backup" e copie o texto.')
    } catch {
      setMsg('Download bloqueado neste ambiente. Use "Gerar backup" e copie o texto.')
    }
  }

  function restaurar() {
    try {
      const s = JSON.parse(texto)
      if (!Array.isArray(s.participantes) || !Array.isArray(s.criterios) || !Array.isArray(s.lancamentos)) throw new Error('formato')
      setState({ premio: '', ...s, mes: s.mes || monthOf(todayStr()) })
      setMsg('Backup restaurado.')
    } catch {
      setMsg('Texto inválido. Cole um backup JSON gerado por este app.')
    }
  }

  function limpar() {
    setState(buildSeed())
    setMsg('Dados reiniciados com os exemplos.')
  }

  return (
    <div>
      {msg && <div className="msg">{msg}</div>}
      <div className="form">
        <button className="btn" onClick={gerar}>Gerar backup</button>
        <button className="btn" onClick={baixar}>Baixar backup</button>
        <button className="btn primary" onClick={restaurar}>Restaurar do texto</button>
        <DeleteButton onConfirm={limpar} />
      </div>
      <textarea className="backup" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="O backup aparece aqui. Para restaurar, cole o JSON neste campo e clique em Restaurar do texto." />
    </div>
  )
}

const TABS = [
  ['ranking', 'Ranking'],
  ['lancamentos', 'Lançamentos'],
  ['participantes', 'Participantes'],
  ['criterios', 'Critérios'],
  ['dados', 'Backup'],
]

export default function App() {
  useInjectedStyles()
  const [state, setState] = useState(loadState)
  const [tab, setTab] = useState('ranking')

  useEffect(() => {
    storage.set(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  const lancMes = useMemo(() => state.lancamentos.filter((l) => monthOf(l.data) === state.mes), [state.lancamentos, state.mes])

  const ranking = useMemo(() => {
    const pontosCrit = Object.fromEntries(state.criterios.map((c) => [c.id, c.pontos]))
    const lista = state.participantes.map((p) => {
      const meus = lancMes.filter((l) => l.participanteId === p.id)
      const pontos = meus.reduce((s, l) => s + (pontosCrit[l.criterioId] || 0) * l.quantidade, 0)
      return { id: p.id, nome: p.nome, equipe: p.equipe, qtd: meus.length, pontos }
    })
    return lista.sort((a, b) => b.pontos - a.pontos || b.qtd - a.qtd || a.nome.localeCompare(b.nome))
  }, [state.participantes, state.criterios, lancMes])

  const equipes = useMemo(() => {
    const mapa = {}
    ranking.forEach((r) => {
      const chave = r.equipe || 'Sem equipe'
      mapa[chave] = mapa[chave] || { equipe: chave, membros: 0, pontos: 0 }
      mapa[chave].membros += 1
      mapa[chave].pontos += r.pontos
    })
    return Object.values(mapa).sort((a, b) => b.pontos - a.pontos)
  }, [ranking])

  return (
    <div className="cm">
      <header className="cm-header">
        <div>
          <h1>Competição Mensal ICQA</h1>
          <div className="cm-sub">Pontuação por participante e por equipe, mês a mês</div>
        </div>
        <div className="cm-month">
          <button className="btn" onClick={() => setState((s) => ({ ...s, mes: shiftMonth(s.mes, -1) }))}>◀</button>
          <span className="label">{monthLabel(state.mes)}</span>
          <button className="btn" onClick={() => setState((s) => ({ ...s, mes: shiftMonth(s.mes, 1) }))}>▶</button>
        </div>
      </header>
      <nav className="cm-tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      <main className="cm-main">
        {tab === 'ranking' && <Ranking state={state} setState={setState} ranking={ranking} equipes={equipes} lancMes={lancMes} />}
        {tab === 'lancamentos' && <Lancamentos state={state} setState={setState} lancMes={lancMes} />}
        {tab === 'participantes' && <Participantes state={state} setState={setState} />}
        {tab === 'criterios' && <Criterios state={state} setState={setState} />}
        {tab === 'dados' && <Dados state={state} setState={setState} />}
      </main>
    </div>
  )
}
