import type { PrismaClient } from "@rw/db";

export interface PgQueryClient {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function createPgQueryClient(prisma: PrismaClient): PgQueryClient {
  return {
    async query(text, values) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values);
      return { rows: Array.isArray(rows) ? rows : [] };
    },
  };
}
