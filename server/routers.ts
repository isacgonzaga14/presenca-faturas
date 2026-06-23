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
  }),
});

export type AppRouter = typeof appRouter;
