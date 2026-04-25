import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { AppConfig } from "./config";
import { callLLMMini, TraceWriter } from "./alejandria";
import { anonymize, deanonymize, anonymizationStats, setClientTerms } from "./anonymizer";
import { ragRetrieve, type RAGOptions } from "./rag";

const CACHE_DIR = path.join(process.cwd(), ".doc_cache");

// ── Types ─────────────────────────────────────────────────────
export interface DocSummary {
  fileName: string;
  hash: string;
  module: string;
  transactions: string[];
  orgElements: Record<string, string[]>;
  businessProcess: string;
  keySteps: string[];
  businessRules: string[];
  variants: string[];
  rawSummary: string;
  createdAt: string;
  tokensSaved: number;
}

// ── Cache management ──────────────────────────────────────────
function getCachePath(hash: string): string {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  return path.join(CACHE_DIR, `${hash}.json`);
}

function hashContent(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

export function getCached(content: string): DocSummary | null {
  const hash = hashContent(content);
  const cachePath = getCachePath(hash);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    } catch {
      return null;
    }
  }
  return null;
}

function saveCache(content: string, summary: DocSummary): void {
  const hash = hashContent(content);
  const cachePath = getCachePath(hash);
  summary.hash = hash;
  fs.writeFileSync(cachePath, JSON.stringify(summary, null, 2));
}

export function clearCache(): void {
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function getCacheStats(): { files: number; totalSaved: number } {
  if (!fs.existsSync(CACHE_DIR)) return { files: 0, totalSaved: 0 };
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
  let totalSaved = 0;
  files.forEach(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8"));
      totalSaved += data.tokensSaved || 0;
    } catch { /* skip corrupt entries */ }
  });
  return { files: files.length, totalSaved };
}

// ── Chunking ──────────────────────────────────────────────────
function chunkText(text: string, maxWords = 400): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
  }
  return chunks;
}

function buildRagOptions(config: AppConfig): RAGOptions {
  return {
    chunkSize: Number(config.rag_chunk_size || 800),
    chunkOverlap: Number(config.rag_chunk_overlap || 200),
    topK: Number(config.rag_top_k || 8),
    minScore: Number(config.rag_min_score || 0.05),
  };
}

function buildClientTerms(fileName: string, config: AppConfig): string[] {
  const fromConfig = Array.isArray(config.client_terms) ? config.client_terms : [];
  const fromFileName = path.basename(fileName, path.extname(fileName));
  return [...fromConfig, fromFileName].filter((value) => String(value || "").trim().length > 2);
}

// ── Main: read and summarize with cache ───────────────────────
export async function readAndSummarize(
  fileName: string,
  content: string,
  config: AppConfig,
  log: (msg: string, type?: string) => void,
  trace?: TraceWriter
): Promise<DocSummary> {
  // Check cache first
  const cached = getCached(content);
  if (cached) {
    log(`         Cache hit: ${fileName} (saved ~${cached.tokensSaved} tokens)`, "detail");
    return cached;
  }

  const originalTokens = Math.round(content.length / 4);
  log(`         Processing: ${fileName} (~${originalTokens} tokens)`, "detail");

  const securityAnonymize = config.security_anonymize !== false;
  const securityRag = config.security_rag !== false;

  setClientTerms(buildClientTerms(fileName, config));
  const anonResult = securityAnonymize ? anonymize(content) : { text: content, map: { forward: new Map<string, string>(), reverse: new Map<string, string>() } };
  if (securityAnonymize && anonResult.map.forward.size > 0) {
    log(`         Anonymization: ${anonymizationStats(anonResult.map)}`, "detail");
  }

  let contentForLlm = anonResult.text;
  if (securityRag) {
    const rag = ragRetrieve(
      [{ name: fileName, text: anonResult.text }],
      "sap transactions tcode organizational structure business process business rules variants",
      buildRagOptions(config)
    );

    if (rag.chunks.length > 0) {
      contentForLlm = rag.chunks.map((chunk) => chunk.text).join("\n\n");
      log(
        `         RAG selected ${rag.chunks.length} chunk(s), saved ~${rag.tokensSaved} tokens`,
        "detail"
      );
    }
  }

  // Chunk the document
  const chunks = chunkText(contentForLlm, 400);
  log(`         Split into ${chunks.length} chunk(s)...`, "detail");

  // Summarize each chunk with the mini model (parallel)
  const chunkSummaries: string[] = await Promise.all(
    chunks.map((chunk, i) =>
      callLLMMini(
        `Extract from this SAP document chunk:
SAP transactions (tcodes), org structure elements and values,
business rules, process steps, variants/cases.
Be very concise. Use bullet points only.

${chunk}`,
        config,
        300,
        undefined,
        trace,
        "cache_chunk_summary"
      )
    )
  );

  // Merge chunk summaries into structured output
  const mergedRaw = await callLLMMini(
    `You are a SAP consultant. Merge these document summaries into structured JSON.

CRITICAL: The "transactions" array must include EVERY SAP transaction code (tcode) found across ALL chunks. Do NOT drop any. If a chunk mentions VA01, VL01N, VF01, ME21N — ALL of them must appear in the final array. Missing a transaction here means it will be lost from the entire process.

${chunkSummaries.join("\n---\n")}

Respond ONLY with this JSON (no markdown):
{
  "module": "SD",
  "transactions": ["VA01","VF01","VL01N"],
  "orgElements": {"Sales Organization": ["0601","0003"], "Plant": ["0100"]},
  "businessProcess": "One sentence description",
  "keySteps": ["Step 1", "Step 2"],
  "businessRules": ["Rule 1", "Rule 2"],
  "variants": ["Variant 1", "Variant 2"]
}`,
    config,
    600,
    undefined,
    trace,
    "cache_merge_summary"
  );

  const merged = securityAnonymize ? deanonymize(mergedRaw, anonResult.map) : mergedRaw;

  let parsed: any = {};
  try {
    parsed = JSON.parse(merged.replace(/```json|```/g, "").trim());
  } catch {
    parsed = {
      module: "SD", transactions: [], orgElements: {},
      businessProcess: "", keySteps: [], businessRules: [], variants: []
    };
  }

  const finalTokens = Math.round(JSON.stringify(parsed).length / 4);
  const saved = Math.max(0, originalTokens - finalTokens);

  const summary: DocSummary = {
    fileName,
    hash: hashContent(content),
    module: parsed.module || "SD",
    transactions: parsed.transactions || [],
    orgElements: parsed.orgElements || {},
    businessProcess: parsed.businessProcess || "",
    keySteps: parsed.keySteps || [],
    businessRules: parsed.businessRules || [],
    variants: parsed.variants || [],
    rawSummary: JSON.stringify(parsed),
    createdAt: new Date().toISOString(),
    tokensSaved: saved,
  };

  saveCache(content, summary);
  log(`         Summarized: ${fileName} | saved ~${saved} tokens | cached`, "detail");

  return summary;
}

// ── Format cached summaries into compact context ──────────────
export function formatCachedContext(summaries: DocSummary[]): string {
  return summaries.map(s => `
=== ${s.fileName} ===
Module: ${s.module}
Transactions: ${s.transactions.join(", ")}
Business Process: ${s.businessProcess}
Org Structure: ${JSON.stringify(s.orgElements)}
Key Steps: ${s.keySteps.join(" | ")}
Business Rules: ${s.businessRules.join(" | ")}
Variants: ${s.variants.join(" | ")}
  `.trim()).join("\n\n");
}
