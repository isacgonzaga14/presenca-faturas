import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getUserConfig, saveUserConfig,
  getUserMeses, upsertUserMes, deleteUserMes,
} from "./db";
import { storagePut } from "./storage";
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
      return {
        empresaNome: cfg.empresaNome,
        empresaNif: cfg.empresaNif,
        empresaMorada: cfg.empresaMorada,
        tipos: JSON.parse(cfg.tiposJson) as string[],
      };
    }),

    save: protectedProcedure
      .input(z.object({
        empresaNome: z.string().min(1),
        empresaNif: z.string().min(1),
        empresaMorada: z.string(),
        tipos: z.array(z.string()),
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

  // ─── Ficheiros (upload para S3) ────────────────────────────────────────────
  ficheiros: router({
    upload: protectedProcedure
      .input(z.object({
        nomeOriginal: z.string(),
        mimeType: z.string(),
        dadosBase64: z.string(), // ficheiro em base64
        movId: z.string(),       // ID do movimento associado
      }))
      .mutation(async ({ ctx, input }) => {
        const ext = input.nomeOriginal.split(".").pop() || "bin";
        const key = `user-${ctx.user.id}/ficheiros/${input.movId}-${Date.now()}.${ext}`;
        const buffer = Buffer.from(input.dadosBase64, "base64");
        const { url } = await storagePut(key, buffer, input.mimeType);
        return { key, url, nome: input.nomeOriginal };
      }),
  }),

  // ─── Análise de PDFs com IA ───────────────────────────────────────────────
  documentos: router(
{
    // Analisa um PDF (base64) e extrai dados estruturados
    analisar: protectedProcedure
      .input(z.object({
        nomeOriginal: z.string(),
        mimeType: z.string(),
        dadosBase64: z.string(),
      }))
      .mutation(async ({ input }) => {
        const dataUrl = `data:${input.mimeType};base64,${input.dadosBase64}`;

        const prompt = `Analisa este documento PDF (fatura ou recibo verde português) e extrai os seguintes dados em JSON.

Regras:
- "tipo": "FATURA" se for uma fatura-recibo emitida por empresa, "RECIBO_VERDE" se for emitida pela AT (Autoridade Tributária)
- "numeroDocumento": número da fatura/recibo (ex: "FR M/442" ou "FR ATSIRE01FR/14")
- "inst": número INST mencionado no texto da designação/descrição (apenas os dígitos, ex: "163"). Se não houver INST, retorna null.
- "nomePrestador": nome completo de quem emitiu o documento
- "nomeCliente": nome de quem recebeu o serviço
- "valor": valor total a pagar (número, sem símbolo de moeda)
- "mesServico": mês a que se refere o serviço prestado (em português minúsculas, ex: "fevereiro")
- "anoServico": ano do serviço (número, ex: 2026)
- "dataEmissao": data de emissão no formato DD-MM-YYYY

Responde APENAS com JSON válido, sem markdown, sem explicações.`;

        // Usar file_url para PDFs, image_url para imagens
        const isPdf = input.mimeType === "application/pdf";
        const contentItem = isPdf
          ? { type: "file_url" as const, file_url: { url: dataUrl, mime_type: "application/pdf" as const } }
          : { type: "image_url" as const, image_url: { url: dataUrl, detail: "high" as const } };

        const response = await invokeLLM({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                contentItem,
              ],
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "documento_fiscal",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  tipo:            { type: "string" },
                  numeroDocumento: { type: "string" },
                  inst:            { type: ["string", "null"] },
                  nomePrestador:   { type: "string" },
                  nomeCliente:     { type: "string" },
                  valor:           { type: "number" },
                  mesServico:      { type: "string" },
                  anoServico:      { type: "number" },
                  dataEmissao:     { type: "string" },
                },
                required: ["tipo","numeroDocumento","inst","nomePrestador","nomeCliente","valor","mesServico","anoServico","dataEmissao"],
                additionalProperties: false,
              },
            },
          },
        });

        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error("IA não devolveu resposta");

        const dados = typeof content === "string" ? JSON.parse(content) : content;

        // Guardar o ficheiro em S3
        const ext = input.nomeOriginal.split(".").pop() || "pdf";
        const key = `documentos/${Date.now()}-${input.nomeOriginal.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const buffer = Buffer.from(input.dadosBase64, "base64");
        const { url } = await storagePut(key, buffer, input.mimeType);

        return {
          ...dados,
          arquivoKey: key,
          arquivoUrl: url,
          arquivoNome: input.nomeOriginal,
        };
      }),

    // Gera relatório para contabilista em texto formatado
    gerarRelatorio: protectedProcedure
      .input(z.object({
        mes: z.string(),
        ano: z.number(),
        movimentosJson: z.string(),
        correspondenciasJson: z.string(), // JSON array de correspondências confirmadas
        empresaNome: z.string(),
        empresaNif: z.string(),
        empresaMorada: z.string(),
      }))
      .mutation(async ({ input }) => {
        const movimentos = JSON.parse(input.movimentosJson) as Array<{
          id: string; data: string; descricao: string; valor: number;
          tipo: string; descricaoFatura: string; nomeFatura: string;
          inst?: string; arquivoKey?: string; arquivoUrl?: string; arquivoNome?: string;
        }>;

        const correspondencias = JSON.parse(input.correspondenciasJson) as Array<{
          movId: string;
          numeroDocumento: string;
          nomePrestador: string;
          valor: number;
          mesServico: string;
          anoServico: number;
          arquivoUrl?: string;
          arquivoNome?: string;
          tipo: string; // FATURA | RECIBO_VERDE
        }>;

        const fmt = (v: number) =>
          new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

        const dataRelatorio = new Date().toLocaleDateString("pt-PT");
        let rel = "";
        rel += `RELATÓRIO MENSAL — ${input.mes.toUpperCase()} ${input.ano}\n`;
        rel += `Gerado em: ${dataRelatorio}\n`;
        rel += `Empresa: ${input.empresaNome} | NIF: ${input.empresaNif}\n`;
        rel += `${input.empresaMorada}\n`;
        rel += `${"-".repeat(60)}\n\n`;

        // Faturas
        const faturas = correspondencias.filter(c => c.tipo === "FATURA");
        if (faturas.length > 0) {
          rel += `FATURAS EMITIDAS (${faturas.length})\n`;
          rel += `${"-".repeat(40)}\n`;
          for (const c of faturas) {
            const mov = movimentos.find(m => m.id === c.movId);
            rel += `Doc: ${c.numeroDocumento}\n`;
            rel += `Prestador: ${c.nomePrestador}\n`;
            rel += `Valor: ${fmt(c.valor)}\n`;
            rel += `Serviço: ${c.mesServico} ${c.anoServico}\n`;
            if (mov) {
              rel += `Extrato: ${mov.data} | ${mov.descricao.slice(0, 50)}\n`;
              if (mov.inst) rel += `INST: ${mov.inst}\n`;
            }
            if (c.arquivoUrl) rel += `Arquivo: ${c.arquivoUrl}\n`;
            rel += `\n`;
          }
        }

        // Recibos Verdes
        const recibos = correspondencias.filter(c => c.tipo === "RECIBO_VERDE");
        if (recibos.length > 0) {
          rel += `RECIBOS VERDES (${recibos.length})\n`;
          rel += `${"-".repeat(40)}\n`;
          for (const c of recibos) {
            const mov = movimentos.find(m => m.id === c.movId);
            rel += `Doc: ${c.numeroDocumento}\n`;
            rel += `Prestador: ${c.nomePrestador}\n`;
            rel += `Valor: ${fmt(c.valor)}\n`;
            rel += `Serviço: ${c.mesServico} ${c.anoServico}\n`;
            if (mov) {
              rel += `Extrato: ${mov.data} | ${mov.descricao.slice(0, 50)}\n`;
            }
            if (c.arquivoUrl) rel += `Arquivo: ${c.arquivoUrl}\n`;
            rel += `\n`;
          }
        }

        // Movimentos sem correspondência
        const movSemCorr = movimentos.filter(
          m => (m.tipo === "GERAR FATURA" || m.tipo === "RECIBO VERDE") &&
               !correspondencias.find(c => c.movId === m.id)
        );
        if (movSemCorr.length > 0) {
          rel += `SEM DOCUMENTO ASSOCIADO (${movSemCorr.length})\n`;
          rel += `${"-".repeat(40)}\n`;
          for (const m of movSemCorr) {
            rel += `${m.data} | ${m.tipo} | ${fmt(m.valor)} | ${m.descricao.slice(0, 50)}\n`;
          }
          rel += `\n`;
        }

        // Totais
        const totalFaturas = faturas.reduce((s, c) => s + c.valor, 0);
        const totalRecibos = recibos.reduce((s, c) => s + c.valor, 0);
        rel += `${"-".repeat(60)}\n`;
        rel += `TOTAIS\n`;
        rel += `Faturas: ${fmt(totalFaturas)}\n`;
        rel += `Recibos Verdes: ${fmt(totalRecibos)}\n`;
        rel += `Total geral: ${fmt(totalFaturas + totalRecibos)}\n`;

        return { relatorio: rel };
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
        documentos: JSON.parse(r.documentosJson ?? "[]"),
        correspondencias: JSON.parse(r.correspondenciasJson ?? "[]"),
      }));
    }),

    save: protectedProcedure
      .input(z.object({
        mes: z.string(),
        ano: z.number(),
        movimentosJson: z.string(),
        docGerado: z.string(),
        finalizado: z.boolean(),
        documentosJson: z.string().optional(),
        correspondenciasJson: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await upsertUserMes(ctx.user.id, input.mes, input.ano, {
          movimentosJson: input.movimentosJson,
          docGerado: input.docGerado,
          finalizado: input.finalizado,
          documentosJson: input.documentosJson,
          correspondenciasJson: input.correspondenciasJson,
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
});

export type AppRouter = typeof appRouter;
