import postgres, { type Sql } from "postgres";

export function createPostgresClient(databaseUrl: string): Sql {
  const parsed = new URL(databaseUrl);
  const socket = parsed.hostname.startsWith("%2F") ? decodeURIComponent(parsed.hostname) : undefined;
  const connectionUrl = socket === undefined ? databaseUrl : `postgresql://${parsed.username}@localhost${parsed.pathname}`;
  return postgres(connectionUrl, {
    ...(socket === undefined ? {} : { host: socket, port: Number(parsed.searchParams.get("port") ?? 5432) }),
    max: 10,
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => undefined,
  });
}
