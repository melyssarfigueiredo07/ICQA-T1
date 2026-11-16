/**
 * Controle de RQ — backend compartilhado (Google Apps Script + Google Sheets)
 *
 * CONFIGURAÇÃO (uma vez só):
 *  1. Crie uma Planilha Google (ex.: "Controle de RQ – dados").
 *  2. Extensões > Apps Script. Apague o conteúdo padrão e cole este arquivo.
 *  3. Implantar > Nova implantação > tipo "Aplicativo da Web":
 *       - Executar como: "Eu"
 *       - Quem tem acesso: "Qualquer pessoa da organização" (ou o grupo do time)
 *  4. Copie a URL gerada (termina em /exec) e cole em SHARED_URL no controle-rq.html.
 *
 * As abas "baixas", "responsaveis" e "meta" são criadas automaticamente.
 * Cada gravação substitui o conteúdo inteiro das abas; o campo "versao" em "meta"
 * impede que uma gravação antiga sobrescreva outra feita ao mesmo tempo.
 */

const H_BAIXA = ['id', 'sku', 'quantidade', 'origem', 'skuReingresso', 'responsavel', 'turno', 'data'];
const H_RESP  = ['id', 'nome', 'turno', 'cargo'];

function doGet() {
  return out_(snapshot_());
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const body = JSON.parse(e.postData.contents);
    const atual = getVersion_();

    if (Number(body.baseVersion) !== atual) {
      // alguém gravou depois; devolve o estado atual sem gravar nada
      return out_(Object.assign({ conflict: true }, snapshot_()));
    }

    writeTable_(sheet_('baixas', H_BAIXA), H_BAIXA, body.baixas || []);
    writeTable_(sheet_('responsaveis', H_RESP), H_RESP, body.resp || []);
    setVersion_(atual + 1);
    return out_(Object.assign({ conflict: false }, snapshot_()));
  } finally {
    lock.releaseLock();
  }
}

// ---------- helpers ----------

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name, headers) {
  const s = ss_();
  let sh = s.getSheetByName(name);
  if (!sh) {
    sh = s.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function meta_() {
  const m = sheet_('meta', ['chave', 'valor']);
  if (m.getLastRow() < 2) m.appendRow(['versao', 0]);
  return m;
}

function getVersion_() {
  return Number(meta_().getRange(2, 2).getValue()) || 0;
}

function setVersion_(v) {
  meta_().getRange(2, 2).setValue(v);
}

function readTable_(sh, headers) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues()
    .filter(r => String(r[0]) !== '')
    .map(r => headers.reduce((o, h, i) => (o[h] = r[i], o), {}));
}

function writeTable_(sh, headers, rows) {
  // tudo como texto: evita o Sheets converter datas (yyyy-mm-dd) e números
  sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), headers.length).clearContent().setNumberFormat('@');
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, headers.length)
      .setValues(rows.map(o => headers.map(h => String(o[h] ?? ''))));
  }
}

function snapshot_() {
  return {
    version: getVersion_(),
    baixas: readTable_(sheet_('baixas', H_BAIXA), H_BAIXA),
    resp: readTable_(sheet_('responsaveis', H_RESP), H_RESP)
  };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
