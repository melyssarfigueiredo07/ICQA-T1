// Extrator do LMS (rep-worklog) — rode no Console da aba do LMS, já logado.
// Só LÊ a página (e repete GETs que a própria página já fez). Não envia nada para lugar nenhum:
// o resultado é copiado para a sua área de transferência para você colar no Claude / no app.
(async () => {
  const txt = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const MAX_BODY = 300000;

  // 1) Tabelas da página (e de iframes do mesmo domínio), incluindo grades ARIA (role=table/grid)
  function tabelasDe(doc, origem) {
    const out = [];
    doc.querySelectorAll("table").forEach((t, i) => {
      const linhas = [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map(txt)).filter((l) => l.some(Boolean));
      if (!linhas.length) return;
      const cap = t.querySelector("caption");
      const titulo = (cap && txt(cap)) || txt(t.closest("section,div,article") && t.closest("section,div,article").querySelector("h1,h2,h3,h4,.title") || t) .slice(0, 80);
      const temTh = t.querySelector("thead th, tr th");
      out.push({ origem, indice: i, titulo, cabecalho: temTh ? linhas[0] : null, linhas: temTh ? linhas.slice(1) : linhas });
    });
    doc.querySelectorAll('[role="table"],[role="grid"]').forEach((g, i) => {
      const linhas = [...g.querySelectorAll('[role="row"]')].map((r) => [...r.querySelectorAll('[role="columnheader"],[role="cell"],[role="gridcell"]')].map(txt)).filter((l) => l.some(Boolean));
      if (linhas.length) out.push({ origem: origem + " (aria)", indice: i, titulo: txt(g).slice(0, 80), cabecalho: linhas[0], linhas: linhas.slice(1) });
    });
    return out;
  }
  let tabelas = tabelasDe(document, "pagina");
  document.querySelectorAll("iframe").forEach((f, i) => {
    try { if (f.contentDocument) tabelas = tabelas.concat(tabelasDe(f.contentDocument, "iframe" + i)); } catch (e) { /* outro domínio: ignora */ }
  });

  // 2) Chamadas de dados (fetch/XHR) que a página já fez: repete só os GETs do mesmo domínio e guarda o JSON
  const vistos = new Set();
  const alvos = performance.getEntriesByType("resource")
    .filter((r) => (r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest"))
    .map((r) => r.name)
    .filter((u) => { try { return new URL(u).origin === location.origin; } catch (e) { return false; } })
    .filter((u) => !vistos.has(u) && vistos.add(u))
    .slice(0, 20);
  const respostas = [];
  for (const u of alvos) {
    try {
      const r = await fetch(u, { credentials: "include" });
      const tipo = r.headers.get("content-type") || "";
      if (!r.ok || !/json/i.test(tipo)) { respostas.push({ url: u, status: r.status, tipo }); continue; }
      let corpo = await r.text();
      const cortado = corpo.length > MAX_BODY;
      if (cortado) corpo = corpo.slice(0, MAX_BODY);
      let json = null; try { json = JSON.parse(corpo); } catch (e) { /* cortado */ }
      respostas.push({ url: u, status: r.status, cortado, json: json, texto: json ? undefined : corpo });
    } catch (e) { respostas.push({ url: u, erro: String(e) }); }
  }

  const resultado = {
    fonte: "lms rep-worklog",
    url: location.href,
    repId: new URLSearchParams(location.search).get("id"),
    titulo: document.title,
    cabecalhos: [...document.querySelectorAll("h1,h2,h3")].map(txt).filter(Boolean).slice(0, 10),
    coletadoEm: new Date().toISOString(),
    tabelas, respostas,
  };
  const json = JSON.stringify(resultado, null, 1);

  // 3) Resumo na tela do Console
  console.log("%cLMS: " + tabelas.length + " tabela(s), " + respostas.length + " chamada(s) de dados", "font-weight:bold");
  tabelas.forEach((t, i) => { console.log("Tabela " + i + " — " + t.titulo + " (" + t.linhas.length + " linhas)"); if (t.cabecalho) console.log("  colunas:", t.cabecalho.join(" | ")); });
  respostas.forEach((r) => console.log("  dados:", r.status || "", r.url));
  if (!tabelas.length && !respostas.length) console.warn("Nada encontrado. Espere a tabela carregar na tela e rode de novo.");

  // 4) Copia o resultado (copy() só existe no Console; senão tenta a área de transferência; senão mostra uma caixa)
  let copiado = false;
  try { if (typeof copy === "function") { copy(json); copiado = true; } } catch (e) { /* segue */ }
  if (!copiado) { try { await navigator.clipboard.writeText(json); copiado = true; } catch (e) { /* segue */ } }
  if (!copiado) {
    const ta = document.createElement("textarea");
    ta.value = json; ta.style.cssText = "position:fixed;top:10px;left:10px;width:60vw;height:40vh;z-index:2147483647;background:#ffe";
    document.body.appendChild(ta); ta.select();
    console.warn("Copie o texto da caixa amarela (Ctrl+C) e depois feche-a.");
    ta.addEventListener("blur", () => ta.remove());
  }
  console.log(copiado ? "✓ Resultado copiado (" + Math.round(json.length / 1024) + " KB). Cole no chat com Ctrl+V." : "Resultado na caixa amarela.");
  return resultado;
})();
