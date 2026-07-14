// ============================================================
// gerarPropostaPDF.ts
// Gera uma proposta de contrato profissional em PDF
// usando jsPDF — sem dependências externas de renderização.
// ============================================================

import jsPDF from "jspdf";

// ─── Tipos ────────────────────────────────────────────────────
export interface DadosPropostaPDF {
  // Emitente (prestador de serviço)
  nomeEmpresa: string;
  nif: string;
  morada: string;
  // Destinatário (cliente)
  nomeCliente: string;
  // Dados do contrato
  nomeContrato: string;
  dataEmissao: string;
  // Simulador
  numFuncionarios: number;
  salarioPorFuncionario: number;
  reservaPercent: number;
  proLabore: number;
  ssTaxaProLabore: number;
  encargosPatronaisAtivos: boolean;
  encargosPatronaisPercent: number;
  contabilidade: number;
  // Resultados calculados
  salarios: number;
  reserva: number;
  ssProLabore: number;
  encargosPatronais: number;
  custoTotal: number;
  // Modo normal
  modoReverso: boolean;
  margemPercent: number;
  margemEuros: number;
  valorContrato: number;
  // Modo reverso
  valorContratoReverso: number;
  viavel: boolean;
}

// ─── Paleta de cores ─────────────────────────────────────────
const COR = {
  azulEscuro:   [10,  20,  40]  as [number, number, number],
  azulMedio:    [20,  40,  80]  as [number, number, number],
  azulClaro:    [30,  58, 138]  as [number, number, number],
  verdeEscuro:  [6,   78,  59]  as [number, number, number],
  verdeMedio:   [16, 185, 129]  as [number, number, number],
  ambar:        [217,119,  6]   as [number, number, number],
  vermelho:     [220, 38,  38]  as [number, number, number],
  cinzaClaro:   [241,245,249]   as [number, number, number],
  cinzaMedio:   [203,213,225]   as [number, number, number],
  branco:       [255,255,255]   as [number, number, number],
  pretoPuro:    [0,   0,   0]   as [number, number, number],
  cinzaTexto:   [51,  65,  85]  as [number, number, number],
  cinzaSub:     [100,116,139]   as [number, number, number],
};

// ─── Formatadores ─────────────────────────────────────────────
function eur(v: number): string {
  return v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });
}
function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}
function hoje(): string {
  return new Date().toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });
}

// ─── Função principal ─────────────────────────────────────────
export function gerarPropostaPDF(d: DadosPropostaPDF): void {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210; // largura A4
  const MARGIN = 18;
  const CONTEUDO = W - MARGIN * 2;
  let y = 0;

  // ── helpers de desenho ──────────────────────────────────────
  const setFill = (cor: [number, number, number]) => doc.setFillColor(...cor);
  const setDraw = (cor: [number, number, number]) => doc.setDrawColor(...cor);
  const setFont = (size: number, style: "normal" | "bold" | "italic" = "normal", cor: [number, number, number] = COR.cinzaTexto) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", style);
    doc.setTextColor(...cor);
  };
  const rect = (x: number, yy: number, w: number, h: number, fill?: [number, number, number], draw?: [number, number, number]) => {
    if (fill) setFill(fill);
    if (draw) setDraw(draw);
    doc.rect(x, yy, w, h, fill && draw ? "FD" : fill ? "F" : "D");
  };
  const linha = (x1: number, yy: number, x2: number, cor: [number, number, number] = COR.cinzaMedio, espessura = 0.3) => {
    doc.setLineWidth(espessura);
    setDraw(cor);
    doc.line(x1, yy, x2, yy);
  };
  const texto = (t: string, x: number, yy: number, opts?: { align?: "left" | "center" | "right"; maxWidth?: number }) => {
    doc.text(t, x, yy, opts as Parameters<typeof doc.text>[3]);
  };

  // ══════════════════════════════════════════════════════════════
  // CABEÇALHO — barra azul escura com logo/nome
  // ══════════════════════════════════════════════════════════════
  rect(0, 0, W, 38, COR.azulEscuro);

  // Nome da empresa emitente
  setFont(16, "bold", COR.branco);
  texto(d.nomeEmpresa, MARGIN, 14);

  // NIF + morada
  setFont(8, "normal", COR.cinzaMedio);
  texto(`NIF ${d.nif}  ·  ${d.morada}`, MARGIN, 20);

  // Título do documento
  setFont(11, "bold", COR.verdeMedio);
  texto("PROPOSTA DE PRESTAÇÃO DE SERVIÇOS", MARGIN, 30);

  // Data + nº proposta (canto direito)
  setFont(8, "normal", COR.cinzaMedio);
  texto(`Emitido em: ${d.dataEmissao || hoje()}`, W - MARGIN, 14, { align: "right" });
  setFont(8, "bold", COR.branco);
  texto(`Ref.: PROP-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`, W - MARGIN, 20, { align: "right" });

  y = 46;

  // ══════════════════════════════════════════════════════════════
  // BLOCO: Destinatário + Objecto do contrato
  // ══════════════════════════════════════════════════════════════
  // Caixa cinza clara
  rect(MARGIN, y, CONTEUDO, 22, COR.cinzaClaro);
  setFont(7, "bold", COR.cinzaSub);
  texto("DESTINATÁRIO", MARGIN + 4, y + 6);
  setFont(11, "bold", COR.azulEscuro);
  texto(d.nomeCliente || "—", MARGIN + 4, y + 13);
  setFont(8, "normal", COR.cinzaTexto);
  texto(`Objecto: ${d.nomeContrato || "Serviços de Portaria e Segurança"}`, MARGIN + 4, y + 19);
  y += 28;

  // ══════════════════════════════════════════════════════════════
  // SECÇÃO 1 — Estrutura de Custos Operacionais
  // ══════════════════════════════════════════════════════════════
  setFont(9, "bold", COR.azulClaro);
  texto("1. ESTRUTURA DE CUSTOS OPERACIONAIS MENSAIS", MARGIN, y);
  linha(MARGIN, y + 2, W - MARGIN, COR.azulClaro, 0.5);
  y += 8;

  // Cabeçalho da tabela
  rect(MARGIN, y, CONTEUDO, 7, COR.azulMedio);
  setFont(8, "bold", COR.branco);
  texto("Rubrica", MARGIN + 4, y + 5);
  texto("Detalhe", MARGIN + 90, y + 5);
  texto("Valor (€)", W - MARGIN - 4, y + 5, { align: "right" });
  y += 7;

  // Linhas da tabela
  type LinhaTabela = { label: string; detalhe: string; valor: number; destaque?: boolean };
  const linhasTabela: LinhaTabela[] = [
    {
      label: "Salários brutos",
      detalhe: `${d.numFuncionarios} func. × ${eur(d.salarioPorFuncionario)}`,
      valor: d.salarios,
    },
    {
      label: `Reserva de fim de ano (${pct(d.reservaPercent)})`,
      detalhe: "Subsídio de Natal e férias",
      valor: d.reserva,
    },
    {
      label: "Pró-labore (gestão)",
      detalhe: "Remuneração da gerência",
      valor: d.proLabore,
    },
    {
      label: `Seg. Social — pró-labore (${pct(d.ssTaxaProLabore)})`,
      detalhe: "Contribuição obrigatória",
      valor: d.ssProLabore,
    },
    ...(d.encargosPatronaisAtivos ? [{
      label: `Encargos patronais (${pct(d.encargosPatronaisPercent)})`,
      detalhe: "Sobre salários brutos",
      valor: d.encargosPatronais,
    }] : []),
    {
      label: "Contabilidade",
      detalhe: "Serviços contabilísticos mensais",
      valor: d.contabilidade,
    },
  ];

  linhasTabela.forEach((row, i) => {
    const bg: [number, number, number] = i % 2 === 0 ? COR.branco : COR.cinzaClaro;
    rect(MARGIN, y, CONTEUDO, 8, bg);
    setFont(8, "normal", COR.cinzaTexto);
    texto(row.label, MARGIN + 4, y + 5.5);
    setFont(7.5, "normal", COR.cinzaSub);
    texto(row.detalhe, MARGIN + 90, y + 5.5);
    setFont(8, "bold", COR.azulEscuro);
    texto(eur(row.valor), W - MARGIN - 4, y + 5.5, { align: "right" });
    y += 8;
  });

  // Linha de total
  rect(MARGIN, y, CONTEUDO, 9, COR.azulEscuro);
  setFont(9, "bold", COR.branco);
  texto("CUSTO TOTAL OPERACIONAL MENSAL", MARGIN + 4, y + 6);
  texto(eur(d.custoTotal), W - MARGIN - 4, y + 6, { align: "right" });
  y += 15;

  // ══════════════════════════════════════════════════════════════
  // SECÇÃO 2 — Proposta de Valor / Análise de Viabilidade
  // ══════════════════════════════════════════════════════════════
  setFont(9, "bold", COR.azulClaro);
  texto("2. PROPOSTA DE VALOR DO CONTRATO", MARGIN, y);
  linha(MARGIN, y + 2, W - MARGIN, COR.azulClaro, 0.5);
  y += 10;

  if (!d.modoReverso) {
    // ── Modo Normal: proposta calculada ──────────────────────
    // Caixa verde com valor proposto
    rect(MARGIN, y, CONTEUDO, 28, COR.verdeEscuro);
    setFont(8, "bold", COR.verdeMedio);
    texto("VALOR MENSAL PROPOSTO (excl. IVA)", MARGIN + 4, y + 7);
    setFont(22, "bold", COR.branco);
    texto(eur(d.valorContrato), W / 2, y + 20, { align: "center" });
    y += 33;

    // Grid de detalhe: margem + IVA + anual
    const colW = CONTEUDO / 3;
    const itens = [
      { label: "Margem de lucro", valor: pct(d.margemPercent), sub: eur(d.margemEuros) + "/mês", cor: COR.verdeMedio },
      { label: "Valor com IVA 23%", valor: eur(d.valorContrato * 1.23), sub: "Valor a facturar", cor: COR.ambar },
      { label: "Valor anual (excl. IVA)", valor: eur(d.valorContrato * 12), sub: "12 × mensalidade", cor: COR.azulClaro },
    ];
    itens.forEach((item, i) => {
      const cx = MARGIN + i * colW;
      rect(cx, y, colW - 2, 20, COR.cinzaClaro);
      setFont(7, "bold", COR.cinzaSub);
      texto(item.label.toUpperCase(), cx + 4, y + 6);
      setFont(10, "bold", item.cor);
      texto(item.valor, cx + 4, y + 13);
      setFont(7, "normal", COR.cinzaSub);
      texto(item.sub, cx + 4, y + 18);
    });
    y += 26;

  } else {
    // ── Modo Reverso: análise do valor proposto pelo cliente ──
    const corPrincipal = d.viavel ? COR.verdeEscuro : [100, 0, 0] as [number, number, number];
    const corTexto = d.viavel ? COR.verdeMedio : COR.vermelho;

    rect(MARGIN, y, CONTEUDO, 28, corPrincipal);
    setFont(8, "bold", corTexto);
    texto(d.viavel ? "ANÁLISE DE VIABILIDADE — CONTRATO PROPOSTO PELO CLIENTE" : "⚠ ATENÇÃO — CONTRATO ABAIXO DO CUSTO OPERACIONAL", MARGIN + 4, y + 7);
    setFont(22, "bold", COR.branco);
    texto(eur(d.valorContratoReverso), W / 2, y + 20, { align: "center" });
    y += 33;

    // Grid: margem % + lucro € + IVA
    const colW = CONTEUDO / 3;
    const corMargem: [number, number, number] = d.viavel ? COR.verdeMedio : COR.vermelho;
    const itens = [
      { label: "Margem resultante", valor: pct(d.margemPercent), sub: d.viavel ? "Viável" : "Inviável", cor: corMargem },
      { label: d.viavel ? "Lucro mensal" : "Prejuízo mensal", valor: eur(Math.abs(d.margemEuros)), sub: d.viavel ? "Após todos os custos" : "Abaixo do custo", cor: corMargem },
      { label: "Valor com IVA 23%", valor: eur(d.valorContratoReverso * 1.23), sub: "Valor a facturar", cor: COR.ambar },
    ];
    itens.forEach((item, i) => {
      const cx = MARGIN + i * colW;
      rect(cx, y, colW - 2, 20, COR.cinzaClaro);
      setFont(7, "bold", COR.cinzaSub);
      texto(item.label.toUpperCase(), cx + 4, y + 6);
      setFont(10, "bold", item.cor);
      texto(item.valor, cx + 4, y + 13);
      setFont(7, "normal", COR.cinzaSub);
      texto(item.sub, cx + 4, y + 18);
    });
    y += 26;

    // Barra de viabilidade
    setFont(7.5, "bold", COR.cinzaSub);
    texto("DISTRIBUIÇÃO DO VALOR DO CONTRATO", MARGIN, y + 4);
    y += 7;
    const barW = CONTEUDO;
    const pctCusto = d.valorContratoReverso > 0 ? Math.min(1, d.custoTotal / d.valorContratoReverso) : 1;
    rect(MARGIN, y, barW, 6, COR.cinzaClaro);
    const corBarra: [number, number, number] = d.viavel ? COR.ambar : COR.vermelho;
    rect(MARGIN, y, barW * pctCusto, 6, corBarra);
    setFont(7, "normal", COR.cinzaTexto);
    texto(`Custos: ${pct(pctCusto * 100)}`, MARGIN + 2, y + 4.5);
    if (d.viavel) {
      texto(`Lucro: ${pct((1 - pctCusto) * 100)}`, W - MARGIN - 2, y + 4.5, { align: "right" });
    }
    y += 12;
  }

  // ══════════════════════════════════════════════════════════════
  // SECÇÃO 3 — Condições e Notas
  // ══════════════════════════════════════════════════════════════
  // Verificar se precisa de nova página
  if (y > 230) { doc.addPage(); y = 20; }

  setFont(9, "bold", COR.azulClaro);
  texto("3. CONDIÇÕES E NOTAS", MARGIN, y);
  linha(MARGIN, y + 2, W - MARGIN, COR.azulClaro, 0.5);
  y += 10;

  const notas = [
    "Os valores apresentados são mensais e referem-se ao período de vigência do contrato.",
    "O valor do contrato não inclui IVA (taxa de 23% aplicável nos termos legais).",
    "A reserva de fim de ano destina-se exclusivamente ao pagamento de subsídios de Natal e férias.",
    "Os encargos com Segurança Social do pró-labore são da responsabilidade da empresa prestadora.",
    "Esta proposta tem validade de 30 dias a contar da data de emissão.",
    "Qualquer alteração ao número de funcionários ou condições de serviço implica revisão dos valores.",
  ];

  notas.forEach((nota, i) => {
    setFont(8, "normal", COR.cinzaTexto);
    texto(`${i + 1}.  ${nota}`, MARGIN + 2, y);
    y += 6;
  });

  y += 4;

  // ══════════════════════════════════════════════════════════════
  // RODAPÉ — linha + dados legais
  // ══════════════════════════════════════════════════════════════
  const RODAPE_Y = 282;
  linha(MARGIN, RODAPE_Y - 4, W - MARGIN, COR.azulMedio, 0.5);

  setFont(7, "normal", COR.cinzaSub);
  texto(d.nomeEmpresa, MARGIN, RODAPE_Y);
  texto(`NIF ${d.nif}  ·  ${d.morada}`, MARGIN, RODAPE_Y + 4);

  setFont(7, "italic", COR.cinzaSub);
  texto("Documento gerado automaticamente — PRESENÇOBRIGATÓRIA Sistema de Gestão", W / 2, RODAPE_Y, { align: "center" });
  texto(hoje(), W - MARGIN, RODAPE_Y, { align: "right" });

  // ── Guardar ──────────────────────────────────────────────────
  const nomeArquivo = `Proposta_${(d.nomeContrato || "Contrato").replace(/\s+/g, "_")}_${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}.pdf`;
  doc.save(nomeArquivo);
}
