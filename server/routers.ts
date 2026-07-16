import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getUserConfig, saveUserConfig,
  getUserMeses, upsertUserMes, deleteUserMes,
} from "./db";
import { storagePut, storageGetSignedUrl } from "./storage";
import { invokeLLM } from "./_core/llm";
import PDFDocument from "pdfkit";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // ─── Configurações da empresa ─────────────────────────────────────────────
  config: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const cfg = await getUserConfig(ctx.user.id);
      if (!cfg) return null;
      // Suporta formato antigo (string[]) e novo ({nome,cor}[])
      const raw = JSON.parse(cfg.tiposJson);
      const tipos: Array<{ nome: string; cor: string }> = Array.isArray(raw)
        ? raw.map((t: string | { nome: string; cor?: string }) =>
            typeof t === "string" ? { nome: t, cor: "" } : { nome: t.nome, cor: t.cor ?? "" }
          )
        : [];
      return {
        empresaNome: cfg.empresaNome,
        empresaNif: cfg.empresaNif,
        empresaMorada: cfg.empresaMorada,
        tipos,
      };
    }),

    save: protectedProcedure
      .input(z.object({
        empresaNome: z.string().min(1),
        empresaNif: z.string().min(1),
        empresaMorada: z.string(),
        // Aceita {nome, cor}[] para persistir as cores personalizadas
        tipos: z.array(z.object({ nome: z.string(), cor: z.string() })),
      }))
      .mutation(async ({ ctx, input }) => {
        await saveUserConfig(ctx.user.id, {
          empresaNome: input.empresaNome,
          empresaNif: input.empresaNif,
          empresaMorada: input.empresaMorada,
          tiposJson: JSON.stringify(input.tipos),
        });
        return { success: true };
      }),
  }),

  // ─── Meses ─────────────────────────────────────────────────────
  meses: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await getUserMeses(ctx.user.id);
      return rows.map(r => ({
        mes: r.mes,
        ano: r.ano,
        movimentos: JSON.parse(r.movimentosJson),
        docGerado: r.docGerado,
        finalizado: r.finalizado,
      }));
    }),

    save: protectedProcedure
      .input(z.object({
        mes: z.string(),
        ano: z.number(),
        movimentosJson: z.string(),
        docGerado: z.string(),
        finalizado: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        await upsertUserMes(ctx.user.id, input.mes, input.ano, {
          movimentosJson: input.movimentosJson,
          docGerado: input.docGerado,
          finalizado: input.finalizado,
        });
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ mes: z.string(), ano: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await deleteUserMes(ctx.user.id, input.mes, input.ano);
        return { success: true };
      }),
  }),

  // ─── Ficheiros (conciliação de faturas) ───────────────────────────────────
  ficheiros: router({
    upload: protectedProcedure
      .input(z.object({
        nomeOriginal: z.string().min(1),
        mimeType: z.string().min(1),
        dadosBase64: z.string().min(1),
        movId: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const buffer = Buffer.from(input.dadosBase64, "base64");
        const safeNome = input.nomeOriginal.replace(/[^a-zA-Z0-9._-]/g, "_");
        const key = `user-${ctx.user.id}/conciliacao/${input.movId ?? Date.now()}-${safeNome}`;
        const { key: finalKey, url } = await storagePut(key, buffer, input.mimeType);
        return { key: finalKey, url, nome: input.nomeOriginal };
      }),

    // ─── Conciliação inteligente por IA ───────────────────────────────────
    // Recebe vários PDFs em base64 + lista de movimentos do mês.
    // OPTIMIZAÇÕES:
    //   1. Uploads para S3 em paralelo (Promise.all)
    //   2. Análise de cada PDF individualmente em paralelo (Promise.all)
    //      → muito mais rápido do que enviar todos de uma vez ao LLM
    conciliarComIA: protectedProcedure
      .input(z.object({
        ficheiros: z.array(z.object({
          nomeOriginal: z.string(),
          mimeType: z.string(),
          dadosBase64: z.string(),
        })),
        movimentos: z.array(z.object({
          id: z.string(),
          data: z.string(),
          descricao: z.string(),
          valor: z.number(),
          tipo: z.string(),
          inst: z.string().optional(),
          arquivoNome: z.string().optional(),
        })),
      }))
      .mutation(async ({ ctx, input }) => {
        // Filtrar movimentos que ainda não têm documento
        const semDoc = input.movimentos.filter(m => !m.arquivoNome);
        if (semDoc.length === 0) return { ligacoes: [], semCorrespondencia: [] };

        // ── 1. UPLOADS EM PARALELO ──────────────────────────────────────────
        type FicheiroInfo = {
          nomeOriginal: string;
          mimeType: string;
          key: string;
          url: string;
          signedUrl: string;
          index: number;
        };

        const ficheiroInfos: FicheiroInfo[] = await Promise.all(
          input.ficheiros.map(async (f, index) => {
            const buffer = Buffer.from(f.dadosBase64, "base64");
            const safeNome = f.nomeOriginal.replace(/[^a-zA-Z0-9._-]/g, "_");
            const key = `user-${ctx.user.id}/conciliacao/ia-${Date.now()}-${index}-${safeNome}`;
            const { key: finalKey, url } = await storagePut(key, buffer, f.mimeType);
            const signedUrl = await storageGetSignedUrl(finalKey);
            return { nomeOriginal: f.nomeOriginal, mimeType: f.mimeType, key: finalKey, url, signedUrl, index };
          })
        );

        // Texto dos movimentos disponíveis (partilhado por todos os prompts)
        const movimentosTexto = semDoc.map((m, i) =>
          `[${i}] ID=${m.id} | Data=${m.data} | Valor=${m.valor.toFixed(2)}€ | Tipo=${m.tipo} | INST=${m.inst ?? "—"} | Desc=${m.descricao}`
        ).join("\n");

        // ── 2. ANÁLISE INDIVIDUAL DE CADA PDF EM PARALELO ──────────────────
        // Cada PDF é analisado numa chamada separada ao LLM → muito mais rápido
        type ResultadoPDF = {
          ficheiroIndex: number;
          movimentoId: string | null;
          confianca: string;
          motivo: string;
          ivaFatura: number | null;
        };

        const resultadosPDF: ResultadoPDF[] = await Promise.all(
          ficheiroInfos.map(async (f) => {
            try {
              const resultado = await invokeLLM({
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: `És um assistente de conciliação contabilística. Analisa o documento em anexo (fatura, recibo ou comprovativo) e identifica o movimento bancário correspondente.

MOVIMENTOS DISPONÍVEIS:
${movimentosTexto}

Para o documento em anexo, extrai:
- Valor total
- Data
- Nome/NIF do emitente ou destinatário
- Número de referência (INST, fatura, recibo)

Depois escolhe o movimento mais provável. Critérios por ordem de importância:
1. Valor (diferença máxima 0.02€) — critério mais forte
2. Número INST ou referência
3. Data e nome

Se não houver correspondência clara, devolve movimentoId: null.

Extrai também o valor do IVA do documento (campo IVA, IVA Normal, IVA 23%, Valor IVA, etc.). Se não encontrares IVA, devolve null.

Responde APENAS com JSON válido:
{ "movimentoId": "mov-3" ou null, "confianca": "alta" | "media" | "baixa", "motivo": "explicação breve", "ivaFatura": 12.34 ou null }`,
                      },
                      {
                        type: "file_url",
                        file_url: { url: f.signedUrl, mime_type: "application/pdf" },
                      } as any,
                    ] as any,
                  },
                ],
                response_format: { type: "json_object" },
              });
              const texto = typeof resultado.choices[0].message.content === "string"
                ? resultado.choices[0].message.content
                : JSON.stringify(resultado.choices[0].message.content);
              const parsed = JSON.parse(texto);
              return {
                ficheiroIndex: f.index,
                movimentoId: parsed.movimentoId ?? null,
                confianca: parsed.confianca ?? "baixa",
                motivo: parsed.motivo ?? "",
                ivaFatura: typeof parsed.ivaFatura === "number" ? Math.round(parsed.ivaFatura * 100) / 100 : null,
              };
            } catch {
              return { ficheiroIndex: f.index, movimentoId: null, confianca: "baixa", motivo: "Erro na análise", ivaFatura: null };
            }
          })
        );

        // ── 3. DEDUPLICAR: cada movimento só pode receber UM ficheiro ───────
        // Se dois PDFs apontam para o mesmo movimento, fica o de maior confiança
        const ordemConfianca: Record<string, number> = { alta: 3, media: 2, baixa: 1 };
        const movimentoUsado = new Map<string, ResultadoPDF>();
        for (const r of resultadosPDF) {
          if (!r.movimentoId) continue;
          const existente = movimentoUsado.get(r.movimentoId);
          if (!existente || (ordemConfianca[r.confianca] ?? 0) > (ordemConfianca[existente.confianca] ?? 0)) {
            movimentoUsado.set(r.movimentoId, r);
          }
        }

        // Construir resultado final
        const ligacoesComUrl = Array.from(movimentoUsado.values()).map(r => {
          const f = ficheiroInfos[r.ficheiroIndex];
          return {
            movimentoId: r.movimentoId!,
            arquivoNome: f?.nomeOriginal ?? "",
            arquivoUrl: f?.url ?? "",
            arquivoKey: f?.key ?? "",
            confianca: r.confianca,
            motivo: r.motivo,
            ivaFatura: r.ivaFatura ?? null,
          };
        }).filter(l => l.movimentoId && l.arquivoNome);

        const movimentosLigados = new Set(ligacoesComUrl.map(l => l.movimentoId));
        const semCorrespondenciaNomes = resultadosPDF
          .filter(r => !r.movimentoId || !movimentosLigados.has(r.movimentoId))
          .map(r => ficheiroInfos[r.ficheiroIndex]?.nomeOriginal ?? `ficheiro-${r.ficheiroIndex}`);

        return { ligacoes: ligacoesComUrl, semCorrespondencia: semCorrespondenciaNomes };
      }),
  }),

  // ─── Relatório para o contabilista ───────────────────────────────────────
  relatorio: router({
    gerarPDF: protectedProcedure
      .input(z.object({
        mes: z.string(),
        ano: z.number(),
        movimentos: z.array(z.object({
          data: z.string(),
          descricao: z.string(),
          valor: z.number(),
          tipo: z.string(),
          nomeFatura: z.string().optional(),
          arquivoNome: z.string().optional(),
          arquivoUrl: z.string().optional(),
          statusDoc: z.string().optional(),
          ivaFatura: z.number().optional(),
          anotacao: z.string().optional(),
        })),
        empresaNome: z.string(),
        empresaNif: z.string(),
        empresaMorada: z.string().optional(),
        tipos: z.array(z.object({ nome: z.string(), cor: z.string() })).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // ═══════════════════════════════════════════════════════════════════
        // EXECUTIVE FINANCIAL REPORT — Layout moderno e profissional
        // ═══════════════════════════════════════════════════════════════════

        // Paleta de cores por tipo (respeita as cores do utilizador)
        const COR_PADRAO: Record<string, string> = {
          "FATURA SERVIÇO": "#3b82f6",
          "FATURA":         "#3b82f6",
          "COMPRA":         "#ef4444",
          "RECIBO VERDE":   "#22c55e",
          "RECIBO":         "#06b6d4",
          "MANUT. CONTA":   "#d97706",
          "AVENÇA CONT.":  "#9333ea",
          "RECEBIMENTO":    "#10b981",
          "SEG. SOCIAL":    "#f97316",
          "IVA":            "#ec4899",
        };
        const corMap: Record<string, string> = { ...COR_PADRAO };
        if (input.tipos) {
          for (const t of input.tipos) if (t.cor) corMap[t.nome] = t.cor;
        }

        const hexToRgb = (hex: string): [number, number, number] => {
          const h = (hex || "#6b7280").replace("#", "").padEnd(6, "0");
          return [
            parseInt(h.slice(0, 2), 16) || 0,
            parseInt(h.slice(2, 4), 16) || 0,
            parseInt(h.slice(4, 6), 16) || 0,
          ];
        };

        // Luminosidade para decidir texto branco/preto sobre badge
        const luminancia = (hex: string): number => {
          const [r, g, b] = hexToRgb(hex);
          return 0.299 * r + 0.587 * g + 0.114 * b;
        };

        // Formatação monetária pt-PT
        const eur = (v: number) => v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        // PRÉ-CÁLCULOS
        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        const movs = input.movimentos;
        const totalEntradas = movs.filter(m => m.tipo === "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
        const totalSaidas   = movs.filter(m => m.tipo !== "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
        const liquido       = totalEntradas - totalSaidas;
        const totalIva      = movs.reduce((s, m) => s + (m.ivaFatura ?? 0), 0);
        const conciliados   = movs.filter(m => m.statusDoc === "conciliado").length;
        const semDoc        = movs.filter(m => !m.statusDoc || m.statusDoc === "sem_doc").length;
        const mesLabel      = input.mes.charAt(0).toUpperCase() + input.mes.slice(1);
        const dataGeracao   = new Date().toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });

        // Distribuição por tipo (para o gráfico de barras)
        const porTipo: Record<string, number> = {};
        for (const m of movs) {
          if (!m.tipo) continue;
          porTipo[m.tipo] = (porTipo[m.tipo] ?? 0) + m.valor;
        }
        const tiposOrdenados = Object.entries(porTipo).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const maxTipo = tiposOrdenados.length > 0 ? tiposOrdenados[0][1] : 1;

        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        // DOCUMENTO PDF
        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        const doc = new PDFDocument({ margin: 0, size: "A4", compress: true, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));

        // Constantes de layout
        const PW = 595.28;  // largura A4 pontos
        const PH = 841.89;  // altura A4 pontos
        const ML = 36;      // margem esquerda
        const MR = 36;      // margem direita
        const CW = PW - ML - MR; // largura útil
        const FOOTER_H = 28;
        const CONTENT_BOTTOM = PH - FOOTER_H - 10;

        // Paleta
        const C = {
          navy:      "#0f172a",
          navyMid:   "#1e3a5c",
          navyLight: "#1e40af",
          accent:    "#2563eb",
          accentAlt: "#0ea5e9",
          green:     "#16a34a",
          greenLight:"#dcfce7",
          red:       "#dc2626",
          redLight:  "#fee2e2",
          amber:     "#d97706",
          amberLight:"#fef3c7",
          blue:      "#2563eb",
          blueLight: "#dbeafe",
          slate50:   "#f8fafc",
          slate100:  "#f1f5f9",
          slate200:  "#e2e8f0",
          slate400:  "#94a3b8",
          slate600:  "#475569",
          slate800:  "#1e293b",
          white:     "#ffffff",
          black:     "#000000",
        };

        // Helpers
        const fill = (color: string) => { doc.fillColor(color); return doc; };
        const stroke = (color: string) => { doc.strokeColor(color); return doc; };
        const font = (f: "R" | "B" | "I", size: number) => {
          doc.font(f === "B" ? "Helvetica-Bold" : f === "I" ? "Helvetica-Oblique" : "Helvetica").fontSize(size);
          return doc;
        };
        const rect = (x: number, y: number, w: number, h: number, color: string, radius = 0) => {
          if (radius > 0) doc.roundedRect(x, y, w, h, radius).fill(color);
          else doc.rect(x, y, w, h).fill(color);
        };
        const hline = (x1: number, y: number, x2: number, color: string, lw = 0.5) => {
          doc.moveTo(x1, y).lineTo(x2, y).lineWidth(lw).stroke(color);
        };

        // Rodapé em cada página
        const drawFooter = (pageNum: number, totalPages: number) => {
          const fy = PH - FOOTER_H;
          rect(0, fy, PW, FOOTER_H, C.navy);
          fill(C.slate400).font("R", 7)
            .text(`${input.empresaNome}  ·  NIF ${input.empresaNif}  ·  Relatório Financeiro ${mesLabel} ${input.ano}`, ML, fy + 10, { width: CW - 60 });
          fill(C.slate400).font("R", 7)
            .text(`Página ${pageNum} de ${totalPages}`, ML, fy + 10, { width: CW, align: "right" });
        };

        // Fundo branco em cada página
        doc.on("pageAdded", () => rect(0, 0, PW, PH, C.white));
        rect(0, 0, PW, PH, C.white);

        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        // PÁGINA 1 — CAPA EXECUTIVA
        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────

        // Barra superior azul escura (capa)
        rect(0, 0, PW, 200, C.navy);
        // Faixa accent diagonal decorativa
        rect(0, 195, PW, 6, C.accent);
        // Linha fina accent
        rect(0, 201, PW, 2, C.accentAlt);

        // Logo / inicial da empresa
        const ini = (input.empresaNome || "P").charAt(0).toUpperCase();
        rect(ML, 30, 48, 48, C.accent, 6);
        fill(C.white).font("B", 22).text(ini, ML, 44, { width: 48, align: "center" });

        // Nome da empresa
        fill(C.white).font("B", 16).text(input.empresaNome, ML + 58, 34, { width: CW - 58 });
        fill(C.slate400).font("R", 8).text(`NIF ${input.empresaNif}  ·  ${input.empresaMorada ?? ""}`, ML + 58, 54, { width: CW - 58 });

        // Título do relatório
        fill(C.white).font("B", 28).text("RELATÓRIO FINANCEIRO", ML, 105, { width: CW });
        fill(C.accentAlt).font("B", 14).text(`${mesLabel.toUpperCase()} ${input.ano}`, ML, 138, { width: CW });
        fill(C.slate400).font("R", 8).text(`Gerado em ${dataGeracao}  ·  ${movs.length} movimentos`, ML, 157, { width: CW });

        // ── KPIs em 4 cartões ─────────────────────────────────────────────────────────────────────────────────────
        const kpiY = 218;
        const kpiW = (CW - 12) / 4;
        const kpiH = 72;
        const kpis = [
          { label: "ENTRADAS",    valor: eur(totalEntradas), cor: C.green,  bg: C.greenLight,  icon: "↑" },
          { label: "SAÍDAS",      valor: eur(totalSaidas),   cor: C.red,    bg: C.redLight,    icon: "↓" },
          { label: "LÍQUIDO",     valor: eur(liquido),       cor: liquido >= 0 ? C.blue : C.red, bg: liquido >= 0 ? C.blueLight : C.redLight, icon: "=" },
          { label: "IVA DEDUT.",  valor: eur(totalIva),      cor: C.amber,  bg: C.amberLight,  icon: "%" },
        ];
        kpis.forEach((k, i) => {
          const kx = ML + i * (kpiW + 4);
          rect(kx, kpiY, kpiW, kpiH, C.slate50, 4);
          // Barra colorida lateral
          rect(kx, kpiY, 4, kpiH, k.cor, 0);
          // Ícone
          rect(kx + kpiW - 26, kpiY + 8, 18, 18, k.bg, 3);
          fill(k.cor).font("B", 10).text(k.icon, kx + kpiW - 26, kpiY + 12, { width: 18, align: "center" });
          // Label
          fill(C.slate600).font("B", 6.5).text(k.label, kx + 10, kpiY + 10, { width: kpiW - 40 });
          // Valor
          fill(k.cor).font("B", 11).text(k.valor, kx + 10, kpiY + 24, { width: kpiW - 16 });
          // Linha inferior
          hline(kx + 4, kpiY + kpiH - 1, kx + kpiW, C.slate200);
        });

        // ── Gráfico de barras horizontais por tipo ─────────────────────────────────────────────────────────────────────────────────────
        let cy = kpiY + kpiH + 20;

        if (tiposOrdenados.length > 0) {
          fill(C.slate800).font("B", 9).text("DISTRIBUIÇÃO POR CATEGORIA", ML, cy);
          hline(ML, cy + 13, ML + CW, C.slate200);
          cy += 20;

          const BAR_MAX_W = CW * 0.55;
          const BAR_H = 14;
          const BAR_GAP = 6;
          const LABEL_W = 110;
          const VAL_W = 80;

          tiposOrdenados.forEach(([tipo, valor]) => {
            const corTipo = corMap[tipo] ?? "#6b7280";
            const barW = maxTipo > 0 ? (valor / maxTipo) * BAR_MAX_W : 0;
            const pct = totalSaidas + totalEntradas > 0 ? ((valor / (totalSaidas + totalEntradas)) * 100).toFixed(1) : "0.0";

            // Label do tipo
            fill(C.slate800).font("B", 7).text(tipo, ML, cy + 3, { width: LABEL_W, ellipsis: true });

            // Barra de fundo
            rect(ML + LABEL_W + 6, cy, BAR_MAX_W, BAR_H, C.slate100, 2);
            // Barra preenchida
            if (barW > 2) rect(ML + LABEL_W + 6, cy, barW, BAR_H, corTipo, 2);

            // Badge com valor
            fill(C.slate600).font("R", 6.5).text(eur(valor), ML + LABEL_W + BAR_MAX_W + 10, cy + 3, { width: VAL_W });
            fill(C.slate400).font("R", 6).text(`${pct}%`, ML + LABEL_W + BAR_MAX_W + 10, cy + 10, { width: VAL_W });

            cy += BAR_H + BAR_GAP;
          });
          cy += 8;
        }

        // ── Bloco de conciliação ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        if (cy + 40 < CONTENT_BOTTOM) {
          fill(C.slate800).font("B", 9).text("ESTADO DA CONCILIAÇÃO DOCUMENTAL", ML, cy);
          hline(ML, cy + 13, ML + CW, C.slate200);
          cy += 20;

          const concW = (CW - 8) / 3;
          const concItems = [
            { label: "Conciliados",   val: conciliados,              cor: C.green,  bg: C.greenLight },
            { label: "Sem documento", val: semDoc,                    cor: C.red,    bg: C.redLight   },
            { label: "Total",         val: movs.length,              cor: C.blue,   bg: C.blueLight  },
          ];
          concItems.forEach((ci, i) => {
            const cx2 = ML + i * (concW + 4);
            rect(cx2, cy, concW, 36, ci.bg, 4);
            fill(ci.cor).font("B", 18).text(String(ci.val), cx2 + 10, cy + 6, { width: concW - 20 });
            fill(ci.cor).font("R", 7).text(ci.label.toUpperCase(), cx2 + 10, cy + 24, { width: concW - 20 });
          });
          cy += 50;
        }

        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        // PÁGINA 2+ — TABELA DETALHADA DE MOVIMENTOS
        // ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        doc.addPage();
        rect(0, 0, PW, PH, C.white);

        // Cabeçalho da página de detalhe
        rect(0, 0, PW, 38, C.navy);
        rect(0, 36, PW, 3, C.accent);
        fill(C.white).font("B", 10).text("DETALHE DE MOVIMENTOS", ML, 12, { width: CW - 120 });
        fill(C.slate400).font("R", 7.5).text(`${mesLabel} ${input.ano}  ·  ${movs.length} movimentos`, ML, 24, { width: CW - 120 });
        fill(C.slate400).font("R", 7.5).text(input.empresaNome, ML, 24, { width: CW, align: "right" });

        // Colunas da tabela
        // DATA(46) | DESCRIÇÃO(148) | TIPO(72) | VALOR(62) | FATURA(100) | STATUS(35)
        const COL = {
          data:    ML,
          desc:    ML + 48,
          tipo:    ML + 198,
          valor:   ML + 272,
          fatura:  ML + 336,
          status:  ML + 438,
        };
        const COL_W = {
          data:   46,
          desc:   148,
          tipo:   72,
          valor:  62,
          fatura: 100,
          status: 35,
        };

        let ty = 48;
        const TH_H = 16;
        const PAGE_BOTTOM = CONTENT_BOTTOM;

        const drawTableHeader = (yy: number) => {
          rect(ML, yy, CW, TH_H, C.navyMid);
          fill(C.white).font("B", 6.5);
          doc.text("DATA",       COL.data,   yy + 5, { width: COL_W.data });
          doc.text("DESCRIÇÃO", COL.desc,   yy + 5, { width: COL_W.desc });
          doc.text("TIPO",       COL.tipo,   yy + 5, { width: COL_W.tipo });
          doc.text("VALOR",      COL.valor,  yy + 5, { width: COL_W.valor, align: "right" });
          doc.text("FATURA / NOTA", COL.fatura, yy + 5, { width: COL_W.fatura });
          doc.text("STATUS",     COL.status, yy + 5, { width: COL_W.status });
        };

        drawTableHeader(ty);
        ty += TH_H;

        let rowIdx = 0;
        for (const m of movs) {
          const hasAnotacao = !!(m.anotacao && m.anotacao.trim());
          const docNome = m.arquivoNome ?? m.nomeFatura ?? "";
          // Altura da linha: base 16, +8 se tem IVA, +8 se tem anotação
          const hasIva = !!(m.ivaFatura && m.ivaFatura > 0);
          const ROW_H = 16 + (hasIva ? 8 : 0) + (hasAnotacao ? 8 : 0);

          // Nova página se necessário
          if (ty + ROW_H > PAGE_BOTTOM) {
            doc.addPage();
            rect(0, 0, PW, PH, C.white);
            rect(0, 0, PW, 38, C.navy);
            rect(0, 36, PW, 3, C.accent);
            fill(C.white).font("B", 10).text("DETALHE DE MOVIMENTOS (cont.)", ML, 12, { width: CW - 120 });
            fill(C.slate400).font("R", 7.5).text(`${mesLabel} ${input.ano}`, ML, 24, { width: CW - 120 });
            fill(C.slate400).font("R", 7.5).text(input.empresaNome, ML, 24, { width: CW, align: "right" });
            ty = 48;
            drawTableHeader(ty);
            ty += TH_H;
          }

          // Fundo alternado
          const bgRow = rowIdx % 2 === 0 ? C.white : C.slate50;
          rect(ML, ty, CW, ROW_H, bgRow);
          // Linha de separação
          hline(ML, ty + ROW_H, ML + CW, C.slate200, 0.3);

          // Barra colorida lateral pelo tipo
          const corTipo = corMap[m.tipo] ?? "#6b7280";
          rect(ML, ty, 3, ROW_H, corTipo);

          // DATA
          fill(C.slate600).font("R", 7).text(m.data, COL.data + 5, ty + 5, { width: COL_W.data - 5 });

          // DESCRIÇÃO
          fill(C.slate800).font("B", 7).text(m.descricao, COL.desc, ty + 5, { width: COL_W.desc, ellipsis: true });

          // TIPO badge (círculos coloridos + texto)
          if (m.tipo) {
            const [tr, tg, tb] = hexToRgb(corTipo);
            // Badge: rect arredondado com cor do tipo
            doc.save();
            doc.rect(COL.tipo, ty + 3, COL_W.tipo - 4, 10).fillOpacity(0.18).fill(corTipo);
            doc.restore();
            const textColor = luminancia(corTipo) > 160 ? C.slate800 : corTipo;
            fill(textColor).font("B", 6).text(m.tipo, COL.tipo + 2, ty + 5, { width: COL_W.tipo - 6, ellipsis: true });
          }

          // VALOR
          const isEntrada = m.tipo === "RECEBIMENTO";
          fill(isEntrada ? C.green : C.red).font("B", 8)
            .text(`${isEntrada ? "+" : "-"} ${eur(m.valor)}`, COL.valor, ty + 5, { width: COL_W.valor, align: "right" });

          // FATURA / NOTA
          let fatY = ty + 5;
          if (docNome) {
            fill(C.accent).font("R", 6.5).text(docNome, COL.fatura, fatY, { width: COL_W.fatura, ellipsis: true });
            fatY += 8;
          }
          if (hasIva) {
            fill(C.amber).font("R", 6).text(`IVA: ${eur(m.ivaFatura!)}`, COL.fatura, fatY, { width: COL_W.fatura });
            fatY += 8;
          }
          if (hasAnotacao && !docNome) {
            fill(C.amber).font("I", 6).text(`Nota: ${m.anotacao}`, COL.fatura, fatY, { width: COL_W.fatura, ellipsis: true });
          }
          if (!docNome && !hasAnotacao && !hasIva) {
            fill(C.slate400).font("R", 6.5).text("—", COL.fatura, ty + 5, { width: COL_W.fatura });
          }

          // STATUS
          const stTxt   = m.statusDoc === "conciliado" ? "OK" : m.statusDoc === "sem_doc" ? "FALTA" : hasAnotacao ? "NOTA" : "—";
          const stColor = m.statusDoc === "conciliado" ? C.green : m.statusDoc === "sem_doc" ? C.red : hasAnotacao ? C.amber : C.slate400;
          const stBg    = m.statusDoc === "conciliado" ? C.greenLight : m.statusDoc === "sem_doc" ? C.redLight : hasAnotacao ? C.amberLight : C.slate100;
          rect(COL.status, ty + 3, COL_W.status, 10, stBg, 2);
          fill(stColor).font("B", 6).text(stTxt, COL.status, ty + 5, { width: COL_W.status, align: "center" });

          ty += ROW_H;
          rowIdx++;
        }

        // ── Rodapé da tabela com totais ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        if (ty + 30 > PAGE_BOTTOM) { doc.addPage(); rect(0, 0, PW, PH, C.white); ty = 36; }
        ty += 6;
        rect(ML, ty, CW, 22, C.navy, 3);
        fill(C.white).font("B", 7.5).text(`${movs.length} movimentos`, ML + 8, ty + 7, { width: 100 });
        fill(C.greenLight).font("B", 7.5).text(`Entradas: ${eur(totalEntradas)}`, ML + 110, ty + 7, { width: 120 });
        fill("#fca5a5").font("B", 7.5).text(`Saídas: ${eur(totalSaidas)}`, ML + 240, ty + 7, { width: 120 });
        fill(liquido >= 0 ? "#93c5fd" : "#fca5a5").font("B", 7.5).text(`Líquido: ${eur(liquido)}`, ML + 360, ty + 7, { width: 120 });

        // ── Rodapés em todas as páginas (ANTES de doc.end()) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        // Com bufferPages:true, as páginas estão em memória — desenhamos rodapés antes de finalizar
        const totalPages = doc.bufferedPageRange().count;
        for (let i = 0; i < totalPages; i++) {
          doc.switchToPage(i);
          drawFooter(i + 1, totalPages);
        }

        doc.end();
        await new Promise<void>(resolve => doc.on("end", resolve));
        const pdfBuffer = Buffer.concat(chunks);

        const key = `user-${ctx.user.id}/relatorios/relatorio-${input.mes}-${input.ano}-${Date.now()}.pdf`;
        const { url } = await storagePut(key, pdfBuffer, "application/pdf");
        return { url, nome: `Relatorio_${mesLabel}_${input.ano}.pdf` };
      }),
  }),
});

export type AppRouter = typeof appRouter;
