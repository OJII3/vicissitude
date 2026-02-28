import { bootstrap } from "./composition-root.ts";

console.log("Starting Vicissitude...");

try {
	await bootstrap();
	console.log("Vicissitude is running.");
} catch (error) {
	console.error("Failed to start:", error);
	process.exit(1);
}
