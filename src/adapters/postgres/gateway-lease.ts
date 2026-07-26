const KEY = "vicissitude:discord-gateway";
interface ReservedConnection {
  unsafe(query: string): Promise<unknown[]>;
  release(): void | Promise<void>;
}
interface ReservableSql {
  reserve(): Promise<ReservedConnection>;
}

export async function acquireGatewayLease(sql: ReservableSql): Promise<{ release(): Promise<void> }> {
  const connection = await sql.reserve();
  let released = false;
  try {
    const rows = (await connection.unsafe(
      `select pg_try_advisory_lock(hashtextextended('${KEY}', 0)) as locked`,
    )) as Array<{ locked: boolean }>;
    if (!rows[0]?.locked) throw new Error("Gateway is already running");
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          await connection.unsafe(`select pg_advisory_unlock(hashtextextended('${KEY}', 0))`);
        } finally {
          await connection.release();
        }
      },
    };
  } catch (error) {
    await Promise.resolve(connection.release()).catch(() => undefined);
    throw error;
  }
}
