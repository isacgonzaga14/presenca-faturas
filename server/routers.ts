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
    gerarExcel: protectedProcedure
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
        })),
        empresaNome: z.string(),
        empresaNif: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Gerar CSV estruturado (compatível com Excel)
        const linhas: string[] = [];
        const sep = ";";

        // Cabeçalho do relatório
        linhas.push(`RELATÓRIO DE CONCILIAÇÃO CONTABILÍSTICA${sep}${sep}${sep}${sep}${sep}`);
        linhas.push(`Empresa:${sep}${input.empresaNome}${sep}${sep}${sep}${sep}`);
        linhas.push(`NIF:${sep}${input.empresaNif}${sep}${sep}${sep}${sep}`);
        linhas.push(`Período:${sep}${input.mes.charAt(0).toUpperCase() + input.mes.slice(1)} ${input.ano}${sep}${sep}${sep}${sep}`);
        linhas.push(`Gerado em:${sep}${new Date().toLocaleDateString("pt-PT")}${sep}${sep}${sep}${sep}`);
        linhas.push(`${sep}${sep}${sep}${sep}${sep}`);

        // Cabeçalho da tabela
        linhas.push(`DATA${sep}DESCRIÇÃO${sep}VALOR (€)${sep}TIPO${sep}DOCUMENTO${sep}STATUS`);

        // Linhas de movimentos
        for (const m of input.movimentos) {
          const valor = m.valor.toFixed(2).replace(".", ",");
          const doc = m.arquivoNome ?? m.nomeFatura ?? "—";
          const status = m.statusDoc === "conciliado" ? "✓ Conciliado"
            : m.statusDoc === "sem_doc" ? "⚠ Sem documento"
            : "—";
          // Escapar ponto e vírgula nos campos de texto
          const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
          linhas.push(`${m.data}${sep}${esc(m.descricao)}${sep}${valor}${sep}${esc(m.tipo)}${sep}${esc(doc)}${sep}${esc(status)}`);
        }

        // Totais
        const totalGeral = input.movimentos.reduce((s, m) => s + m.valor, 0);
        const conciliados = input.movimentos.filter(m => m.statusDoc === "conciliado").length;
        const semDoc = input.movimentos.filter(m => m.statusDoc === "sem_doc").length;
        linhas.push(`${sep}${sep}${sep}${sep}${sep}`);
        linhas.push(`${sep}TOTAL${sep}${totalGeral.toFixed(2).replace(".", ",")}${sep}${sep}${sep}`);
        linhas.push(`${sep}Conciliados${sep}${conciliados}${sep}${sep}${sep}`);
        linhas.push(`${sep}Sem documento${sep}${semDoc}${sep}${sep}${sep}`);

        const csvContent = linhas.join("\n");
        const buffer = Buffer.from("\uFEFF" + csvContent, "utf-8"); // BOM para Excel reconhecer UTF-8
        const key = `user-${ctx.user.id}/relatorios/relatorio-${input.mes}-${input.ano}-${Date.now()}.csv`;
        const { url } = await storagePut(key, buffer, "text/csv;charset=utf-8");
        return { url, nome: `relatorio-conciliacao-${input.mes}-${input.ano}.csv` };
      }),
  }),
});

export type AppRouter = typeof appRouter;
