// ============================================================
// PRESENÇOBRIGATÓRIA — Gerador de Relatório de Extratos (cliente)
// Usa jsPDF (já instalado) — sem dependência de servidor
// Layout: Capa executiva + Tabela detalhada de movimentos
// ============================================================

import jsPDF from "jspdf";

export interface MovimentoRelatorio {
  data: string;
  descricao: string;
  valor: number;
  tipo: string;
  nomeFatura?: string;
  arquivoNome?: string;
  statusDoc?: string;
  ivaFatura?: number | null;
  anotacao?: string;
}

export interface TipoConfig {
  nome: string;
  cor: string;
}

export interface ConfigRelatorio {
  mes: string;
  ano: number;
  empresaNome: string;
  empresaNif: string;
  empresaMorada?: string;
  tipos: TipoConfig[];
  movimentos: MovimentoRelatorio[];
}

// ── Paleta de cores padrão ──────────────────────────────────
const COR_PADRAO: Record<string, string> = {
  "FATURA SERVIÇO": "#3b82f6",
  "FATURA":         "#3b82f6",
  "COMPRA":         "#ef4444",
  "RECIBO VERDE":   "#22c55e",
  "RECIBO":         "#06b6d4",
  "MANUT. CONTA":   "#d97706",
  "AVENÇA CONT.":   "#9333ea",
  "RECEBIMENTO":    "#10b981",
  "SEG. SOCIAL":    "#f97316",
  "IVA":            "#ec4899",
};

// ── Utilitários ─────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || "#6b7280").replace("#", "").padEnd(6, "0");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function eur(v: number): string {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function setFill(doc: jsPDF, hex: string) {
  const [r, g, b] = hexToRgb(hex);
  doc.setFillColor(r, g, b);
}

function setTextColor(doc: jsPDF, hex: string) {
  const [r, g, b] = hexToRgb(hex);
  doc.setTextColor(r, g, b);
}

function setDrawColor(doc: jsPDF, hex: string) {
  const [r, g, b] = hexToRgb(hex);
  doc.setDrawColor(r, g, b);
}

function filledRect(doc: jsPDF, x: number, y: number, w: number, h: number, hex: string) {
  setFill(doc, hex);
  doc.rect(x, y, w, h, "F");
}

function roundedRect(doc: jsPDF, x: number, y: number, w: number, h: number, hex: string, r = 2) {
  setFill(doc, hex);
  doc.roundedRect(x, y, w, h, r, r, "F");
}

function hline(doc: jsPDF, x1: number, y: number, x2: number, hex: string, lw = 0.3) {
  setDrawColor(doc, hex);
  doc.setLineWidth(lw);
  doc.line(x1, y, x2, y);
}

function boldText(doc: jsPDF, text: string, x: number, y: number, opts?: { maxWidth?: number; align?: "left" | "center" | "right" }) {
  doc.setFont("helvetica", "bold");
  if (opts?.align && opts.align !== "left") {
    doc.text(text, x, y, { align: opts.align, maxWidth: opts?.maxWidth });
  } else {
    doc.text(text, x, y, { maxWidth: opts?.maxWidth });
  }
}

function normalText(doc: jsPDF, text: string, x: number, y: number, opts?: { maxWidth?: number; align?: "left" | "center" | "right" }) {
  doc.setFont("helvetica", "normal");
  if (opts?.align && opts.align !== "left") {
    doc.text(text, x, y, { align: opts.align, maxWidth: opts?.maxWidth });
  } else {
    doc.text(text, x, y, { maxWidth: opts?.maxWidth });
  }
}

function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}

// ── Gerador principal ────────────────────────────────────────
export function gerarRelatorioExtratos(cfg: ConfigRelatorio): void {
  const { mes, ano, empresaNome, empresaNif, empresaMorada, tipos, movimentos } = cfg;

  // Mapa de cores (utilizador sobrepõe padrão)
  const corMap: Record<string, string> = { ...COR_PADRAO };
  for (const t of tipos) if (t.cor) corMap[t.nome] = t.cor;

  // Pré-cálculos
  const totalEntradas = movimentos.filter(m => m.tipo === "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
  const totalSaidas   = movimentos.filter(m => m.tipo !== "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
  const liquido       = totalEntradas - totalSaidas;
  const totalIva      = movimentos.reduce((s, m) => s + (m.ivaFatura ?? 0), 0);
  const conciliados   = movimentos.filter(m => m.statusDoc === "conciliado").length;
  const semDoc        = movimentos.filter(m => !m.statusDoc || m.statusDoc === "sem_doc").length;
  const mesLabel      = mes.charAt(0).toUpperCase() + mes.slice(1);
  const dataGeracao   = new Date().toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });

  // Distribuição por tipo
  const porTipo: Record<string, number> = {};
  for (const m of movimentos) {
    if (!m.tipo) continue;
    porTipo[m.tipo] = (porTipo[m.tipo] ?? 0) + m.valor;
  }
  const tiposOrdenados = Object.entries(porTipo).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxTipo = tiposOrdenados.length > 0 ? tiposOrdenados[0][1] : 1;

  // Paleta
  const C = {
    navy:       "#0f172a",
    navyMid:    "#1e3a5c",
    accent:     "#2563eb",
    accentAlt:  "#0ea5e9",
    green:      "#16a34a",
    greenLight: "#dcfce7",
    red:        "#dc2626",
    redLight:   "#fee2e2",
    amber:      "#d97706",
    amberLight: "#fef3c7",
    blue:       "#2563eb",
    blueLight:  "#dbeafe",
    slate50:    "#f8fafc",
    slate100:   "#f1f5f9",
    slate200:   "#e2e8f0",
    slate400:   "#94a3b8",
    slate600:   "#475569",
    slate800:   "#1e293b",
    white:      "#ffffff",
  };

  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });

  // Dimensões A4 em pontos
  const PW = 595.28;
  const PH = 841.89;
  const ML = 36;
  const MR = 36;
  const CW = PW - ML - MR;
  const FOOTER_H = 22;
  const CONTENT_BOTTOM = PH - FOOTER_H - 8;

  // ── Rodapé (chamado em cada página) ────────────────────────
  const drawFooter = (pageNum: number, totalPages: number) => {
    filledRect(doc, 0, PH - FOOTER_H, PW, FOOTER_H, C.navy);
    setTextColor(doc, C.slate400);
    doc.setFontSize(6.5);
    normalText(doc, `${empresaNome}  ·  NIF ${empresaNif}  ·  Relatório Financeiro ${mesLabel} ${ano}`, ML, PH - FOOTER_H + 14);
    normalText(doc, `Pág. ${pageNum} / ${totalPages}`, PW - MR, PH - FOOTER_H + 14, { align: "right" });
  };

  // ═══════════════════════════════════════════════════════════
  // PÁGINA 1 — CAPA EXECUTIVA
  // ═══════════════════════════════════════════════════════════

  // Barra superior navy
  filledRect(doc, 0, 0, PW, 195, C.navy);
  filledRect(doc, 0, 193, PW, 5, C.accent);
  filledRect(doc, 0, 198, PW, 2, C.accentAlt);

  // Logótipo (inicial da empresa)
  const ini = (empresaNome || "P").charAt(0).toUpperCase();
  roundedRect(doc, ML, 28, 46, 46, C.accent, 5);
  setTextColor(doc, C.white);
  doc.setFontSize(22);
  boldText(doc, ini, ML + 23, 58, { align: "center" });

  // Nome e dados da empresa
  setTextColor(doc, C.white);
  doc.setFontSize(15);
  boldText(doc, truncate(empresaNome, 55), ML + 56, 52);
  setTextColor(doc, C.slate400);
  doc.setFontSize(7.5);
  normalText(doc, `NIF ${empresaNif}  ·  ${empresaMorada ?? ""}`, ML + 56, 65);

  // Título do relatório
  setTextColor(doc, C.white);
  doc.setFontSize(26);
  boldText(doc, "RELATÓRIO FINANCEIRO", ML, 108);
  setTextColor(doc, C.accentAlt);
  doc.setFontSize(13);
  boldText(doc, `${mesLabel.toUpperCase()} ${ano}`, ML, 128);
  setTextColor(doc, C.slate400);
  doc.setFontSize(7.5);
  normalText(doc, `Gerado em ${dataGeracao}  ·  ${movimentos.length} movimentos`, ML, 145);

  // ── KPI Cards ───────────────────────────────────────────────
  const kpiY = 212;
  const kpiW = (CW - 12) / 4;
  const kpiH = 68;
  const kpis = [
    { label: "ENTRADAS",   valor: eur(totalEntradas), cor: C.green,  bg: C.greenLight,  icon: "+" },
    { label: "SAÍDAS",     valor: eur(totalSaidas),   cor: C.red,    bg: C.redLight,    icon: "-" },
    { label: "LÍQUIDO",    valor: eur(liquido),        cor: liquido >= 0 ? C.blue : C.red, bg: liquido >= 0 ? C.blueLight : C.redLight, icon: "=" },
    { label: "IVA DEDUT.", valor: eur(totalIva),       cor: C.amber,  bg: C.amberLight,  icon: "%" },
  ];

  kpis.forEach((k, i) => {
    const kx = ML + i * (kpiW + 4);
    roundedRect(doc, kx, kpiY, kpiW, kpiH, C.slate50, 3);
    // Barra colorida lateral
    filledRect(doc, kx, kpiY, 4, kpiH, k.cor);
    // Ícone badge
    roundedRect(doc, kx + kpiW - 24, kpiY + 7, 16, 16, k.bg, 2);
    setTextColor(doc, k.cor);
    doc.setFontSize(9);
    boldText(doc, k.icon, kx + kpiW - 16, kpiY + 18, { align: "center" });
    // Label
    setTextColor(doc, C.slate600);
    doc.setFontSize(6);
    boldText(doc, k.label, kx + 9, kpiY + 16);
    // Valor
    setTextColor(doc, k.cor);
    doc.setFontSize(9.5);
    boldText(doc, k.valor, kx + 9, kpiY + 32);
    // Linha inferior
    hline(doc, kx + 4, kpiY + kpiH - 1, kx + kpiW, C.slate200);
  });

  // ── Gráfico de barras por categoria ─────────────────────────
  let cy = kpiY + kpiH + 18;

  if (tiposOrdenados.length > 0) {
    setTextColor(doc, C.slate800);
    doc.setFontSize(8.5);
    boldText(doc, "DISTRIBUIÇÃO POR CATEGORIA", ML, cy);
    hline(doc, ML, cy + 5, ML + CW, C.slate200, 0.5);
    cy += 14;

    const BAR_MAX_W = CW * 0.52;
    const BAR_H = 13;
    const BAR_GAP = 5;
    const LABEL_W = 108;
    const VAL_W = 78;

    tiposOrdenados.forEach(([tipo, valor]) => {
      const corTipo = corMap[tipo] ?? "#6b7280";
      const barW = maxTipo > 0 ? (valor / maxTipo) * BAR_MAX_W : 0;
      const pct = (totalSaidas + totalEntradas) > 0
        ? ((valor / (totalSaidas + totalEntradas)) * 100).toFixed(1)
        : "0.0";

      // Label
      setTextColor(doc, C.slate800);
      doc.setFontSize(6.5);
      boldText(doc, truncate(tipo, 18), ML, cy + BAR_H - 4);

      // Barra fundo
      roundedRect(doc, ML + LABEL_W + 4, cy, BAR_MAX_W, BAR_H, C.slate100, 2);
      // Barra preenchida
      if (barW > 2) roundedRect(doc, ML + LABEL_W + 4, cy, barW, BAR_H, corTipo, 2);

      // Valor e %
      setTextColor(doc, C.slate600);
      doc.setFontSize(6.5);
      normalText(doc, eur(valor), ML + LABEL_W + BAR_MAX_W + 8, cy + BAR_H - 4);
      setTextColor(doc, C.slate400);
      doc.setFontSize(5.5);
      normalText(doc, `${pct}%`, ML + LABEL_W + BAR_MAX_W + 8, cy + BAR_H + 3);

      cy += BAR_H + BAR_GAP;
    });
    cy += 6;
  }

  // ── Bloco de conciliação ─────────────────────────────────────
  if (cy + 50 < CONTENT_BOTTOM) {
    setTextColor(doc, C.slate800);
    doc.setFontSize(8.5);
    boldText(doc, "ESTADO DA CONCILIAÇÃO DOCUMENTAL", ML, cy);
    hline(doc, ML, cy + 5, ML + CW, C.slate200, 0.5);
    cy += 14;

    const concW = (CW - 8) / 3;
    const concItems = [
      { label: "CONCILIADOS",   val: conciliados,     cor: C.green, bg: C.greenLight },
      { label: "SEM DOCUMENTO", val: semDoc,           cor: C.red,   bg: C.redLight   },
      { label: "TOTAL",         val: movimentos.length, cor: C.blue, bg: C.blueLight  },
    ];
    concItems.forEach((ci, i) => {
      const cx = ML + i * (concW + 4);
      roundedRect(doc, cx, cy, concW, 34, ci.bg, 3);
      setTextColor(doc, ci.cor);
      doc.setFontSize(17);
      boldText(doc, String(ci.val), cx + 9, cy + 20);
      doc.setFontSize(6.5);
      normalText(doc, ci.label, cx + 9, cy + 30);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // PÁGINA 2+ — TABELA DETALHADA
  // ═══════════════════════════════════════════════════════════
  doc.addPage();

  // Colunas: DATA(44) | DESC(144) | TIPO(70) | VALOR(60) | FATURA(96) | STATUS(34)
  const COL = {
    data:   ML,
    desc:   ML + 46,
    tipo:   ML + 192,
    valor:  ML + 264,
    fatura: ML + 326,
    status: ML + 424,
  };
  const COL_W = { data: 44, desc: 144, tipo: 70, valor: 60, fatura: 96, status: 34 };

  const drawPageHeader = (cont = false) => {
    filledRect(doc, 0, 0, PW, 36, C.navy);
    filledRect(doc, 0, 34, PW, 3, C.accent);
    setTextColor(doc, C.white);
    doc.setFontSize(9.5);
    boldText(doc, cont ? "DETALHE DE MOVIMENTOS (cont.)" : "DETALHE DE MOVIMENTOS", ML, 20);
    setTextColor(doc, C.slate400);
    doc.setFontSize(7);
    normalText(doc, `${mesLabel} ${ano}  ·  ${movimentos.length} movimentos`, ML, 30);
    normalText(doc, truncate(empresaNome, 45), PW - MR, 30, { align: "right" });
  };

  const drawTableHeader = (yy: number) => {
    filledRect(doc, ML, yy, CW, 15, C.navyMid);
    setTextColor(doc, C.white);
    doc.setFontSize(6);
    boldText(doc, "DATA",          COL.data,   yy + 10);
    boldText(doc, "DESCRIÇÃO",     COL.desc,   yy + 10);
    boldText(doc, "TIPO",          COL.tipo,   yy + 10);
    boldText(doc, "VALOR",         COL.valor + COL_W.valor, yy + 10, { align: "right" });
    boldText(doc, "FATURA / NOTA", COL.fatura, yy + 10);
    boldText(doc, "STATUS",        COL.status, yy + 10);
  };

  drawPageHeader(false);
  let ty = 46;
  drawTableHeader(ty);
  ty += 15;

  let rowIdx = 0;
  let pageNum = 2;

  for (const m of movimentos) {
    const hasAnotacao = !!(m.anotacao && m.anotacao.trim());
    const docNome = m.arquivoNome ?? m.nomeFatura ?? "";
    const hasIva = !!(m.ivaFatura && m.ivaFatura > 0);
    const ROW_H = 15 + (hasIva ? 8 : 0) + (hasAnotacao ? 8 : 0);

    // Nova página se necessário
    if (ty + ROW_H > CONTENT_BOTTOM) {
      drawFooter(pageNum, 0); // placeholder, actualizamos no final
      doc.addPage();
      pageNum++;
      drawPageHeader(true);
      ty = 46;
      drawTableHeader(ty);
      ty += 15;
      rowIdx = 0;
    }

    // Fundo alternado
    const bgRow = rowIdx % 2 === 0 ? C.white : C.slate50;
    filledRect(doc, ML, ty, CW, ROW_H, bgRow);
    hline(doc, ML, ty + ROW_H, ML + CW, C.slate200, 0.25);

    // Barra colorida lateral pelo tipo
    const corTipo = corMap[m.tipo] ?? "#6b7280";
    filledRect(doc, ML, ty, 3, ROW_H, corTipo);

    // DATA
    setTextColor(doc, C.slate600);
    doc.setFontSize(6.5);
    normalText(doc, m.data, COL.data + 5, ty + 10);

    // DESCRIÇÃO
    setTextColor(doc, C.slate800);
    doc.setFontSize(6.5);
    boldText(doc, truncate(m.descricao, 28), COL.desc, ty + 10);

    // TIPO badge
    if (m.tipo) {
      const [tr, tg, tb] = hexToRgb(corTipo);
      doc.setFillColor(tr, tg, tb);
      doc.setGState(new (doc as any).GState({ opacity: 0.18 }));
      doc.roundedRect(COL.tipo, ty + 3, COL_W.tipo - 4, 10, 1.5, 1.5, "F");
      doc.setGState(new (doc as any).GState({ opacity: 1 }));
      setTextColor(doc, corTipo);
      doc.setFontSize(5.5);
      boldText(doc, truncate(m.tipo, 14), COL.tipo + 2, ty + 10);
    }

    // VALOR
    const isEntrada = m.tipo === "RECEBIMENTO";
    setTextColor(doc, isEntrada ? C.green : C.red);
    doc.setFontSize(7.5);
    boldText(doc, `${isEntrada ? "+" : "-"} ${eur(m.valor)}`, COL.valor + COL_W.valor, ty + 10, { align: "right" });

    // FATURA / NOTA / IVA
    let fatY = ty + 10;
    if (docNome) {
      setTextColor(doc, C.accent);
      doc.setFontSize(6);
      normalText(doc, truncate(docNome, 20), COL.fatura, fatY);
      fatY += 8;
    }
    if (hasIva) {
      setTextColor(doc, C.amber);
      doc.setFontSize(5.5);
      normalText(doc, `IVA: ${eur(m.ivaFatura!)}`, COL.fatura, fatY);
      fatY += 8;
    }
    if (hasAnotacao && !docNome) {
      setTextColor(doc, C.amber);
      doc.setFontSize(5.5);
      doc.setFont("helvetica", "italic");
      doc.text(truncate(m.anotacao!, 22), COL.fatura, fatY);
    }
    if (!docNome && !hasAnotacao && !hasIva) {
      setTextColor(doc, C.slate400);
      doc.setFontSize(6.5);
      normalText(doc, "—", COL.fatura, ty + 10);
    }

    // STATUS badge
    const stTxt   = m.statusDoc === "conciliado" ? "OK" : m.statusDoc === "sem_doc" ? "FALTA" : hasAnotacao ? "NOTA" : "—";
    const stColor = m.statusDoc === "conciliado" ? C.green : m.statusDoc === "sem_doc" ? C.red : hasAnotacao ? C.amber : C.slate400;
    const stBg    = m.statusDoc === "conciliado" ? C.greenLight : m.statusDoc === "sem_doc" ? C.redLight : hasAnotacao ? C.amberLight : C.slate100;
    roundedRect(doc, COL.status, ty + 3, COL_W.status, 10, stBg, 2);
    setTextColor(doc, stColor);
    doc.setFontSize(5.5);
    boldText(doc, stTxt, COL.status + COL_W.status / 2, ty + 10, { align: "center" });

    ty += ROW_H;
    rowIdx++;
  }

  // ── Barra de totais final ────────────────────────────────────
  if (ty + 26 > CONTENT_BOTTOM) {
    drawFooter(pageNum, 0);
    doc.addPage();
    pageNum++;
    ty = 36;
  }
  ty += 5;
  roundedRect(doc, ML, ty, CW, 20, C.navy, 3);
  setTextColor(doc, C.white);
  doc.setFontSize(7);
  boldText(doc, `${movimentos.length} movimentos`, ML + 8, ty + 13);
  setTextColor(doc, "#86efac");
  boldText(doc, `Entradas: ${eur(totalEntradas)}`, ML + 100, ty + 13);
  setTextColor(doc, "#fca5a5");
  boldText(doc, `Saídas: ${eur(totalSaidas)}`, ML + 230, ty + 13);
  setTextColor(doc, liquido >= 0 ? "#93c5fd" : "#fca5a5");
  boldText(doc, `Líquido: ${eur(liquido)}`, ML + 355, ty + 13);

  // ── Rodapés em todas as páginas ─────────────────────────────
  const totalPaginas = doc.getNumberOfPages();
  // Página 1
  doc.setPage(1);
  drawFooter(1, totalPaginas);
  // Páginas 2+
  for (let p = 2; p <= totalPaginas; p++) {
    doc.setPage(p);
    drawFooter(p, totalPaginas);
  }

  // ── Download ─────────────────────────────────────────────────
  doc.save(`Relatorio_${mesLabel}_${ano}.pdf`);
}
