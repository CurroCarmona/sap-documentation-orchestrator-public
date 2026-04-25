import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { AppConfig } from "./config";
import { callLLMMini, TraceWriter } from "./alejandria";
import { anonymize, deanonymize, anonymizationStats, setClientTerms } from "./anonymizer";
import { ragRetrieve, type RAGOptions } from "./rag";

const CACHE_DIR = path.join(process.cwd(), ".doc_cache");

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
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true });
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
    } catch {}
  });
  return { files: files.length, totalSaved };
}
