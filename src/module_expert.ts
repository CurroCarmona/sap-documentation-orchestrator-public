// ── Module Expert: SD Query Orchestrator ─────────────────────
// Detects process, builds query plan, executes, and synthesizes

import * as fs from "fs";
import * as path from "path";
import { QueryRequest, QueryResult, executeQuery } from "./sap_adt_client";
import {
  anonymize,
  rehydrate,
  createSessionMap,
  getSessionMap,
  SessionAnonymizationMap,
  AnonymizationRule,
  RangeBand,
} from "./sap_anonymizer";
import { callLLM } from "./alejandria";
import { AppConfig } from "./config";
import { inferExpectedTcodeByIntent, normalizeModuleCode } from "./scenario_generator";

// SAP Client interface for query execution
interface SapQueryExecutor {
  executeQuery(request: QueryRequest): Promise<QueryResult>;
}

// ── Types ────────────────────────────────────────────────────

export interface Anchor {
  category: string;
  value: string | null;
  source: "escenario" | "script" | "inferido";
  mandatory_filter: boolean;
}

export interface ProcessDetectionResult {
  module: string;
  process_family: string;
  transaction_code?: string;
  transaction_description?: string;
  confidence: "high" | "medium" | "low";
  anchors: Anchor[];
  implicit_data_needs: string[];
  skip_sap_enrichment?: boolean;
}

export interface PlannedQuery {
  id: string;
  queryGroupId: string;
  description: string;
  table: string;
  sql: string;
  sqlOriginal: string;
  wasEdited: boolean;
  priority: "mandatory" | "optional";
  dependsOn?: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: QueryResult;
}

export interface QueryPlan {
  scenarioId?: string;
  sessionId?: string;
  moduleId?: string;
  detected_process_family?: string;
  processFamily?: string;
  processFamilyName?: string;
  processDescription?: string;
  transactionCode?: string;
  transactionDescription?: string;
  detectedAnchors: Anchor[];
  queries: PlannedQuery[];
  cachedFrom?: number;
  skip_sap_enrichment?: boolean;
}

export interface ModuleExpertContext {
  scenarioText: string;
  scriptSteps?: string[];
  scenarioId: string;
  moduleId: string;
  config: AppConfig;
  localMode: boolean;
}

export interface EnrichedContext {
  scenarioId: string;
  dataFound: Record<string, any>[];
  anonymizationMap: SessionAnonymizationMap;
  stats: {
    queriesExecuted: number;
    rowsFound: number;
    errors: number;
  };
}

export interface SynthesisResult {
  scenarioId: string;
  keyInputData: Record<string, any>;
  synthesizedText: string;
  rehydratedForTester?: string;
}

// ── Module Config Cache ──────────────────────────────────────

let moduleConfigCache: Record<string, any> = {};
let queryConfigCache: Record<string, any> = {};

function mergeAnchors(primary: Anchor[], secondary: Anchor[]): Anchor[] {
  const merged: Anchor[] = [];
  const seen = new Set<string>();

  for (const anchor of [...primary, ...secondary]) {
    if (!anchor || !anchor.category || !anchor.value) continue;
    const key = `${anchor.category}::${String(anchor.value).toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(anchor);
  }

  return merged;
}

function detectAnchorSource(value: string, scenarioText: string): Anchor["source"] {
  return scenarioText.toUpperCase().includes(String(value).toUpperCase())
    ? "escenario"
    : "script";
}

function extractAnchorsFromText(context: ModuleExpertContext): Anchor[] {
  const scenarioText = String(context.scenarioText || "");
  const extraText = Array.isArray(context.scriptSteps) ? context.scriptSteps.join("\n") : "";
  const combinedText = [scenarioText, extraText].filter(Boolean).join("\n");
  const anchors: Anchor[] = [];

  const patterns: Array<{ category: string; regexes: RegExp[] }> = [
    {
      category: "order_type",
      regexes: [
        /(?:order type|tipo de pedido|document type|auart)[^A-Z0-9]{0,20}([A-Z][A-Z0-9]{1,5})/i,
        /\btipo\s+([A-Z][A-Z0-9]{1,5})\b/i
      ]
    },
    {
      category: "customer_id",
      regexes: [
        /(?:customer|cliente|kunnr)[^A-Z0-9]{0,20}([A-Z0-9]{6,12})/i
      ]
    },
    {
      category: "sales_org",
      regexes: [
        /(?:sales organization|sales org|organizaci[oó]n de ventas|vkorg)[^A-Z0-9]{0,20}([0-9]{4})/i
      ]
    },
    {
      category: "plant",
      regexes: [
        /(?:plant|werks|centro)[^A-Z0-9]{0,20}([0-9]{4})/i
      ]
    },
    {
      category: "material_id",
      regexes: [
        /(?:material|matnr)[^A-Z0-9]{0,20}([A-Z0-9\-]{6,24})/i
      ]
    }
  ];

  for (const pattern of patterns) {
    for (const regex of pattern.regexes) {
      const match = combinedText.match(regex);
      const rawValue = match?.[1] ? String(match[1]).trim() : "";
      if (!rawValue) continue;
      anchors.push({
        category: pattern.category,
        value: rawValue.toUpperCase(),
        source: detectAnchorSource(rawValue, scenarioText),
        mandatory_filter: true,
      });
      break;
    }
  }

  return anchors;
}

function buildSalesOrgFallbackQuery(
  detection: ProcessDetectionResult,
  context: ModuleExpertContext
): PlannedQuery | null {
  if (context.moduleId !== "SD" || detection.process_family !== "order_to_cash") {
    return null;
  }

  const salesOrg = detection.anchors.find(a => a.category === "sales_org" && a.value)?.value;
  if (!salesOrg) {
    return null;
  }

  const filters = [
    `VKORG = '${salesOrg}'`,
    `ERDAT >= ADD_DAYS(CURRENT_DATE, -30)`
  ];
  const orderType = detection.anchors.find(a => a.category === "order_type" && a.value)?.value;
  const customerId = detection.anchors.find(a => a.category === "customer_id" && a.value)?.value;

  if (orderType) filters.unshift(`AUART = '${orderType}'`);
  if (customerId) filters.push(`KUNNR = '${customerId}'`);

  return {
    id: "query_fallback_1",
    queryGroupId: "sales_order_sample_by_sales_org",
    description: "Pedido de ejemplo reciente por organizacion de ventas",
    table: "VBAK",
    sql: `SELECT VBELN, AUART, VKORG, VTWEG, SPART, KUNNR, ERDAT, ERNAM, VKBUR, VKGRP FROM VBAK WHERE ${filters.join(" AND ")} ORDER BY ERDAT DESC`,
    sqlOriginal: `SELECT VBELN, AUART, VKORG, VTWEG, SPART, KUNNR, ERDAT, ERNAM, VKBUR, VKGRP FROM VBAK WHERE ${filters.join(" AND ")} ORDER BY ERDAT DESC`,
    wasEdited: false,
    priority: "optional",
    status: "pending",
  };
}

function loadModuleConfig(moduleId: string): any {
  if (moduleConfigCache[moduleId]) {
    return moduleConfigCache[moduleId];
  }

  const configPath = path.join(process.cwd(), "module_experts", `${moduleId}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Module config not found: ${moduleId}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  moduleConfigCache[moduleId] = config;
  return config;
}

function loadQueryConfig(moduleId: string): any {
  if (queryConfigCache[moduleId]) {
    return queryConfigCache[moduleId];
  }

  const configPath = path.join(
    process.cwd(),
    "module_experts",
    `${moduleId}_queries.json`
  );
  if (!fs.existsSync(configPath)) {
    throw new Error(`Query config not found: ${moduleId}_queries.json`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  queryConfigCache[moduleId] = config;
  return config;
}

// ── Phase 1: Detect Process & Anchors ────────────────────────

export async function detectProcess(
  context: ModuleExpertContext
): Promise<ProcessDetectionResult> {
  const moduleConfig = loadModuleConfig(context.moduleId);
  const queryConfig = loadQueryConfig(context.moduleId);

  const processFamilies = Object.keys(queryConfig.process_families || {});

  // PRE-DETECTION: Use rule-based inference first (more reliable than LLM)
  const scenarioText = context.scenarioText || "";
  
  console.log(`[Module Expert] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[Module Expert] Analyzing scenario text:`);
  console.log(`[Module Expert] "${scenarioText}"`);
  console.log(`[Module Expert] Module: ${context.moduleId}`);
  
  const inferredTcode = inferExpectedTcodeByIntent(scenarioText, context.moduleId);
  
  console.log(`[Module Expert] Rule-based detection result: ${inferredTcode || "❌ NONE DETECTED"}`);
  console.log(`[Module Expert] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Build transaction catalog for prompt
  let transactionCatalog = "";
  for (const familyKey in queryConfig.process_families) {
    const family = queryConfig.process_families[familyKey];
    transactionCatalog += `\n**${family.name}** (${familyKey}):\n`;
    if (family.transactions && family.transactions.length > 0) {
      family.transactions.forEach((tx: any) => {
        transactionCatalog += `  - ${tx.code}: ${tx.description}\n`;
        if (tx.keywords && tx.keywords.length > 0) {
          transactionCatalog += `    Keywords: ${tx.keywords.join(", ")}\n`;
        }
      });
    }
  }

  // Build expected anchors guide
  const anchorGuide = `
ANCLAS ESPERADAS POR PROCESO:
- **Pedidos de venta (VA**)**: 
  - order_type (AUART): Tipo de pedido (ej: ZOR, ZTAN, TA, ZVP2)
  - customer_id (KUNNR): Cliente (ej: 1000567, DTCE*)
  - sales_org (VKORG): Organización de ventas (ej: 1000, 2000)
  - material_id (MATNR): Material (opcional)
  
- **Entregas (VL**)**: 
  - delivery_number (VBELN): Número de entrega (si se menciona)
  - customer_id (KUNNR): Cliente
  - sales_org (VKORG): Organización de ventas
  
- **Facturas (VF**)**: 
  - billing_number (VBELN): Número de factura (si se menciona)
  - customer_id (KUNNR): Cliente
  - sales_org (VKORG): Organización de ventas
  
- **Ofertas (VA2*)**: 
  - customer_id (KUNNR): Cliente
  - sales_org (VKORG): Organización de ventas
  - material_id (MATNR): Material (opcional)
`;

  const prompt = `
Eres un experto en SAP módulo ${context.moduleId}.

${inferredTcode ? `NOTA: Sistema pre-detectó transacción ${inferredTcode} usando reglas. Valida si es correcta.` : ""}

TRANSACCIONES DISPONIBLES:
${transactionCatalog}
${anchorGuide}

Analiza el siguiente escenario de prueba y detecta:
1. **Transacción SAP exacta** mencionada o implícita (código como VA01, VL01N, VF01, etc.)
2. **Familia de proceso** correspondiente
3. **Anclas** (valores clave mencionados explícitamente: tipo pedido, cliente, material, etc.)
4. **Nivel de confianza**: 
   - "high" si el escenario menciona explícitamente la transacción o describe claramente la operación
   - "medium" si la operación está clara pero la transacción es inferida
   - "medium" si puedes inferir la transacción por contexto
   - "low" si no está claro

ESCENARIO:
${context.scenarioText}

${
    context.scriptSteps
      ? `STEPS DEL SCRIPT:\n${context.scriptSteps.join("\n")}`
      : ""
  }

REGLAS CRÍTICAS:
1. **Identificación de transacción**:
   - Si el escenario menciona "crear", "alta", "nuevo" → transacciones *01 (VA01, VL01N, VF01)
   - Si menciona "modificar", "cambiar", "editar" → transacciones *02 (VA02, VL02N, VF02)
   - Si menciona "visualizar", "consultar", "display" → transacciones *03 (VA03, VL03N, VF03)
   - Si menciona "pedido de venta", "sales order" → familia order_to_cash, transacción VA**
   - Si menciona "entrega", "delivery" → familia delivery, transacción VL**
   - Si menciona "factura", "billing", "invoice" → familia billing, transacción VF**
   - Si menciona "oferta", "quotation" → familia quotation, transacción VA2*

2. **Extracción de anclas** (CRÍTICO - SIN ANCLAS NO SE EJECUTAN QUERIES):
   - **OBLIGATORIO**: Debes encontrar AL MENOS UNA ancla con valor específico
   - Busca valores exactos mencionados en el texto:
     * Tipos de documento: "tipo ZOR", "tipo de pedido ZTAN", "AUART = ZVP2"
     * Clientes: "cliente 1000567", "KUNNR DTCE020700", "customer 5000123"
     * Números de documento: "pedido 5019765709", "delivery 8012345678"
     * Materiales: "material 100-400", "MATNR 000000000030001234"
   - **NUNCA inventes valores** - si no ves un valor específico, NO lo incluyas
   - Marca mandatory_filter=true SOLO para anclas con valor explícito
   - Si el escenario es genérico sin valores específicos → confidence="low"

3. **Nivel de confianza**:
   - **"high"** SOLO si se cumplen AMBAS condiciones:
     * Transacción clara (mencionada o inferible sin duda)
     * AL MENOS UNA ancla con valor específico encontrada
   - **"medium"** si falta transacción clara O faltan anclas
   - **"low"** si el escenario es genérico sin valores específicos

**IMPORTANTE**: Queries sin anclas específicas retornarían millones de registros inútiles y podrían colapsar el sistema SAP. Si dudas o no encuentras valores específicos → confidence="low" o "medium".

Responde en JSON con esta estructura EXACTA:
{
  "module": "${context.moduleId}",
  "process_family": "order_to_cash",
  "transaction_code": "VA01",
  "transaction_description": "Create Sales Order",
  "confidence": "high",
  "anchors": [
    {
      "category": "order_type",
      "value": "ZOR",
      "source": "escenario",
      "mandatory_filter": true
    }
  ],
  "implicit_data_needs": ["customer_master", "material_master"]
}
`.trim();

  const response = await callLLM(
    prompt,
    context.config,
    3000,
    undefined,
    undefined,
    "module_expert_detect_process"
  );

  // Parse JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse process detection response");
  }

  const detection: ProcessDetectionResult = JSON.parse(jsonMatch[0]);
  detection.anchors = Array.isArray(detection.anchors) ? detection.anchors : [];
  detection.implicit_data_needs = Array.isArray(detection.implicit_data_needs) ? detection.implicit_data_needs : [];

  const extractedAnchors = extractAnchorsFromText(context);
  if (extractedAnchors.length > 0) {
    detection.anchors = mergeAnchors(extractedAnchors, detection.anchors);
    console.log(
      `[Module Expert] Deterministic anchor extraction found: ${extractedAnchors.map(a => `${a.category}=${a.value}`).join(", ")}`
    );
  }

  // ALWAYS use rule-based detection if available (more reliable than LLM)
  if (inferredTcode) {
    console.log(`[Module Expert] ✓ Rule-based detection found: ${inferredTcode}`);
    detection.transaction_code = inferredTcode;
    // Upgrade confidence - rules are reliable
    if (detection.confidence === "low") {
      detection.confidence = "medium";
      console.log(`[Module Expert] ✓ Upgraded confidence from low to medium (rule-based)`);
    }
  }

  // FLEXIBLE VALIDATION: If we have rule-based tcode OR scenario text, continue
  // Only reject if truly insufficient information
  if (detection.confidence === "low" && !inferredTcode) {
    // If we have scenario text, upgrade to medium and continue
    // The system will decide later if SAP enrichment is possible based on anchors
    if (scenarioText.length > 10) {
      console.log(`[Module Expert] ⚠ Low confidence but scenario has text - upgrading to medium and continuing`);
      detection.confidence = "medium";
      // If LLM didn't provide transaction, try to infer a generic one based on keywords
      if (!detection.transaction_code) {
        console.log(`[Module Expert] ⚠ No transaction detected - system will skip SAP enrichment`);
        detection.skip_sap_enrichment = true;
      }
    } else {
      throw new Error(
        `Escenario no suficientemente claro para identificar transacción SAP con certeza. ` +
        `Confianza detectada: ${detection.confidence}. ` +
        `Por favor, especifica claramente la transacción (ej: VA01, VL01N, VF01) o la operación (crear pedido, modificar entrega, etc.)`
      );
    }
  }

  // Validate transaction code is provided
  if (!detection.transaction_code) {
    throw new Error(
      `No se pudo identificar el código de transacción SAP. ` +
      `Por favor, especifica la transacción exacta en el escenario (ej: VA01, VL01N, VF01)`
    );
  }

  // Check for mandatory anchors - but don't fail if missing
  // If no anchors found, we'll return empty plan and continue with normal generation
  const mandatoryAnchors = detection.anchors.filter(a => a.mandatory_filter && a.value);

  if (mandatoryAnchors.length > 0 && detection.confidence !== "high") {
    detection.confidence = inferredTcode || detection.transaction_code ? "high" : "medium";
  }
  
  if (mandatoryAnchors.length === 0) {
    console.log(`[Module Expert] No anchors detected - will skip SAP enrichment`);
    // Don't throw error - just flag it for later
    detection.skip_sap_enrichment = true;
  } else {
    console.log(`[Module Expert] Detected ${mandatoryAnchors.length} mandatory anchors:`, 
      mandatoryAnchors.map(a => `${a.category}=${a.value}`).join(", "));
  }

  return detection;
}

// ── Phase 2: Build Query Plan ────────────────────────────────

export function buildQueryPlan(
  detection: ProcessDetectionResult,
  context: ModuleExpertContext
): QueryPlan {
  const moduleConfig = loadModuleConfig(context.moduleId);
  const queryConfig = loadQueryConfig(context.moduleId);

  // If no anchors or no valid process family, return empty plan (skip SAP enrichment)
  if (detection.skip_sap_enrichment || detection.process_family === "N/A") {
    console.log(`[Module Expert] Skipping query plan - skip_sap_enrichment: ${detection.skip_sap_enrichment}, process_family: ${detection.process_family}`);
    return {
      sessionId: context.scenarioId,
      detected_process_family: detection.process_family || "N/A",
      transactionCode: detection.transaction_code || "Unknown",
      processFamilyName: detection.process_family || "N/A",
      queries: [],
      detectedAnchors: detection.anchors,
      skip_sap_enrichment: true
    };
  }

  const processFamily = queryConfig.process_families[detection.process_family];
  if (!processFamily) {
    throw new Error(`Unknown process family: ${detection.process_family}`);
  }

  const queryGroups = [
    ...processFamily.query_groups,
    ...detection.implicit_data_needs,
  ];

  const queries: PlannedQuery[] = [];
  let queryIndex = 1;

  for (const groupId of queryGroups) {
    const groupDef = queryConfig.query_groups[groupId];
    if (!groupDef) continue;

    try {
      const sql = buildSqlFromTemplate(groupDef, detection.anchors, moduleConfig, queryConfig);

      queries.push({
        id: `query_${queryIndex++}`,
        queryGroupId: groupId,
        description: groupDef.description || groupId,
        table: groupDef.table || "UNKNOWN",
        sql,
        sqlOriginal: sql,
        wasEdited: false,
        priority: groupDef.priority || "optional",
        dependsOn: groupDef.depends_on,
        status: "pending",
      });
    } catch (err: any) {
      // Skip queries that can't satisfy mandatory filters (e.g., VBAP needs VBELN for creation scenarios)
      console.log(`[Module Expert] Skipping query ${groupId}: ${err.message}`);
      continue;
    }
  }

  // If no queries could be built (all required mandatory filters not available), skip SAP enrichment
  if (queries.length === 0) {
    const fallbackQuery = buildSalesOrgFallbackQuery(detection, context);
    if (fallbackQuery) {
      console.log(`[Module Expert] Using fallback sales-order sample query for sales_org anchor`);
      return {
        scenarioId: context.scenarioId,
        moduleId: context.moduleId,
        processFamily: detection.process_family,
        processFamilyName: processFamily.name,
        processDescription: processFamily.description,
        transactionCode: detection.transaction_code,
        transactionDescription: detection.transaction_description,
        detectedAnchors: detection.anchors,
        queries: [fallbackQuery],
      };
    }

    console.log(`[Module Expert] No queries could be built - returning empty plan`);
    return {
      sessionId: context.scenarioId,
      detected_process_family: detection.process_family,
      transactionCode: detection.transaction_code,
      processFamilyName: processFamily.name,
      queries: [],
      detectedAnchors: detection.anchors,
      skip_sap_enrichment: true
    };
  }

  return {
    scenarioId: context.scenarioId,
    moduleId: context.moduleId,
    processFamily: detection.process_family,
    processFamilyName: processFamily.name,
    processDescription: processFamily.description,
    transactionCode: detection.transaction_code,
    transactionDescription: detection.transaction_description,
    detectedAnchors: detection.anchors,
    queries,
  };
}

function buildSqlFromTemplate(
  groupDef: any,
  anchors: Anchor[],
  moduleConfig: any,
  queryConfig: any
): string {
  const fields = groupDef.fields.join(", ");
  const filters: string[] = [];

  // Get anchor field mapping
  const fieldMapping = queryConfig.anchor_field_mapping || {};

  // Apply anchors
  for (const anchor of anchors) {
    // Map category to SAP field name
    const sapFieldName = fieldMapping[anchor.category] || anchor.category.toUpperCase();
    
    if (
      groupDef.filter_strategy?.anchor_fields?.includes(sapFieldName) &&
      anchor.value
    ) {
      filters.push(`${sapFieldName} = '${anchor.value}'`);
    }
  }

  // CRITICAL: Check if we have mandatory filters
  const hasMandatoryFilter = groupDef.filter_strategy?.mandatory_filters?.some(
    (field: string) => filters.some(f => f.startsWith(field))
  );

  // If this query requires mandatory filters but we don't have them, throw error
  // We should NEVER execute generic queries without specific filters
  if (groupDef.filter_strategy?.mandatory_filters && !hasMandatoryFilter) {
    throw new Error(
      `Query para tabla ${groupDef.table} requiere filtros obligatorios ` +
      `(${groupDef.filter_strategy.mandatory_filters.join(", ")}). ` +
      `No se encontraron valores específicos en el escenario. ` +
      `Queries genéricas sin filtros específicos retornarían millones de registros.`
    );
  }

  // Apply date filter only if we already have specific filters
  // NEVER use date-only filtering - it's too generic
  if (filters.length > 0 && groupDef.filter_strategy?.date_field) {
    const days = groupDef.filter_strategy.date_range_days || 90;
    filters.push(
      `${groupDef.filter_strategy.date_field} >= ADD_DAYS(CURRENT_DATE, -${days})`
    );
  }

  // Apply module defaults as additional filter (not primary)
  if (moduleConfig.defaults?.sales_org && groupDef.fields.includes("VKORG") && filters.length > 0) {
    filters.push(`VKORG = '${moduleConfig.defaults.sales_org}'`);
  }

  if (filters.length === 0) {
    throw new Error(
      `No se pudieron construir filtros para la query de tabla ${groupDef.table}. ` +
      `El escenario debe proporcionar valores específicos para ejecutar queries precisas.`
    );
  }

  const whereClause = filters.join(" AND ");
  const sql = groupDef.sql_template
    .replace("{fields}", fields)
    .replace("{filters}", whereClause);

  return sql;
}

// ── Phase 3: Execute Plan ────────────────────────────────────

export async function executePlan(
  plan: QueryPlan,
  sapClient: SapQueryExecutor,
  context: ModuleExpertContext
): Promise<EnrichedContext> {
  const moduleConfig = loadModuleConfig(context.moduleId);
  const sessionMap = createSessionMap(context.scenarioId, context.moduleId);

  const dataFound: Record<string, any>[] = [];
  let queriesExecuted = 0;
  let rowsFound = 0;
  let errors = 0;

  // Sort queries by dependency order
  const sortedQueries = topologicalSort(plan.queries);

  for (const query of sortedQueries) {
    if (query.status !== "approved") continue;

    // Resolve dependencies
    let sql = query.sql;
    if (query.dependsOn) {
      const depQuery = plan.queries.find((q) => q.queryGroupId === query.dependsOn);
      if (depQuery?.result?.rows?.[0]) {
        const joinKey = depQuery.result.rows[0][depQuery.table.toUpperCase()];
        sql = sql.replace(/\{resultado #\d+\}/g, `'${joinKey}'`);
      }
    }

    // Execute query
    const request: QueryRequest = {
      sql,
      maxRows: 5,
      queryGroupId: query.queryGroupId,
      scenarioId: context.scenarioId,
    };

    const result = await sapClient.executeQuery(request);
    query.result = result;

    if (result.success) {
      query.status = "executed";
      queriesExecuted++;
      rowsFound += result.rowCount;

      // Anonymize results
      const anonymizeResult = anonymize({
        rows: result.rows,
        rules: moduleConfig.anonymization?.rules || [],
        sessionMap,
        rangeBands: moduleConfig.anonymization?.range_bands,
      });

      dataFound.push({
        queryGroupId: query.queryGroupId,
        description: query.description,
        rows: anonymizeResult.rows,
      });
    } else {
      query.status = "failed";
      errors++;
    }
  }

  return {
    scenarioId: context.scenarioId,
    dataFound,
    anonymizationMap: sessionMap,
    stats: {
      queriesExecuted,
      rowsFound,
      errors,
    },
  };
}

function topologicalSort(queries: PlannedQuery[]): PlannedQuery[] {
  const sorted: PlannedQuery[] = [];
  const visited = new Set<string>();

  function visit(query: PlannedQuery) {
    if (visited.has(query.id)) return;

    if (query.dependsOn) {
      const dep = queries.find((q) => q.queryGroupId === query.dependsOn);
      if (dep) visit(dep);
    }

    visited.add(query.id);
    sorted.push(query);
  }

  for (const query of queries) {
    visit(query);
  }

  return sorted;
}

// ── Phase 4: Synthesize ──────────────────────────────────────

export async function synthesize(
  enrichedContext: EnrichedContext,
  originalScenario: string,
  scriptSteps: string[],
  config: AppConfig,
  localMode: boolean
): Promise<SynthesisResult> {
  const dataContext = enrichedContext.dataFound
    .map((group) => {
      const rows = group.rows
        .map((row) =>
          Object.entries(row)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        )
        .join("\n    ");
      return `${group.description}:\n    ${rows}`;
    })
    .join("\n\n");

  const prompt = `
Eres un experto en SAP. Basándote en los datos reales encontrados en el sistema, proporciona valores concretos para el input data de cada step del test scenario.

ESCENARIO ORIGINAL:
${originalScenario}

STEPS DEL SCRIPT:
${scriptSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

DATOS ENCONTRADOS EN SAP:
${dataContext}

TAREA:
Por cada step que requiera input data, proporciona los valores concretos encontrados.
Usa los identificadores tal como aparecen en los datos.
Si un campo no tiene dato, indica: [pendiente — validar en sistema]

Responde en formato claro y estructurado.
`.trim();

  const response = await callLLM(
    prompt,
    config,
    3000,
    undefined,
    undefined,
    "module_expert_synthesize"
  );

  let rehydratedForTester: string | undefined;
  if (localMode) {
    const rehydrateResult = rehydrate({
      text: response,
      sessionMap: enrichedContext.anonymizationMap,
    });
    rehydratedForTester = rehydrateResult.text;
  }

  return {
    scenarioId: enrichedContext.scenarioId,
    keyInputData: {},
    synthesizedText: response,
    rehydratedForTester,
  };
}

// ── Main Orchestrator ────────────────────────────────────────

export async function orchestrateModuleExpert(
  context: ModuleExpertContext,
  sapClient: SapQueryExecutor
): Promise<{
  plan: QueryPlan;
  enrichedContext?: EnrichedContext;
  synthesis?: SynthesisResult;
}> {
  // Phase 1: Detect
  const detection = await detectProcess(context);

  // Phase 2: Build Plan
  const plan = buildQueryPlan(detection, context);

  return { plan };
}

export async function executeModuleExpertPlan(
  plan: QueryPlan,
  sapClient: SapQueryExecutor,
  context: ModuleExpertContext
): Promise<{
  enrichedContext: EnrichedContext;
  synthesis: SynthesisResult;
}> {
  // Phase 3: Execute
  const enrichedContext = await executePlan(plan, sapClient, context);

  // Phase 4: Synthesize
  const synthesis = await synthesize(
    enrichedContext,
    context.scenarioText,
    context.scriptSteps || [],
    context.config,
    context.localMode
  );

  return { enrichedContext, synthesis };
}
