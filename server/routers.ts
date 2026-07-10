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
        const doc = new PDFDocument({ margin: 18, size: "A4", compress: true });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));

        // Paleta clara
        const BG_HEADER = "#1e3a5c";
        const BG_TH     = "#1e3a5c";
        const BG_ROW_A  = "#f8fafc";
        const BG_ROW_B  = "#eef2f7";
        const ACCENT    = "#2563eb";
        const TEXT_W    = "#ffffff";
        const TEXT_DARK = "#1e293b";
        const TEXT_SEC  = "#475569";
        const BORDER    = "#cbd5e1";
        const M = 18;
        const W = 595 - M * 2;

        // Fundo branco
        doc.rect(0, 0, 595, 842).fill("#ffffff");
        doc.on("pageAdded", () => doc.rect(0, 0, 595, 842).fill("#ffffff"));

        // ── Cabeçalho da empresa ──────────────────────────────────────────────────────────────────────
        const mesLabel = input.mes.charAt(0).toUpperCase() + input.mes.slice(1);
        const HDR_H = 50;
        doc.rect(M, M, W, HDR_H).fill(BG_HEADER);
        doc.rect(M, M, 4, HDR_H).fill(ACCENT);
        doc.fillColor(TEXT_W).font("Helvetica-Bold").fontSize(11)
           .text(input.empresaNome, M + 10, M + 7, { width: W - 130 });
        doc.fillColor("#93c5fd").font("Helvetica").fontSize(7)
           .text(`NIF ${input.empresaNif}  ·  ${input.empresaMorada ?? ""}`, M + 10, M + 21, { width: W - 130 });
        doc.fillColor("#93c5fd").font("Helvetica").fontSize(7)
           .text(`Relatório · ${mesLabel} ${input.ano}  ·  Gerado em ${new Date().toLocaleDateString("pt-PT")}`, M + 10, M + 32, { width: W - 130 });

        const totalEntrada = input.movimentos.filter(m => m.tipo === "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
        const totalSaida = input.movimentos.filter(m => m.tipo !== "RECEBIMENTO").reduce((s, m) => s + m.valor, 0);
        const conciliados = input.movimentos.filter(m => m.statusDoc === "conciliado").length;
        const semDoc = input.movimentos.filter(m => !m.statusDoc || m.statusDoc === "sem_doc").length;
        doc.fillColor("#34d399").font("Helvetica-Bold").fontSize(8)
           .text(`↑ ${totalEntrada.toFixed(2)} €`, 595 - M - 110, M + 9, { width: 110, align: "right" });
        doc.fillColor("#f87171").font("Helvetica-Bold").fontSize(8)
           .text(`↓ ${totalSaida.toFixed(2)} €`, 595 - M - 110, M + 22, { width: 110, align: "right" });
        doc.fillColor("#93c5fd").font("Helvetica").fontSize(6.5)
           .text(`${conciliados} conciliados  ·  ${semDoc} sem doc`, 595 - M - 110, M + 37, { width: 110, align: "right" });

        // ── Cabeçalho da tabela ──────────────────────────────────────────────────────────────────────
        // Colunas: DATA(50) | DESC+TIPO(190) | VALOR(62) | DOC+NOTA(185) | STATUS(55)
        const Y_TABLE = M + HDR_H + 4;
        const COL = {
          data:   M,
          desc:   M + 50,
          valor:  M + 240,
          doc:    M + 302,
          status: M + 487,
        };
        const TH_H = 15;
        doc.rect(M, Y_TABLE, W, TH_H).fill(BG_TH);
        doc.fillColor(TEXT_W).font("Helvetica-Bold").fontSize(6.5);
        doc.text("DATA",              COL.data,   Y_TABLE + 4, { width: 48 });
        doc.text("DESCRIÇÃO / TIPO",  COL.desc,   Y_TABLE + 4, { width: 188 });
        doc.text("VALOR",             COL.valor,  Y_TABLE + 4, { width: 60, align: "right" });
        doc.text("DOCUMENTO / NOTA",  COL.doc,    Y_TABLE + 4, { width: 183 });
        doc.text("STATUS",            COL.status, Y_TABLE + 4, { width: 70 });

        // ── Linhas de movimentos ──────────────────────────────────────────────────────────────────────────
        let y = Y_TABLE + TH_H;
        let rowIdx = 0;
        const PAGE_H = 842 - M;

        const drawTH = (yPos: number) => {
          doc.rect(M, yPos, W, TH_H).fill(BG_TH);
          doc.fillColor(TEXT_W).font("Helvetica-Bold").fontSize(6.5);
          doc.text("DATA",              COL.data,   yPos + 4, { width: 48 });
          doc.text("DESCRIÇÃO / TIPO",  COL.desc,   yPos + 4, { width: 188 });
          doc.text("VALOR",             COL.valor,  yPos + 4, { width: 60, align: "right" });
          doc.text("DOCUMENTO / NOTA",  COL.doc,    yPos + 4, { width: 183 });
          doc.text("STATUS",            COL.status, yPos + 4, { width: 70 });
        };

        for (const m of input.movimentos) {
          const hasAnotacao = !!(m.anotacao && m.anotacao.trim());
          const hasDoc = !!(m.arquivoNome ?? m.nomeFatura);
          const ROW_H = (hasAnotacao && hasDoc) ? 30 : hasAnotacao ? 22 : 17;

          if (y + ROW_H > PAGE_H) {
            doc.addPage();
            y = M;
            drawTH(y);
            y += TH_H;
          }

          const bgRow = rowIdx % 2 === 0 ? BG_ROW_A : BG_ROW_B;
          doc.rect(M, y, W, ROW_H).fill(bgRow);
          doc.rect(M, y + ROW_H - 0.5, W, 0.5).fill(BORDER);

          // DATA
          doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(6.5).fillOpacity(1);
          doc.text(m.data, COL.data, y + 4, { width: 48 });

          // DESCRIÇÃO + TIPO badge
          doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(6.5);
          doc.text(m.descricao, COL.desc, y + 2, { width: 188, height: 9, ellipsis: true });
          const corHex = corMap[m.tipo] ?? "#6b7280";
          const [r, g, b] = hexToRgb(corHex);
          if (m.tipo) {
            doc.save();
            doc.rect(COL.desc, y + 9, 82, 8).fillOpacity(0.15).fill(corHex);
            doc.restore();
            doc.fillColor(corHex).font("Helvetica-Bold").fontSize(5.5).fillOpacity(1);
            doc.text(m.tipo, COL.desc + 2, y + 11, { width: 78, ellipsis: true });
          }

          // VALOR
          const isEntrada = m.tipo === "RECEBIMENTO";
          doc.fillColor(isEntrada ? "#16a34a" : "#dc2626").font("Helvetica-Bold").fontSize(7.5);
          doc.text(`${m.valor.toFixed(2)} €`, COL.valor, y + 4, { width: 60, align: "right" });

          // DOCUMENTO + IVA + ANOTAÇÃO
          const docNome = m.arquivoNome ?? m.nomeFatura ?? "";
          if (docNome) {
            doc.fillColor(ACCENT).font("Helvetica").fontSize(6.5);
            doc.text(docNome, COL.doc, y + 2, { width: 183, height: 9, ellipsis: true });
            if (m.ivaFatura && m.ivaFatura > 0) {
              doc.fillColor("#b45309").font("Helvetica").fontSize(5.5);
              doc.text(`IVA ${m.ivaFatura.toFixed(2)} €`, COL.doc, y + 10, { width: 100 });
            }
          }
          if (hasAnotacao) {
            const notaY = docNome ? y + 19 : y + 3;
            doc.fillColor("#92400e").font("Helvetica").fontSize(5.5);
            doc.text(`Nota: ${m.anotacao}`, COL.doc, notaY, { width: 183, height: 9, ellipsis: true });
          }
          if (!docNome && !hasAnotacao) {
            doc.fillColor(BORDER).font("Helvetica").fontSize(6.5);
            doc.text("—", COL.doc, y + 4, { width: 183 });
          }

          // STATUS
          const statusTxt = m.statusDoc === "conciliado" ? "✓ OK"
            : m.statusDoc === "sem_doc" ? "⚠ Falta"
            : hasAnotacao ? "Nota"
            : "—";
          const statusColor = m.statusDoc === "conciliado" ? "#16a34a"
            : m.statusDoc === "sem_doc" ? "#dc2626"
            : hasAnotacao ? "#b45309"
            : TEXT_SEC;
          doc.fillColor(statusColor).font("Helvetica-Bold").fontSize(6.5);
          doc.text(statusTxt, COL.status, y + 4, { width: 70 });

          y += ROW_H;
          rowIdx++;
        }

        // ── Rodapé com totais ─────────────────────────────────────────────────────────────────────────────
        if (y + 24 > PAGE_H) { doc.addPage(); y = M; }
        doc.rect(M, y + 3, W, 1).fill(ACCENT);
        y += 8;
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(6.5)
           .text(`Total: ${input.movimentos.length} movimentos`, COL.data, y);
        doc.fillColor("#16a34a").font("Helvetica-Bold").fontSize(6.5)
           .text(`Entradas: ${totalEntrada.toFixed(2)} €`, COL.desc, y);
        doc.fillColor("#dc2626").font("Helvetica-Bold").fontSize(6.5)
           .text(`Saídas: ${totalSaida.toFixed(2)} €`, COL.valor, y, { width: 60, align: "right" });
        doc.fillColor(TEXT_SEC).font("Helvetica").fontSize(6.5)
           .text(`Conciliados: ${conciliados}  ·  Sem doc: ${semDoc}`, COL.doc, y);

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
