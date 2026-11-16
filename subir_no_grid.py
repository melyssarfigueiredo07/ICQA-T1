#!/usr/bin/env python3
"""Sobe o Controle de RQ no Grid como documento novo.

Como usar (com a VPN da MELI conectada), na pasta onde estão este script
e o controle-rq-grid.zip:

    python3 subir_no_grid.py

O script pergunta quem deve ter acesso. Também dá para informar direto:

    python3 subir_no_grid.py nome.sobrenome outra.pessoa

Se a pasta controle-rq/ existir ao lado do script, o zip é gerado de novo a
partir dela. O script só cria um documento por pasta: se ele já existir,
mostra o link em vez de criar outro.
"""
import json
import os
import subprocess
import sys
import uuid
import zipfile

SKILL_VERSION = "3.6.11"
TITULO = "Controle de RQ"
GRID_HOST = os.environ.get("GRID_HOST", "https://grid.melioffice.com").rstrip("/")

PASTA_DO_SCRIPT = os.path.dirname(os.path.abspath(__file__))
PASTA_FONTE = os.path.join(PASTA_DO_SCRIPT, "controle-rq")
ZIP = os.path.join(PASTA_DO_SCRIPT, "controle-rq-grid.zip")
ESTADO = os.path.join(PASTA_DO_SCRIPT, ".controle-rq-grid.json")


def montar_zip():
    """Recria o zip a partir de controle-rq/ (se a pasta existir) e confere o zip."""
    if os.path.isdir(PASTA_FONTE):
        arquivos = []
        for raiz, pastas, nomes in os.walk(PASTA_FONTE):
            pastas[:] = sorted(p for p in pastas if not p.startswith("."))
            for nome in sorted(nomes):
                if nome.startswith("."):
                    continue
                completo = os.path.join(raiz, nome)
                arcname = os.path.relpath(completo, PASTA_FONTE).replace(os.sep, "/")
                arquivos.append((arcname, completo))
        if not any(arcname == "index.html" for arcname, _ in arquivos):
            sys.exit("A pasta controle-rq/ não tem index.html. Nada foi enviado.")
        with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
            for arcname, completo in arquivos:
                zf.write(completo, arcname)

    if not os.path.isfile(ZIP):
        sys.exit("Não encontrei controle-rq-grid.zip ao lado do script. Nada foi enviado.")
    with zipfile.ZipFile(ZIP) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
    if not any(i.filename == "index.html" for i in infos):
        sys.exit("O zip precisa ter index.html na raiz. Nada foi enviado.")
    if len(infos) > 500 or any(i.file_size > 25 * 1024 * 1024 for i in infos):
        sys.exit("O zip passa dos limites do Grid (500 arquivos, 25 MB por arquivo). Nada foi enviado.")
    return len(infos)


def ler_estado():
    if not os.path.exists(ESTADO):
        return {}
    with open(ESTADO, encoding="utf-8") as f:
        return json.load(f)


def gravar_estado(dados):
    with open(ESTADO, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)


def apagar_estado():
    if os.path.exists(ESTADO):
        os.remove(ESTADO)


def pessoas_informadas(args):
    if not args:
        print("Quem deve ter acesso ao documento?")
        print("Digite os usuários MELI separados por vírgula (ex.: nome.sobrenome, outra.pessoa).")
        print("Deixe em branco para criar o documento só para você.")
        try:
            args = [input("> ")]
        except EOFError:
            args = []
    return [p.strip() for a in args for p in a.split(",") if p.strip()]


def descrever(pessoa):
    if isinstance(pessoa, dict):
        partes = [str(pessoa[k]) for k in ("name", "username", "email") if pessoa.get(k)]
        return " | ".join(partes) or json.dumps(pessoa, ensure_ascii=False)
    return str(pessoa)


def chamar_grid(config):
    """Uma chamada ao Grid com o arquivo e a configuração. Devolve (codigo_http, resposta)."""
    cmd = [
        "curl", "-sS", "--max-time", "600", "-X", "POST",
        GRID_HOST + "/api/v1/engine/run",
        "-F", "config=" + json.dumps(config, ensure_ascii=False),
        "-F", "file=@" + os.path.basename(ZIP),
        "-w", "\n%{http_code}",
    ]
    p = subprocess.run(cmd, cwd=PASTA_DO_SCRIPT, capture_output=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        return None, (p.stderr.strip() or "falha de conexão")
    corpo, _, codigo = p.stdout.rpartition("\n")
    try:
        resposta = json.loads(corpo)
    except ValueError:
        resposta = {"detail": corpo[:300]}
    return int(codigo or 0), resposta


def main():
    estado = ler_estado()
    if estado.get("doc_id"):
        print("Este controle já foi criado no Grid:")
        print("  " + str(estado.get("view_url") or estado["doc_id"]))
        print("Para criar outro documento, apague o arquivo .controle-rq-grid.json e rode de novo.")
        sys.exit(1)

    pessoas = pessoas_informadas(sys.argv[1:])
    total = montar_zip()

    # a chave é guardada antes do envio: se a conexão cair, a próxima tentativa usa a mesma
    chave = estado.get("idempotency_key") or str(uuid.uuid4())
    gravar_estado({"idempotency_key": chave})

    config = {"skill_version": SKILL_VERSION, "title": TITULO, "idempotency_key": chave}
    if pessoas:
        config["share_with"] = pessoas
    else:
        print("Ninguém foi informado: o documento ficará visível só para você.")

    print(f"Enviando {total} arquivos ao Grid…")
    confirmado = False
    while True:
        cfg = dict(config, confirmed=True) if confirmado else config
        codigo, resp = chamar_grid(cfg)
        if codigo is None:
            print("Não consegui falar com o Grid: " + str(resp))
            print("Confirme que a VPN da MELI está conectada e rode o mesmo comando de novo.")
            sys.exit(1)
        if not isinstance(resp, dict):
            resp = {"detail": str(resp)}

        doc_id = resp.get("doc_id")
        if doc_id:
            # o documento existe (mesmo que algum passo tenha falhado): nunca criar outro
            gravar_estado({"doc_id": doc_id, "view_url": resp.get("view_url"), "idempotency_key": chave})

        if codigo == 401:
            apagar_estado()
            print("Sem acesso ao Grid. Conecte-se à VPN da MELI e rode de novo.")
            if resp.get("recovery"):
                print(str(resp["recovery"]))
            sys.exit(1)
        if codigo == 426:
            apagar_estado()
            print("A versão da skill do Grid mudou. Avise quem mantém este script para atualizar SKILL_VERSION.")
            sys.exit(1)

        if resp.get("ok"):
            print("")
            print("Criado no Grid: " + str(resp.get("view_url")))
            for aviso in resp.get("warnings") or []:
                print("Aviso: " + str(aviso))
            print("Cópia do pacote enviado: " + ZIP)
            return

        if resp.get("confirmation_required"):
            if confirmado:
                if not doc_id:
                    apagar_estado()
                sys.exit("O Grid pediu confirmação de novo. Nada mais foi enviado; tente de novo.")
            conf = resp["confirmation_required"]
            print(str(conf.get("message") if isinstance(conf, dict) else conf))
            for pessoa in (resp.get("data") or {}).get("resolved_recipients") or []:
                print("  - " + descrever(pessoa))
            try:
                escolha = input("Confirmar o compartilhamento com essas pessoas? (s/N): ")
            except EOFError:
                escolha = ""
            if escolha.strip().lower() not in ("s", "sim", "y", "yes"):
                apagar_estado()
                print("Cancelado. Nada foi criado.")
                sys.exit(1)
            confirmado = True
            continue

        ambiguos = resp.get("disambiguation") or []
        if ambiguos:
            if not doc_id:
                apagar_estado()
            print("Não consegui identificar estes usuários. Use o usuário exato e rode de novo:")
            for pessoa in ambiguos:
                print("  - " + descrever(pessoa))
            sys.exit(1)

        falhas = [s for s in resp.get("steps") or [] if isinstance(s, dict) and s.get("status") == "FAIL"]
        if not doc_id:
            apagar_estado()
        print("Não foi possível concluir o envio.")
        for s in falhas:
            print("- {}: {}".format(s.get("label", "passo"), s.get("detail", "")))
            if s.get("recovery"):
                print("  Como resolver: " + str(s["recovery"]))
        if not falhas:
            print(str(resp.get("detail") or resp))
        if doc_id:
            print("O documento foi criado mesmo assim: " + str(resp.get("view_url")))
        sys.exit(1)


if __name__ == "__main__":
    main()
