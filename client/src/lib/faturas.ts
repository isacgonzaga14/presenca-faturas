// ============================================================
// PRESENÇOBRIGATÓRIA — Lógica de Faturas
// Corporate Brutalism: dados em primeiro lugar, zero ornamento
// ============================================================

export type TipoMovimento =
  | "GERAR FATURA"
  | "RECIBO VERDE"
  | "RECIBO"
  | "FATURA COMPRA"
  | "MANUTENÇÃO DE CONTA"
  | "PAGAMENTO AO ESTADO"
  | "AVENÇA CONTAB"
  | "SEGURO BANCARIO"
  | "RECIBO SALARIO"
  | "";

export interface Movimento {
  id: string;
  data: string;
  descricao: string;
  valor: number;
  tipo: TipoMovimento;
  descricaoFatura: string;
  nomeFatura: string;
  inst?: string;
}

export const TIPOS: TipoMovimento[] = [
  "GERAR FATURA",
  "RECIBO VERDE",
  "RECIBO",
  "FATURA COMPRA",
  "MANUTENÇÃO DE CONTA",
  "PAGAMENTO AO ESTADO",
  "AVENÇA CONTAB",
  "SEGURO BANCARIO",
  "RECIBO SALARIO",
];

export const TIPO_ROW_CLASS: Record<TipoMovimento, string> = {
  "GERAR FATURA":        "row-fatura",
  "RECIBO VERDE":        "row-recibo-verde",
  "RECIBO":              "row-recibo",
  "FATURA COMPRA":       "row-compra",
  "MANUTENÇÃO DE CONTA": "row-manutencao",
  "PAGAMENTO AO ESTADO": "row-estado",
  "AVENÇA CONTAB":       "row-avenca",
  "SEGURO BANCARIO":     "row-seguro",
  "RECIBO SALARIO":      "row-salario",
  "":                    "",
};

export const TIPO_BADGE_CLASS: Record<TipoMovimento, string> = {
  "GERAR FATURA":        "badge-fatura",
  "RECIBO VERDE":        "badge-recibo-verde",
  "RECIBO":              "badge-recibo",
  "FATURA COMPRA":       "badge-compra",
  "MANUTENÇÃO DE CONTA": "badge-manutencao",
  "PAGAMENTO AO ESTADO": "badge-estado",
  "AVENÇA CONTAB":       "badge-avenca",
  "SEGURO BANCARIO":     "badge-seguro",
  "RECIBO SALARIO":      "badge-salario",
  "":                    "",
};

// Mês anterior
export function mesAnterior(mes: string): string {
  const idx = [
    "janeiro","fevereiro","março","abril","maio","junho",
    "julho","agosto","setembro","outubro","novembro","dezembro"
  ].indexOf(mes.toLowerCase());
  if (idx <= 0) return "dezembro";
  return ["janeiro","fevereiro","março","abril","maio","junho",
    "julho","agosto","setembro","outubro","novembro","dezembro"][idx - 1];
}

// Clientes por nome
const LX_LIVING  = ["jacqueline", "juciclecio", "diogo"];
const MARVILA    = ["maria", "zito", "eliane", "wilson"];

export function extrairInst(desc: string): string | null {
  const m = desc.match(/INST\s+(\d+)/i);
  return m ? m[1] : null;
}

export function extrairNome(desc: string): string {
  const m = desc.match(/PT\d{23}\s+(.+)/i);
  return m ? m[1].trim() : "";
}

export function clientePorNome(nome: string): string {
  const n = nome.toLowerCase();
  if (LX_LIVING.some(k => n.includes(k))) return "Lx Living";
  if (MARVILA.some(k => n.includes(k))) return "8 Marvila";
  return "";
}

// mesRef = mês de referência do serviço (já calculado externamente)
export function gerarDescricao(desc: string, tipo: TipoMovimento, mesRef: string, valor: number): string {
  const inst = extrairInst(desc);
  if (!inst) return "";
  const nome = extrairNome(desc);
  const cliente = clientePorNome(nome);
  const clienteStr = cliente ? ` ao ${cliente},` : "";
  const numerario = valor > 1800 ? " Pagamentos em numerario." : "";

  switch (tipo) {
    case "GERAR FATURA":
      return `Serviço prestado no mês de ${mesRef}${clienteStr} como porteiro em eventos e festas privadas (INST ${inst}).${numerario}`;
    case "RECIBO VERDE":
      return `Recibo verde — Serviço prestado no mês de ${mesRef}${clienteStr} (INST ${inst}).`;
    case "RECIBO":
      return `Recibo — Serviço prestado no mês de ${mesRef} (INST ${inst}).`;
    case "FATURA COMPRA":
      return `Fatura de compra referente ao mês de ${mesRef} (INST ${inst}).`;
    default:
      return "";
  }
}

export function calcularValorBase(valor: number): number {
  return valor / 1.23;
}

export function formatEur(valor: number): string {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(valor);
}

export function totalPorTipo(movimentos: Movimento[], tipo: TipoMovimento): number {
  return movimentos
    .filter(m => m.tipo === tipo)
    .reduce((sum, m) => sum + m.valor, 0);
}

// Parsear linha do extrato BPI
export function parsearLinhaExtrato(linha: string, idx: number): Movimento | null {
  // Formato esperado: data \t descrição \t valor
  const partes = linha.split(/\t/);
  if (partes.length < 3) return null;
  const data = partes[0].trim();
  const descricao = partes[1].trim();
  const valorStr = partes[2].trim().replace(/\./g, "").replace(",", ".");
  const valor = Math.abs(parseFloat(valorStr));
  if (isNaN(valor)) return null;
  const inst = extrairInst(descricao);
  return {
    id: `mov-${idx}`,
    data,
    descricao,
    valor,
    tipo: "",
    descricaoFatura: "",
    nomeFatura: "",
    inst: inst ?? undefined,
  };
}

// Parsear CSV/TSV do extrato BPI xlsx exportado como texto
export function parsearExtrato(texto: string): Movimento[] {
  const linhas = texto.split("\n").map(l => l.trim()).filter(Boolean);
  const movimentos: Movimento[] = [];
  let idx = 0;
  for (const linha of linhas) {
    const mov = parsearLinhaExtrato(linha, idx);
    if (mov) { movimentos.push(mov); idx++; }
  }
  return movimentos;
}

// Gerar texto final para WhatsApp/fatura
export function gerarDocumentoFinal(
  movimentos: Movimento[],
  mes: string,
  empresa = {
    nome: "PRESENÇOBRIGATÓRIA - UNIPESSOAL LDA",
    nif: "518604870",
    morada: "Rua Miguel Pais, Nº 46, 1º F, Barreiro, 2830-356, Portugal",
  }
): string {
  const selecionados = movimentos.filter(m => m.tipo === "GERAR FATURA");
  if (selecionados.length === 0) return "";

  // Mês de referência = mês anterior ao mês do extrato (igual à tabela)
  const mesRef = mesAnterior(mes);

  // Agrupar por nome (extrairNome)
  const grupos: Record<string, Movimento[]> = {};
  for (const m of selecionados) {
    const nome = extrairNome(m.descricao) || m.descricao.slice(0, 20);
    if (!grupos[nome]) grupos[nome] = [];
    grupos[nome].push(m);
  }

  const totalGeral = selecionados.reduce((s, m) => s + m.valor, 0);
  const totalBase = calcularValorBase(totalGeral);
  const dez = totalBase * 0.1;

  let doc = "";
  doc += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  doc += `📋 FATURAS — ${mes.toUpperCase()}\n`;
  doc += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  doc += `📊 Resumo\n`;
  doc += `Total (c/ IVA): ${formatEur(totalGeral)}\n`;
  doc += `Valor base:     ${formatEur(totalBase)}\n`;
  doc += `10% do base:    ${formatEur(dez)}\n\n`;
  doc += `──────────────────────────────\n\n`;

  let fatNum = 1;
  for (const [, movs] of Object.entries(grupos)) {
    const totalGrupo = movs.reduce((s, m) => s + m.valor, 0);
    const baseGrupo = calcularValorBase(totalGrupo);
    const desc = gerarDescricao(movs[0].descricao, "GERAR FATURA", mesRef, totalGrupo);

    doc += `📄 Fatura ${fatNum}\n`;
    doc += `${desc}\n`;
    doc += `Valor base: ${formatEur(baseGrupo)} (+ IVA) = ${formatEur(totalGrupo)}\n\n`;
    fatNum++;
  }

  doc += `──────────────────────────────\n`;
  doc += `${empresa.nome}\n`;
  doc += `NIF: ${empresa.nif}\n`;
  doc += `${empresa.morada}\n`;

  return doc;
}
