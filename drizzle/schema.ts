import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Configurações da empresa por utilizador
export const userConfig = mysqlTable("user_config", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  empresaNome: varchar("empresaNome", { length: 255 }).notNull().default("PRESENÇOBRIGATÓRIA - UNIPESSOAL LDA"),
  empresaNif: varchar("empresaNif", { length: 20 }).notNull().default("518604870"),
  empresaMorada: varchar("empresaMorada", { length: 500 }).notNull().default("Rua Miguel Pais, Nº 46, 1º F, Barreiro, 2830-356, Portugal"),
  // JSON array de tipos de movimento
  tiposJson: text("tiposJson").notNull().default('["FATURA","COMPRA","RECIBO VERDE","RECIBO","MANUT. CONTA","AVENÇA CONT.","RECEBIMENTO","SEG. SOCIAL","IVA"]'),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UserConfig = typeof userConfig.$inferSelect;
export type InsertUserConfig = typeof userConfig.$inferInsert;

// Meses por utilizador (um registo por mês/ano)
export const userMes = mysqlTable("user_mes", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  mes: varchar("mes", { length: 20 }).notNull(),
  ano: int("ano").notNull(),
  // JSON com array de movimentos
  movimentosJson: text("movimentosJson").notNull().default("[]"),
  docGerado: text("docGerado").notNull().default(""),
  finalizado: boolean("finalizado").notNull().default(false),
  // JSON com documentos analisados e correspondências confirmadas
  documentosJson: text("documentosJson").notNull().default("[]"),
  correspondenciasJson: text("correspondenciasJson").notNull().default("[]"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UserMes = typeof userMes.$inferSelect;
export type InsertUserMes = typeof userMes.$inferInsert;
