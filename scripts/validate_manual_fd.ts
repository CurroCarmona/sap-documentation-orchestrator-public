import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../src/config";
import { generateScenarios, GeneratedScenario, ScenarioCasePolicy } from "../src/scenario_generator";

function classifyCaseType(s: GeneratedScenario): "positive" | "negative" | "unknown" {
  const text = `${String(s.scenario["Tests type"] || "")} ${String(s.scenario["Test Scenario"] || "")} ${String(s.scenario["Scenario Description"] || "")} ${String(s.scenario["Expected Results"] || "")}`.toLowerCase();
  if (/(negative|error|invalid|failure|reject|denied|block|exception|incorrect|wrong|forbidden|incomplete|missing|fallo|rechazo)/i.test(text)) return "negative";
  if (/(positive|happy|success|standard|normal|valid|correct|main flow)/i.test(text)) return "positive";
  return "unknown";
}

function summarizeByTx(scenarios: GeneratedScenario[]) {
  const byTx = new Map<string, { total: number; positive: number; negative: number; unknown: number; names: string[] }>();
  for (const s of scenarios) {
    const tx = String(s.scenario["Key SAP transaction"] || "").trim().toUpperCase() || "REVIEW_TCODE";
    const t = classifyCaseType(s);
    const row = byTx.get(tx) || { total: 0, positive: 0, negative: 0, unknown: 0, names: [] };
    row.total += 1;
    row[t] += 1;
    row.names.push(String(s.scenario["Test Scenario"] || "").trim());
    byTx.set(tx, row);
  }
  return Array.from(byTx.entries()).map(([tx, data]) => ({ tx, ...data }));
}

async function runPolicy(policy: ScenarioCasePolicy) {
  const config = loadConfig();

  const supportingPath =
    process.env.SUPPORTING_DOC ||
    (config.supporting_docs_folder
      ? path.join(config.supporting_docs_folder, "Manual - Calculo automaticoTesters v2.docx")
      : "");
  const fdPath =
    process.env.FD_DOC ||
    (config.fd_folder
      ? path.join(config.fd_folder, "FD_ZSDU0176.docx")
      : "");

  if (!fs.existsSync(supportingPath)) throw new Error(`Supporting document not found: ${supportingPath}`);
  if (!fs.existsSync(fdPath)) throw new Error(`FD document not found: ${fdPath}`);

  const logs: string[] = [];
  const result = await generateScenarios(
    {
      l1: "3.- Supply Chain",
      l2: "3.3.- Sales & Operation Execution",
      l3: "3.3.1.- Customer Service & Consumer Care",
      l4: "Calculo automatico Testers",
      workstream: "SD",
      documents: [{ name: path.basename(supportingPath), path: supportingPath }],
      abapPrograms: [{ name: path.basename(fdPath), path: fdPath }],
      expertPrompt: "Prioritize transaction-level functional tests. Keep scenarios concise and non-technical.",
      existingScenarioNames: [],
      excelScenarios: undefined,
      executionMode: "supporting_plus_fd",
      dedupeMode: "flexible_transaction_intent",
      scenarioCasePolicy: policy,
      config,
    },
    (msg, type) => {
      if (type !== "progress") logs.push(`${type || "log"}: ${msg}`);
    }
  );

  const byTx = summarizeByTx(result.scenarios);
  return {
    policy,
    scenarios: result.scenarios.length,
    warnings: result.warnings,
    coverage: result.coverage,
    byTransaction: byTx,
    tracePath: result.tracePath,
    logs: logs.slice(-120),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const runPositiveOnly = await runPolicy("positive_only");
  const runPositiveNegative = await runPolicy("positive_and_negative");

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    input: {
      supportingDocument: "Manual - Calculo automaticoTesters v2.docx",
      functionalDesign: "FD_ZSDU0176.docx",
      mode: "supporting_plus_fd",
      dedupeMode: "flexible_transaction_intent",
    },
    results: {
      positive_only: runPositiveOnly,
      positive_and_negative: runPositiveNegative,
    },
  };

  const outDir = path.join(process.cwd(), "validation_reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `validation_manual_fd_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`REPORT_PATH=${outPath}`);
  console.log(`TRACE_POSITIVE_ONLY=${runPositiveOnly.tracePath}`);
  console.log(`TRACE_POSITIVE_AND_NEGATIVE=${runPositiveNegative.tracePath}`);
  console.log(`POSITIVE_ONLY_SCENARIOS=${runPositiveOnly.scenarios}`);
  console.log(`POSITIVE_AND_NEGATIVE_SCENARIOS=${runPositiveNegative.scenarios}`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
