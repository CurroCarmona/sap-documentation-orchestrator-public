import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../src/config";
import { generateScenarios, ScenarioCasePolicy } from "../src/scenario_generator";

async function main() {
  const config = loadConfig();
  const supportingPath =
    process.argv[2] ||
    (config.supporting_docs_folder
      ? path.join(config.supporting_docs_folder, "KT - Catalog Unit - Supply Bridge Pedidos - Diseño técnico.docx")
      : "");
  const fdPath =
    process.argv[3] ||
    (config.fd_folder
      ? path.join(config.fd_folder, "FD_METHOD_exit_vofm_main_998_.docx")
      : "");
  const policy: ScenarioCasePolicy = "positive_only";

  if (!fs.existsSync(supportingPath)) throw new Error(`Supporting document not found: ${supportingPath}`);
  if (!fs.existsSync(fdPath)) throw new Error(`FD document not found: ${fdPath}`);

  const config = loadConfig();

  const result = await generateScenarios(
    {
      l1: "3.- Supply Chain",
      l2: "3.3.- Sales & Operation Execution",
      l3: "3.3.1.- Customer Service & Consumer Care",
      l4: "Supply Bridge Pedidos",
      workstream: "SD",
      documents: [{ name: path.basename(supportingPath), path: supportingPath }],
      abapPrograms: [{ name: path.basename(fdPath), path: fdPath }],
      expertPrompt: "Generate concise, functional transaction-oriented test scenarios. Prefer one clear positive scenario per transaction.",
      existingScenarioNames: [],
      excelScenarios: undefined,
      executionMode: "supporting_plus_fd",
      dedupeMode: "flexible_transaction_intent",
      scenarioCasePolicy: policy,
      config,
    },
    () => {}
  );

  const first = result.scenarios[0];
  if (!first) throw new Error("No scenario generated");

  const output = {
    generatedAt: new Date().toISOString(),
    input: {
      supportingDocument: supportingPath,
      functionalDesign: fdPath,
      policy,
    },
    selectedScenario: {
      testScenario: first.scenario["Test Scenario"],
      scenarioDescription: first.scenario["Scenario Description"],
      keySapTransaction: first.scenario["Key SAP transaction"],
      testsType: first.scenario["Tests type"],
      expectedResults: first.scenario["Expected Results"],
      testData: first.scenario["Test Data"],
      preConditions: first.scenario["Pre-Conditions"] || first.scenario["Preconditions"] || "",
      postConditions: first.scenario["Post-Conditions"] || first.scenario["Postconditions"] || "",
      supportingDocumentation: first.scenario["Supporting documentation"] || "",
      functionalDesign: first.scenario["Functional Design"] || "",
    },
    selectedScript: (first.scripts || []).map((s: any) => ({
      stepNumber: s["Step number"],
      sapTransactionCode: s["SAP transaction code"],
      keyProgram: s["Key Program"] || "",
      stepDescription: s["Step description"],
      expectedResult: s["Expected result"],
      keyInputData: s["Key input data"],
      comments: s["Comments"] || "",
    })),
    generatedScenariosCount: result.scenarios.length,
    coverage: result.coverage,
    warnings: result.warnings,
    tracePath: result.tracePath,
  };

  const outDir = path.join(process.cwd(), "validation_reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `single_test_scenario_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`REPORT_PATH=${outPath}`);
  console.log(`TEST_SCENARIO=${String(output.selectedScenario.testScenario || "")}`);
  console.log(`KEY_SAP_TRANSACTION=${String(output.selectedScenario.keySapTransaction || "")}`);
  console.log(`SCENARIO_DESCRIPTION=${String(output.selectedScenario.scenarioDescription || "")}`);
  console.log(`SUPPORTING_DOCUMENTATION=${String(output.selectedScenario.supportingDocumentation || "")}`);
  console.log(`FUNCTIONAL_DESIGN=${String(output.selectedScenario.functionalDesign || "")}`);
  const step1KeyProgram = Array.isArray(output.selectedScript) && output.selectedScript[0] ? output.selectedScript[0].keyProgram : "";
  console.log(`SCRIPT_KEY_PROGRAM=${step1KeyProgram}`);
  console.log(`SCRIPT_STEPS=${Array.isArray(output.selectedScript) ? output.selectedScript.length : 0}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
