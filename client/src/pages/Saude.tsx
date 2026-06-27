// ============================================================
// PRESENÇOBRIGATÓRIA — Saúde da Empresa
// Aba de análise financeira. Recolhe os dados já inseridos na
// aba de Gestão de Extratos (trpc.meses.list) e produz:
//   • Indicadores (entradas, saídas, resultado, Estado)
//   • Conciliação do saldo REAL da conta vs. o que está lançado
//   • Evolução mensal e por contrato
//   • Relatórios imprimíveis (contabilista + conciliação)
// Design: mesmo "Corporate Brutalism" escuro da Home.
// ============================================================

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Building2, Activity, User, LogOut, Printer, Wallet, TrendingUp,
  TrendingDown, Scale, AlertTriangle, CheckCircle2, Landmark, FileText,
  RefreshCw, Settings2, Info, BookOpen,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as ReTooltip, Legend,
} from "recharts";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import NavSuperior from "@/components/NavSuperior";
import { formatEur } from "@/lib/faturas";
import {
  EstadoMes, Direcao, DIRECAO_PADRAO, direcaoDe, resumoGlobal,
  conciliar, diagnosticarDiferenca, indicadores,
  DadosSaldo,
} from "@/lib/saude";

// ─── Persistência local (por utilizador) ──────────────────────────────
function lerSaldo(uid: string | number): DadosSaldo {
  try {
    const raw = localStorage.getItem(`saude-saldo-${uid}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignora */ }
  // Saldo inicial padrão: 203,28 € (saldo bancário BPI em 01/01/2026 — confirmado pelo balancete 2025 e extrato jan/2026)
  return { saldoInicial: 203.28, saldoInicialData: "01/01/2026", saldoReal: 0, saldoRealData: "" };
}
function gravarSaldo(uid: string | number, d: DadosSaldo) {
  try { localStorage.setItem(`saude-saldo-${uid}`, JSON.stringify(d)); } catch { /* ignora */ }
}
function lerDirecoes(uid: string | number): Record<string, Direcao> {
  try {
    const raw = localStorage.getItem(`saude-direcoes-${uid}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignora */ }
  return {};
}
function gravarDirecoes(uid: string | number, d: Record<string, Direcao>) {
  try { localStorage.setItem(`saude-direcoes-${uid}`, JSON.stringify(d)); } catch { /* ignora */ }
}

// Converte texto "1.234,56" ou "1234.56" em número.
function parseNum(txt: string): number {
  if (!txt) return 0;
  const limpo = txt.trim().replace(/\s/g, "").replace(/€/g, "");
  // Se tem vírgula e ponto, assume ponto=milhar, vírgula=decimal
  let n: string;
  if (limpo.includes(",")) {
    n = limpo.replace(/\./g, "").replace(",", ".");
  } else {
    n = limpo;
  }
  const v = parseFloat(n);
  return isNaN(v) ? 0 : v;
}

const CORES_TIPO: Record<string, string> = {
  "RECEBIMENTO": "#10b981",
  "FATURA SERVIÇO": "#3b82f6",
  "FATURA": "#3b82f6",
  "COMPRA": "#ef4444",
  "RECIBO VERDE": "#22c55e",
  "RECIBO": "#06b6d4",
  "MANUT. CONTA": "#d97706",
  "AVENÇA CONT.": "#9333ea",
  "SEG. SOCIAL": "#f97316",
  "IVA": "#ec4899",
  "—": "#64748b",
};
function corTipo(t: string): string { return CORES_TIPO[t] || "#64748b"; }

// ─── Cartão KPI ────────────────────────────────────────────────────────
function Kpi({ titulo, valor, sub, icon: Icon, cor }: {
  titulo: string; valor: string; sub?: string; icon: React.ElementType; cor: string;
}) {
  return (
    <div className="bg-[#141b29] border border-[#1e3a5c] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-blue-300/70 font-semibold">{titulo}</span>
        <Icon className="w-4 h-4" style={{ color: cor }} />
      </div>
      <div className="text-2xl font-bold font-mono leading-none" style={{ color: cor }}>{valor}</div>
      {sub && <div className="text-[11px] text-blue-300/60">{sub}</div>}
    </div>
  );
}

export default function Saude() {
  const { user, logout } = useAuth();
  const uid = user?.id ?? "anon";

  const configQuery = trpc.config.get.useQuery();
  const mesesQuery = trpc.meses.list.useQuery();

  const empresaNome = configQuery.data?.empresaNome ?? "PRESENÇOBRIGATÓRIA - UNIPESSOAL LDA";
  const empresaNif = configQuery.data?.empresaNif ?? "518604870";
  const empresaMorada = configQuery.data?.empresaMorada ?? "";

  const meses: EstadoMes[] = useMemo(
    () => (mesesQuery.data ?? []).map((m: any) => ({
      mes: m.mes, ano: m.ano, movimentos: m.movimentos ?? [],
      docGerado: m.docGerado ?? "", finalizado: m.finalizado ?? false,
    })),
    [mesesQuery.data],
  );

  // Estado: saldo + overrides de direção (persistidos no navegador)
  const [saldo, setSaldo] = useState<DadosSaldo>({ saldoInicial: 203.28, saldoInicialData: "01/01/2026", saldoReal: 0, saldoRealData: "" });
  const [saldoInicialTxt, setSaldoInicialTxt] = useState("");
  const [saldoRealTxt, setSaldoRealTxt] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Direcao>>({});
  const [mostrarDirecoes, setMostrarDirecoes] = useState(false);
  const [relatorio, setRelatorio] = useState<null | "contabilista" | "conciliacao">(null);

  useEffect(() => {
    const s = lerSaldo(uid);
    setSaldo(s);
    // Se nunca foi guardado (saldo inicial = 0), pré-preenche com 203,28 € (balancete 2025)
    const saldoInicialEfetivo = s.saldoInicial !== 0 ? s.saldoInicial : 203.28;
    setSaldoInicialTxt(saldoInicialEfetivo ? String(saldoInicialEfetivo).replace(".", ",") : "");
    setSaldoRealTxt(s.saldoReal ? String(s.saldoReal).replace(".", ",") : "");
    setOverrides(lerDirecoes(uid));
  }, [uid]);

  const guardarSaldo = useCallback(() => {
    const novo: DadosSaldo = {
      saldoInicial: parseNum(saldoInicialTxt),
      saldoInicialData: saldo.saldoInicialData,
      saldoReal: parseNum(saldoRealTxt),
      saldoRealData: new Date().toLocaleDateString("pt-PT"),
    };
    setSaldo(novo);
    gravarSaldo(uid, novo);
  }, [saldoInicialTxt, saldoRealTxt, saldo.saldoInicialData, uid]);

  function alterarDirecao(tipo: string, dir: Direcao) {
    const novo = { ...overrides, [tipo]: dir };
    setOverrides(novo);
    gravarDirecoes(uid, novo);
  }

  // ─── Cálculos ────────────────────────────────────────────────────────
  const global = useMemo(() => resumoGlobal(meses, overrides), [meses, overrides]);
  const conc = useMemo(() => conciliar(global, saldo), [global, saldo]);
  const diagnostico = useMemo(() => diagnosticarDiferenca(conc, global), [conc, global]);
  const ind = useMemo(() => indicadores(global), [global]);

  const dadosGrafico = useMemo(() => global.acumulado.map(a => {
    const r = global.meses.find(m => m.chave === a.chave)!;
    return {
      nome: `${a.mes.slice(0, 3)} ${String(a.ano).slice(2)}`,
      Entradas: Number(r.entradas.toFixed(2)),
      Saídas: Number(r.saidas.toFixed(2)),
      Acumulado: Number(a.acumulado.toFixed(2)),
    };
  }), [global]);

  const tiposOrdenados = useMemo(
    () => Object.entries(global.porTipo)
      .filter(([t]) => t !== "—")
      .sort((a, b) => b[1] - a[1]),
    [global.porTipo],
  );

  const tiposTodos = useMemo(() => {
    const arr = Object.keys(DIRECAO_PADRAO).filter(Boolean);
    for (const t of Object.keys(global.porTipo)) if (t !== "—" && !arr.includes(t)) arr.push(t);
    return arr;
  }, [global.porTipo]);

  // ─── Impressão ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!relatorio) return;
    const t = setTimeout(() => window.print(), 120);
    const limpar = () => setRelatorio(null);
    window.addEventListener("afterprint", limpar);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", limpar); };
  }, [relatorio]);

  const dataHoje = new Date().toLocaleDateString("pt-PT");
  const semDados = meses.length === 0 || global.totalMovimentos === 0;

  // Dados históricos 2025 (balancete analítico jan-dez 2025)
  const HISTORICO_2025 = {
    rendimentos: 83064.00,
    gastos: 77227.84,
    resultado: 5836.16,
    saldoBancario: 203.28,
    saldoCaixa: 5119.28,
    clientesEmAberto: 5490.72, // INST 120 — fatura dez/2025 paga em jan/2026
    ivaPagar: 4803.22,
    segSocialPagar: 174.00,
  };

  const corLiquido = global.liquido >= 0 ? "#34d399" : "#f87171";
  const corDiferenca = conc.conciliado ? "#34d399" : Math.abs(conc.diferenca) < 50 ? "#fbbf24" : "#f87171";

  return (
    <div className="min-h-screen bg-[#0a0e16] app-screen" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {/* HEADER */}
      <header className="bg-[#0f2744] text-white shadow-xl border-b-4 border-[#2563eb] no-print">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Building2 className="w-7 h-7 text-blue-400" />
            <div>
              <div className="font-bold text-lg tracking-tight leading-none text-white">PRESENÇOBRIGATÓRIA</div>
              <div className="text-blue-300 text-xs font-mono mt-0.5">{empresaNome} · NIF {empresaNif}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-2 text-xs text-blue-200 bg-white/10 px-3 py-1.5 rounded border border-white/20">
              <User className="w-3.5 h-3.5" />
              <span>{user?.name || user?.email || "Utilizador"}</span>
            </div>
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

      <NavSuperior />

      {/* CONTEÚDO */}
      <main className="container py-6 no-print">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            <h1 className="text-xl font-bold text-white">Saúde da Empresa</h1>
            <span className="text-xs text-blue-300/60 font-mono">· {meses.length} meses · {global.totalMovimentos} movimentos</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => mesesQuery.refetch()}
              className="flex items-center gap-1.5 text-xs text-blue-200 hover:text-white border border-blue-700 hover:border-blue-400 px-3 py-1.5 rounded transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Atualizar
            </button>
            <button
              onClick={() => setRelatorio("conciliacao")}
              disabled={semDados}
              className="flex items-center gap-1.5 text-xs text-white bg-[#1e3a5c] hover:bg-[#2a4f7a] border border-blue-600/40 px-3 py-1.5 rounded transition-colors disabled:opacity-40"
            >
              <Printer className="w-3.5 h-3.5" /> Conciliação
            </button>
            <button
              onClick={() => setRelatorio("contabilista")}
              disabled={semDados}
              className="flex items-center gap-1.5 text-xs text-white bg-[#2563eb] hover:bg-[#1d4ed8] px-3 py-1.5 rounded transition-colors disabled:opacity-40"
            >
              <FileText className="w-3.5 h-3.5" /> Relatório p/ contabilista
            </button>
          </div>
        </div>

        {/* PAINEL HISTÓRICO 2025 — sempre visível */}
        <section className="bg-[#0f1e35] border border-[#1e3a5c] rounded-lg p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-bold text-white">Contexto histórico — Exercício 2025</h2>
            <span className="text-[10px] text-blue-300/50 font-mono ml-1">Balancete Analítico jan–dez 2025</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="bg-[#141b29] rounded p-3">
              <div className="text-[10px] uppercase text-emerald-300/70 font-semibold mb-1">Rendimentos 2025</div>
              <div className="font-mono font-bold text-emerald-300 text-sm">{formatEur(HISTORICO_2025.rendimentos)}</div>
              <div className="text-[10px] text-blue-300/40 mt-0.5">Prestações de serviços</div>
            </div>
            <div className="bg-[#141b29] rounded p-3">
              <div className="text-[10px] uppercase text-red-300/70 font-semibold mb-1">Gastos 2025</div>
              <div className="font-mono font-bold text-red-300 text-sm">{formatEur(HISTORICO_2025.gastos)}</div>
              <div className="text-[10px] text-blue-300/40 mt-0.5">FSE + Pessoal + outros</div>
            </div>
            <div className="bg-[#141b29] rounded p-3">
              <div className="text-[10px] uppercase text-blue-300/70 font-semibold mb-1">Resultado 2025</div>
              <div className="font-mono font-bold text-blue-200 text-sm">{formatEur(HISTORICO_2025.resultado)}</div>
              <div className="text-[10px] text-blue-300/40 mt-0.5">Rendimentos − Gastos</div>
            </div>
            <div className="bg-[#141b29] rounded p-3">
              <div className="text-[10px] uppercase text-amber-300/70 font-semibold mb-1">Saldo bancário</div>
              <div className="font-mono font-bold text-amber-200 text-sm">{formatEur(HISTORICO_2025.saldoBancario)}</div>
              <div className="text-[10px] text-blue-300/40 mt-0.5">31/12/2025 · BPI</div>
            </div>
            <div className="bg-[#141b29] rounded p-3">
              <div className="text-[10px] uppercase text-purple-300/70 font-semibold mb-1">Clientes em aberto</div>
              <div className="font-mono font-bold text-purple-200 text-sm">{formatEur(HISTORICO_2025.clientesEmAberto)}</div>
              <div className="text-[10px] text-blue-300/40 mt-0.5">INST 120 · pago jan/2026</div>
            </div>
            <div className="bg-[#141b29] rounded p-3">
              <div className="text-[10px] uppercase text-orange-300/70 font-semibold mb-1">IVA a pagar</div>
              <div className="font-mono font-bold text-orange-200 text-sm">{formatEur(HISTORICO_2025.ivaPagar)}</div>
              <div className="text-[10px] text-blue-300/40 mt-0.5">Seg. Social: {formatEur(HISTORICO_2025.segSocialPagar)}</div>
            </div>
          </div>
          <div className="mt-3 flex items-start gap-2 bg-blue-950/40 border border-blue-800/40 rounded p-2.5 text-[11px] text-blue-200/80">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-blue-400" />
            <span>
              <strong>Nota sobre o INST 120 (5.490,72 €):</strong> Este recebimento de janeiro 2026 corresponde à fatura de dezembro 2025 — já estava registado como cliente em aberto no balancete 2025 (conta 21111999). O saldo inicial de 2026 é <strong>203,28 €</strong>, confirmado pelo extracto BPI de 01/01/2026.
            </span>
          </div>
        </section>

        {semDados && (
          <div className="bg-[#141b29] border border-[#1e3a5c] rounded-lg p-8 text-center text-blue-300/70 mb-6">
            <Info className="w-8 h-8 mx-auto mb-3 text-blue-400/50" />
            <p className="font-semibold text-blue-200">Ainda não há movimentos para analisar.</p>
            <p className="text-sm mt-1">Importe e classifique os extratos na aba <strong>Gestão de Extratos</strong>. Esta página recolhe automaticamente esses dados.</p>
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <Kpi titulo="Total Entradas" valor={formatEur(global.entradas)} sub="dinheiro recebido" icon={TrendingUp} cor="#34d399" />
          <Kpi titulo="Total Saídas" valor={formatEur(global.saidas)} sub="dinheiro pago" icon={TrendingDown} cor="#f87171" />
          <Kpi titulo="Resultado Líquido" valor={formatEur(global.liquido)} sub={`margem ${(ind.margem * 100).toFixed(1)}%`} icon={Scale} cor={corLiquido} />
          <Kpi titulo="Obrigações ao Estado" valor={formatEur(global.estado)} sub="Seg. Social + IVA" icon={Landmark} cor="#fb923c" />
        </div>

        {/* CONCILIAÇÃO — pergunta do saldo real */}
        <section className="bg-[#141b29] border border-[#1e3a5c] rounded-lg p-5 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Wallet className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-bold text-white">Conciliação do Saldo</h2>
          </div>
          <p className="text-xs text-blue-300/60 mb-4">
            Qual é o saldo <strong>real, atual</strong>, na conta da empresa? Comparamos com o que está lançado para garantir que não há falhas ao prestar contas ao Estado.
          </p>

          <div className="grid sm:grid-cols-2 gap-4 mb-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-blue-300/70 font-semibold">Saldo inicial do período (€)</span>
              <input
                value={saldoInicialTxt}
                onChange={e => setSaldoInicialTxt(e.target.value)}
                onBlur={guardarSaldo}
                inputMode="decimal"
                placeholder="0,00"
                className="bg-[#0a0e16] border border-[#1e3a5c] rounded px-3 py-2 text-white font-mono text-sm focus:border-blue-500 outline-none"
              />
              <span className="text-[10px] text-blue-300/40">saldo bancário em 01/01/2026 · confirmado pelo balancete 2025 e extrato BPI</span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-amber-300/80 font-semibold">★ Saldo real atual na conta (€)</span>
              <input
                value={saldoRealTxt}
                onChange={e => setSaldoRealTxt(e.target.value)}
                onBlur={guardarSaldo}
                inputMode="decimal"
                placeholder="0,00"
                className="bg-[#0a0e16] border border-amber-700/50 rounded px-3 py-2 text-white font-mono text-sm focus:border-amber-500 outline-none"
              />
              <span className="text-[10px] text-blue-300/40">saldo actual no homebanking BPI{saldo.saldoRealData ? ` · lido em ${saldo.saldoRealData}` : " · ainda não preenchido"}</span>
            </label>
          </div>

          {/* Linha de conciliação */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-[#0a0e16] rounded p-3">
              <div className="text-[10px] uppercase text-blue-300/60 font-semibold">Saldo inicial</div>
              <div className="font-mono font-bold text-blue-100">{formatEur(conc.saldoInicial)}</div>
            </div>
            <div className="bg-[#0a0e16] rounded p-3">
              <div className="text-[10px] uppercase text-blue-300/60 font-semibold">+ Variação lançada</div>
              <div className="font-mono font-bold" style={{ color: corLiquido }}>{formatEur(conc.variacaoLancada)}</div>
            </div>
            <div className="bg-[#0a0e16] rounded p-3">
              <div className="text-[10px] uppercase text-blue-300/60 font-semibold">= Saldo teórico</div>
              <div className="font-mono font-bold text-blue-100">{formatEur(conc.saldoTeorico)}</div>
            </div>
            <div className="rounded p-3 border" style={{ borderColor: corDiferenca, background: "rgba(0,0,0,0.25)" }}>
              <div className="text-[10px] uppercase font-semibold" style={{ color: corDiferenca }}>Diferença (real − teórico)</div>
              <div className="font-mono font-bold text-lg" style={{ color: corDiferenca }}>{formatEur(conc.diferenca)}</div>
            </div>
          </div>

          {/* Estado da conciliação */}
          {conc.conciliado ? (
            <div className="flex items-start gap-2 bg-emerald-950/40 border border-emerald-800/50 rounded p-3 text-emerald-200 text-sm">
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-400" />
              <span>Conta conciliada: o saldo real coincide com o que está lançado. Pronto para prestar contas.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2 bg-amber-950/30 border border-amber-800/50 rounded p-3 text-amber-100 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
                <span className="font-semibold">Há uma diferença de {formatEur(Math.abs(conc.diferenca))} entre o saldo real e o lançado.</span>
              </div>
              <ul className="list-disc pl-8 space-y-1 text-amber-200/90 text-[13px]">
                {diagnostico.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}
        </section>

        {/* GRÁFICO */}
        {!semDados && (
          <section className="bg-[#141b29] border border-[#1e3a5c] rounded-lg p-5 mb-6">
            <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-blue-400" /> Evolução mensal
            </h2>
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer>
                <ComposedChart data={dadosGrafico} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5c" />
                  <XAxis dataKey="nome" tick={{ fill: "#93c5fd", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#93c5fd", fontSize: 11 }} tickFormatter={(v) => `${v}€`} />
                  <ReTooltip
                    contentStyle={{ background: "#0f2744", border: "1px solid #2563eb", borderRadius: 6, color: "#fff" }}
                    formatter={(v: any) => formatEur(Number(v))}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: "#93c5fd" }} />
                  <Bar dataKey="Entradas" fill="#10b981" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Saídas" fill="#ef4444" radius={[3, 3, 0, 0]} />
                  <Line type="monotone" dataKey="Acumulado" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        <div className="grid lg:grid-cols-2 gap-6">
          {/* TABELA MENSAL */}
          {!semDados && (
            <section className="bg-[#141b29] border border-[#1e3a5c] rounded-lg p-5">
              <h2 className="text-base font-bold text-white mb-4">Resumo por mês</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase text-blue-300/70 border-b border-[#1e3a5c]">
                      <th className="text-left py-2 font-semibold">Mês</th>
                      <th className="text-right py-2 font-semibold">Entradas</th>
                      <th className="text-right py-2 font-semibold">Saídas</th>
                      <th className="text-right py-2 font-semibold">Líquido</th>
                      <th className="text-right py-2 font-semibold">Acumulado</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {global.acumulado.map(a => {
                      const r = global.meses.find(m => m.chave === a.chave)!;
                      return (
                        <tr key={a.chave} className="border-b border-[#161e2c]">
                          <td className="py-2 capitalize text-blue-100 font-sans">{a.mes} {a.ano}{r.porClassificar > 0 && <span className="ml-1 text-amber-400" title={`${r.porClassificar} por classificar`}>●</span>}</td>
                          <td className="py-2 text-right text-emerald-300">{formatEur(r.entradas)}</td>
                          <td className="py-2 text-right text-red-300">{formatEur(r.saidas)}</td>
                          <td className="py-2 text-right" style={{ color: r.liquido >= 0 ? "#34d399" : "#f87171" }}>{formatEur(r.liquido)}</td>
                          <td className="py-2 text-right text-blue-200">{formatEur(a.acumulado)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-mono font-bold border-t-2 border-[#1e3a5c]">
                      <td className="py-2 text-blue-100 font-sans">TOTAL</td>
                      <td className="py-2 text-right text-emerald-300">{formatEur(global.entradas)}</td>
                      <td className="py-2 text-right text-red-300">{formatEur(global.saidas)}</td>
                      <td className="py-2 text-right" style={{ color: corLiquido }}>{formatEur(global.liquido)}</td>
                      <td className="py-2 text-right text-blue-200">—</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}

          {/* BREAKDOWN POR TIPO */}
          {!semDados && (
            <section className="bg-[#141b29] border border-[#1e3a5c] rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-bold text-white">Distribuição por tipo</h2>
                <button
                  onClick={() => setMostrarDirecoes(v => !v)}
                  className="flex items-center gap-1.5 text-[11px] text-blue-300 hover:text-white border border-blue-800 px-2 py-1 rounded"
                >
                  <Settings2 className="w-3.5 h-3.5" /> Direções
                </button>
              </div>

              {mostrarDirecoes && (
                <div className="mb-4 bg-[#0a0e16] rounded p-3 border border-[#1e3a5c]">
                  <p className="text-[11px] text-blue-300/60 mb-2">Define se cada tipo conta como entrada ou saída no cálculo do saldo.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {tiposTodos.map(t => (
                      <div key={t} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-blue-100 truncate">{t}</span>
                        <select
                          value={direcaoDe(t, overrides)}
                          onChange={e => alterarDirecao(t, e.target.value as Direcao)}
                          className="bg-[#141b29] border border-[#1e3a5c] rounded px-1.5 py-1 text-blue-200 text-[11px]"
                        >
                          <option value="entrada">entrada</option>
                          <option value="saida">saída</option>
                          <option value="neutro">neutro</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {tiposOrdenados.map(([t, v]) => {
                  const pct = global.entradas + global.saidas > 0 ? (v / (global.entradas + global.saidas)) * 100 : 0;
                  const dir = direcaoDe(t, overrides);
                  return (
                    <div key={t}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="flex items-center gap-1.5 text-blue-100">
                          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: corTipo(t) }} />
                          {t}
                          <span className="text-[10px] text-blue-300/40">({dir})</span>
                        </span>
                        <span className="font-mono text-blue-200">{formatEur(v)}</span>
                      </div>
                      <div className="h-2 bg-[#0a0e16] rounded overflow-hidden">
                        <div className="h-full rounded" style={{ width: `${pct}%`, background: corTipo(t) }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </main>

      {/* ───────── RELATÓRIOS IMPRIMÍVEIS ───────── */}
      {relatorio === "contabilista" && (
        <RelatorioContabilista
          empresaNome={empresaNome} empresaNif={empresaNif} empresaMorada={empresaMorada}
          global={global} conc={conc} ind={ind} data={dataHoje}
        />
      )}
      {relatorio === "conciliacao" && (
        <RelatorioConciliacao
          empresaNome={empresaNome} empresaNif={empresaNif}
          global={global} conc={conc} diagnostico={diagnostico} data={dataHoje}
        />
      )}
    </div>
  );
}

// ─── RELATÓRIO PARA O CONTABILISTA ─────────────────────────────────────
function RelatorioContabilista({ empresaNome, empresaNif, empresaMorada, global, conc, ind, data }: any) {
  return (
    <div className="area-impressao">
      <div className="rel-doc">
        <div className="rel-cab">
          <div>
            <h1>Relatório Financeiro</h1>
            <div className="rel-sub">{empresaNome} · NIF {empresaNif}</div>
            {empresaMorada && <div className="rel-sub">{empresaMorada}</div>}
          </div>
          <div className="rel-meta">
            <div>Documento para o contabilista</div>
            <div>Emitido em {data}</div>
          </div>
        </div>

        <h2>1. Resumo do período</h2>
        <table className="rel-tab">
          <tbody>
            <tr><td>Total de entradas</td><td className="num">{formatEur(global.entradas)}</td></tr>
            <tr><td>Total de saídas</td><td className="num">{formatEur(global.saidas)}</td></tr>
            <tr className="forte"><td>Resultado líquido</td><td className="num">{formatEur(global.liquido)}</td></tr>
            <tr><td>Obrigações ao Estado (Seg. Social + IVA)</td><td className="num">{formatEur(global.estado)}</td></tr>
            <tr><td>Margem</td><td className="num">{(ind.margem * 100).toFixed(1)}%</td></tr>
            <tr><td>Nº de meses acompanhados</td><td className="num">{global.meses.length}</td></tr>
            <tr><td>Nº de movimentos</td><td className="num">{global.totalMovimentos}</td></tr>
          </tbody>
        </table>

        <h2>2. Detalhe mensal</h2>
        <table className="rel-tab">
          <thead>
            <tr><th>Mês</th><th className="num">Entradas</th><th className="num">Saídas</th><th className="num">Líquido</th><th className="num">Acumulado</th></tr>
          </thead>
          <tbody>
            {global.acumulado.map((a: any) => {
              const r = global.meses.find((m: any) => m.chave === a.chave);
              return (
                <tr key={a.chave}>
                  <td style={{ textTransform: "capitalize" }}>{a.mes} {a.ano}</td>
                  <td className="num">{formatEur(r.entradas)}</td>
                  <td className="num">{formatEur(r.saidas)}</td>
                  <td className="num">{formatEur(r.liquido)}</td>
                  <td className="num">{formatEur(a.acumulado)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="forte"><td>TOTAL</td><td className="num">{formatEur(global.entradas)}</td><td className="num">{formatEur(global.saidas)}</td><td className="num">{formatEur(global.liquido)}</td><td className="num">—</td></tr>
          </tfoot>
        </table>

        <h2>3. Distribuição por tipo de movimento</h2>
        <table className="rel-tab">
          <thead><tr><th>Tipo</th><th className="num">Total</th></tr></thead>
          <tbody>
            {Object.entries(global.porTipo).filter(([t]) => t !== "—").sort((a: any, b: any) => b[1] - a[1]).map(([t, v]: any) => (
              <tr key={t}><td>{t}</td><td className="num">{formatEur(v)}</td></tr>
            ))}
          </tbody>
        </table>

        <h2>4. Conciliação bancária</h2>
        <table className="rel-tab">
          <tbody>
            <tr><td>Saldo inicial</td><td className="num">{formatEur(conc.saldoInicial)}</td></tr>
            <tr><td>Variação lançada</td><td className="num">{formatEur(conc.variacaoLancada)}</td></tr>
            <tr><td>Saldo teórico</td><td className="num">{formatEur(conc.saldoTeorico)}</td></tr>
            <tr><td>Saldo real na conta</td><td className="num">{formatEur(conc.saldoReal)}</td></tr>
            <tr className="forte"><td>Diferença</td><td className="num">{formatEur(conc.diferenca)}</td></tr>
            <tr><td>Estado</td><td className="num">{conc.conciliado ? "Conciliado" : "A regularizar"}</td></tr>
          </tbody>
        </table>

        <div className="rel-rodape">
          <div>{empresaNome} — NIF {empresaNif}</div>
          <div>Relatório gerado automaticamente pela aplicação PRESENÇOBRIGATÓRIA em {data}.</div>
        </div>
      </div>
    </div>
  );
}

// ─── RELATÓRIO DE CONCILIAÇÃO ──────────────────────────────────────────
function RelatorioConciliacao({ empresaNome, empresaNif, global, conc, diagnostico, data }: any) {
  return (
    <div className="area-impressao">
      <div className="rel-doc">
        <div className="rel-cab">
          <div>
            <h1>Relatório de Conciliação</h1>
            <div className="rel-sub">{empresaNome} · NIF {empresaNif}</div>
          </div>
          <div className="rel-meta">
            <div>Saldo real vs. lançado</div>
            <div>Emitido em {data}</div>
          </div>
        </div>

        <table className="rel-tab">
          <tbody>
            <tr><td>Saldo inicial do período</td><td className="num">{formatEur(conc.saldoInicial)}</td></tr>
            <tr><td>Total de entradas lançadas</td><td className="num">{formatEur(global.entradas)}</td></tr>
            <tr><td>Total de saídas lançadas</td><td className="num">{formatEur(global.saidas)}</td></tr>
            <tr><td>Variação líquida lançada</td><td className="num">{formatEur(conc.variacaoLancada)}</td></tr>
            <tr className="forte"><td>Saldo teórico (esperado)</td><td className="num">{formatEur(conc.saldoTeorico)}</td></tr>
            <tr className="forte"><td>Saldo real na conta</td><td className="num">{formatEur(conc.saldoReal)}</td></tr>
            <tr className="forte destaque"><td>DIFERENÇA</td><td className="num">{formatEur(conc.diferenca)}</td></tr>
          </tbody>
        </table>

        <h2>Estado</h2>
        <p className="rel-estado">
          {conc.conciliado
            ? "✓ Conta CONCILIADA. O saldo real coincide com os movimentos lançados. Não há diferenças a regularizar."
            : `⚠ Existe uma diferença de ${formatEur(Math.abs(conc.diferenca))} a regularizar antes de prestar contas.`}
        </p>

        {!conc.conciliado && diagnostico.length > 0 && (
          <>
            <h2>Possíveis causas a verificar</h2>
            <ul className="rel-lista">
              {diagnostico.map((d: string, i: number) => <li key={i}>{d}</li>)}
            </ul>
          </>
        )}

        <div className="rel-rodape">
          <div>{empresaNome} — NIF {empresaNif}</div>
          <div>Conciliação gerada em {data} pela aplicação PRESENÇOBRIGATÓRIA.</div>
        </div>
      </div>
    </div>
  );
}
