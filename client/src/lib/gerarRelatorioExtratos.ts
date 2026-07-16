// ============================================================
// PRESENÇOBRIGATÓRIA — Gerador de Relatório de Extratos (cliente)
// Usa jsPDF — geração 100% no browser, sem dependência de servidor
// Layout: Cabeçalho executivo + Tabela detalhada (sem capa)
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

// ── Paleta padrão ────────────────────────────────────────────
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

function boldText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  opts?: { maxWidth?: number; align?: "left" | "center" | "right" }
) {
  doc.setFont("helvetica", "bold");
  const align = opts?.align;
  if (align && align !== "left") {
    doc.text(text, x, y, { align, maxWidth: opts?.maxWidth });
  } else {
    doc.text(text, x, y, { maxWidth: opts?.maxWidth });
  }
}

function normalText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  opts?: { maxWidth?: number; align?: "left" | "center" | "right" }
) {
  doc.setFont("helvetica", "normal");
  const align = opts?.align;
  if (align && align !== "left") {
    doc.text(text, x, y, { align, maxWidth: opts?.maxWidth });
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
    slate300:   "#cbd5e1",
    slate400:   "#94a3b8",
    slate600:   "#475569",
    slate700:   "#334155",
    slate800:   "#1e293b",
    white:      "#ffffff",
  };

  // ── Dimensões A4 — margens reduzidas ────────────────────────
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const PW = 595.28;
  const PH = 841.89;
  const ML = 18;          // margem esquerda reduzida (era 36)
  const MR = 18;          // margem direita reduzida
  const CW = PW - ML - MR;
  const FOOTER_H = 20;
  const CONTENT_BOTTOM = PH - FOOTER_H - 6;

  // ── Colunas da tabela (A4 landscape-like aproveitamento) ────
  // DATA(52) | DESC(168) | TIPO(82) | VALOR(72) | FATURA(108) | STATUS(40)
  // Total = 52+168+82+72+108+40 = 522 ≈ CW(559) — gap de 37 distribuído
  const COL = {
    data:   ML,
    desc:   ML + 54,
    tipo:   ML + 224,
    valor:  ML + 308,
    fatura: ML + 382,
    status: ML + 498,
  };
  const COL_W = {
    data:   52,
    desc:   168,
    tipo:   82,
    valor:  72,
    fatura: 114,
    status: 40,
  };

  // ── Cabeçalho da página (repetido em cada nova página) ──────
  const HEADER_H = 80; // altura total do bloco de cabeçalho

  const drawPageHeader = (pageNum: number, isFirst: boolean) => {
    // Barra navy principal
    filledRect(doc, 0, 0, PW, 52, C.navy);
    // Linha de acento
    filledRect(doc, 0, 50, PW, 3, C.accent);
    filledRect(doc, 0, 53, PW, 1, C.accentAlt);

    // Inicial da empresa (badge)
    const ini = (empresaNome || "P").charAt(0).toUpperCase();
    roundedRect(doc, ML, 8, 36, 36, C.accent, 4);
    setTextColor(doc, C.white);
    doc.setFontSize(17);
    boldText(doc, ini, ML + 18, 31, { align: "center" });

    // Nome e NIF
    setTextColor(doc, C.white);
    doc.setFontSize(11);
    boldText(doc, truncate(empresaNome, 50), ML + 44, 24);
    setTextColor(doc, C.slate400);
    doc.setFontSize(7.5);
    normalText(doc, `NIF ${empresaNif}  ·  ${empresaMorada ?? ""}`, ML + 44, 36);

    // Título do relatório (direita)
    setTextColor(doc, C.white);
    doc.setFontSize(13);
    boldText(doc, `RELATÓRIO FINANCEIRO — ${mesLabel.toUpperCase()} ${ano}`, PW - MR, 22, { align: "right" });
    setTextColor(doc, C.slate400);
    doc.setFontSize(7.5);
    normalText(doc, `Gerado em ${dataGeracao}  ·  ${movimentos.length} movimentos`, PW - MR, 35, { align: "right" });
    if (!isFirst) {
      setTextColor(doc, C.accentAlt);
      doc.setFontSize(7);
      normalText(doc, `(continuação — pág. ${pageNum})`, PW - MR, 46, { align: "right" });
    }

    // ── KPI strip abaixo do navy ─────────────────────────────
    filledRect(doc, 0, 54, PW, 26, C.slate50);
    hline(doc, 0, 80, PW, C.slate200, 0.5);

    const kpis = [
      { label: "ENTRADAS",   valor: eur(totalEntradas), cor: C.green },
      { label: "SAÍDAS",     valor: eur(totalSaidas),   cor: C.red   },
      { label: "LÍQUIDO",    valor: eur(liquido),        cor: liquido >= 0 ? C.blue : C.red },
      { label: "IVA DEDUT.", valor: eur(totalIva),       cor: C.amber },
      { label: "CONCILIADOS", valor: `${conciliados} / ${movimentos.length}`, cor: C.green },
      { label: "SEM DOC.",   valor: String(semDoc),      cor: semDoc > 0 ? C.red : C.slate400 },
    ];

    const kpiW = CW / kpis.length;
    kpis.forEach((k, i) => {
      const kx = ML + i * kpiW;
      // Separador vertical
      if (i > 0) {
        setDrawColor(doc, C.slate200);
        doc.setLineWidth(0.4);
        doc.line(kx, 57, kx, 78);
      }
      setTextColor(doc, C.slate600);
      doc.setFontSize(5.5);
      boldText(doc, k.label, kx + kpiW / 2, 63, { align: "center" });
      setTextColor(doc, k.cor);
      doc.setFontSize(8.5);
      boldText(doc, k.valor, kx + kpiW / 2, 75, { align: "center" });
    });
  };

  // ── Cabeçalho da tabela ──────────────────────────────────────
  const TH_H = 18;
  const drawTableHeader = (yy: number) => {
    filledRect(doc, ML, yy, CW, TH_H, C.navyMid);
    setTextColor(doc, C.white);
    doc.setFontSize(7.5);
    boldText(doc, "DATA",          COL.data   + 4,              yy + 12);
    boldText(doc, "DESCRIÇÃO",     COL.desc   + 4,              yy + 12);
    boldText(doc, "TIPO",          COL.tipo   + 4,              yy + 12);
    boldText(doc, "VALOR",         COL.valor  + COL_W.valor - 4, yy + 12, { align: "right" });
    boldText(doc, "FATURA / NOTA", COL.fatura + 4,              yy + 12);
    boldText(doc, "STATUS",        COL.status + COL_W.status / 2, yy + 12, { align: "center" });
  };

  // ── Rodapé ───────────────────────────────────────────────────
  const drawFooter = (pageNum: number, totalPages: number) => {
    filledRect(doc, 0, PH - FOOTER_H, PW, FOOTER_H, C.navy);
    setTextColor(doc, C.slate400);
    doc.setFontSize(7);
    normalText(doc, `${empresaNome}  ·  NIF ${empresaNif}  ·  Relatório Financeiro ${mesLabel} ${ano}`, ML, PH - FOOTER_H + 13);
    normalText(doc, `Página ${pageNum} de ${totalPages}`, PW - MR, PH - FOOTER_H + 13, { align: "right" });
  };

  // ═══════════════════════════════════════════════════════════
  // PÁGINA 1 — começa directamente com cabeçalho + tabela
  // ═══════════════════════════════════════════════════════════
  drawPageHeader(1, true);

  let ty = HEADER_H + 4;
  drawTableHeader(ty);
  ty += TH_H;

  let rowIdx = 0;
  let currentPage = 1;

  for (const m of movimentos) {
    const hasAnotacao = !!(m.anotacao && m.anotacao.trim());
    const docNome = m.arquivoNome ?? m.nomeFatura ?? "";
    const hasIva  = !!(m.ivaFatura && m.ivaFatura > 0);

    // Altura da linha: base + extras para IVA e anotação
    const extraLines = (hasIva ? 1 : 0) + (hasAnotacao && !docNome ? 1 : 0);
    const ROW_H = 18 + extraLines * 9;

    // Nova página se necessário
    if (ty + ROW_H + 28 > CONTENT_BOTTOM) {
      drawFooter(currentPage, 0); // placeholder
      doc.addPage();
      currentPage++;
      drawPageHeader(currentPage, false);
      ty = HEADER_H + 4;
      drawTableHeader(ty);
      ty += TH_H;
      rowIdx = 0;
    }

    // Fundo alternado
    const bgRow = rowIdx % 2 === 0 ? C.white : C.slate50;
    filledRect(doc, ML, ty, CW, ROW_H, bgRow);
    hline(doc, ML, ty + ROW_H, ML + CW, C.slate200, 0.25);

    // Barra colorida lateral pelo tipo (4px)
    const corTipo = corMap[m.tipo] ?? "#6b7280";
    filledRect(doc, ML, ty, 4, ROW_H, corTipo);

    const midY = ty + ROW_H / 2 + 3.5; // centro vertical da linha

    // ── DATA ──────────────────────────────────────────────────
    setTextColor(doc, C.slate600);
    doc.setFontSize(8);
    normalText(doc, m.data, COL.data + 6, midY);

    // ── DESCRIÇÃO ─────────────────────────────────────────────
    setTextColor(doc, C.slate800);
    doc.setFontSize(8);
    boldText(doc, truncate(m.descricao, 30), COL.desc + 4, midY);

    // ── TIPO badge ────────────────────────────────────────────
    if (m.tipo) {
      const [tr, tg, tb] = hexToRgb(corTipo);
      // Badge fundo semitransparente
      doc.setFillColor(tr, tg, tb);
      doc.setGState(new (doc as any).GState({ opacity: 0.15 }));
      doc.roundedRect(COL.tipo + 2, ty + (ROW_H - 13) / 2, COL_W.tipo - 6, 13, 2, 2, "F");
      doc.setGState(new (doc as any).GState({ opacity: 1 }));
      setTextColor(doc, corTipo);
      doc.setFontSize(7);
      boldText(doc, truncate(m.tipo, 14), COL.tipo + COL_W.tipo / 2 - 1, midY, { align: "center" });
    }

    // ── VALOR ─────────────────────────────────────────────────
    const isEntrada = m.tipo === "RECEBIMENTO";
    setTextColor(doc, isEntrada ? C.green : C.red);
    doc.setFontSize(8.5);
    boldText(doc,
      `${isEntrada ? "+" : "-"} ${eur(m.valor)}`,
      COL.valor + COL_W.valor - 4,
      midY,
      { align: "right" }
    );

    // ── FATURA / NOTA / IVA ───────────────────────────────────
    let fatY = ty + 11;
    if (docNome) {
      setTextColor(doc, C.accent);
      doc.setFontSize(7.5);
      normalText(doc, truncate(docNome, 22), COL.fatura + 4, fatY);
      fatY += 9;
    }
    if (hasIva) {
      setTextColor(doc, C.amber);
      doc.setFontSize(7);
      normalText(doc, `IVA: ${eur(m.ivaFatura!)}`, COL.fatura + 4, fatY);
      fatY += 9;
    }
    if (hasAnotacao && !docNome) {
      setTextColor(doc, C.amber);
      doc.setFontSize(7);
      doc.setFont("helvetica", "italic");
      doc.text(truncate(m.anotacao!, 22), COL.fatura + 4, fatY);
    }
    if (!docNome && !hasAnotacao && !hasIva) {
      setTextColor(doc, C.slate300);
      doc.setFontSize(8);
      normalText(doc, "—", COL.fatura + 4, midY);
    }

    // ── STATUS badge ──────────────────────────────────────────
    const stTxt   = m.statusDoc === "conciliado" ? "OK"
                  : m.statusDoc === "sem_doc"    ? "FALTA"
                  : hasAnotacao                  ? "NOTA" : "—";
    const stColor = m.statusDoc === "conciliado" ? C.green
                  : m.statusDoc === "sem_doc"    ? C.red
                  : hasAnotacao                  ? C.amber : C.slate400;
    const stBg    = m.statusDoc === "conciliado" ? C.greenLight
                  : m.statusDoc === "sem_doc"    ? C.redLight
                  : hasAnotacao                  ? C.amberLight : C.slate100;

    roundedRect(doc, COL.status + 2, ty + (ROW_H - 13) / 2, COL_W.status - 4, 13, stBg, 2);
    setTextColor(doc, stColor);
    doc.setFontSize(7);
    boldText(doc, stTxt, COL.status + COL_W.status / 2, midY, { align: "center" });

    ty += ROW_H;
    rowIdx++;
  }

  // ── Barra de totais final ────────────────────────────────────
  if (ty + 28 > CONTENT_BOTTOM) {
    drawFooter(currentPage, 0);
    doc.addPage();
    currentPage++;
    ty = HEADER_H + 4;
  }
  ty += 6;
  roundedRect(doc, ML, ty, CW, 22, C.navy, 3);
  setTextColor(doc, C.white);
  doc.setFontSize(8);
  boldText(doc, `${movimentos.length} movimentos`, ML + 10, ty + 15);
  setTextColor(doc, "#86efac");
  boldText(doc, `Entradas: ${eur(totalEntradas)}`, ML + 110, ty + 15);
  setTextColor(doc, "#fca5a5");
  boldText(doc, `Saídas: ${eur(totalSaidas)}`, ML + 260, ty + 15);
  setTextColor(doc, liquido >= 0 ? "#93c5fd" : "#fca5a5");
  boldText(doc, `Líquido: ${eur(liquido)}`, ML + 400, ty + 15);

  // ── Rodapés em todas as páginas ─────────────────────────────
  const totalPaginas = doc.getNumberOfPages();
  for (let p = 1; p <= totalPaginas; p++) {
    doc.setPage(p);
    drawFooter(p, totalPaginas);
  }

  // ── Download ─────────────────────────────────────────────────
  doc.save(`Relatorio_${mesLabel}_${ano}.pdf`);
}
