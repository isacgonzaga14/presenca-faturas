// ============================================================
// PRESENÇOBRIGATÓRIA — Gestão de Extratos
// Design: Corporate Brutalism — IBM Plex, cores funcionais
// Sistema de abas mensais + painel de configurações
// ============================================================

import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  Movimento, TipoMovimento, TIPOS_PADRAO,
  TIPO_ROW_CLASS, TIPO_BADGE_CLASS,
  gerarDescricao, calcularValorBase, formatEur,
  totalPorTipo, gerarDocumentoFinal, extrairInst, mesAnterior,
  ConfigEmpresa, EMPRESA_PADRAO,
} from "@/lib/faturas";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Upload, FileText, Copy, RotateCcw, ChevronDown, ChevronUp,
  Building2, CheckCircle2, Trash2, Plus, Settings, X, GripVertical,
} from "lucide-react";

// ─── Constantes ────────────────────────────────────────────
const MESES = [
  "janeiro","fevereiro","março","abril","maio","junho",
  "julho","agosto","setembro","outubro","novembro","dezembro"
];
const MES_ATUAL = MESES[new Date().getMonth()];
const ANO_ATUAL = new Date().getFullYear();
const STORAGE_KEY = "presenca_meses_v1";
const CONFIG_KEY  = "presenca_config_v1";

// ─── Tipos ─────────────────────────────────────────────────
interface EstadoMes {
  mes: string;
  ano: number;
  movimentos: Movimento[];
  docGerado: string;
  finalizado: boolean;
}

interface Config {
  empresa: ConfigEmpresa;
  tipos: string[];
}

// ─── Persistência ─────────────────────────────────────────
function carregarStorage(): EstadoMes[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as EstadoMes[];
  } catch { return []; }
}

function salvarStorage(meses: EstadoMes[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(meses)); } catch { /* quota */ }
}

function carregarConfig(): Config {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { empresa: EMPRESA_PADRAO, tipos: TIPOS_PADRAO as string[] };
    return JSON.parse(raw) as Config;
  } catch { return { empresa: EMPRESA_PADRAO, tipos: TIPOS_PADRAO as string[] }; }
}

function salvarConfig(cfg: Config) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* quota */ }
}

function chave(mes: string, ano: number) { return `${mes}-${ano}`; }

// ─── Resumo por tipo (dinâmico) ────────────────────────────
const BADGE_MAP: Record<string, string> = {
  "GERAR FATURA":        "badge-fatura",
  "RECIBO VERDE":        "badge-recibo-verde",
  "RECIBO":              "badge-recibo",
  "RECEBIMENTO":         "badge-recebimento",
  "FATURA COMPRA":       "badge-compra",
  "MANUTENÇÃO DE CONTA": "badge-manutencao",
  "PAGAMENTO AO ESTADO": "badge-estado",
  "AVENÇA CONTAB":       "badge-avenca",
  "SEGURO BANCARIO":     "badge-seguro",
  "RECIBO SALARIO":      "badge-salario",
};

// ─── Parser XLSX BPI ───────────────────────────────────────
function parsearXlsx(buffer: ArrayBuffer): Movimento[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const movs: Movimento[] = [];
  let idx = 0;
  let headerFound = false;

  for (const row of rows) {
    if (!row) continue;
    const col0 = String(row[0] || "").trim();
    if (!headerFound) {
      if (col0 === "Data Mov.") { headerFound = true; }
      continue;
    }
    const data = col0;
    const desc = String(row[2] || "").trim();
    const valStr = String(row[3] || "").trim()
      .replace(/\s/g, "")
      .replace(/\./g, "")
      .replace(",", ".");
    const valor = Math.abs(parseFloat(valStr));
    if (!data.match(/\d{2}[-/]\d{2}[-/]\d{4}/) || !desc || isNaN(valor) || valor === 0) continue;
    const inst = extrairInst(desc) ?? undefined;
    movs.push({ id: `mov-${idx++}`, data, descricao: desc, valor, tipo: "", descricaoFatura: "", nomeFatura: "", inst });
  }
  return movs;
}

// ─── Painel de Configurações ───────────────────────────────
function PainelConfig({
  config, onSave, onClose,
}: {
  config: Config;
  onSave: (cfg: Config) => void;
  onClose: () => void;
}) {
  const [empresa, setEmpresa] = useState<ConfigEmpresa>({ ...config.empresa });
  const [tipos, setTipos] = useState<string[]>([...config.tipos]);
  const [novoTipo, setNovoTipo] = useState("");

  const adicionarTipo = () => {
    const t = novoTipo.trim().toUpperCase();
    if (!t || tipos.includes(t)) { setNovoTipo(""); return; }
    setTipos(prev => [...prev, t]);
    setNovoTipo("");
  };

  const removerTipo = (t: string) => {
    setTipos(prev => prev.filter(x => x !== t));
  };

  const guardar = () => {
    if (!empresa.nome.trim() || !empresa.nif.trim()) {
      toast.error("Nome e NIF da empresa são obrigatórios.");
      return;
    }
    onSave({ empresa, tipos });
    toast.success("Configurações guardadas!");
    onClose();
  };

  const repor = () => {
    setEmpresa({ ...EMPRESA_PADRAO });
    setTipos([...TIPOS_PADRAO]);
    toast.info("Valores reposto para os padrão.");
  };

  return (
    <div className="space-y-6">
      {/* Empresa */}
      <div>
        <h3 className="font-bold text-sm text-[#0f2744] mb-3 uppercase tracking-wide border-b border-gray-200 pb-2">
          Dados da Empresa
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Nome da Empresa</label>
            <input
              type="text"
              value={empresa.nome}
              onChange={e => setEmpresa(p => ({ ...p, nome: e.target.value }))}
              className="w-full text-sm border-2 border-gray-300 rounded px-3 py-2 focus:border-blue-500 outline-none font-medium text-gray-800"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">NIF</label>
              <input
                type="text"
                value={empresa.nif}
                onChange={e => setEmpresa(p => ({ ...p, nif: e.target.value }))}
                className="w-full text-sm border-2 border-gray-300 rounded px-3 py-2 focus:border-blue-500 outline-none font-mono text-gray-800"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Morada</label>
            <input
              type="text"
              value={empresa.morada}
              onChange={e => setEmpresa(p => ({ ...p, morada: e.target.value }))}
              className="w-full text-sm border-2 border-gray-300 rounded px-3 py-2 focus:border-blue-500 outline-none text-gray-800"
            />
          </div>
        </div>
      </div>

      {/* Tipos de Movimento */}
      <div>
        <h3 className="font-bold text-sm text-[#0f2744] mb-3 uppercase tracking-wide border-b border-gray-200 pb-2">
          Tipos de Movimento
        </h3>
        <div className="space-y-1.5 mb-3 max-h-52 overflow-y-auto pr-1">
          {tipos.map(t => (
            <div key={t} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded px-3 py-2">
              <div className="flex items-center gap-2">
                <GripVertical className="w-3.5 h-3.5 text-gray-400" />
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${BADGE_MAP[t] || "bg-gray-200 text-gray-700"}`}>{t}</span>
              </div>
              <button
                onClick={() => removerTipo(t)}
                className="text-red-400 hover:text-red-600 transition-colors p-0.5"
                title="Remover tipo"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={novoTipo}
            onChange={e => setNovoTipo(e.target.value)}
            onKeyDown={e => e.key === "Enter" && adicionarTipo()}
            placeholder="Novo tipo (ex: TRANSFERÊNCIA)..."
            className="flex-1 text-xs border-2 border-gray-300 rounded px-3 py-2 focus:border-blue-500 outline-none uppercase placeholder-gray-400"
          />
          <Button size="sm" onClick={adicionarTipo} className="h-9 text-xs bg-[#0f2744] hover:bg-[#1e3a5c] text-white gap-1">
            <Plus className="w-3 h-3" /> Adicionar
          </Button>
        </div>
      </div>

      {/* Acções */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-200">
        <button onClick={repor} className="text-xs text-gray-500 hover:text-gray-700 underline">
          Repor valores padrão
        </button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs h-8 border-gray-300">
            Cancelar
          </Button>
          <Button size="sm" onClick={guardar} className="text-xs h-8 bg-green-700 hover:bg-green-600 text-white gap-1">
            <CheckCircle2 className="w-3 h-3" /> Guardar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Componente Principal ──────────────────────────────────
export default function Home() {
  const [mesesSalvos, setMesesSalvos] = useState<EstadoMes[]>(() => carregarStorage());
  const [config, setConfig] = useState<Config>(() => carregarConfig());
  const [abaActiva, setAbaActiva] = useState<string>(() => {
    const saved = carregarStorage();
    if (saved.length > 0) return chave(saved[saved.length - 1].mes, saved[saved.length - 1].ano);
    return chave(MES_ATUAL, ANO_ATUAL);
  });

  const estadoActivo: EstadoMes = mesesSalvos.find(m => chave(m.mes, m.ano) === abaActiva) ?? {
    mes: abaActiva.split("-")[0],
    ano: parseInt(abaActiva.split("-")[1]) || ANO_ATUAL,
    movimentos: [],
    docGerado: "",
    finalizado: false,
  };

  const [mostrarDoc, setMostrarDoc] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mostrarNovoMes, setMostrarNovoMes] = useState(false);
  const [novoMesSel, setNovoMesSel] = useState(MES_ATUAL);
  const [novoAnoSel, setNovoAnoSel] = useState(ANO_ATUAL);
  const [mostrarConfig, setMostrarConfig] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { salvarStorage(mesesSalvos); }, [mesesSalvos]);
  useEffect(() => { salvarConfig(config); }, [config]);

  useEffect(() => {
    const existe = mesesSalvos.some(m => chave(m.mes, m.ano) === abaActiva);
    if (!existe) {
      const [mes, anoStr] = abaActiva.split("-");
      const ano = parseInt(anoStr) || ANO_ATUAL;
      setMesesSalvos(prev => [...prev, { mes, ano, movimentos: [], docGerado: "", finalizado: false }]);
    }
  }, [abaActiva, mesesSalvos]);

  const actualizarMesActivo = useCallback((patch: Partial<EstadoMes>) => {
    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      if (idx === -1) {
        const [mes, anoStr] = abaActiva.split("-");
        return [...prev, { mes, ano: parseInt(anoStr) || ANO_ATUAL, movimentos: [], docGerado: "", finalizado: false, ...patch }];
      }
      const novo = [...prev];
      novo[idx] = { ...novo[idx], ...patch };
      return novo;
    });
  }, [abaActiva]);

  const { movimentos, docGerado, finalizado, mes, ano } = estadoActivo;
  const tiposActivos = config.tipos as TipoMovimento[];

  // ─── Handlers ────────────────────────────────────────────
  const atualizarTipo = useCallback((id: string, tipo: TipoMovimento) => {
    const mesRef = mesAnterior(mes);
    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      if (idx === -1) return prev;
      const novo = [...prev];
      novo[idx] = {
        ...novo[idx],
        movimentos: novo[idx].movimentos.map(m => {
          if (m.id !== id) return m;
          const desc = gerarDescricao(m.descricao, tipo, mesRef, m.valor);
          return { ...m, tipo, descricaoFatura: desc };
        }),
      };
      return novo;
    });
  }, [abaActiva, mes]);

  const atualizarNomeFatura = useCallback((id: string, nome: string) => {
    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      if (idx === -1) return prev;
      const novo = [...prev];
      novo[idx] = { ...novo[idx], movimentos: novo[idx].movimentos.map(m => m.id === id ? { ...m, nomeFatura: nome } : m) };
      return novo;
    });
  }, [abaActiva]);

  const carregarFicheiro = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        const movs = parsearXlsx(buffer);
        if (movs.length === 0) { toast.error("Nenhum movimento encontrado no ficheiro."); return; }
        actualizarMesActivo({ movimentos: movs, docGerado: "", finalizado: false });
        setMostrarDoc(false);
        if (fileRef.current) fileRef.current.value = "";
        toast.success(`${movs.length} movimentos carregados!`);
      } catch {
        toast.error("Erro ao ler o ficheiro. Certifique-se que é um .xlsx do BPI.");
      }
    };
    reader.readAsArrayBuffer(file);
  }, [actualizarMesActivo]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) carregarFicheiro(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) carregarFicheiro(file);
  };

  const limparDados = () => {
    actualizarMesActivo({ movimentos: [], docGerado: "", finalizado: false });
    setMostrarDoc(false);
    if (fileRef.current) fileRef.current.value = "";
    toast.info("Dados limpos.");
  };

  const gerarDocumento = () => {
    const doc = gerarDocumentoFinal(movimentos, mes, config.empresa);
    if (!doc) { toast.error("Nenhuma linha marcada como GERAR FATURA."); return; }
    actualizarMesActivo({ docGerado: doc });
    setMostrarDoc(true);
    toast.success("Documento gerado!");
  };

  const finalizarMes = () => {
    if (!docGerado) { toast.error("Gere o documento antes de finalizar."); return; }
    actualizarMesActivo({ finalizado: true });
    toast.success(`Mês de ${mes} finalizado e guardado!`);
  };

  const copiarDoc = () => {
    navigator.clipboard.writeText(docGerado);
    toast.success("Copiado para a área de transferência!");
  };

  const adicionarNovoMes = () => {
    const k = chave(novoMesSel, novoAnoSel);
    const existe = mesesSalvos.some(m => chave(m.mes, m.ano) === k);
    if (existe) { setAbaActiva(k); setMostrarNovoMes(false); return; }
    setMesesSalvos(prev => [...prev, { mes: novoMesSel, ano: novoAnoSel, movimentos: [], docGerado: "", finalizado: false }]);
    setAbaActiva(k);
    setMostrarNovoMes(false);
    toast.success(`Mês ${novoMesSel} ${novoAnoSel} adicionado!`);
  };

  const removerMes = (k: string) => {
    if (mesesSalvos.length <= 1) { toast.error("Deve manter pelo menos um mês."); return; }
    const novos = mesesSalvos.filter(m => chave(m.mes, m.ano) !== k);
    setMesesSalvos(novos);
    if (abaActiva === k) setAbaActiva(chave(novos[novos.length - 1].mes, novos[novos.length - 1].ano));
    toast.info("Mês removido.");
  };

  // ─── Métricas ─────────────────────────────────────────────
  const totalFaturas = totalPorTipo(movimentos, "GERAR FATURA");
  const baseTotal = calcularValorBase(totalFaturas);
  const dezPct = baseTotal * 0.1;
  const numFaturas = movimentos.filter(m => m.tipo === "GERAR FATURA").length;
  const totalClassificados = movimentos.filter(m => m.tipo).length;

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#eef0f4]" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>

      {/* HEADER */}
      <header className="bg-[#0f2744] text-white shadow-xl border-b-4 border-[#2563eb]">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="w-7 h-7 text-blue-400" />
            <div>
              <div className="font-bold text-lg tracking-tight leading-none text-white">PRESENÇOBRIGATÓRIA</div>
              <div className="text-blue-300 text-xs font-mono mt-0.5">UNIPESSOAL LDA · NIF 518604870</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-blue-200 text-xs font-mono hidden sm:block">Gestão de Extratos Bancários</div>
            <button
              onClick={() => setMostrarConfig(true)}
              className="flex items-center gap-1.5 text-xs text-blue-200 hover:text-white border border-blue-700 hover:border-blue-400 px-3 py-1.5 rounded transition-colors"
              title="Configurações"
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Configurações</span>
            </button>
          </div>
        </div>
      </header>

      {/* ABAS DE MESES */}
      <div className="bg-[#0f2744] border-b border-[#1e3a5c]">
        <div className="container">
          <div className="flex items-end gap-1 overflow-x-auto pb-0 pt-2">
            {mesesSalvos.map(m => {
              const k = chave(m.mes, m.ano);
              const isActive = k === abaActiva;
              return (
                <div key={k} className="relative group flex-shrink-0">
                  <button
                    onClick={() => { setAbaActiva(k); setMostrarDoc(false); }}
                    className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all duration-150 capitalize
                      ${isActive
                        ? "bg-[#eef0f4] text-[#0f2744] shadow-sm"
                        : "bg-[#1e3a5c] text-blue-200 hover:bg-[#2a4f7a] hover:text-white"
                      }`}
                  >
                    {m.finalizado && <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />}
                    <span>{m.mes} {m.ano}</span>
                    {m.movimentos.length > 0 && (
                      <span className={`text-[10px] font-mono px-1 rounded ${isActive ? "bg-blue-100 text-blue-700" : "bg-blue-900 text-blue-300"}`}>
                        {m.movimentos.length}
                      </span>
                    )}
                  </button>
                  {!isActive && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removerMes(k); }}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full hidden group-hover:flex items-center justify-center text-[10px] hover:bg-red-600 z-10"
                    >×</button>
                  )}
                </div>
              );
            })}
            <button
              onClick={() => setMostrarNovoMes(!mostrarNovoMes)}
              className="flex items-center gap-1 px-3 py-2.5 text-xs text-blue-300 hover:text-white hover:bg-[#2a4f7a] rounded-t-lg transition-colors flex-shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo mês
            </button>
          </div>
        </div>
      </div>

      {/* PAINEL NOVO MÊS */}
      {mostrarNovoMes && (
        <div className="bg-[#1e3a5c] border-b border-[#2563eb] shadow-lg">
          <div className="container py-3 flex items-center gap-3 flex-wrap">
            <span className="text-blue-200 text-xs font-semibold">Adicionar mês:</span>
            <Select value={novoMesSel} onValueChange={setNovoMesSel}>
              <SelectTrigger className="w-32 h-7 bg-white/10 border-white/20 text-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MESES.map(m => <SelectItem key={m} value={m} className="text-xs capitalize">{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={String(novoAnoSel)} onValueChange={v => setNovoAnoSel(parseInt(v))}>
              <SelectTrigger className="w-24 h-7 bg-white/10 border-white/20 text-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2024,2025,2026,2027].map(a => <SelectItem key={a} value={String(a)} className="text-xs">{a}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={adicionarNovoMes} className="h-7 text-xs bg-blue-600 hover:bg-blue-500">Adicionar</Button>
            <button onClick={() => setMostrarNovoMes(false)} className="text-blue-300 hover:text-white text-xs ml-2">Cancelar</button>
          </div>
        </div>
      )}

      <div className="container py-6 space-y-5">

        {/* INDICADOR DE MÊS ACTIVO */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-[#0f2744] capitalize">{mes} {ano}</h2>
            {finalizado && (
              <span className="flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-100 border border-green-300 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3" /> Finalizado
              </span>
            )}
            {movimentos.length === 0 && !finalizado && (
              <span className="text-xs text-gray-500 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                Aguardando extrato
              </span>
            )}
          </div>
          {docGerado && !finalizado && (
            <Button size="sm" onClick={finalizarMes} className="h-8 text-xs bg-green-700 hover:bg-green-600 text-white gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Finalizar mês
            </Button>
          )}
        </div>

        {/* UPLOAD + MÉTRICAS */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="col-span-1 flex flex-col gap-2">
            <div
              className={`flex-1 border-2 border-dashed rounded-lg p-5 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-150
                ${finalizado ? "opacity-50 pointer-events-none" : ""}
                ${dragging ? "border-blue-500 bg-blue-50" : "border-gray-400 bg-white hover:border-blue-500 hover:bg-blue-50/40"}`}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className={`w-8 h-8 ${dragging ? "text-blue-500" : "text-gray-500"}`} />
              <div className="text-center">
                <div className="font-semibold text-gray-800 text-sm">Carregar Extrato</div>
                <div className="text-gray-500 text-xs mt-1">Arraste ou clique · .xlsx do BPI</div>
                {movimentos.length > 0 && (
                  <div className="text-blue-600 text-xs mt-1 font-medium">Substitui os dados actuais</div>
                )}
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onFileChange} />
            </div>
            {movimentos.length > 0 && !finalizado && (
              <button
                onClick={limparDados}
                className="w-full flex items-center justify-center gap-2 text-xs text-red-600 font-medium border border-red-300 rounded-lg py-2 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Limpar dados
              </button>
            )}
          </div>

          <div className="col-span-3 grid grid-cols-3 gap-3">
            {[
              { label: "Total GERAR FATURA", value: formatEur(totalFaturas), sub: `${numFaturas} linha${numFaturas !== 1 ? "s" : ""}`, color: "#0f2744", bg: "#dbeafe" },
              { label: "Valor Base (÷ 1,23)", value: formatEur(baseTotal), sub: "Sem IVA", color: "#1d4ed8", bg: "#eff6ff" },
              { label: "10% do Valor Base", value: formatEur(dezPct), sub: "Referência comissão", color: "#15803d", bg: "#f0fdf4" },
            ].map(({ label, value, sub, color, bg }) => (
              <div key={label} className="rounded-lg p-4 shadow-sm border border-gray-200" style={{ background: bg, borderTop: `4px solid ${color}` }}>
                <div className="text-xs text-gray-600 font-semibold uppercase tracking-wide">{label}</div>
                <div className="font-mono font-bold text-2xl mt-1" style={{ color }}>{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Sem dados */}
        {movimentos.length === 0 && (
          <div className="bg-white border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
            <Upload className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <div className="text-gray-600 font-semibold">Nenhum extrato carregado</div>
            <div className="text-gray-400 text-sm mt-1">Carregue o ficheiro .xlsx do BPI para começar</div>
          </div>
        )}

        {movimentos.length > 0 && (
          <>
            {/* RESUMO POR TIPO */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
                <span className="font-bold text-sm text-gray-800">Resumo por Tipo</span>
                <span className="text-xs text-gray-500 font-mono bg-gray-200 px-2 py-0.5 rounded">{totalClassificados} / {movimentos.length} classificados</span>
              </div>
              <div className="flex flex-wrap gap-2 p-4">
                {tiposActivos.map(tipo => {
                  const total = totalPorTipo(movimentos, tipo);
                  const count = movimentos.filter(m => m.tipo === tipo).length;
                  if (count === 0) return null;
                  const badgeClass = BADGE_MAP[tipo] || "bg-gray-200 text-gray-700";
                  return (
                    <div key={tipo} className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold ${badgeClass}`}>
                      <span>{tipo}</span>
                      <span className="font-mono">{formatEur(total)}</span>
                      <span className="opacity-70">({count})</span>
                    </div>
                  );
                })}
                {movimentos.filter(m => !m.tipo).length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold bg-gray-200 text-gray-700">
                    <span>Sem tipo</span>
                    <span className="font-mono">{movimentos.filter(m => !m.tipo).length}</span>
                  </div>
                )}
              </div>
            </div>

            {/* TABELA */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
                <span className="font-bold text-sm text-gray-800">Movimentos do Extrato</span>
                <div className="flex gap-2">
                  {!finalizado && (
                    <>
                      <Button variant="outline" size="sm" onClick={limparDados} className="text-xs h-7 gap-1 border-gray-300 text-gray-700 hover:bg-gray-100">
                        <RotateCcw className="w-3 h-3" /> Limpar
                      </Button>
                      <Button size="sm" onClick={gerarDocumento} className="text-xs h-7 gap-1 bg-[#0f2744] hover:bg-[#1e3a5c] text-white">
                        <FileText className="w-3 h-3" /> Gerar Faturas
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#0f2744] text-white">
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider w-28">Data</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider">Descrição</th>
                      <th className="text-right px-4 py-3 text-xs font-bold uppercase tracking-wider w-28">Valor</th>
                      <th className="text-center px-4 py-3 text-xs font-bold uppercase tracking-wider w-52">Tipo</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider">Descrição Fatura</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider w-36">Nome Fatura</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimentos.map((mov, i) => {
                      const rowClass = TIPO_ROW_CLASS[mov.tipo] || (i % 2 === 0 ? "bg-white" : "bg-gray-50");
                      const badgeClass = TIPO_BADGE_CLASS[mov.tipo];
                      return (
                        <tr key={mov.id} className={`border-b border-gray-200 transition-colors duration-100 ${rowClass}`}>
                          <td className="px-4 py-3 font-mono text-xs text-gray-600 font-medium">{mov.data}</td>
                          <td className="px-4 py-3">
                            <div className="text-gray-900 text-xs leading-snug whitespace-normal break-words font-medium">
                              {mov.descricao}
                            </div>
                            {mov.inst && (
                              <span className="inline-block mt-0.5 font-mono text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-bold">
                                INST {mov.inst}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-sm text-red-700">
                            {formatEur(mov.valor)}
                          </td>
                          <td className="px-4 py-3">
                            {finalizado ? (
                              <span className={`text-xs font-semibold px-2 py-1 rounded ${badgeClass || "bg-gray-100 text-gray-600"}`}>
                                {mov.tipo || "—"}
                              </span>
                            ) : (
                              <Select
                                value={mov.tipo || "__none__"}
                                onValueChange={(v) => atualizarTipo(mov.id, v === "__none__" ? "" as TipoMovimento : v as TipoMovimento)}
                              >
                                <SelectTrigger className={`h-7 text-xs w-full font-semibold ${badgeClass || "bg-gray-100 text-gray-700 border-gray-300"}`}>
                                  <SelectValue placeholder="— selecionar —" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__" className="text-xs text-gray-500">— selecionar —</SelectItem>
                                  {tiposActivos.map(t => (
                                    <SelectItem key={t} value={t} className="text-xs font-medium">{t}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {mov.descricaoFatura ? (
                              <div className="text-xs text-gray-700 italic leading-snug">{mov.descricaoFatura}</div>
                            ) : (
                              <span className="text-gray-400 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {finalizado ? (
                              <span className="text-xs text-gray-700">{mov.nomeFatura || "—"}</span>
                            ) : (
                              <input
                                type="text"
                                value={mov.nomeFatura}
                                onChange={e => atualizarNomeFatura(mov.id, e.target.value)}
                                placeholder="Nome..."
                                className="w-full text-xs bg-transparent border-b-2 border-gray-300 focus:border-blue-500 outline-none py-0.5 text-gray-800 placeholder-gray-400 font-medium"
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* DOCUMENTO GERADO */}
        {docGerado && (
          <div className="bg-white rounded-lg shadow-sm border-2 border-[#0f2744] overflow-hidden">
            <div
              className="px-4 py-3 border-b border-gray-200 flex items-center justify-between cursor-pointer bg-[#0f2744]"
              onClick={() => setMostrarDoc(!mostrarDoc)}
            >
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-300" />
                <span className="font-bold text-sm text-white">Documento Gerado — Pronto para WhatsApp</span>
                {finalizado && <span className="text-xs text-green-400 font-semibold ml-2">✓ Finalizado</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); copiarDoc(); }} className="text-xs h-7 gap-1 bg-white/10 border-white/30 text-white hover:bg-white/20">
                  <Copy className="w-3 h-3" /> Copiar
                </Button>
                {mostrarDoc ? <ChevronUp className="w-4 h-4 text-blue-300" /> : <ChevronDown className="w-4 h-4 text-blue-300" />}
              </div>
            </div>
            {mostrarDoc && (
              <div className="p-4">
                <pre className="font-mono text-xs text-gray-800 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded p-4 border border-gray-200">
                  {docGerado}
                </pre>
              </div>
            )}
          </div>
        )}

      </div>

      {/* MODAL CONFIGURAÇÕES */}
      <Dialog open={mostrarConfig} onOpenChange={setMostrarConfig}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#0f2744]">
              <Settings className="w-4 h-4" />
              Configurações
            </DialogTitle>
          </DialogHeader>
          <PainelConfig
            config={config}
            onSave={(cfg) => setConfig(cfg)}
            onClose={() => setMostrarConfig(false)}
          />
        </DialogContent>
      </Dialog>

      {/* FOOTER */}
      <footer className="mt-8 bg-[#0f2744] text-blue-300 text-xs py-3 border-t-2 border-[#2563eb]">
        <div className="container text-center font-mono">
          {config.empresa.nome} · NIF {config.empresa.nif} · {config.empresa.morada}
        </div>
      </footer>
    </div>
  );
}
