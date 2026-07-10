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
        })),
        empresaNome: z.string(),
        empresaNif: z.string(),
        empresaMorada: z.string().optional(),
        tipos: z.array(z.object({ nome: z.string(), cor: z.string() })).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // ── Paleta de cores por tipo ──────────────────────────────────────────
        const COR_PADRAO: Record<string, string> = {
          "FATURA SERVIÇO": "#3b82f6",
          "FATURA COMPRA": "#ef4444",
          "RECIBO VERDE": "#22c55e",
          "RECIBO": "#06b6d4",
          "RECIBO SALÁRIO": "#f59e0b",
          "MANUTENÇÃO DE CONTA": "#d97706",
          "AVENÇA CONTAB": "#9333ea",
          "RECEBIMENTO": "#10b981",
          "SEG. SOCIAL": "#f97316",
        };
        const corMap: Record<string, string> = { ...COR_PADRAO };
        if (input.tipos) {
          for (const t of input.tipos) if (t.cor) corMap[t.nome] = t.cor;
        }
        const hexToRgb = (hex: string): [number, number, number] => {
          const h = hex.replace("#", "");
          return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
          ];
        };

        // ── Criar documento PDF ───────────────────────────────────────────────
        const doc = new PDFDocument({ margin: 32, size: "A4", compress: true });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));

        const BG_PAGE   = "#0a0e16";
        const BG_HEADER = "#0f2744";
        const BG_ROW_A  = "#141b29";
        const BG_ROW_B  = "#0d1520";
        const ACCENT    = "#2563eb";
        const TEXT_W    = "#ffffff";
        const TEXT_SEC  = "#93c5fd";
        const TEXT_MONO = "#e2e8f0";
        const W = 595 - 64; // largura útil (A4 − margens)

        // ── Fundo da página ───────────────────────────────────────────────────
        const fillPage = () => {
          doc.rect(0, 0, 595, 842).fill(BG_PAGE);
        };
        fillPage();
        doc.on("pageAdded", fillPage);

        // ── Cabeçalho da empresa ──────────────────────────────────────────────
        const mesLabel = input.mes.charAt(0).toUpperCase() + input.mes.slice(1);
        doc.rect(32, 32, W, 64).fill(BG_HEADER);
        doc.rect(32, 32, 4, 64).fill(ACCENT);
        doc.fillColor(TEXT_W).font("Helvetica-Bold").fontSize(13)
           .text(input.empresaNome, 44, 42, { width: W - 120 });
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(8)
           .text(`NIF ${input.empresaNif}  ·  ${input.empresaMorada ?? ""}`, 44, 58, { width: W - 120 });
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(8)
           .text(`Relatório · ${mesLabel} ${input.ano}  ·  Gerado em ${new Date().toLocaleDateString("pt-PT")}`, 44, 70, { width: W - 120 });

        // Totais no canto direito do cabeçalho
        const totalEntrada = input.movimentos.filter(m => m.tipo === "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
        const totalSaida = input.movimentos.filter(m => m.tipo !== "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
        const conciliados = input.movimentos.filter(m => m.statusDoc === "conciliado").length;
        const semDoc = input.movimentos.filter(m => !m.statusDoc || m.statusDoc === "sem_doc").length;
        doc.fillColor("#34d399").font("Helvetica-Bold").fontSize(9)
           .text(`↑ ${totalEntrada.toFixed(2)} €`, 595 - 32 - 110, 38, { width: 110, align: "right" });
        doc.fillColor("#f87171").font("Helvetica-Bold").fontSize(9)
           .text(`↓ ${totalSaida.toFixed(2)} €`, 595 - 32 - 110, 52, { width: 110, align: "right" });
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(7)
           .text(`${conciliados} conciliados  ·  ${semDoc} sem doc`, 595 - 32 - 110, 68, { width: 110, align: "right" });

        // ── Cabeçalho da tabela ───────────────────────────────────────────────
        const Y_TABLE = 108;
        const COL = { data: 32, desc: 100, valor: 340, tipo: 400, doc: 490, status: 548 };
        doc.rect(32, Y_TABLE, W, 18).fill(ACCENT);
        doc.fillColor(TEXT_W).font("Helvetica-Bold").fontSize(7.5);
        doc.text("DATA",        COL.data,   Y_TABLE + 5, { width: 65 });
        doc.text("DESCRIÇÃO",   COL.desc,   Y_TABLE + 5, { width: 235 });
        doc.text("VALOR",       COL.valor,  Y_TABLE + 5, { width: 55, align: "right" });
        doc.text("TIPO",        COL.tipo,   Y_TABLE + 5, { width: 85 });
        doc.text("DOCUMENTO",   COL.doc,    Y_TABLE + 5, { width: 55 });
        doc.text("STATUS",      COL.status, Y_TABLE + 5, { width: 47 });

        // ── Linhas de movimentos ──────────────────────────────────────────────
        let y = Y_TABLE + 18;
        let rowIdx = 0;
        const ROW_H = 22;
        const PAGE_H = 842 - 32; // margem inferior

        for (const m of input.movimentos) {
          // Nova página se necessário
          if (y + ROW_H > PAGE_H) {
            doc.addPage();
            y = 32;
            // Repetir cabeçalho da tabela
            doc.rect(32, y, W, 18).fill(ACCENT);
            doc.fillColor(TEXT_W).font("Helvetica-Bold").fontSize(7.5);
            doc.text("DATA",        COL.data,   y + 5, { width: 65 });
            doc.text("DESCRIÇÃO",   COL.desc,   y + 5, { width: 235 });
            doc.text("VALOR",       COL.valor,  y + 5, { width: 55, align: "right" });
            doc.text("TIPO",        COL.tipo,   y + 5, { width: 85 });
            doc.text("DOCUMENTO",   COL.doc,    y + 5, { width: 55 });
            doc.text("STATUS",      COL.status, y + 5, { width: 47 });
            y += 18;
          }

          const bgRow = rowIdx % 2 === 0 ? BG_ROW_A : BG_ROW_B;
          doc.rect(32, y, W, ROW_H).fill(bgRow);

          // Badge de tipo com cor
          const corHex = corMap[m.tipo] ?? "#6b7280";
          const [r, g, b] = hexToRgb(corHex);
          const corBg = `rgba(${r},${g},${b},0.15)`;
          // pdfkit não suporta rgba directamente — usar fill com opacity
          doc.save();
          doc.rect(COL.tipo, y + 4, 83, 14).fillOpacity(0.18).fill(corHex);
          doc.restore();

          // Textos da linha
          doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(7).fillOpacity(1);
          doc.text(m.data, COL.data, y + 7, { width: 65 });

          doc.fillColor(TEXT_MONO).font("Helvetica").fontSize(6.5);
          doc.text(m.descricao, COL.desc, y + 4, { width: 235, height: 16, ellipsis: true });

          // Valor com cor (positivo/negativo)
          const isEntrada = m.tipo === "RECEBIMENTO";
          doc.fillColor(isEntrada ? "#34d399" : "#f87171").font("Helvetica-Bold").fontSize(7.5);
          doc.text(`${m.valor.toFixed(2)} €`, COL.valor, y + 7, { width: 55, align: "right" });

          // Nome do tipo sobre o badge
          doc.fillColor(corHex).font("Helvetica-Bold").fontSize(6.5);
          doc.text(m.tipo, COL.tipo + 3, y + 7, { width: 77, ellipsis: true });

          // Documento
          const docNome = m.arquivoNome ?? m.nomeFatura ?? "—";
          doc.fillColor(docNome !== "—" ? "#60a5fa" : "#475569").font("Helvetica").fontSize(6.5);
          doc.text(docNome, COL.doc, y + 4, { width: 55, height: 16, ellipsis: true });
          // IVA da fatura (se existir)
          if (m.ivaFatura && m.ivaFatura > 0) {
            doc.fillColor("#fbbf24").font("Helvetica").fontSize(5.5);
            doc.text(`IVA ${m.ivaFatura.toFixed(2)} €`, COL.doc, y + 13, { width: 55 });
          }

          // Status
          const statusTxt = m.statusDoc === "conciliado" ? "✓ OK"
            : m.statusDoc === "sem_doc" ? "⚠ Falta"
            : "—";
          const statusColor = m.statusDoc === "conciliado" ? "#34d399"
            : m.statusDoc === "sem_doc" ? "#f87171"
            : "#475569";
          doc.fillColor(statusColor).font("Helvetica-Bold").fontSize(7);
          doc.text(statusTxt, COL.status, y + 7, { width: 47 });

          y += ROW_H;
          rowIdx++;
        }

        // ── Rodapé com totais ─────────────────────────────────────────────────
        if (y + 40 > PAGE_H) { doc.addPage(); y = 32; }
        doc.rect(32, y + 4, W, 1).fill(ACCENT);
        y += 12;
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(7)
           .text(`Total movimentos: ${input.movimentos.length}`, COL.data, y);
        doc.fillColor("#34d399").font("Helvetica-Bold").fontSize(7)
           .text(`Entradas: ${totalEntrada.toFixed(2)} €`, COL.desc, y);
        doc.fillColor("#f87171").font("Helvetica-Bold").fontSize(7)
           .text(`Saídas: ${totalSaida.toFixed(2)} €`, COL.valor - 20, y, { width: 80, align: "right" });
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(7)
           .text(`Conciliados: ${conciliados}  ·  Sem doc: ${semDoc}`, COL.tipo, y);

        // ── Finalizar e guardar ───────────────────────────────────────────────
        doc.end();
        await new Promise<void>(resolve => doc.on("end", resolve));
        const pdfBuffer = Buffer.concat(chunks);
        const key = `user-${ctx.user.id}/relatorios/relatorio-${input.mes}-${input.ano}-${Date.now()}.pdf`;
        const { url } = await storagePut(key, pdfBuffer, "application/pdf");
        return { url, nome: `Relatorio-${mesLabel}-${input.ano}.pdf` };
      }),
  }),
});

export type AppRouter = typeof appRouter;
