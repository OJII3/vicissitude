import postgres, { type Sql } from "postgres";

export function createPostgresClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => undefined,
  });
}
