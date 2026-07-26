import postgres, { type Sql } from "postgres";

export function createPostgresClient(databaseUrl: string): Sql {
  const parsed = new URL(databaseUrl);
  const socket = parsed.hostname.startsWith("%2F") ? decodeURIComponent(parsed.hostname) : undefined;
  const socketPort = Number(parsed.searchParams.get("port") ?? 5432);
  if (socket !== undefined) {
    parsed.hostname = "localhost";
    parsed.searchParams.delete("port");
  }
  const connectionUrl = socket === undefined ? databaseUrl : parsed.toString();
  return postgres(connectionUrl, {
    ...(socket === undefined ? {} : { host: socket, port: socketPort }),
    max: 10,
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => undefined,
  });
}
