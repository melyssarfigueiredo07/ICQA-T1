/**
 * Aviso no Chat assim que um preenchimento do forms entra na planilha de respostas.
 *
 * Como ativar (uma vez), em script.google.com com a conta da MELI:
 *  1. Novo projeto. Apague o conteúdo de Código.gs e cole este arquivo inteiro.
 *  2. Engrenagem (Configurações do projeto) → Propriedades do script → Adicionar propriedade:
 *     nome CHAT_WEBHOOK, valor = o link do webhook do espaço. Salve.
 *  3. Na barra de cima, escolha a função instalarGatilho → Executar. Autorize a conta quando pedir.
 *  4. Para conferir sem enviar nada: escolha verMensagemDaUltimaResposta → Executar → Execuções.
 *
 * O webhook não fica neste código: só nas propriedades do script.
 */

var PLANILHA_ID = '1YfsjQmcCwMwtKyzoTksEtkDGdAZgdIwzZS7ppAsEkO0';
var NOME_ABA = 'Respostas ao formulário 1';
var LINK_PAINEL = 'https://grid.adminml.com/d/01M32FJN749JESZP7A0YTSZKRT/view';

// Menção do líder no Chat (users/ID). Vazio = o aviso sai sem marcar ninguém.
var MENCOES = {
  vinicius: 'users/115181501054816205248',
  harley: 'users/110599869128578133441'
};

// Roda a cada resposta nova do formulário.
function onFormSubmit(e) {
  enviarAviso_(lerResposta_(e.range.getSheet(), e.range.getRow()));
}

// Execute uma vez: cria o gatilho de envio do formulário (apaga os antigos para não duplicar).
function instalarGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(PLANILHA_ID).onFormSubmit().create();
}

// Mostra nos registros a mensagem da última resposta, sem enviar.
function verMensagemDaUltimaResposta() {
  var aba = SpreadsheetApp.openById(PLANILHA_ID).getSheetByName(NOME_ABA);
  Logger.log(montarTexto(lerResposta_(aba, aba.getLastRow())));
}

function enviarAviso_(campos) {
  var webhook = PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK');
  if (!webhook) throw new Error('Falta a propriedade CHAT_WEBHOOK (Configurações do projeto → Propriedades do script).');
  var resposta = UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: montarTexto(campos) }),
    muteHttpExceptions: true
  });
  if (resposta.getResponseCode() !== 200) {
    throw new Error('O Chat respondeu ' + resposta.getResponseCode() + ': ' + resposta.getContentText());
  }
}

// Texto aprovado: "Nova solicitação de banco de horas: {nome}, dia {data}, saldo {saldo}, escala {escala}. Aprovar no Painel de Reps."
function montarTexto(campos) {
  var mencao = mencaoDo_(campos.lider);
  var texto = 'Nova solicitação de banco de horas: ' + campos.nome + ', dia ' + campos.data +
    ', saldo ' + (campos.saldo || 'não informado') + ', escala ' + (campos.escala || 'não informada') +
    '. Aprovar no <' + LINK_PAINEL + '|Painel de Reps>.';
  return (mencao ? '<' + mencao + '> ' : '') + texto;
}

function mencaoDo_(lider) {
  var n = normaliza_(lider);
  if (n.indexOf('vinicius') > -1) return MENCOES.vinicius;
  if (n.indexOf('harley') > -1) return MENCOES.harley;
  return '';
}

// Lê a linha da resposta pelo nome das colunas (sem diferença de acento, maiúscula ou espaço no fim).
function lerResposta_(aba, linha) {
  var colunas = aba.getLastColumn();
  var cabecalho = aba.getRange(1, 1, 1, colunas).getValues()[0];
  var valores = aba.getRange(linha, 1, 1, colunas).getValues()[0];
  var campos = {};
  cabecalho.forEach(function (titulo, i) {
    campos[normaliza_(titulo)] = formatar_(valores[i]);
  });
  return {
    nome: campos['nome'] || '',
    data: campos['data'] || '',
    saldo: campos['saldo de horas'] || '',
    escala: campos['escala'] || '',
    lider: campos['lider'] || ''
  };
}

function formatar_(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  return String(valor == null ? '' : valor).trim();
}

function normaliza_(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
