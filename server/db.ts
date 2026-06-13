import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, userConfig, userMes, UserConfig, UserMes } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ─── UserConfig ─────────────────────────────────────────────

const TIPOS_PADRAO_JSON = '["GERAR FATURA","RECIBO VERDE","RECIBO","RECEBIMENTO","FATURA COMPRA","MANUTENÇÃO DE CONTA","PAGAMENTO AO ESTADO","AVENÇA CONTAB","SEGURO BANCARIO","RECIBO SALARIO"]';

export async function getUserConfig(userId: number): Promise<UserConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(userConfig).where(eq(userConfig.userId, userId)).limit(1);
  if (result.length > 0) return result[0];
  // Criar config padrão
  await db.insert(userConfig).values({
    userId,
    empresaNome: "PRESENÇOBRIGATÓRIA - UNIPESSOAL LDA",
    empresaNif: "518604870",
    empresaMorada: "Rua Miguel Pais, Nº 46, 1º F, Barreiro, 2830-356, Portugal",
    tiposJson: TIPOS_PADRAO_JSON,
  });
  const created = await db.select().from(userConfig).where(eq(userConfig.userId, userId)).limit(1);
  return created[0] ?? null;
}

export async function saveUserConfig(userId: number, data: {
  empresaNome: string;
  empresaNif: string;
  empresaMorada: string;
  tiposJson: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(userConfig).where(eq(userConfig.userId, userId)).limit(1);
  if (existing.length > 0) {
    await db.update(userConfig).set(data).where(eq(userConfig.userId, userId));
  } else {
    await db.insert(userConfig).values({ userId, ...data });
  }
}

// ─── UserMes ────────────────────────────────────────────────

export async function getUserMeses(userId: number): Promise<UserMes[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(userMes).where(eq(userMes.userId, userId));
}

export async function getUserMesItem(userId: number, mes: string, ano: number): Promise<UserMes | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(userMes)
    .where(and(eq(userMes.userId, userId), eq(userMes.mes, mes), eq(userMes.ano, ano)))
    .limit(1);
  return result[0] ?? null;
}

export async function upsertUserMes(userId: number, mes: string, ano: number, data: {
  movimentosJson: string;
  docGerado: string;
  finalizado: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await getUserMesItem(userId, mes, ano);
  if (existing) {
    await db.update(userMes).set(data)
      .where(and(eq(userMes.userId, userId), eq(userMes.mes, mes), eq(userMes.ano, ano)));
  } else {
    await db.insert(userMes).values({ userId, mes, ano, ...data });
  }
}

export async function deleteUserMes(userId: number, mes: string, ano: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(userMes)
    .where(and(eq(userMes.userId, userId), eq(userMes.mes, mes), eq(userMes.ano, ano)));
}
