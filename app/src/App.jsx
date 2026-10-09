import { useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'icqa_grid_state_v1'
const AREA_OPTIONS = ['Inbound', 'Outbound', 'Dock', 'Sorter', 'ICQA', 'Outros']
const TURNO_OPTIONS = ['Manhã', 'Tarde', 'Noite']

const BADGE_MAP = {
  ativo: 'ok', 'concluído': 'ok', concluido: 'ok', resolvido: 'ok',
  confirmado: 'ok', confirmada: 'ok', alinhado: 'ok',
  'em andamento': 'info', investigando: 'info', revisar: 'warn',
  pendente: 'warn', 'não iniciado': 'neutral', 'nao iniciado': 'neutral',
  aberto: 'warn', alta: 'bad', 'média': 'warn', media: 'warn', baixa: 'neutral',
  atrasado: 'bad', bloqueado: 'bad', falta: 'bad', desligado: 'bad',
  afastado: 'warn', 'férias': 'info', ferias: 'info', alterada: 'warn',
}

function badgeTone(value) {
  const key = String(value || '').trim().toLowerCase()
  return BADGE_MAP[key] || 'neutral'
}

function uid() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function col(key, label, type, options) {
  return { key, label, type: type || 'text', options: options || null }
}

const MODULES = [
  {
    key: 'reps',
    label: 'Reps',
    columns: [
      col('nome', 'Nome'),
      col('matricula', 'Matrícula'),
      col('funcao', 'Função'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('turno', 'Turno', 'select', TURNO_OPTIONS),
      col('status', 'Status', 'select', ['Ativo', 'Férias', 'Afastado', 'Desligado']),
      col('observacoes', 'Observações'),
    ],
  },
  {
    key: 'escalas',
    label: 'Escalas',
    columns: [
      col('colaborador', 'Colaborador'),
      col('dia', 'Dia', 'date'),
      col('turno', 'Turno', 'select', TURNO_OPTIONS),
      col('entrada', 'Entrada', 'time'),
      col('saida', 'Saída', 'time'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('status', 'Status', 'select', ['Confirmada', 'Pendente', 'Alterada', 'Falta']),
    ],
  },
  {
    key: 'planos',
    label: 'Planos de Ação',
    columns: [
      col('problema', 'Problema'),
      col('acao', 'Ação'),
      col('responsavel', 'Responsável'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('prazo', 'Prazo', 'date'),
      col('prioridade', 'Prioridade', 'select', ['Alta', 'Média', 'Baixa']),
      col('status', 'Status', 'select', ['Não iniciado', 'Em andamento', 'Concluído', 'Atrasado']),
    ],
  },
  {
    key: 'dimensionamento',
    label: 'Dimensionamento',
    columns: [
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('turno', 'Turno', 'select', TURNO_OPTIONS),
      col('data', 'Data', 'date'),
      col('hcNecessario', 'HC Necessário', 'number'),
      col('hcReal', 'HC Real', 'number'),
      col('gap', 'Gap', 'computed'),
      col('observacoes', 'Observações'),
    ],
  },
  {
    key: 'almoco',
    label: 'Almoço',
    columns: [
      col('colaborador', 'Colaborador'),
      col('turno', 'Turno', 'select', TURNO_OPTIONS),
      col('horario1', 'Saída almoço', 'time'),
      col('horario2', 'Retorno almoço', 'time'),
      col('duracao', 'Duração (min)', 'number'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('status', 'Status', 'select', ['Confirmado', 'Pendente']),
    ],
  },
  {
    key: 'pontos',
    label: 'Pontos Alinhados',
    columns: [
      col('tema', 'Tema'),
      col('data', 'Data', 'date'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('responsavel', 'Responsável'),
      col('decisao', 'Decisão'),
      col('status', 'Status', 'select', ['Alinhado', 'Pendente', 'Revisar']),
    ],
  },
  {
    key: 'lost',
    label: 'Controle de Lost em MU',
    columns: [
      col('data', 'Data', 'date'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('item', 'SKU / Item'),
      col('quantidadeMU', 'Quantidade (MU)', 'number'),
      col('motivo', 'Motivo', 'select', ['Avaria', 'Extravio', 'Erro de processo', 'Outro']),
      col('responsavel', 'Responsável'),
      col('status', 'Status', 'select', ['Aberto', 'Investigando', 'Resolvido']),
    ],
  },
  {
    key: 'tarefas',
    label: 'Desenvolvimento de Tarefas',
    columns: [
      col('tarefa', 'Tarefa'),
      col('responsavel', 'Responsável'),
      col('area', 'Área', 'select', AREA_OPTIONS),
      col('inicio', 'Início', 'date'),
      col('fim', 'Fim', 'date'),
      col('progresso', 'Progresso (%)', 'number'),
      col('status', 'Status', 'select', ['Não iniciado', 'Em andamento', 'Concluído', 'Bloqueado']),
    ],
  },
]

function seedRow(mod, values) {
  const row = { id: uid() }
  mod.columns.forEach((c) => {
    row[c.key] = values && values[c.key] !== undefined ? values[c.key] : ''
  })
  return row
}

function buildSeed() {
  const s = {}
  s.reps = [seedRow(MODULES[0], { nome: 'Exemplo - editar ou excluir', funcao: 'Operador', area: 'ICQA', turno: 'Manhã', status: 'Ativo' })]
  s.escalas = [seedRow(MODULES[1], { colaborador: 'Exemplo - editar ou excluir', turno: 'Manhã', area: 'ICQA', status: 'Pendente' })]
  s.planos = [seedRow(MODULES[2], { problema: 'Exemplo - editar ou excluir', prioridade: 'Média', status: 'Não iniciado' })]
  s.dimensionamento = [seedRow(MODULES[3], { area: 'ICQA', turno: 'Manhã', hcNecessario: 10, hcReal: 8 })]
  s.almoco = [seedRow(MODULES[4], { colaborador: 'Exemplo - editar ou excluir', turno: 'Manhã', duracao: 60, status: 'Pendente' })]
  s.pontos = [seedRow(MODULES[5], { tema: 'Exemplo - editar ou excluir', status: 'Pendente' })]
  s.lost = [seedRow(MODULES[6], { item: 'Exemplo - editar ou excluir', quantidadeMU: 0, motivo: 'Avaria', status: 'Aberto' })]
  s.tarefas = [seedRow(MODULES[7], { tarefa: 'Exemplo - editar ou excluir', progresso: 0, status: 'Não iniciado' })]
  return s
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return buildSeed()
    const parsed = JSON.parse(raw)
    MODULES.forEach((m) => {
      if (!parsed[m.key]) parsed[m.key] = []
    })
    return parsed
  } catch {
    return buildSeed()
  }
}

function computeValue(mod, row) {
  if (mod.key === 'dimensionamento') {
    const need = parseFloat(row.hcNecessario) || 0
    const real = parseFloat(row.hcReal) || 0
    return real - need
  }
  return ''
}

function csvEscape(v) {
  v = v === undefined || v === null ? '' : String(v)
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

function parseCsv(text) {
  const rows = []
  let i = 0, field = '', row = [], inQuotes = false
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  row.push(field)
  rows.push(row)
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const STYLES = `
  .app-shell { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #e5e7eb; min-height: 100vh; }
  .app-header { padding: 16px 24px; border-bottom: 1px solid #26262b; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .app-header h1 { font-size: 18px; margin: 0; color: #f5f5f5; }
  .app-header .sub { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .tabs { display: flex; gap: 4px; padding: 8px 16px 0; overflow-x: auto; border-bottom: 1px solid #26262b; }
  .tabs button { border: none; background: transparent; padding: 10px 14px; font-size: 13px; cursor: pointer; color: #9ca3af; border-bottom: 2px solid transparent; white-space: nowrap; }
  .tabs button.active { color: #60a5fa; border-bottom: 2px solid #60a5fa; font-weight: 600; }
  main.content { padding: 20px; max-width: 1400px; margin: 0 auto; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar input[type="search"] { padding: 8px 10px; border: 1px solid #33333a; border-radius: 8px; font-size: 13px; min-width: 220px; background: #18181b; color: #e5e7eb; }
  .btn { padding: 8px 12px; border-radius: 8px; border: 1px solid #33333a; background: #1f1f23; color: #e5e7eb; font-size: 13px; cursor: pointer; }
  .btn:hover { background: #27272c; }
  .btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  .btn.primary:hover { background: #1d4ed8; }
  .row-count { font-size: 12px; color: #9ca3af; margin-left: auto; }
  .grid-wrap { background: #141416; border: 1px solid #26262b; border-radius: 10px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  thead th { text-align: left; padding: 10px 8px; background: #1a1a1d; border-bottom: 1px solid #26262b; white-space: nowrap; font-weight: 600; color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tbody td { padding: 4px 6px; border-bottom: 1px solid #202024; vertical-align: middle; }
  tbody tr:hover { background: #18181b; }
  td input, td select { width: 100%; min-width: 110px; padding: 6px 8px; border: 1px solid transparent; border-radius: 6px; font-size: 13px; background: transparent; color: #e5e7eb; font-family: inherit; }
  td input:hover, td select:hover { border-color: #33333a; }
  td input:focus, td select:focus { border-color: #60a5fa; background: #0f0f11; outline: none; }
  td.computed { font-weight: 600; text-align: center; }
  td.actions-cell { white-space: nowrap; text-align: center; }
  .icon-btn { border: none; background: transparent; cursor: pointer; color: #f87171; font-size: 15px; padding: 4px 8px; }
  select.badge { border-radius: 14px; font-weight: 600; font-size: 12px; text-align: center; padding-left: 10px; }
  select.badge option { background: #18181b; color: #e5e7eb; }
  .tone-ok { background: #052e18; color: #4ade80; }
  .tone-warn { background: #3a2c05; color: #fbbf24; }
  .tone-bad { background: #3a0d0d; color: #f87171; }
  .tone-info { background: #062a4a; color: #60a5fa; }
  .tone-neutral { background: #1f1f23; color: #d1d5db; }
  .dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .tile { background: #141416; border: 1px solid #26262b; border-radius: 10px; padding: 16px; }
  .tile .value { font-size: 26px; font-weight: 700; color: #f5f5f5; }
  .tile .label { font-size: 12px; color: #9ca3af; margin-top: 4px; }
  .tile.alert .value { color: #f87171; }
  .empty-hint { padding: 24px; text-align: center; color: #9ca3af; font-size: 13px; }
  .app-footer { text-align: center; font-size: 11px; color: #6b7280; padding: 20px; }
`

function useInjectedStyles() {
  useEffect(() => {
    const styleEl = document.createElement('style')
    styleEl.textContent = STYLES
    document.head.appendChild(styleEl)
    return () => document.head.removeChild(styleEl)
  }, [])
}

function StatTile({ value, label, alert }) {
  return (
    <div className={'tile' + (alert ? ' alert' : '')}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  )
}

function Dashboard({ state }) {
  const repsAtivos = (state.reps || []).filter((r) => r.status === 'Ativo').length
  const planosAtrasados = (state.planos || []).filter((r) => r.status === 'Atrasado').length
  const planosAndamento = (state.planos || []).filter((r) => r.status === 'Em andamento').length
  const gapTotal = (state.dimensionamento || []).reduce(
    (sum, r) => sum + ((parseFloat(r.hcReal) || 0) - (parseFloat(r.hcNecessario) || 0)),
    0
  )
  const lostTotal = (state.lost || []).reduce((sum, r) => sum + (parseFloat(r.quantidadeMU) || 0), 0)
  const pontosPendentes = (state.pontos || []).filter((r) => r.status !== 'Alinhado').length
  const tarefasAndamento = (state.tarefas || []).filter((r) => r.status === 'Em andamento').length
  const tarefasBloqueadas = (state.tarefas || []).filter((r) => r.status === 'Bloqueado').length

  return (
    <div>
      <div className="dashboard-grid">
        <StatTile value={repsAtivos} label="Reps ativos" />
        <StatTile value={planosAndamento} label="Planos de ação em andamento" />
        <StatTile value={planosAtrasados} label="Planos de ação atrasados" alert={planosAtrasados > 0} />
        <StatTile value={(gapTotal > 0 ? '+' : '') + gapTotal} label="Gap de dimensionamento" alert={gapTotal < 0} />
        <StatTile value={lostTotal} label="Total lost (MU)" alert={lostTotal > 0} />
        <StatTile value={pontosPendentes} label="Pontos pendentes de alinhamento" alert={pontosPendentes > 0} />
        <StatTile value={tarefasAndamento} label="Tarefas em andamento" />
        <StatTile value={tarefasBloqueadas} label="Tarefas bloqueadas" alert={tarefasBloqueadas > 0} />
      </div>
      <div className="empty-hint">Use as abas acima para editar cada módulo. Os totais aqui atualizam automaticamente.</div>
    </div>
  )
}

function ModuleView({ mod, rows, onUpdateCell, onAddRow, onRemoveRow, onImportRows }) {
  const [search, setSearch] = useState('')
  const fileInputRef = useRef(null)

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    if (!term) return rows
    return rows.filter((row) =>
      mod.columns.some((c) => {
        const v = c.type === 'computed' ? computeValue(mod, row) : row[c.key]
        return String(v || '').toLowerCase().indexOf(term) > -1
      })
    )
  }, [rows, search, mod])

  function exportCsv() {
    const headers = mod.columns.map((c) => c.label)
    const lines = [headers.map(csvEscape).join(',')]
    rows.forEach((row) => {
      const vals = mod.columns.map((c) => csvEscape(c.type === 'computed' ? computeValue(mod, row) : row[c.key]))
      lines.push(vals.join(','))
    })
    downloadBlob(lines.join('\n'), 'text/csv;charset=utf-8;', mod.key + '.csv')
  }

  function handleImportFile(e) {
    const f = e.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const parsedRows = parseCsv(reader.result)
      if (parsedRows.length < 1) return
      const header = parsedRows[0]
      const idxByCol = {}
      mod.columns.forEach((c) => {
        const idx = header.indexOf(c.label)
        if (idx > -1) idxByCol[c.key] = idx
      })
      const newRows = []
      for (let r = 1; r < parsedRows.length; r++) {
        const raw = parsedRows[r]
        if (raw.length === 1 && raw[0].trim() === '') continue
        const obj = { id: uid() }
        mod.columns.forEach((c) => {
          if (c.type === 'computed') return
          const idx = idxByCol[c.key]
          obj[c.key] = idx !== undefined && raw[idx] !== undefined ? raw[idx] : ''
        })
        newRows.push(obj)
      }
      onImportRows(newRows)
    }
    reader.readAsText(f, 'UTF-8')
    e.target.value = ''
  }

  return (
    <div>
      <div className="toolbar">
        <input
          type="search"
          placeholder={'Buscar em ' + mod.label + '...'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn primary" onClick={onAddRow}>+ Adicionar linha</button>
        <button className="btn" onClick={exportCsv}>Exportar CSV</button>
        <button className="btn" onClick={() => fileInputRef.current?.click()}>Importar CSV</button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleImportFile} />
        <span className="row-count">{filtered.length} linha(s)</span>
      </div>
      <div className="grid-wrap">
        {rows.length === 0 ? (
          <div className="empty-hint">Nenhuma linha ainda. Clique em "+ Adicionar linha" para começar.</div>
        ) : (
          <table>
            <thead>
              <tr>
                {mod.columns.map((c) => <th key={c.key}>{c.label}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  {mod.columns.map((c) => (
                    <td key={c.key} className={c.type === 'computed' ? 'computed' : undefined}>
                      {c.type === 'computed' ? (
                        computeValue(mod, row)
                      ) : c.type === 'select' ? (
                        <select
                          className={'badge tone-' + badgeTone(row[c.key])}
                          value={row[c.key] || ''}
                          onChange={(e) => onUpdateCell(row.id, c.key, e.target.value)}
                        >
                          <option value="">—</option>
                          {c.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      ) : (
                        <input
                          type={c.type === 'time' ? 'time' : c.type === 'date' ? 'date' : c.type === 'number' ? 'number' : 'text'}
                          value={row[c.key] || ''}
                          onChange={(e) => onUpdateCell(row.id, c.key, e.target.value)}
                        />
                      )}
                    </td>
                  ))}
                  <td className="actions-cell">
                    <button className="icon-btn" title="Excluir linha" onClick={() => onRemoveRow(row.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default function App() {
  useInjectedStyles()
  const [state, setState] = useState(loadState)
  const [activeTab, setActiveTab] = useState('dashboard')
  const backupInputRef = useRef(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  const activeMod = MODULES.find((m) => m.key === activeTab)

  function updateCell(modKey, rowId, colKey, value) {
    setState((prev) => ({
      ...prev,
      [modKey]: prev[modKey].map((r) => (r.id === rowId ? { ...r, [colKey]: value } : r)),
    }))
  }

  function addRow(mod) {
    setState((prev) => ({ ...prev, [mod.key]: [...prev[mod.key], seedRow(mod)] }))
  }

  function removeRow(mod, rowId) {
    if (!confirm('Excluir esta linha?')) return
    setState((prev) => ({ ...prev, [mod.key]: prev[mod.key].filter((r) => r.id !== rowId) }))
  }

  function importRows(mod, newRows) {
    setState((prev) => ({ ...prev, [mod.key]: newRows }))
  }

  function exportBackup() {
    downloadBlob(JSON.stringify(state, null, 2), 'application/json', 'icqa-grid-backup.json')
  }

  function importBackup(e) {
    const f = e.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result)
        MODULES.forEach((m) => {
          if (!parsed[m.key]) parsed[m.key] = []
        })
        setState(parsed)
      } catch {
        alert('Arquivo inválido. Selecione um backup JSON exportado por este painel.')
      }
    }
    reader.readAsText(f, 'UTF-8')
    e.target.value = ''
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Painel de Operações ICQA</h1>
          <div className="sub">Reps · Escalas · Planos de ação · Dimensionamento · Almoço · Pontos alinhados · Controle de lost em MU · Desenvolvimento de tarefas</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={exportBackup}>Exportar backup (JSON)</button>
          <button className="btn" onClick={() => backupInputRef.current?.click()}>Importar backup (JSON)</button>
          <input ref={backupInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={importBackup} />
        </div>
      </header>
      <nav className="tabs">
        <button className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>Resumo</button>
        {MODULES.map((m) => (
          <button key={m.key} className={activeTab === m.key ? 'active' : ''} onClick={() => setActiveTab(m.key)}>{m.label}</button>
        ))}
      </nav>
      <main className="content">
        {activeTab === 'dashboard' ? (
          <Dashboard state={state} />
        ) : (
          <ModuleView
            mod={activeMod}
            rows={state[activeMod.key] || []}
            onUpdateCell={(rowId, colKey, value) => updateCell(activeMod.key, rowId, colKey, value)}
            onAddRow={() => addRow(activeMod)}
            onRemoveRow={(rowId) => removeRow(activeMod, rowId)}
            onImportRows={(newRows) => importRows(activeMod, newRows)}
          />
        )}
      </main>
      <footer className="app-footer">Os dados ficam salvos neste navegador (localStorage). Use "Exportar backup" para guardar uma cópia ou transferir para outro computador.</footer>
    </div>
  )
}
