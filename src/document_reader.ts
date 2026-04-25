/**
 * Document Reader - Unified document reading utilities
 */

import mammoth from "mammoth";
import * as fs from "fs";
import * as path from "path";

export async function readDocx(input: string | Buffer): Promise<string> {
  try {
    const result = typeof input === "string"
      ? await mammoth.extractRawText({ path: input })
      : await mammoth.extractRawText({ buffer: input });
    return result.value || "";
  } catch (err: any) {
    throw new Error(`Failed to read document: ${err.message}`);
  }
}

export async function readDocument(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".docx" || ext === ".doc") {
    return await readDocx(filePath);
  }
  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf-8");
  }
  throw new Error(`Unsupported document format: ${ext}`);
}
