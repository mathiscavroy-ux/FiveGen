// `npm run demo`: offline demo with simulated engine responses, stored apart from real data.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.FORGE_MOCK = "1";
process.env.ADMIN_EMAIL ??= "admin@demo.local";
process.env.FREE_CREDITS ??= "15";
process.env.FORGE_DATA_DIR ??= path.join(root, "data-demo");
process.env.PORT ??= "3211";

await import("./index.js");
