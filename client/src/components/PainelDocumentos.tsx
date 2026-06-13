// ============================================================
// PainelDocumentos — Upload em lote, correspondência automática
// e relatório para contabilista
// ============================================================
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Movimento, formatEur } from "@/lib/faturas";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Upload, FileText, CheckCircle2, XCircle, Link2,
  Download, Loader2, AlertTriangle, FileCheck2, ClipboardList,
} from "lucide-react";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface DadosDocumento {
  tipo: "FATURA" | "RECIBO_VERDE";
  numeroDocumento: string;
  inst: string | null;
  nomePrestador: string;
  nomeCliente: string;
  valor: number;
  mesServico: string;
  anoServico: number;
  dataEmissao: string;
  arquivoKey: string;
  arquivoUrl: string;
  arquivoNome: string;
}

interface Correspondencia {
  docIdx: number;         // índice em documentosAnalisados
  movId: string;          // ID do movimento no extrato
  confianca: "alta" | "media" | "baixa";
  motivo: string;
  confirmada: boolean;
}

interface Props {
  movimentos: Movimento[];
  mes: string;
  ano: number;
  config: { empresaNome: string; empresaNif: string; empresaMorada: string } | null;
  correspondenciasGuardadas: Correspondencia[];
  documentosGuardados: DadosDocumento[];
  onCorrespondenciasChange: (corrs: Correspondencia[], docs: DadosDocumento[]) => void;
}

// ─── Lógica de correspondência automática ─────────────────────────────────────

function encontrarCorrespondencia(
  doc: DadosDocumento,
  movimentos: Movimento[],
  usadas: Set<string>
): { movId: string; confianca: "alta" | "media" | "baixa"; motivo: string } | null {
  if (doc.tipo === "FATURA" && doc.inst) {
    // Correspondência por INST — alta confiança
    const mov = movimentos.find(
      m => m.inst === doc.inst && !usadas.has(m.id) &&
           (m.tipo === "GERAR FATURA" || m.tipo === "")
    );
    if (mov) return { movId: mov.id, confianca: "alta", motivo: `INST ${doc.inst} encontrado no extrato` };
  }

  if (doc.tipo === "RECIBO_VERDE") {
    // Correspondência por valor + nome (parcial) — média confiança
    const nomeLower = doc.nomePrestador.toLowerCase();
    const primeiroNome = nomeLower.split(" ")[0];
    const mov = movimentos.find(m => {
      if (usadas.has(m.id)) return false;
      if (m.tipo !== "RECIBO VERDE" && m.tipo !== "") return false;
      const diffValor = Math.abs(m.valor - doc.valor);
      const descLower = m.descricao.toLowerCase();
      const nomeMatch = descLower.includes(primeiroNome) || descLower.includes(nomeLower.split(" ").pop() || "");
      const valorMatch = diffValor < 1;
      if (nomeMatch && valorMatch) return true;
      if (valorMatch) return true; // só valor — baixa confiança
      return false;
    });
    if (mov) {
      const descLower = mov.descricao.toLowerCase();
      const nomeMatch = descLower.includes(primeiroNome);
      return {
        movId: mov.id,
        confianca: nomeMatch ? "media" : "baixa",
        motivo: nomeMatch
          ? `Nome "${doc.nomePrestador}" e valor ${formatEur(doc.valor)} coincidem`
          : `Valor ${formatEur(doc.valor)} coincide (confirmar nome)`,
      };
    }
  }

  if (doc.tipo === "FATURA" && !doc.inst) {
    // Sem INST — tentar por valor
    const mov = movimentos.find(
      m => !usadas.has(m.id) &&
           (m.tipo === "GERAR FATURA" || m.tipo === "") &&
           Math.abs(m.valor - doc.valor) < 1
    );
    if (mov) return { movId: mov.id, confianca: "baixa", motivo: `Valor ${formatEur(doc.valor)} coincide (sem INST)` };
  }

  return null;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function PainelDocumentos({
  movimentos, mes, ano, config,
  correspondenciasGuardadas, documentosGuardados,
  onCorrespondenciasChange,
}: Props) {
  const [documentos, setDocumentos] = useState<DadosDocumento[]>(documentosGuardados);
  const [correspondencias, setCorrespondencias] = useState<Correspondencia[]>(correspondenciasGuardadas);
  const [processando, setProcessando] = useState<string[]>([]); // nomes dos ficheiros a processar
  const [mostrarRelatorio, setMostrarRelatorio] = useState(false);
  const [textoRelatorio, setTextoRelatorio] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const analisarMutation = trpc.documentos.analisar.useMutation();
  const relatorioMutation = trpc.documentos.gerarRelatorio.useMutation();

  // ── Upload em lote ──────────────────────────────────────────
  const handleUpload = async (files: FileList) => {
    const novosProcessando: string[] = [];
    for (const f of Array.from(files)) novosProcessando.push(f.name);
    setProcessando(novosProcessando);

    const novosDocumentos: DadosDocumento[] = [];
    const erros: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const base64 = await lerBase64(file);
        const resultado = await analisarMutation.mutateAsync({
          nomeOriginal: file.name,
          mimeType: file.type || "application/pdf",
          dadosBase64: base64,
        });
        novosDocumentos.push(resultado as DadosDocumento);
      } catch (e) {
        erros.push(file.name);
        console.error("Erro ao analisar", file.name, e);
      }
    }

    setProcessando([]);

    if (erros.length > 0) {
      toast.error(`Erro ao analisar: ${erros.join(", ")}`);
    }

    if (novosDocumentos.length > 0) {
      const todosDocumentos = [...documentos, ...novosDocumentos];
      setDocumentos(todosDocumentos);

      // Gerar correspondências automáticas
      const usadas = new Set(correspondencias.map(c => c.movId));
      const novasCorrs: Correspondencia[] = [...correspondencias];

      for (let i = documentos.length; i < todosDocumentos.length; i++) {
        const doc = todosDocumentos[i];
        const corr = encontrarCorrespondencia(doc, movimentos, usadas);
        if (corr) {
          usadas.add(corr.movId);
          novasCorrs.push({ docIdx: i, ...corr, confirmada: corr.confianca === "alta" });
        } else {
          novasCorrs.push({ docIdx: i, movId: "", confianca: "baixa", motivo: "Sem correspondência automática", confirmada: false });
        }
      }

      setCorrespondencias(novasCorrs);
      onCorrespondenciasChange(novasCorrs, todosDocumentos);
      toast.success(`${novosDocumentos.length} documento(s) analisado(s) com sucesso`);
    }
  };

  const lerBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const result = e.target?.result as string;
        resolve(result.split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // ── Confirmar / rejeitar correspondência ───────────────────
  const toggleConfirmar = (docIdx: number) => {
    const novas = correspondencias.map(c =>
      c.docIdx === docIdx ? { ...c, confirmada: !c.confirmada } : c
    );
    setCorrespondencias(novas);
    onCorrespondenciasChange(novas, documentos);
  };

  const alterarMovimento = (docIdx: number, movId: string) => {
    const novas = correspondencias.map(c =>
      c.docIdx === docIdx ? { ...c, movId, confirmada: !!movId } : c
    );
    setCorrespondencias(novas);
    onCorrespondenciasChange(novas, documentos);
  };

  const removerDocumento = (docIdx: number) => {
    const novosDocs = documentos.filter((_, i) => i !== docIdx);
    const novasCorrs = correspondencias
      .filter(c => c.docIdx !== docIdx)
      .map(c => ({ ...c, docIdx: c.docIdx > docIdx ? c.docIdx - 1 : c.docIdx }));
    setDocumentos(novosDocs);
    setCorrespondencias(novasCorrs);
    onCorrespondenciasChange(novasCorrs, novosDocs);
  };

  // ── Gerar relatório ─────────────────────────────────────────
  const gerarRelatorio = async () => {
    if (!config) { toast.error("Configure os dados da empresa primeiro"); return; }
    const confirmadas = correspondencias.filter(c => c.confirmada && c.movId);
    if (confirmadas.length === 0) { toast.error("Confirma pelo menos uma correspondência"); return; }

    const corrParaRelatorio = confirmadas.map(c => {
      const doc = documentos[c.docIdx];
      return {
        movId: c.movId,
        numeroDocumento: doc.numeroDocumento,
        nomePrestador: doc.nomePrestador,
        valor: doc.valor,
        mesServico: doc.mesServico,
        anoServico: doc.anoServico,
        arquivoUrl: doc.arquivoUrl,
        arquivoNome: doc.arquivoNome,
        tipo: doc.tipo,
      };
    });

    try {
      const resultado = await relatorioMutation.mutateAsync({
        mes,
        ano,
        movimentosJson: JSON.stringify(movimentos),
        correspondenciasJson: JSON.stringify(corrParaRelatorio),
        empresaNome: config.empresaNome,
        empresaNif: config.empresaNif,
        empresaMorada: config.empresaMorada,
      });
      setTextoRelatorio(resultado.relatorio);
      setMostrarRelatorio(true);
    } catch (e) {
      toast.error("Erro ao gerar relatório");
    }
  };

  const copiarRelatorio = () => {
    navigator.clipboard.writeText(textoRelatorio);
    toast.success("Relatório copiado!");
  };

  const downloadRelatorio = () => {
    const blob = new Blob([textoRelatorio], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio-${mes}-${ano}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Contadores ──────────────────────────────────────────────
  const confirmadas = correspondencias.filter(c => c.confirmada && c.movId).length;
  const pendentes = correspondencias.filter(c => !c.confirmada).length;
  const movSemDoc = movimentos.filter(
    m => (m.tipo === "GERAR FATURA" || m.tipo === "RECIBO VERDE") &&
         !correspondencias.find(c => c.movId === m.id && c.confirmada)
  ).length;

  return (
    <div className="space-y-4">
      {/* ── Cabeçalho ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <FileCheck2 className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold text-gray-900">Documentos & Correspondências</h3>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {confirmadas > 0 && (
            <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full font-medium">
              {confirmadas} confirmada(s)
            </span>
          )}
          {pendentes > 0 && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded-full font-medium">
              {pendentes} pendente(s)
            </span>
          )}
          {movSemDoc > 0 && (
            <span className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded-full font-medium">
              {movSemDoc} sem documento
            </span>
          )}
        </div>
      </div>

      {/* ── Zona de upload ── */}
      <div
        className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
        onClick={() => inputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) handleUpload(e.dataTransfer.files); }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files?.length) handleUpload(e.target.files); e.target.value = ""; }}
        />
        {processando.length > 0 ? (
          <div className="space-y-2">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto" />
            <p className="text-sm text-gray-600">A analisar {processando.length} ficheiro(s) com IA...</p>
            <div className="space-y-1">
              {processando.map(n => (
                <p key={n} className="text-xs text-gray-500">{n}</p>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Upload className="w-8 h-8 text-gray-400 mx-auto" />
            <p className="text-sm font-medium text-gray-700">Arrasta os PDFs aqui ou clica para seleccionar</p>
            <p className="text-xs text-gray-500">Faturas e recibos verdes — a IA extrai os dados automaticamente</p>
          </div>
        )}
      </div>

      {/* ── Lista de documentos e correspondências ── */}
      {documentos.length > 0 && (
        <div className="space-y-2">
          {documentos.map((doc, idx) => {
            const corr = correspondencias.find(c => c.docIdx === idx);
            const movAssociado = corr?.movId ? movimentos.find(m => m.id === corr.movId) : null;

            return (
              <div
                key={idx}
                className={`border rounded-lg p-3 space-y-2 ${
                  corr?.confirmada ? "border-green-300 bg-green-50" :
                  corr?.movId ? "border-amber-300 bg-amber-50" :
                  "border-gray-200 bg-white"
                }`}
              >
                {/* Linha do documento */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <FileText className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      doc.tipo === "RECIBO_VERDE" ? "text-green-600" : "text-blue-600"
                    }`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                          doc.tipo === "RECIBO_VERDE"
                            ? "bg-green-100 text-green-800"
                            : "bg-blue-100 text-blue-800"
                        }`}>
                          {doc.tipo === "RECIBO_VERDE" ? "RECIBO VERDE" : "FATURA"}
                        </span>
                        <span className="text-sm font-medium text-gray-900">{doc.numeroDocumento}</span>
                        <span className="text-sm text-gray-700">{formatEur(doc.valor)}</span>
                      </div>
                      <p className="text-xs text-gray-600 truncate">{doc.nomePrestador}</p>
                      <p className="text-xs text-gray-500">{doc.mesServico} {doc.anoServico}{doc.inst ? ` · INST ${doc.inst}` : ""}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {doc.arquivoUrl && (
                      <a href={doc.arquivoUrl} target="_blank" rel="noopener noreferrer"
                        className="p-1 text-gray-400 hover:text-blue-600 transition-colors" title="Ver ficheiro">
                        <Link2 className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button onClick={() => removerDocumento(idx)}
                      className="p-1 text-gray-400 hover:text-red-500 transition-colors" title="Remover">
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Correspondência */}
                {corr && (
                  <div className="border-t pt-2 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link2 className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        corr.confianca === "alta" ? "bg-green-100 text-green-700" :
                        corr.confianca === "media" ? "bg-amber-100 text-amber-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>
                        {corr.confianca === "alta" ? "Alta confiança" :
                         corr.confianca === "media" ? "Média confiança" : "Baixa confiança"}
                      </span>
                      <span className="text-xs text-gray-500">{corr.motivo}</span>
                    </div>

                    {/* Selector de movimento */}
                    <div className="flex items-center gap-2">
                      <select
                        value={corr.movId}
                        onChange={e => alterarMovimento(idx, e.target.value)}
                        className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-800 min-w-0"
                      >
                        <option value="">— Sem correspondência —</option>
                        {movimentos
                          .filter(m => m.tipo === "GERAR FATURA" || m.tipo === "RECIBO VERDE" || m.tipo === "")
                          .map(m => (
                            <option key={m.id} value={m.id}>
                              {m.data} | {formatEur(m.valor)}{m.inst ? ` | INST ${m.inst}` : ""} | {m.descricao.slice(0, 35)}
                            </option>
                          ))
                        }
                      </select>

                      {corr.movId && (
                        <button
                          onClick={() => toggleConfirmar(idx)}
                          className={`flex items-center gap-1 text-xs px-2 py-1 rounded font-medium transition-colors ${
                            corr.confirmada
                              ? "bg-green-600 text-white hover:bg-green-700"
                              : "bg-gray-100 text-gray-700 hover:bg-green-100 hover:text-green-700"
                          }`}
                        >
                          {corr.confirmada
                            ? <><CheckCircle2 className="w-3.5 h-3.5" /> Confirmado</>
                            : <><CheckCircle2 className="w-3.5 h-3.5" /> Confirmar</>
                          }
                        </button>
                      )}
                    </div>

                    {/* Movimento associado */}
                    {movAssociado && (
                      <div className="text-xs text-gray-600 bg-white rounded px-2 py-1 border border-gray-100">
                        <span className="font-medium">{movAssociado.data}</span> · {formatEur(movAssociado.valor)} · {movAssociado.descricao.slice(0, 50)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Movimentos sem documento ── */}
      {movSemDoc > 0 && documentos.length > 0 && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <span className="text-sm font-medium text-amber-800">Movimentos sem documento associado</span>
          </div>
          <div className="space-y-1">
            {movimentos
              .filter(m =>
                (m.tipo === "GERAR FATURA" || m.tipo === "RECIBO VERDE") &&
                !correspondencias.find(c => c.movId === m.id && c.confirmada)
              )
              .map(m => (
                <div key={m.id} className="text-xs text-amber-700">
                  {m.data} · {m.tipo} · {formatEur(m.valor)}{m.inst ? ` · INST ${m.inst}` : ""}
                </div>
              ))
            }
          </div>
        </div>
      )}

      {/* ── Botão relatório ── */}
      {confirmadas > 0 && (
        <Button
          onClick={gerarRelatorio}
          disabled={relatorioMutation.isPending}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
        >
          {relatorioMutation.isPending
            ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> A gerar relatório...</>
            : <><ClipboardList className="w-4 h-4 mr-2" /> Gerar Relatório para Contabilista</>
          }
        </Button>
      )}

      {/* ── Modal do relatório ── */}
      {mostrarRelatorio && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-indigo-600" />
                Relatório para Contabilista — {mes} {ano}
              </h3>
              <button onClick={() => setMostrarRelatorio(false)} className="text-gray-400 hover:text-gray-600">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-xs text-gray-800 whitespace-pre-wrap font-mono bg-gray-50 p-3 rounded-lg">
                {textoRelatorio}
              </pre>
            </div>
            <div className="flex gap-2 p-4 border-t">
              <Button onClick={copiarRelatorio} variant="outline" className="flex-1">
                Copiar texto
              </Button>
              <Button onClick={downloadRelatorio} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white">
                <Download className="w-4 h-4 mr-2" /> Descarregar .txt
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
