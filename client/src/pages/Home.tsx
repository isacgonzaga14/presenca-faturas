// ============================================================
// PRESENÇOBRIGATÓRIA — Gestão de Extratos
// Design: Corporate Brutalism — IBM Plex, cores funcionais
// ============================================================

import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  Movimento, TipoMovimento, TIPOS,
  TIPO_ROW_CLASS, TIPO_BADGE_CLASS,
  gerarDescricao, calcularValorBase, formatEur,
  totalPorTipo, gerarDocumentoFinal, extrairInst, mesAnterior,
} from "@/lib/faturas";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Upload, FileText, Copy, RotateCcw, ChevronDown, ChevronUp, Building2 } from "lucide-react";

const MESES = [
  "janeiro","fevereiro","março","abril","maio","junho",
  "julho","agosto","setembro","outubro","novembro","dezembro"
];

const MES_ATUAL = MESES[new Date().getMonth()];

// Dados demo do extrato de maio
const DEMO_MOVIMENTOS: Movimento[] = [
  { id:"1", data:"25-05-2026", descricao:"TRF SEPA+ INST 186 P/ PT50003300004556047281305 Isac silva",       valor:300.00,  tipo:"", descricaoFatura:"", nomeFatura:"", inst:"186" },
  { id:"2", data:"25-05-2026", descricao:"TRF SEPA+ INST 185 P/ PT50000700000068934844623 Jose zito sa",     valor:1100.00, tipo:"", descricaoFatura:"", nomeFatura:"", inst:"185" },
  { id:"3", data:"22-05-2026", descricao:"PAGSERV INSTITUTO GESTAO FINANC SEG SOCIAL 834393271",              valor:186.65,  tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"4", data:"22-05-2026", descricao:"PAGAMENTO AO ESTADO - 162 812 559 823 462",                        valor:2718.95, tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"5", data:"20-05-2026", descricao:"TRF CR SEPA+ 156 P/ PT50001800035821657302084 FORTUNESYMBO",       valor:140.00,  tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"6", data:"19-05-2026", descricao:"19/05 COMPRA EL-E 3816089/47 PA FERNAO FERRO FERNAO FERR",         valor:60.00,   tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"7", data:"11-05-2026", descricao:"TRF SEPA+ INST 183 P/ PT50356000019001813664734 Isac silva",       valor:50.00,   tipo:"", descricaoFatura:"", nomeFatura:"", inst:"183" },
  { id:"8", data:"11-05-2026", descricao:"TRF SEPA+ INST 182 P/ PT50001800035821657302084 FORTUNESYMBO",     valor:140.00,  tipo:"", descricaoFatura:"", nomeFatura:"", inst:"182" },
  { id:"9", data:"11-05-2026", descricao:"PAGSERV INSTITUTO GESTAO FINANC SEG SOCIAL 823624080",              valor:188.90,  tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"10",data:"08-05-2026", descricao:"TRF SEPA+ INST 181 P/ PT50003600499910668837477 Alexander jo",     valor:796.85,  tipo:"", descricaoFatura:"", nomeFatura:"", inst:"181" },
  { id:"11",data:"08-05-2026", descricao:"IMPOSTO DE SELO ABR 2026",                                          valor:0.32,    tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"12",data:"08-05-2026", descricao:"MANUTENCAO DE CONTA VALOR NEGOCIOS ABR 2026",                      valor:7.99,    tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"13",data:"08-05-2026", descricao:"DD COMPANHIA DE SEGUROS ALLIANZ PORTUGAL 00807960129",              valor:70.32,   tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"14",data:"07-05-2026", descricao:"TRF SEPA+ INST 180 P/ PT50003300004556047281305 Isac gonzaga",     valor:607.20,  tipo:"", descricaoFatura:"", nomeFatura:"", inst:"180" },
  { id:"15",data:"06-05-2026", descricao:"06/05 COMPRA EL-E 3816089/46 PA PALHAIS PALHAIS BAR",              valor:98.50,   tipo:"", descricaoFatura:"", nomeFatura:"" },
  { id:"16",data:"06-05-2026", descricao:"TRF SEPA+ INST 179 P/ PT50001800035812704402098 Maria da Con",     valor:1300.00, tipo:"", descricaoFatura:"", nomeFatura:"", inst:"179" },
  { id:"17",data:"06-05-2026", descricao:"TRF SEPA+ INST 178 P/ PT50000700000071901967923 Eliane morai",     valor:1100.00, tipo:"", descricaoFatura:"", nomeFatura:"", inst:"178" },
  { id:"18",data:"04-05-2026", descricao:"TRF SEPA+ INST 177 P/ PT50002300004566468534594 JOAO ALFREDO",     valor:1100.00, tipo:"", descricaoFatura:"", nomeFatura:"", inst:"177" },
  { id:"19",data:"04-05-2026", descricao:"TRF SEPA+ INST 176 P/ PT50003300004566985563905 JUCICLECIO F",     valor:1100.00, tipo:"", descricaoFatura:"", nomeFatura:"", inst:"176" },
  { id:"20",data:"04-05-2026", descricao:"TRF SEPA+ INST 175 P/ PT50003300004553991502105 Jacqueline a",     valor:1100.00, tipo:"", descricaoFatura:"", nomeFatura:"", inst:"175" },
];

function parsearXlsx(buffer: ArrayBuffer): Movimento[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
  const movs: Movimento[] = [];
  let idx = 0;
  for (const row of rows) {
    if (!row || row.length < 3) continue;
    const data = String(row[0] || "").trim();
    const desc = String(row[1] || "").trim();
    const valStr = String(row[2] || "").trim().replace(/\./g, "").replace(",", ".");
    const valor = Math.abs(parseFloat(valStr));
    if (!data.match(/\d{2}[-/]\d{2}[-/]\d{4}/) || isNaN(valor)) continue;
    const inst = extrairInst(desc) ?? undefined;
    movs.push({ id: `mov-${idx++}`, data, descricao: desc, valor, tipo: "", descricaoFatura: "", nomeFatura: "", inst });
  }
  return movs;
}

// Resumo por tipo
const RESUMO_TIPOS: { tipo: TipoMovimento; label: string; badgeClass: string }[] = [
  { tipo: "GERAR FATURA",        label: "Gerar Fatura",        badgeClass: "badge-fatura" },
  { tipo: "RECIBO VERDE",        label: "Recibo Verde",        badgeClass: "badge-recibo-verde" },
  { tipo: "RECIBO",              label: "Recibo",              badgeClass: "badge-recibo" },
  { tipo: "FATURA COMPRA",       label: "Fatura Compra",       badgeClass: "badge-compra" },
  { tipo: "MANUTENÇÃO DE CONTA", label: "Manutenção Conta",    badgeClass: "badge-manutencao" },
  { tipo: "PAGAMENTO AO ESTADO", label: "Pagamento ao Estado", badgeClass: "badge-estado" },
  { tipo: "AVENÇA CONTAB",       label: "Avença Contab.",      badgeClass: "badge-avenca" },
  { tipo: "SEGURO BANCARIO",     label: "Seguro Bancário",     badgeClass: "badge-seguro" },
  { tipo: "RECIBO SALARIO",      label: "Recibo Salário",      badgeClass: "badge-salario" },
];

export default function Home() {
  const [movimentos, setMovimentos] = useState<Movimento[]>(DEMO_MOVIMENTOS);
  const [mes, setMes] = useState<string>(MES_ATUAL);
  const [docGerado, setDocGerado] = useState<string>("");
  const [mostrarDoc, setMostrarDoc] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const atualizarTipo = useCallback((id: string, tipo: TipoMovimento) => {
    setMovimentos(prev => prev.map(m => {
      if (m.id !== id) return m;
      const mesRef = mesAnterior(mes);
      const desc = tipo === "GERAR FATURA" || tipo === "RECIBO VERDE" || tipo === "RECIBO" || tipo === "FATURA COMPRA"
        ? gerarDescricao(m.descricao, tipo, mesRef, m.valor)
        : "";
      return { ...m, tipo, descricaoFatura: desc };
    }));
  }, [mes]);

  const atualizarNomeFatura = useCallback((id: string, nome: string) => {
    setMovimentos(prev => prev.map(m => m.id === id ? { ...m, nomeFatura: nome } : m));
  }, []);

  const carregarFicheiro = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        const movs = parsearXlsx(buffer);
        if (movs.length === 0) { toast.error("Nenhum movimento encontrado no ficheiro."); return; }
        setMovimentos(movs);
        setDocGerado("");
        setMostrarDoc(false);
        toast.success(`${movs.length} movimentos carregados com sucesso!`);
      } catch {
        toast.error("Erro ao ler o ficheiro. Certifique-se que é um .xlsx do BPI.");
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) carregarFicheiro(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) carregarFicheiro(file);
  };

  const gerarDocumento = () => {
    const doc = gerarDocumentoFinal(movimentos, mes);
    if (!doc) { toast.error("Nenhuma linha marcada como GERAR FATURA."); return; }
    setDocGerado(doc);
    setMostrarDoc(true);
    toast.success("Documento gerado!");
  };

  const copiarDoc = () => {
    navigator.clipboard.writeText(docGerado);
    toast.success("Copiado para a área de transferência!");
  };

  const resetar = () => {
    setMovimentos(DEMO_MOVIMENTOS);
    setDocGerado("");
    setMostrarDoc(false);
    toast.info("Dados resetados para demo.");
  };

  const totalFaturas = totalPorTipo(movimentos, "GERAR FATURA");
  const baseTotal = calcularValorBase(totalFaturas);
  const dezPct = baseTotal * 0.1;
  const numFaturas = movimentos.filter(m => m.tipo === "GERAR FATURA").length;

  return (
    <div className="min-h-screen bg-[#f7f8fa]" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>

      {/* HEADER */}
      <header className="bg-[#1B3A5C] text-white shadow-lg">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="w-7 h-7 text-blue-300" />
            <div>
              <div className="font-bold text-lg tracking-tight leading-none">PRESENÇOBRIGATÓRIA</div>
              <div className="text-blue-300 text-xs font-mono mt-0.5">UNIPESSOAL LDA · NIF 518604870</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-blue-200 text-sm hidden sm:block">Mês de referência:</span>
            <Select value={mes} onValueChange={setMes}>
              <SelectTrigger className="w-36 bg-white/10 border-white/20 text-white text-sm h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MESES.map(m => (
                  <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <div className="container py-6 space-y-6">

        {/* UPLOAD + MÉTRICAS */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Upload */}
          <div
            className={`col-span-1 border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-150
              ${dragging ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className={`w-8 h-8 ${dragging ? "text-blue-500" : "text-gray-400"}`} />
            <div className="text-center">
              <div className="font-semibold text-gray-700 text-sm">Carregar Extrato</div>
              <div className="text-gray-400 text-xs mt-1">Arraste ou clique · .xlsx do BPI</div>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onFileChange} />
          </div>

          {/* Métricas */}
          <div className="col-span-2 grid grid-cols-3 gap-3">
            {[
              { label: "Total GERAR FATURA", value: formatEur(totalFaturas), sub: `${numFaturas} linha${numFaturas !== 1 ? "s" : ""}`, color: "#1B3A5C" },
              { label: "Valor Base (÷ 1,23)", value: formatEur(baseTotal), sub: "Sem IVA", color: "#2563eb" },
              { label: "10% do Valor Base", value: formatEur(dezPct), sub: "Referência comissão", color: "#059669" },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="bg-white rounded-lg p-4 shadow-sm border border-gray-100" style={{ borderTop: `3px solid ${color}` }}>
                <div className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</div>
                <div className="font-mono font-bold text-xl mt-1" style={{ color }}>{value}</div>
                <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* RESUMO POR TIPO */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="font-semibold text-sm text-gray-700">Resumo por Tipo</span>
            <span className="text-xs text-gray-400 font-mono">{movimentos.filter(m => m.tipo).length} / {movimentos.length} classificados</span>
          </div>
          <div className="flex flex-wrap gap-2 p-4">
            {RESUMO_TIPOS.map(({ tipo, label, badgeClass }) => {
              const total = totalPorTipo(movimentos, tipo);
              const count = movimentos.filter(m => m.tipo === tipo).length;
              if (count === 0) return null;
              return (
                <div key={tipo} className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium ${badgeClass}`}>
                  <span>{label}</span>
                  <span className="font-mono font-bold">{formatEur(total)}</span>
                  <span className="opacity-60">({count})</span>
                </div>
              );
            })}
            {movimentos.filter(m => !m.tipo).length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
                <span>Sem tipo</span>
                <span className="font-mono">{movimentos.filter(m => !m.tipo).length}</span>
              </div>
            )}
          </div>
        </div>

        {/* TABELA */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="font-semibold text-sm text-gray-700">Movimentos do Extrato</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetar} className="text-xs h-7 gap-1">
                <RotateCcw className="w-3 h-3" /> Demo
              </Button>
              <Button size="sm" onClick={gerarDocumento} className="text-xs h-7 gap-1 bg-[#1B3A5C] hover:bg-[#2E6DA4]">
                <FileText className="w-3 h-3" /> Gerar Faturas
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">Data</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Descrição</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">Valor</th>
                  <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-48">Tipo</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Descrição Fatura</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Nome Fatura</th>
                </tr>
              </thead>
              <tbody>
                {movimentos.map((mov, i) => {
                  const rowClass = TIPO_ROW_CLASS[mov.tipo] || (i % 2 === 0 ? "bg-white" : "bg-gray-50/50");
                  const badgeClass = TIPO_BADGE_CLASS[mov.tipo];
                  return (
                    <tr
                      key={mov.id}
                      className={`border-b border-gray-100 transition-colors duration-150 ${rowClass}`}
                      style={{ borderLeft: mov.tipo ? undefined : "3px solid transparent" }}
                    >
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{mov.data}</td>
                      <td className="px-4 py-2.5">
                        <div className="text-gray-800 text-xs leading-snug whitespace-normal break-words">
                          {mov.descricao}
                        </div>
                        {mov.inst && (
                          <span className="inline-block mt-0.5 font-mono text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
                            INST {mov.inst}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-xs text-red-600">
                        {formatEur(mov.valor)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Select value={mov.tipo || "__none__"} onValueChange={(v) => atualizarTipo(mov.id, v === "__none__" ? "" as TipoMovimento : v as TipoMovimento)}>
                          <SelectTrigger className={`h-7 text-xs w-full border-0 shadow-none ${badgeClass || "bg-gray-100 text-gray-500"}`}>
                            <SelectValue placeholder="— selecionar —" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__" className="text-xs text-gray-400">— selecionar —</SelectItem>
                            {TIPOS.map(t => (
                              <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-4 py-2.5">
                        {mov.descricaoFatura ? (
                          <div className="text-xs text-gray-600 italic leading-snug max-w-sm">{mov.descricaoFatura}</div>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <input
                          type="text"
                          value={mov.nomeFatura}
                          onChange={e => atualizarNomeFatura(mov.id, e.target.value)}
                          placeholder="Nome..."
                          className="w-full text-xs bg-transparent border-b border-gray-200 focus:border-blue-400 outline-none py-0.5 text-gray-700 placeholder-gray-300"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* DOCUMENTO GERADO */}
        {docGerado && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
            <div
              className="px-4 py-3 border-b border-gray-100 flex items-center justify-between cursor-pointer"
              onClick={() => setMostrarDoc(!mostrarDoc)}
            >
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#1B3A5C]" />
                <span className="font-semibold text-sm text-gray-700">Documento Gerado — Pronto para WhatsApp</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); copiarDoc(); }} className="text-xs h-7 gap-1">
                  <Copy className="w-3 h-3" /> Copiar
                </Button>
                {mostrarDoc ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </div>
            </div>
            {mostrarDoc && (
              <div className="p-4">
                <pre className="font-mono text-xs text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded p-4 border border-gray-100">
                  {docGerado}
                </pre>
              </div>
            )}
          </div>
        )}

      </div>

      {/* FOOTER */}
      <footer className="mt-8 bg-[#1B3A5C] text-blue-200 text-xs py-3">
        <div className="container text-center font-mono">
          PRESENÇOBRIGATÓRIA - UNIPESSOAL LDA · NIF 518604870 · Rua Miguel Pais, Nº 46, 1º F, Barreiro, 2830-356, Portugal
        </div>
      </footer>
    </div>
  );
}
