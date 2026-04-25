import { loadConfig } from "../src/config";
import { listDFSourcesWithFDStatus } from "../src/fd_generator";

const config = loadConfig();
const items = listDFSourcesWithFDStatus(config);

console.log("=== DF SOURCES VALIDATION ===");
console.log(`Total sources: ${items.length}`);

const missing = items.filter(i => !i.hasFD);
const ready = items.filter(i => i.hasFD);

console.log(`Ready (with FD): ${ready.length}`);
console.log(`Missing FD: ${missing.length}`);
