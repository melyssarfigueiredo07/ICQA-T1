# Corrida de Produtividade (versão GRID)

Adaptação do app Google Apps Script "Corrida de Produtividade" para o GRID.
A interface é a mesma; o `Código.gs` foi portado para `src/engine.js` e os dados
(antes em `PropertiesService`) agora ficam em `src/storage.js`:

1. `window.GRID.state` (SDK injetado pelo GRID em todo HTML), compartilhado entre usuários
2. memória (se o SDK não existir), usando a aba Backup para não perder dados

O GRID rejeita uploads que usam `localStorage`/`sessionStorage`/`document.cookie`
(erro `invalid_file`), por isso o app não usa nenhum deles.

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
