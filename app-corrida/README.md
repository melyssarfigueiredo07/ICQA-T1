# Corrida de Produtividade / Competição Mensal (versão GRID)

Adaptação do app Google Apps Script "Corrida de Produtividade" para o GRID.
A interface é a mesma; o `Código.gs` foi portado para `src/engine.js` e os dados
(antes em `PropertiesService`) agora ficam em `src/storage.js`:

1. API de state do GRID (`/api/v1/documents/{doc_id}/state`), compartilhada entre usuários
2. `localStorage` (se o iframe permitir)
3. memória (aba Backup para não perder dados)

## Build e pacote

```
npm install
npm run build
cd dist && zip -r ../corrida-produtividade-grid.zip index.html assets
```

## Migrar os dados do Apps Script

No editor do Apps Script, rode e copie o resultado do log:

```js
function exportarParaGrid() {
  var p = PropertiesService.getScriptProperties();
  Logger.log(JSON.stringify({
    meta: JSON.parse(p.getProperty("meta") || "{}"),
    entries: JSON.parse(p.getProperty("entries") || "[]")
  }));
}
```

Cole o JSON na aba Backup do app e clique em "Restaurar do texto".
