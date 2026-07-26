import { createServer, type Server } from "node:http";

export interface HealthState {
  ready: boolean;
  details?: Record<string, unknown>;
}
export function createHealthServer(initial: HealthState = { ready: false }) {
  let state = initial;
  let server: Server | undefined;
  return {
    setReady(ready: boolean, details?: Record<string, unknown>) {
      state = details ? { ready, details } : { ready };
    },
    listen(port: number, host = "127.0.0.1"): Promise<Server> {
      server = createServer((request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.end();
          return;
        }
        const status = request.url === "/live" ? 200 : request.url === "/ready" ? (state.ready ? 200 : 503) : 404;
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            healthy: status === 200,
            ready: state.ready,
            ...(state.details ? { details: state.details } : {}),
          }),
        );
      });
      return new Promise((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, () => resolve(server!));
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
