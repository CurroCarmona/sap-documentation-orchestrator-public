import { loadConfig } from "../src/config";
import { generateScenarios, GenerationContext } from "../src/scenario_generator";

function arg(name: string, fallback = ""): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return String(process.argv[idx + 1]);
  return fallback;
}

(async () => {
  const config = loadConfig();

  const l3 = arg("l3", "3.3.1.- Customer Service & Consumer Care");
  const l4 = arg("l4", "Create sales order");
  const workstream = arg("workstream", "SD");
  const docPath = arg("doc", "");

  if (!docPath) {
    console.error("Usage: tsx scripts/generate_single_test_scenario.ts --doc <path-to-doc>");
    process.exit(1);
  }

  const ctx: GenerationContext = {
    l1: "3.- Supply Chain",
    l2: "3.3.- Sales & Operation Execution",
    l3,
    l4,
    workstream,
    documents: [{ name: docPath.split(/[\\/]/).pop() || docPath, path: docPath }],
    abapPrograms: [],
    expertPrompt: "",
    existingScenarioNames: [],
    executionMode: "supporting_only",
    dedupeMode: "strict_transaction",
    scenarioCasePolicy: "positive_only",
    config
  };

  console.log("Generating scenario...");
  const result = await generateScenarios(ctx, (msg, type) => {
    if (type === "progress") return;
    if (type === "partial_scenario") return;
    console.log(`[${type || "log"}] ${msg}`);
  });

  console.log(`Scenarios: ${result.scenarios.length}`);
})();