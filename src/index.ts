import { startGateway } from "./gateway.ts";

console.log("Starting Vicissitude...");

try {
  await startGateway();
  console.log("Vicissitude is running.");
} catch (error) {
  console.error("Failed to start:", error);
  process.exit(1);
}
