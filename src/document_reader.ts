/**
 * Document Reader - Unified document reading utilities
 * Consolidates DOCX/DOC reading logic used across multiple modules
 */

import mammoth from "mammoth";
import * as fs from "fs";
import * as path from "path";

/**
 * Read text content from a DOCX/DOC file
 * @param input - File path (string) or Buffer
 * @returns Extracted text content
 */
export async function readDocx(input: string | Buffer): Promise<string> {
  try {
    const result = typeof input === "string"
      ? await mammoth.extractRawText({ path: input })
      : await mammoth.extractRawText({ buffer: input });
    
    return result.value || "";
  } catch (err: any) {
    console.error(`[readDocx] Error reading document:`, err.message);
    throw new Error(`Failed to read document: ${err.message}`);
  }
}

/**
 * Read text content from multiple DOCX files
 * @param paths - Array of file paths
 * @returns Array of extracted text content (same order as input)
 */
export async function readMultipleDocx(paths: string[]): Promise<string[]> {
  const results = await Promise.allSettled(
    paths.map(p => readDocx(p))
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    } else {
      console.warn(`[readMultipleDocx] Failed to read ${paths[index]}: ${result.reason?.message}`);
      return "";
    }
  });
}

/**
 * Read document from file path with automatic format detection
 * Supports: .docx, .doc, .txt
 * @param filePath - Path to document file
 * @returns Extracted text content
 */
export async function readDocument(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".docx" || ext === ".doc") {
    return await readDocx(filePath);
  } else if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf-8");
  } else {
    throw new Error(`Unsupported document format: ${ext}`);
  }
}

/**
 * Read documents from file paths with error handling
 * @param filePaths - Array of file paths
 * @param options - Options for reading
 * @returns Object with successful texts and errors
 */
export async function readDocumentsSafe(
  filePaths: string[],
  options?: { skipEmpty?: boolean }
): Promise<{
  texts: string[];
  errors: Array<{ path: string; error: string }>;
}> {
  const texts: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const filePath of filePaths) {
    try {
      const text = await readDocument(filePath);
      
      if (options?.skipEmpty && !text.trim()) {
        continue;
      }

      texts.push(text);
    } catch (err: any) {
      errors.push({
        path: filePath,
        error: err.message || "Unknown error"
      });
    }
  }

  return { texts, errors };
}

/**
 * Read DOCX from SharePoint buffer with metadata
 * @param buffer - File buffer from SharePoint
 * @param fileName - Original file name for logging
 * @returns Extracted text content
 */
export async function readDocxFromBuffer(
  buffer: Buffer,
  fileName?: string
): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (err: any) {
    const fileRef = fileName ? ` (${fileName})` : "";
    console.error(`[readDocxFromBuffer] Error reading buffer${fileRef}:`, err.message);
    throw new Error(`Failed to read document buffer${fileRef}: ${err.message}`);
  }
}
