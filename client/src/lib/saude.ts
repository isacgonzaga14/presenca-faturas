// ============================================================
// PRESENÇOBRIGATÓRIA — Lógica de Saúde Financeira da Empresa
// Análise sóbria: entradas/saídas, obrigações ao Estado e
// conciliação do saldo real vs. o que está lançado.
//
// Nota crítica: os movimentos guardam SEMPRE o valor em
// absoluto (Math.abs no parser). A direção (entrada/saída) é
// inferida pelo TIPO do movimento. Por decisão de negócio:
//   - RECEBIMENTO        → entrada (dinheiro que ENTRA)
//   - tudo o resto        → saída   (dinheiro que SAI)
//   - FATURA SERVIÇO/INST → saída (transferências, variáveis)
//   - ""  (por classificar) → neutro (não entra no cálculo, mas
//                             é sinalizado por afetar a fiabilidade)
// A direção é configurável por tipo na própria página.
// ============================================================

import { Movimento } from "./faturas";

export type Direcao = "entrada" | "saida" | "neutro";

// Mapa de direção padrão por tipo de movimento.
export const DIRECAO_PADRAO: Record<string, Direcao> = {
  "RECEBIMENTO": "entrada",
  "FATURA SERVIÇO": "saida",
  "FATURA": "saida",
  "COMPRA": "saida",
  "RECIBO VERDE": "saida",
  "RECIBO": "saida",
  "MANUT. CONTA": "saida",
  "AVENÇA CONT.": "saida",
  "SEG. SOCIAL": "saida",
  "IVA": "saida",
  "": "neutro",
};

// Tipos que representam obrigações ao Estado / Segurança Social.
export const TIPOS_ESTADO = ["SEG. SOCIAL", "IVA"];

export const MESES_ORDEM = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export interface EstadoMes {
  mes: string;
  ano: number;
  movimentos: Movimento[];
  docGerado: string;
  finalizado: boolean;
}

// Direção efetiva de um tipo, considerando overrides do utilizador.
export function direcaoDe(
  tipo: string,
  overrides?: Record<string, Direcao>,
): Direcao {
  if (overrides && overrides[tipo]) return overrides[tipo];
  if (tipo in DIRECAO_PADRAO) return DIRECAO_PADRAO[tipo];
  // Tipo personalizado desconhecido: por prudência conta como saída.
  return "saida";
}

// Valor com sinal de acordo com a direção (entrada +, saída −, neutro 0).
export function valorComSinal(
  mov: Movimento,
  overrides?: Record<string, Direcao>,
): number {
  const dir = direcaoDe(mov.tipo, overrides);
  if (dir === "entrada") return Math.abs(mov.valor);
  if (dir === "saida") return -Math.abs(mov.valor);
  return 0;
}

export interface ResumoMes {
  mes: string;
  ano: number;
  chave: string;
  entradas: number;
  saidas: number;
  liquido: number;
  estado: number;
  porClassificar: number;
  semDocumento: number;
  finalizado: boolean;
}

export interface ResumoGlobal {
  meses: ResumoMes[];
  entradas: number;
  saidas: number;
  liquido: number;
  estado: number;
  porTipo: Record<string, number>;
  totalMovimentos: number;
  porClassificar: number;
  semDocumento: number;
  acumulado: { mes: string; ano: number; chave: string; acumulado: number }[];
}

export function resumoGlobal(
  meses: EstadoMes[],
  overrides?: Record<string, Direcao>,
): ResumoGlobal {
  // Ordenar meses cronologicamente
  const ordenados = [...meses].sort((a, b) => {
    if (a.ano !== b.ano) return a.ano - b.ano;
    return MESES_ORDEM.indexOf(a.mes) - MESES_ORDEM.indexOf(b.mes);
  });

  const resumosMes: ResumoMes[] = ordenados.map(m => {
    let entradas = 0, saidas = 0, estado = 0;
    let porClassificar = 0, semDocumento = 0;
    const movs = m.movimentos ?? [];

    for (const mov of movs) {
      const dir = direcaoDe(mov.tipo, overrides);
      const abs = Math.abs(mov.valor);
      if (dir === "entrada") entradas += abs;
      else if (dir === "saida") saidas += abs;
      if (!mov.tipo) porClassificar++;
      if (TIPOS_ESTADO.includes(mov.tipo)) estado += abs;
      if (mov.statusDoc === "sem_doc" && dir === "saida") semDocumento++;
    }

    return {
      mes: m.mes,
      ano: m.ano,
      chave: `${m.mes}-${m.ano}`,
      entradas,
      saidas,
      liquido: entradas - saidas,
      estado,
      porClassificar,
      semDocumento,
      finalizado: m.finalizado,
    };
  });

  // Totais globais
  let gEntradas = 0, gSaidas = 0, gEstado = 0, gPorClassificar = 0, gSemDoc = 0;
  const porTipo: Record<string, number> = {};
  let totalMovimentos = 0;

  for (const m of ordenados) {
    const movs = m.movimentos ?? [];
    totalMovimentos += movs.length;
    for (const mov of movs) {
      const dir = direcaoDe(mov.tipo, overrides);
      const abs = Math.abs(mov.valor);
      if (dir === "entrada") gEntradas += abs;
      else if (dir === "saida") gSaidas += abs;
      if (!mov.tipo) gPorClassificar++;
      if (TIPOS_ESTADO.includes(mov.tipo)) gEstado += abs;
      if (mov.statusDoc === "sem_doc" && dir === "saida") gSemDoc++;
      const tipoKey = mov.tipo || "—";
      porTipo[tipoKey] = (porTipo[tipoKey] ?? 0) + abs;
    }
  }

  // Acumulado cronológico
  let acc = 0;
  const acumulado = resumosMes.map(r => {
    acc += r.liquido;
    return { mes: r.mes, ano: r.ano, chave: r.chave, acumulado: acc };
  });

  return {
    meses: resumosMes,
    entradas: gEntradas,
    saidas: gSaidas,
    liquido: gEntradas - gSaidas,
    estado: gEstado,
    porTipo,
    totalMovimentos,
    porClassificar: gPorClassificar,
    semDocumento: gSemDoc,
    acumulado,
  };
}

// ─── Conciliação do saldo ─────────────────────────────────────────────
export interface DadosSaldo {
  saldoInicial: number;
  saldoInicialData: string;
  saldoReal: number;
  saldoRealData: string;
}

export interface ResultadoConciliacao {
  saldoInicial: number;
  variacaoLancada: number;
  saldoTeorico: number;
  saldoReal: number;
  diferenca: number;
  conciliado: boolean;
}

export function conciliar(
  global: ResumoGlobal,
  saldo: DadosSaldo,
): ResultadoConciliacao {
  const saldoInicial = saldo.saldoInicial ?? 0;
  const variacaoLancada = global.liquido;
  const saldoTeorico = saldoInicial + variacaoLancada;
  const saldoReal = saldo.saldoReal ?? 0;
  const diferenca = saldoReal - saldoTeorico;
  return {
    saldoInicial,
    variacaoLancada,
    saldoTeorico,
    saldoReal,
    diferenca,
    conciliado: Math.abs(diferenca) < 0.02,
  };
}

export function diagnosticarDiferenca(
  conc: ResultadoConciliacao,
  global: ResumoGlobal,
): string[] {
  if (conc.conciliado) return [];
  const avisos: string[] = [];

  const sentido = conc.diferenca > 0
    ? "O saldo real é MAIOR do que o lançado — há entradas por registar (ou saídas registadas a mais)."
    : "O saldo real é MENOR do que o lançado — há saídas por registar (ou entradas registadas a mais).";
  avisos.push(sentido);

  if (global.porClassificar > 0) {
    avisos.push(`${global.porClassificar} movimento(s) ainda sem tipo definido — não entram no cálculo e podem explicar a diferença.`);
  }
  const mesesAbertos = global.meses.filter(m => !m.finalizado).length;
  if (mesesAbertos > 0) {
    avisos.push(`${mesesAbertos} mês(es) ainda não finalizado(s) — confirme que todos os movimentos foram importados.`);
  }
  if (global.semDocumento > 0) {
    avisos.push(`${global.semDocumento} saída(s) sem documento anexado — reveja a conciliação documental.`);
  }
  avisos.push("Confirme também o saldo inicial introduzido e se o período cobre todos os movimentos desde essa data.");
  return avisos;
}

// ─── Indicadores de saúde ─────────────────────────────────────────────
export interface Indicadores {
  margem: number;             // liquido / entradas (0 se sem entradas)
  pesoEstado: number;         // estado / saidas
  rácioCobertura: number;     // entradas / saidas
}

export function indicadores(global: ResumoGlobal): Indicadores {
  return {
    margem: global.entradas > 0 ? global.liquido / global.entradas : 0,
    pesoEstado: global.saidas > 0 ? global.estado / global.saidas : 0,
    rácioCobertura: global.saidas > 0 ? global.entradas / global.saidas : 0,
  };
}

export function nomeMesCapitalizado(mes: string): string {
  return mes.charAt(0).toUpperCase() + mes.slice(1);
}
