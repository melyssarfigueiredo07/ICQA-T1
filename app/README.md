# ICQA Tracker

Painel de operações (Reps, Escalas, Planos de Ação, Dimensionamento, Almoço,
Pontos Alinhados, Controle de Lost em MU, Desenvolvimento de Tarefas) para
publicar no GRID.

## Desenvolvimento

```
npm install
npm run dev
```

## Gerar o pacote para o GRID

O GRID espera um `index.html` que carregue um bundle JS a partir de uma pasta
`assets/`, ambos na raiz do zip.

```
npm install
npm run build
cd dist && zip -r ../icqa-tracker-grid.zip index.html assets
```

Suba o `icqa-tracker-grid.zip` gerado no GRID.

Os dados de cada módulo ficam salvos no `localStorage` do navegador. Use os
botões "Exportar backup (JSON)" / "Importar backup (JSON)" no topo do app
para guardar ou transferir os dados.
