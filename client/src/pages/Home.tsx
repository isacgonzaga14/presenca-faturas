// ============================================================
// PRESENÇOBRIGATÓRIA — Gestão de Extratos
// Design: Corporate Brutalism — IBM Plex, cores funcionais
// Sistema multi-utilizador com login + filtro + auto-classificação
// ============================================================

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
  LogIn, LogOut, User, Filter, Wand2, Save, Cloud, CloudOff,
  Paperclip, FolderOpen, FileCheck2, FileX2, Download, ExternalLink,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";

// ─── Constantes ────────────────────────────────────────────
const MESES = [
  "janeiro","fevereiro","março","abril","maio","junho",
  "julho","agosto","setembro","outubro","novembro","dezembro"
];
const MES_ATUAL = MESES[new Date().getMonth()];
const ANO_ATUAL = new Date().getFullYear();

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

function chave(mes: string, ano: number) { return `${mes}-${ano}`; }

// ─── Pré-classificação automática por palavras-chave ───────
const REGRAS_AUTO: Array<{ palavras: string[]; tipo: TipoMovimento }> = [
  { palavras: ["seguro","seg ban","seguro bancario"], tipo: "SEGURO BANCARIO" },
  { palavras: ["seg soc","segurança social","seg social","ss "], tipo: "PAGAMENTO AO ESTADO" },
  { palavras: ["at ","autoridade tributaria","irs","iva ","at-"], tipo: "PAGAMENTO AO ESTADO" },
  { palavras: ["contabilidade","contabil","avença","avenca"], tipo: "AVENÇA CONTAB" },
  { palavras: ["manutencao","manutenção","comissão","comissao","mensalidade conta"], tipo: "MANUTENÇÃO DE CONTA" },
  { palavras: ["recibo salario","salario","vencimento","remuneracao","remuneração"], tipo: "RECIBO SALARIO" },
  { palavras: ["recibo verde","recibo vd"], tipo: "RECIBO VERDE" },
  { palavras: ["inst ","transferencia inst","transf inst"], tipo: "GERAR FATURA" },
];

function classificarAutomaticamente(movimentos: Movimento[], mesRef: string): Movimento[] {
  return movimentos.map(mov => {
    if (mov.tipo) return mov; // já classificado, não sobrescrever
    const descLower = mov.descricao.toLowerCase();
    for (const regra of REGRAS_AUTO) {
      if (regra.palavras.some(p => descLower.includes(p))) {
        const desc = gerarDescricao(mov.descricao, regra.tipo, mesRef, mov.valor);
        return { ...mov, tipo: regra.tipo, descricaoFatura: desc };
      }
    }
    return mov;
  });
}

// ─── Badge map ─────────────────────────────────────────────
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
    onClose();
  };

  const repor = () => {
    setEmpresa({ ...EMPRESA_PADRAO });
    setTipos([...TIPOS_PADRAO]);
    toast.info("Valores repostos para os padrão.");
  };

  return (
    <div className="space-y-6">
      {/* Empresa */}
      <div>
        <h3 className="font-bold text-sm text-blue-100 mb-3 uppercase tracking-wide border-b border-white/10 pb-2">
          Dados da Empresa
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">Nome da Empresa</label>
            <input
              type="text"
              value={empresa.nome}
              onChange={e => setEmpresa(p => ({ ...p, nome: e.target.value }))}
              className="w-full text-sm border-2 border-white/15 rounded px-3 py-2 focus:border-blue-500 outline-none font-medium text-slate-200"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">NIF</label>
            <input
              type="text"
              value={empresa.nif}
              onChange={e => setEmpresa(p => ({ ...p, nif: e.target.value }))}
              className="w-full text-sm border-2 border-white/15 rounded px-3 py-2 focus:border-blue-500 outline-none font-mono text-slate-200"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">Morada</label>
            <input
              type="text"
              value={empresa.morada}
              onChange={e => setEmpresa(p => ({ ...p, morada: e.target.value }))}
              className="w-full text-sm border-2 border-white/15 rounded px-3 py-2 focus:border-blue-500 outline-none text-slate-200"
            />
          </div>
        </div>
      </div>

      {/* Tipos de Movimento */}
      <div>
        <h3 className="font-bold text-sm text-blue-100 mb-3 uppercase tracking-wide border-b border-white/10 pb-2">
          Tipos de Movimento
        </h3>
        <div className="space-y-1.5 mb-3 max-h-52 overflow-y-auto pr-1">
          {tipos.map(t => (
            <div key={t} className="flex items-center justify-between bg-[#11161f] border border-white/10 rounded px-3 py-2">
              <div className="flex items-center gap-2">
                <GripVertical className="w-3.5 h-3.5 text-slate-500" />
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${BADGE_MAP[t] || "bg-[#232c3d] text-slate-300"}`}>{t}</span>
              </div>
              <button
                onClick={() => removerTipo(t)}
                className="text-red-400 hover:text-red-400 transition-colors p-0.5"
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
            className="flex-1 text-xs border-2 border-white/15 rounded px-3 py-2 focus:border-blue-500 outline-none uppercase placeholder-gray-400"
          />
          <Button size="sm" onClick={adicionarTipo} className="h-9 text-xs bg-[#0f2744] hover:bg-[#1e3a5c] text-white gap-1">
            <Plus className="w-3 h-3" /> Adicionar
          </Button>
        </div>
      </div>

      {/* Acções */}
      <div className="flex items-center justify-between pt-2 border-t border-white/10">
        <button onClick={repor} className="text-xs text-slate-400 hover:text-slate-200 underline">
          Repor valores padrão
        </button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs h-8 border-white/15">
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

// ─── Ecrã de Login ─────────────────────────────────────────
function EcraLogin() {
  return (
    <div className="min-h-screen bg-[#0a0e16] flex flex-col" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <header className="bg-[#0f2744] text-white shadow-xl border-b-4 border-[#2563eb]">
        <div className="container py-4 flex items-center gap-3">
          <Building2 className="w-7 h-7 text-blue-400" />
          <div>
            <div className="font-bold text-lg tracking-tight leading-none text-white">PRESENÇOBRIGATÓRIA</div>
            <div className="text-blue-300 text-xs font-mono mt-0.5">Gestão de Extratos Bancários</div>
          </div>
        </div>
      </header>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="bg-[#141b29] rounded-xl shadow-lg border border-white/10 p-10 max-w-sm w-full text-center">
          <div className="w-16 h-16 bg-[#0f2744] rounded-full flex items-center justify-center mx-auto mb-6">
            <Building2 className="w-8 h-8 text-blue-300" />
          </div>
          <h2 className="text-xl font-bold text-blue-100 mb-2">Bem-vindo</h2>
          <p className="text-slate-400 text-sm mb-8">
            Faça login para aceder à sua conta e gerir os seus extratos bancários.
          </p>
          <a
            href={getLoginUrl()}
            className="flex items-center justify-center gap-2 w-full bg-[#0f2744] hover:bg-[#1e3a5c] text-white font-semibold py-3 px-6 rounded-lg transition-colors text-sm"
          >
            <LogIn className="w-4 h-4" />
            Entrar com a minha conta
          </a>
          <p className="text-xs text-slate-500 mt-4">
            Cada utilizador tem os seus próprios dados separados.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Componente Principal ──────────────────────────────────
export default function Home() {
  const { user, isAuthenticated, loading: authLoading, logout } = useAuth();

  // ─── Dados do servidor ───────────────────────────────────
  const { data: configData, isLoading: configLoading } = trpc.config.get.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );
  const { data: mesesData, isLoading: mesesLoading } = trpc.meses.list.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  const utils = trpc.useUtils();

  // ─── Estado de gravação ──────────────────────────────────
  const [estadoGravacao, setEstadoGravacao] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveConfigMutation = trpc.config.save.useMutation({
    onSuccess: () => {
      utils.config.get.invalidate();
      toast.success("Configurações guardadas!");
    },
    onError: () => toast.error("Erro ao guardar configurações."),
  });

  const saveMesMutation = trpc.meses.save.useMutation({
    onMutate: () => setEstadoGravacao("saving"),
    onSuccess: () => {
      setEstadoGravacao("saved");
      setTimeout(() => setEstadoGravacao("idle"), 2000);
    },
    onError: () => {
      setEstadoGravacao("error");
      toast.error("Erro ao guardar dados. A tentar novamente...");
      setTimeout(() => setEstadoGravacao("idle"), 3000);
    },
  });

  const deleteMesMutation = trpc.meses.delete.useMutation({
    onSuccess: () => utils.meses.list.invalidate(),
    onError: () => toast.error("Erro ao remover mês."),
  });

  // ─── Config local (sincronizada com servidor) ────────────
  const [config, setConfig] = useState<Config>({
    empresa: EMPRESA_PADRAO,
    tipos: TIPOS_PADRAO as string[],
  });

  useEffect(() => {
    if (configData) {
      setConfig({
        empresa: {
          nome: configData.empresaNome,
          nif: configData.empresaNif,
          morada: configData.empresaMorada,
        },
        tipos: configData.tipos,
      });
    }
  }, [configData]);

  // ─── Meses (sincronizados com servidor) ──────────────────
  const [mesesSalvos, setMesesSalvos] = useState<EstadoMes[]>([]);
  const [abaActiva, setAbaActiva] = useState<string>(() => chave(MES_ATUAL, ANO_ATUAL));

  useEffect(() => {
    if (mesesData && mesesData.length > 0) {
      setMesesSalvos(mesesData as EstadoMes[]);
      setAbaActiva(prev => {
        const existe = mesesData.some((m: EstadoMes) => chave(m.mes, m.ano) === prev);
        if (!existe) {
          const ultimo = mesesData[mesesData.length - 1] as EstadoMes;
          return chave(ultimo.mes, ultimo.ano);
        }
        return prev;
      });
    } else if (mesesData && mesesData.length === 0) {
      setMesesSalvos([{ mes: MES_ATUAL, ano: ANO_ATUAL, movimentos: [], docGerado: "", finalizado: false }]);
    }
  }, [mesesData]);

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
  const [filtroTipo, setFiltroTipo] = useState<string>("TODOS");
  const fileRef = useRef<HTMLInputElement>(null);
  const pastaRef = useRef<HTMLInputElement>(null);
  const [mostrarRelatorio, setMostrarRelatorio] = useState(false);
  const uploadFicheiroMutation = trpc.ficheiros.upload.useMutation();
  const [conciliando, setConciliando] = useState(false);

  // ─── Guardar no servidor com debounce ────────────────────
  const guardarMesNoServidor = useCallback((estado: EstadoMes) => {
    if (!isAuthenticated) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setEstadoGravacao("saving");
    debounceRef.current = setTimeout(() => {
      saveMesMutation.mutate({
        mes: estado.mes,
        ano: estado.ano,
        movimentosJson: JSON.stringify(estado.movimentos),
        docGerado: estado.docGerado,
        finalizado: estado.finalizado,
      });
    }, 800); // debounce de 800ms
  }, [isAuthenticated, saveMesMutation]);

  // ─── Ler ficheiro como base64 (para upload persistente) ────────
  const lerComoBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve((e.target?.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // ─── Conciliar PDFs por nome de ficheiro (com upload persistente) ──
  const conciliarPdfs = useCallback(async (files: FileList) => {
    if (!files.length) return;
    const pdfs = Array.from(files).filter(f =>
      f.name.toLowerCase().endsWith(".pdf") ||
      f.name.toLowerCase().endsWith(".png") ||
      f.name.toLowerCase().endsWith(".jpg") ||
      f.name.toLowerCase().endsWith(".jpeg")
    );
    if (pdfs.length === 0) { toast.error("Nenhum PDF ou imagem encontrado na pasta."); return; }

    const movsActuais = mesesSalvos.find(m => chave(m.mes, m.ano) === abaActiva)?.movimentos ?? [];
    setConciliando(true);

    const usados = new Set<string>();
    const planoLigacoes: { movId: string; file: File }[] = [];

    for (const mov of movsActuais) {
      if (mov.arquivoNome) continue;
      let escolhido: File | undefined;
      if (mov.inst) {
        escolhido = pdfs.find(f => {
          if (usados.has(f.name)) return false;
          const n = f.name.toLowerCase();
          return n.includes(`inst-${mov.inst}`) ||
                 n.includes(`inst${mov.inst}`) ||
                 n.includes(`inst_${mov.inst}`) ||
                 n.includes(`-${mov.inst}_`) ||
                 n.includes(`_${mov.inst}_`) ||
                 n.includes(`_${mov.inst}.`) ||
                 n.includes(`-${mov.inst}.`);
        });
      }
      if (!escolhido) {
        const valorStr = mov.valor.toFixed(2).replace(".", "[.,]");
        const valorRe = new RegExp(valorStr);
        escolhido = pdfs.find(f => !usados.has(f.name) && valorRe.test(f.name));
      }
      if (escolhido) {
        usados.add(escolhido.name);
        planoLigacoes.push({ movId: mov.id, file: escolhido });
      }
    }

    if (planoLigacoes.length === 0) {
      setConciliando(false);
      toast.info(`${pdfs.length} ficheiro${pdfs.length !== 1 ? "s" : ""} lido${pdfs.length !== 1 ? "s" : ""}. Nenhuma correspondência nova encontrada.`);
      return;
    }

    toast.info(`A enviar ${planoLigacoes.length} ficheiro${planoLigacoes.length !== 1 ? "s" : ""}...`);

    const ligacoesPorMovId = new Map<string, { arquivoNome: string; arquivoUrl: string; arquivoKey: string }>();
    let falhas = 0;

    for (const { movId, file } of planoLigacoes) {
      try {
        const dadosBase64 = await lerComoBase64(file);
        const resultado = await uploadFicheiroMutation.mutateAsync({
          nomeOriginal: file.name,
          mimeType: file.type || "application/octet-stream",
          dadosBase64,
          movId,
        });
        ligacoesPorMovId.set(movId, {
          arquivoNome: resultado.nome,
          arquivoUrl: resultado.url,
          arquivoKey: resultado.key,
        });
      } catch {
        falhas++;
      }
    }

    const novosMov = movsActuais.map(mov => {
      const ligacao = ligacoesPorMovId.get(mov.id);
      return ligacao ? { ...mov, ...ligacao } : mov;
    });

    const movsComStatus = novosMov.map(m => ({
      ...m,
      statusDoc: m.arquivoNome
        ? ("conciliado" as const)
        : (m.tipo === "GERAR FATURA" || m.tipo === "RECIBO VERDE"
            ? ("sem_doc" as const)
            : undefined),
    }));

    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      if (idx === -1) return prev;
      const novoEstado = { ...prev[idx], movimentos: movsComStatus };
      const novo = [...prev];
      novo[idx] = novoEstado;
      guardarMesNoServidor(novoEstado);
      return novo;
    });

    setConciliando(false);
    const ligacoes = ligacoesPorMovId.size;
    if (falhas > 0) {
      toast.error(`${ligacoes} correspondência${ligacoes !== 1 ? "s" : ""} guardada${ligacoes !== 1 ? "s" : ""}. ${falhas} falhou${falhas !== 1 ? "ram" : ""} ao enviar — tente novamente.`);
    } else {
      toast.success(`${pdfs.length} ficheiro${pdfs.length !== 1 ? "s" : ""} lido${pdfs.length !== 1 ? "s" : ""}. ${ligacoes} correspondência${ligacoes !== 1 ? "s" : ""} guardada${ligacoes !== 1 ? "s" : ""}.`);
    }
  }, [mesesSalvos, abaActiva, uploadFicheiroMutation, guardarMesNoServidor]);

  const onPastaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) conciliarPdfs(e.target.files);
    if (pastaRef.current) pastaRef.current.value = "";
  };

  // ─── Exportar relatório CSV para contabilista ─────────────
  const exportarCsv = useCallback(() => {
    const estadoAtual = mesesSalvos.find(m => chave(m.mes, m.ano) === abaActiva);
    const movsAtual = estadoAtual?.movimentos ?? [];
    const mesAtual = estadoAtual?.mes ?? "";
    const anoAtual = estadoAtual?.ano ?? ANO_ATUAL;
    const linhas = [
      ["Data", "Descrição", "Valor (€)", "Tipo", "Descrição Fatura", "Nome Fatura", "Status Documento", "Arquivo"],
      ...movsAtual.map(m => [
        m.data,
        m.descricao,
        m.valor.toFixed(2).replace(".", ","),
        m.tipo || "—",
        m.descricaoFatura || "—",
        m.nomeFatura || "—",
        m.statusDoc === "conciliado" ? "✅ Conciliado" : m.statusDoc === "sem_doc" ? "❌ Falta Documento" : "—",
        m.arquivoNome || "—",
      ]),
    ];
    const csv = linhas.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(";")
    ).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio-${mesAtual}-${anoAtual}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Relatório CSV exportado!");
  }, [mesesSalvos, abaActiva]);

  // ─── Actualizar mês activo ────────────────────────────────
  const actualizarMesActivo = useCallback((patch: Partial<EstadoMes>) => {
    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      let novoEstado: EstadoMes;
      if (idx === -1) {
        const [mes, anoStr] = abaActiva.split("-");
        novoEstado = { mes, ano: parseInt(anoStr) || ANO_ATUAL, movimentos: [], docGerado: "", finalizado: false, ...patch };
        const novo = [...prev, novoEstado];
        guardarMesNoServidor(novoEstado);
        return novo;
      }
      novoEstado = { ...prev[idx], ...patch };
      const novo = [...prev];
      novo[idx] = novoEstado;
      guardarMesNoServidor(novoEstado);
      return novo;
    });
  }, [abaActiva, guardarMesNoServidor]);

  const { movimentos, docGerado, finalizado, mes, ano } = estadoActivo;
  const tiposActivos = config.tipos as TipoMovimento[];

  // ─── Filtro por tipo ──────────────────────────────────────
  const movimentosFiltrados = useMemo(() => {
    if (filtroTipo === "TODOS") return movimentos;
    if (filtroTipo === "SEM_TIPO") return movimentos.filter(m => !m.tipo);
    if (filtroTipo === "CONCILIADO") return movimentos.filter(m => m.statusDoc === "conciliado");
    if (filtroTipo === "SEM_DOC") return movimentos.filter(m => m.statusDoc === "sem_doc");
    return movimentos.filter(m => m.tipo === filtroTipo);
  }, [movimentos, filtroTipo]);

  const tiposComMovimentos = useMemo(() => {
    const set = new Set(movimentos.map(m => m.tipo || "SEM_TIPO"));
    return Array.from(set);
  }, [movimentos]);

  // ─── Handlers ────────────────────────────────────────────
  const atualizarTipo = useCallback((id: string, tipo: TipoMovimento) => {
    const mesRef = mesAnterior(mes);
    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      if (idx === -1) return prev;
      const novosMov = prev[idx].movimentos.map(m => {
        if (m.id !== id) return m;
        const desc = gerarDescricao(m.descricao, tipo, mesRef, m.valor);
        return { ...m, tipo, descricaoFatura: desc };
      });
      const novoEstado = { ...prev[idx], movimentos: novosMov };
      const novo = [...prev];
      novo[idx] = novoEstado;
      guardarMesNoServidor(novoEstado);
      return novo;
    });
  }, [abaActiva, mes, guardarMesNoServidor]);

  const atualizarNomeFatura = useCallback((id: string, nome: string) => {
    setMesesSalvos(prev => {
      const idx = prev.findIndex(m => chave(m.mes, m.ano) === abaActiva);
      if (idx === -1) return prev;
      const novosMov = prev[idx].movimentos.map(m => m.id === id ? { ...m, nomeFatura: nome } : m);
      const novoEstado = { ...prev[idx], movimentos: novosMov };
      const novo = [...prev];
      novo[idx] = novoEstado;
      return novo;
    });
  }, [abaActiva]);

  const guardarNomeFatura = useCallback(() => {
    const estado = mesesSalvos.find(m => chave(m.mes, m.ano) === abaActiva);
    if (estado) guardarMesNoServidor(estado);
  }, [abaActiva, mesesSalvos, guardarMesNoServidor]);

  const carregarFicheiro = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        const movsBrutos = parsearXlsx(buffer);
        if (movsBrutos.length === 0) { toast.error("Nenhum movimento encontrado no ficheiro."); return; }

        // Pré-classificação automática
        const mesRef = mesAnterior(mes);
        const movsClassificados = classificarAutomaticamente(movsBrutos, mesRef);
        const numAutoClassificados = movsClassificados.filter(m => m.tipo).length;

        actualizarMesActivo({ movimentos: movsClassificados, docGerado: "", finalizado: false });
        setMostrarDoc(false);
        setFiltroTipo("TODOS");
        if (fileRef.current) fileRef.current.value = "";

        if (numAutoClassificados > 0) {
          toast.success(`${movsBrutos.length} movimentos carregados! ${numAutoClassificados} classificados automaticamente.`);
        } else {
          toast.success(`${movsBrutos.length} movimentos carregados!`);
        }
      } catch {
        toast.error("Erro ao ler o ficheiro. Certifique-se que é um .xlsx do BPI.");
      }
    };
    reader.readAsArrayBuffer(file);
  }, [actualizarMesActivo, mes]);

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
    setFiltroTipo("TODOS");
    if (fileRef.current) fileRef.current.value = "";
    toast.info("Dados limpos.");
  };

  // ─── Pré-classificar manualmente (botão) ─────────────────
  const preClassificarManual = useCallback(() => {
    const mesRef = mesAnterior(mes);
    const movsClassificados = classificarAutomaticamente(movimentos, mesRef);
    const novos = movsClassificados.filter(m => m.tipo).length;
    const jaClassificados = movimentos.filter(m => m.tipo).length;
    const classificados = novos - jaClassificados;
    actualizarMesActivo({ movimentos: movsClassificados });
    if (classificados > 0) {
      toast.success(`${classificados} movimento${classificados !== 1 ? "s" : ""} classificado${classificados !== 1 ? "s" : ""} automaticamente!`);
    } else {
      toast.info("Nenhum movimento novo para classificar automaticamente.");
    }
  }, [movimentos, mes, actualizarMesActivo]);

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
    const novoEstado: EstadoMes = { mes: novoMesSel, ano: novoAnoSel, movimentos: [], docGerado: "", finalizado: false };
    setMesesSalvos(prev => [...prev, novoEstado]);
    guardarMesNoServidor(novoEstado);
    setAbaActiva(k);
    setMostrarNovoMes(false);
    setFiltroTipo("TODOS");
    toast.success(`Mês ${novoMesSel} ${novoAnoSel} adicionado!`);
  };

  const removerMes = (k: string) => {
    if (mesesSalvos.length <= 1) { toast.error("Deve manter pelo menos um mês."); return; }
    const [mesDel, anoStr] = k.split("-");
    const anoDel = parseInt(anoStr) || ANO_ATUAL;
    deleteMesMutation.mutate({ mes: mesDel, ano: anoDel });
    const novos = mesesSalvos.filter(m => chave(m.mes, m.ano) !== k);
    setMesesSalvos(novos);
    if (abaActiva === k) {
      setAbaActiva(chave(novos[novos.length - 1].mes, novos[novos.length - 1].ano));
    }
    toast.info("Mês removido.");
  };

  const salvarConfig = (cfg: Config) => {
    setConfig(cfg);
    saveConfigMutation.mutate({
      empresaNome: cfg.empresa.nome,
      empresaNif: cfg.empresa.nif,
      empresaMorada: cfg.empresa.morada,
      tipos: cfg.tipos,
    });
  };

  // ─── Métricas ─────────────────────────────────────────────
  const totalFaturas = totalPorTipo(movimentos, "GERAR FATURA");
  const baseTotal = calcularValorBase(totalFaturas);
  const dezPct = baseTotal * 0.1;
  const numFaturas = movimentos.filter(m => m.tipo === "GERAR FATURA").length;
  const totalClassificados = movimentos.filter(m => m.tipo).length;
  const semTipo = movimentos.filter(m => !m.tipo).length;

  // ─── Loading / Login ──────────────────────────────────────
  if (authLoading || (isAuthenticated && (configLoading || mesesLoading))) {
    return (
      <div className="min-h-screen bg-[#0a0e16] flex items-center justify-center" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <div className="text-blue-100 font-semibold text-sm">A carregar...</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <EcraLogin />;
  }

  // ─── Indicador de gravação ────────────────────────────────
  const IndicadorGravacao = () => {
    if (estadoGravacao === "idle") return null;
    return (
      <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-all ${
        estadoGravacao === "saving" ? "text-amber-300" :
        estadoGravacao === "saved"  ? "text-green-400" :
        "text-red-400"
      }`}>
        {estadoGravacao === "saving" && <><div className="w-3 h-3 border-2 border-amber-500/30 border-t-transparent rounded-full animate-spin" /><span>A guardar...</span></>}
        {estadoGravacao === "saved"  && <><Cloud className="w-3 h-3" /><span>Guardado ✓</span></>}
        {estadoGravacao === "error"  && <><CloudOff className="w-3 h-3" /><span>Erro ao guardar</span></>}
      </div>
    );
  };

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0e16]" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>

      {/* HEADER */}
      <header className="bg-[#0f2744] text-white shadow-xl border-b-4 border-[#2563eb]">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="w-7 h-7 text-blue-400" />
            <div>
              <div className="font-bold text-lg tracking-tight leading-none text-white">PRESENÇOBRIGATÓRIA</div>
              <div className="text-blue-300 text-xs font-mono mt-0.5">{config.empresa.nome} · NIF {config.empresa.nif}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IndicadorGravacao />
            {/* Utilizador */}
            <div className="hidden sm:flex items-center gap-2 text-xs text-blue-200 bg-white/10 px-3 py-1.5 rounded border border-white/20">
              <User className="w-3.5 h-3.5" />
              <span>{user?.name || user?.email || "Utilizador"}</span>
            </div>
            <button
              onClick={() => setMostrarConfig(true)}
              className="flex items-center gap-1.5 text-xs text-blue-200 hover:text-white border border-blue-700 hover:border-blue-400 px-3 py-1.5 rounded transition-colors"
              title="Configurações"
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Configurações</span>
            </button>
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 text-xs text-red-300 hover:text-red-100 border border-red-800 hover:border-red-500 px-3 py-1.5 rounded transition-colors"
              title="Sair"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sair</span>
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
              const isFinalizado = m.finalizado;
              const temDados = m.movimentos.length > 0;

              return (
                <div key={k} className="relative group flex-shrink-0">
                  <button
                    onClick={() => { setAbaActiva(k); setMostrarDoc(false); setFiltroTipo("TODOS"); }}
                    className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all duration-150 capitalize
                      ${isActive
                        ? "bg-[#0a0e16] text-blue-100 shadow-sm"
                        : isFinalizado
                          ? "bg-green-900/60 text-green-300 hover:bg-green-800/70 hover:text-green-100 border border-green-700/50"
                          : temDados
                            ? "bg-[#1e3a5c] text-blue-100 hover:bg-[#2a4f7a] hover:text-white border border-blue-600/30"
                            : "bg-[#1e3a5c] text-blue-300 hover:bg-[#2a4f7a] hover:text-white"
                      }`}
                  >
                    {isFinalizado
                      ? <CheckCircle2 className="w-3 h-3 text-green-400 flex-shrink-0" />
                      : temDados
                        ? <Save className="w-3 h-3 text-blue-400 flex-shrink-0" />
                        : null
                    }
                    <span>{m.mes} {m.ano}</span>
                    {temDados && (
                      <span className={`text-[10px] font-mono px-1 rounded ${
                        isActive ? "bg-blue-500/15 text-blue-300" :
                        isFinalizado ? "bg-green-800 text-green-300" :
                        "bg-blue-900 text-blue-300"
                      }`}>
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
            <Button size="sm" onClick={adicionarNovoMes} className="h-7 text-xs bg-blue-600 hover:bg-blue-500/150">Adicionar</Button>
            <button onClick={() => setMostrarNovoMes(false)} className="text-blue-300 hover:text-white text-xs ml-2">Cancelar</button>
          </div>
        </div>
      )}

      <div className="container py-6 space-y-5">

        {/* INDICADOR DE MÊS ACTIVO */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-blue-100 capitalize">{mes} {ano}</h2>
            {finalizado && (
              <span className="flex items-center gap-1 text-xs font-semibold text-green-300 bg-green-500/15 border border-green-500/30 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3" /> Finalizado
              </span>
            )}
            {movimentos.length === 0 && !finalizado && (
              <span className="text-xs text-amber-400 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-full">
                Aguardando extrato
              </span>
            )}
            {movimentos.length > 0 && semTipo > 0 && !finalizado && (
              <span className="text-xs text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-full">
                {semTipo} sem tipo
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
                ${dragging ? "border-blue-500 bg-blue-500/15" : "border-white/20 bg-[#141b29] hover:border-blue-500 hover:bg-blue-500/10"}`}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className={`w-8 h-8 ${dragging ? "text-blue-400" : "text-slate-400"}`} />
              <div className="text-center">
                <div className="font-semibold text-slate-200 text-sm">Carregar Extrato</div>
                <div className="text-slate-400 text-xs mt-1">Arraste ou clique · .xlsx do BPI</div>
                {movimentos.length > 0 && (
                  <div className="text-blue-400 text-xs mt-1 font-medium">Substitui os dados actuais</div>
                )}
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onFileChange} />
            </div>
            {movimentos.length > 0 && !finalizado && (
              <button
                onClick={limparDados}
                className="w-full flex items-center justify-center gap-2 text-xs text-red-400 font-medium border border-red-500/30 rounded-lg py-2 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Limpar dados
              </button>
            )}
          </div>

          <div className="col-span-3 grid grid-cols-3 gap-3">
            {[
              { label: "Total GERAR FATURA", value: formatEur(totalFaturas), sub: `${numFaturas} linha${numFaturas !== 1 ? "s" : ""}`, color: "#60a5fa", bg: "#15314f" },
              { label: "Valor Base (÷ 1,23)", value: formatEur(baseTotal), sub: "Sem IVA", color: "#60a5fa", bg: "#11203a" },
              { label: "10% do Valor Base", value: formatEur(dezPct), sub: "Referência comissão", color: "#4ade80", bg: "#103a22" },
            ].map(({ label, value, sub, color, bg }) => (
              <div key={label} className="rounded-lg p-4 shadow-sm border border-white/10" style={{ background: bg, borderTop: `4px solid ${color}` }}>
                <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">{label}</div>
                <div className="font-mono font-bold text-2xl mt-1" style={{ color }}>{value}</div>
                <div className="text-xs text-slate-400 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Sem dados */}
        {movimentos.length === 0 && (
          <div className="bg-[#141b29] border-2 border-dashed border-white/15 rounded-lg p-12 text-center">
            <Upload className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <div className="text-slate-400 font-semibold">Nenhum extrato carregado</div>
            <div className="text-slate-500 text-sm mt-1">Carregue o ficheiro .xlsx do BPI para começar</div>
          </div>
        )}

        {movimentos.length > 0 && (
          <>
            {/* RESUMO POR TIPO */}
            <div className="bg-[#141b29] rounded-lg shadow-sm border border-white/10 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-[#11161f]">
                <span className="font-bold text-sm text-slate-200">Resumo por Tipo</span>
                <span className="text-xs text-slate-400 font-mono bg-[#232c3d] px-2 py-0.5 rounded">{totalClassificados} / {movimentos.length} classificados</span>
              </div>
              <div className="flex flex-wrap gap-2 p-4">
                {tiposActivos.map(tipo => {
                  const total = totalPorTipo(movimentos, tipo);
                  const count = movimentos.filter(m => m.tipo === tipo).length;
                  if (count === 0) return null;
                  const badgeClass = BADGE_MAP[tipo] || "bg-[#232c3d] text-slate-300";
                  return (
                    <div key={tipo} className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold ${badgeClass}`}>
                      <span>{tipo}</span>
                      <span className="font-mono">{formatEur(total)}</span>
                      <span className="opacity-70">({count})</span>
                    </div>
                  );
                })}
                {movimentos.filter(m => !m.tipo).length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold bg-[#232c3d] text-slate-300">
                    <span>Sem tipo</span>
                    <span className="font-mono">{movimentos.filter(m => !m.tipo).length}</span>
                  </div>
                )}
              </div>
            </div>

            {/* TABELA */}
            <div className="bg-[#141b29] rounded-lg shadow-sm border border-white/10 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-[#11161f] flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-sm text-slate-200">Movimentos do Extrato</span>
                  {/* FILTRO POR TIPO */}
                  <div className="flex items-center gap-1.5">
                    <Filter className="w-3.5 h-3.5 text-slate-400" />
                    <Select value={filtroTipo} onValueChange={setFiltroTipo}>
                      <SelectTrigger className="h-7 text-xs w-44 border-white/15 bg-[#141b29] text-slate-300">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="TODOS" className="text-xs font-medium">Todos ({movimentos.length})</SelectItem>
                        {tiposActivos.map(t => {
                          const count = movimentos.filter(m => m.tipo === t).length;
                          if (count === 0) return null;
                          return (
                            <SelectItem key={t} value={t} className="text-xs">
                              {t} ({count})
                            </SelectItem>
                          );
                        })}
                        {movimentos.filter(m => !m.tipo).length > 0 && (
                          <SelectItem value="SEM_TIPO" className="text-xs text-slate-400">
                            Sem tipo ({movimentos.filter(m => !m.tipo).length})
                          </SelectItem>
                        )}
                        {movimentos.some(m => m.statusDoc === "conciliado") && (
                          <SelectItem value="CONCILIADO" className="text-xs text-green-300">
                            ✅ Conciliados ({movimentos.filter(m => m.statusDoc === "conciliado").length})
                          </SelectItem>
                        )}
                        {movimentos.some(m => m.statusDoc === "sem_doc") && (
                          <SelectItem value="SEM_DOC" className="text-xs text-red-300">
                            ❌ Falta Documento ({movimentos.filter(m => m.statusDoc === "sem_doc").length})
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {filtroTipo !== "TODOS" && (
                      <span className="text-xs text-blue-400 font-semibold bg-blue-500/15 border border-blue-500/30 px-2 py-0.5 rounded">
                        {movimentosFiltrados.length} linha{movimentosFiltrados.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  {/* RESUMO DE CONCILIAÇÃO */}
                  {movimentos.some(m => m.statusDoc) && (() => {
                    const conciliados = movimentos.filter(m => m.statusDoc === "conciliado").length;
                    const semDoc = movimentos.filter(m => m.statusDoc === "sem_doc").length;
                    const total = conciliados + semDoc;
                    return (
                      <div className="flex items-center gap-2 text-[10px] font-semibold">
                        <span className="text-green-300 bg-green-500/15 px-2 py-0.5 rounded flex items-center gap-1">
                          <FileCheck2 className="w-3 h-3" /> {conciliados}/{total} conciliados
                        </span>
                        {semDoc > 0 && (
                          <span className="text-red-300 bg-red-500/15 px-2 py-0.5 rounded flex items-center gap-1">
                            <FileX2 className="w-3 h-3" /> {semDoc} em falta
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {movimentos.length > 0 && (
                    <Button variant="outline" size="sm" onClick={exportarCsv} className="text-xs h-7 gap-1 border-green-600 text-green-300 hover:bg-green-500/10" title="Exportar relatório CSV para contabilista">
                      <Download className="w-3 h-3" /> Relatório CSV
                    </Button>
                  )}
                  {!finalizado && (
                    <>
                      {movimentos.length > 0 && (
                        <Button variant="outline" size="sm" disabled={conciliando} onClick={() => pastaRef.current?.click()} className="text-xs h-7 gap-1 border-purple-500 text-purple-300 hover:bg-purple-500/10" title="Carregar PDFs/imagens de faturas para conciliação automática">
                          {conciliando
                            ? <><div className="w-3 h-3 border-2 border-purple-300 border-t-transparent rounded-full animate-spin" /> A conciliar...</>
                            : <><FolderOpen className="w-3 h-3" /> Conciliar Faturas</>}
                        </Button>
                      )}
                      {semTipo > 0 && (
                        <Button variant="outline" size="sm" onClick={preClassificarManual} className="text-xs h-7 gap-1 border-amber-400 text-amber-300 hover:bg-amber-500/10" title="Classificar automaticamente por palavras-chave">
                          <Wand2 className="w-3 h-3" /> Auto-classificar
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={limparDados} className="text-xs h-7 gap-1 border-white/15 text-slate-300 hover:bg-white/5">
                        <RotateCcw className="w-3 h-3" /> Limpar
                      </Button>
                      <Button size="sm" onClick={gerarDocumento} className="text-xs h-7 gap-1 bg-[#0f2744] hover:bg-[#1e3a5c] text-white">
                        <FileText className="w-3 h-3" /> Gerar Faturas
                      </Button>
                    </>
                  )}
                  {/* Input oculto para selecção de pasta */}
                  <input
                    ref={pastaRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    multiple
                    className="hidden"
                    onChange={onPastaChange}
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse" style={{fontSize: '11px'}}>
                  <thead>
                    <tr className="bg-[#0f2744] text-white">
                      <th className="text-left px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider w-24 border-r border-blue-900">Data</th>
                      <th className="text-left px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider border-r border-blue-900">Descrição</th>
                      <th className="text-right px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider w-24 border-r border-blue-900">Valor</th>
                      <th className="text-center px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider w-44 border-r border-blue-900">Tipo</th>
                      <th className="text-left px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider border-r border-blue-900">Desc. Fatura</th>
                      <th className="text-left px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider w-32 border-r border-blue-900">Nome Fatura</th>
                      <th className="text-center px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider w-20">Doc</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimentosFiltrados.map((mov, i) => {
                      const rowClass = TIPO_ROW_CLASS[mov.tipo] || (i % 2 === 0 ? "bg-[#141b29]" : "bg-[#11161f]");
                      const badgeClass = TIPO_BADGE_CLASS[mov.tipo];
                      return (
                        <tr key={mov.id} className={`border-b border-white/5 hover:brightness-95 transition-all duration-75 ${rowClass}`} style={{height: '28px'}}>
                          <td className="px-2 py-0.5 font-mono text-[10px] text-slate-400 font-medium border-r border-white/10 whitespace-nowrap">{mov.data}</td>
                          <td className="px-2 py-0.5 border-r border-white/10 max-w-[220px]">
                            <div className="flex items-center gap-1">
                              <span className="text-slate-100 text-[11px] font-medium truncate" title={mov.descricao}>{mov.descricao}</span>
                              {mov.inst && (
                                <span className="shrink-0 font-mono text-[9px] bg-blue-500/15 text-blue-300 px-1 py-0 rounded font-bold">
                                  {mov.inst}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono font-bold text-[11px] text-red-300 border-r border-white/10 whitespace-nowrap">
                            {formatEur(mov.valor)}
                          </td>
                          <td className="px-1 py-0.5 border-r border-white/10">
                            {finalizado ? (
                              <span className={`text-[10px] font-semibold px-1.5 py-0 rounded ${badgeClass || "bg-[#1c2433] text-slate-400"}`}>
                                {mov.tipo || "—"}
                              </span>
                            ) : (
                              <Select
                                value={mov.tipo || "__none__"}
                                onValueChange={(v) => atualizarTipo(mov.id, v === "__none__" ? "" as TipoMovimento : v as TipoMovimento)}
                              >
                                <SelectTrigger className={`h-6 text-[10px] w-full font-semibold border-0 shadow-none ${badgeClass || "bg-[#1c2433] text-slate-300"}`}>
                                  <SelectValue placeholder="— tipo —" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__" className="text-xs text-slate-400">— tipo —</SelectItem>
                                  {tiposActivos.map(t => (
                                    <SelectItem key={t} value={t} className="text-xs font-medium">{t}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </td>
                          <td className="px-2 py-0.5 border-r border-white/10 max-w-[180px]">
                            {mov.descricaoFatura ? (
                              <span className="text-[10px] text-slate-300 italic truncate block" title={mov.descricaoFatura}>{mov.descricaoFatura}</span>
                            ) : (
                              <span className="text-slate-600 text-[10px]">—</span>
                            )}
                          </td>
                          <td className="px-2 py-0.5 border-r border-white/10">
                            {finalizado ? (
                              <span className="text-[10px] text-slate-300 truncate block" title={mov.nomeFatura}>{mov.nomeFatura || "—"}</span>
                            ) : (
                              <input
                                type="text"
                                value={mov.nomeFatura}
                                onChange={e => atualizarNomeFatura(mov.id, e.target.value)}
                                onBlur={guardarNomeFatura}
                                placeholder="Nome..."
                                className="w-full text-[10px] bg-transparent border-b border-white/15 focus:border-blue-500 outline-none text-slate-200 placeholder-gray-400"
                              />
                            )}
                          </td>
                          {/* COLUNA STATUS DOCUMENTO */}
                          <td className="px-1 py-0.5 text-center">
                            {mov.statusDoc === "conciliado" ? (
                              <div className="flex items-center justify-center gap-1">
                                <span title={mov.arquivoNome} className="inline-flex items-center gap-0.5 text-[9px] font-bold text-green-300 bg-green-500/15 px-1 py-0 rounded">
                                  <FileCheck2 className="w-2.5 h-2.5" /> OK
                                </span>
                                {mov.arquivoUrl && (
                                  <a href={mov.arquivoUrl} target="_blank" rel="noreferrer" title="Ver documento" className="text-blue-400 hover:text-blue-300">
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </a>
                                )}
                              </div>
                            ) : mov.statusDoc === "sem_doc" ? (
                              <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-red-300 bg-red-500/15 px-1 py-0 rounded">
                                <FileX2 className="w-2.5 h-2.5" /> Falta
                              </span>
                            ) : (
                              <span className="text-slate-300 text-[10px]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {movimentosFiltrados.length === 0 && filtroTipo !== "TODOS" && (
                  <div className="text-center py-8 text-slate-500 text-sm">
                    Nenhum movimento com o tipo "{filtroTipo === "SEM_TIPO" ? "Sem tipo" : filtroTipo}"
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* DOCUMENTO GERADO */}
        {docGerado && (
          <div className="bg-[#141b29] rounded-lg shadow-sm border-2 border-blue-900/50 overflow-hidden">
            <div
              className="px-4 py-3 border-b border-white/10 flex items-center justify-between cursor-pointer bg-[#0f2744]"
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
                <pre className="font-mono text-xs text-slate-200 whitespace-pre-wrap leading-relaxed bg-[#11161f] rounded p-4 border border-white/10">
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
            <DialogTitle className="flex items-center gap-2 text-blue-100">
              <Settings className="w-4 h-4" />
              Configurações
            </DialogTitle>
          </DialogHeader>
          <PainelConfig
            config={config}
            onSave={salvarConfig}
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
