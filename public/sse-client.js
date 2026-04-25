/**
 * Server-Sent Events (SSE) client for streaming responses
 * Unified implementation to avoid duplication between integrations.js and generate.js
 */

import { apiUrl } from "./shared.js";

/**
 * Read Server-Sent Events from a streaming endpoint
 * @param {string} endpoint - API endpoint path
 * @param {object} payload - Request payload
 * @param {function} onEvent - Callback for each event: (eventData) => void | Promise<void>
 * @returns {Promise<void>}
 */
export async function readSSE(endpoint, payload, onEvent) {
  const res = await fetch(apiUrl(endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });

  if (!res.ok || !res.body) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Streaming endpoint unavailable: ${res.status} ${errorText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const lines = part.split("\n");
      const dataLines = lines
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim());

      if (!dataLines.length) continue;

      const raw = dataLines.join("\n");
      let eventPayload;

      try {
        eventPayload = JSON.parse(raw);
      } catch (_err) {
        // If not valid JSON, treat as plain text detail message
        eventPayload = { type: "detail", msg: raw };
      }

      // Call event handler (supports both sync and async)
      await Promise.resolve(onEvent(eventPayload));
    }
  }
}

/**
 * Read SSE and collect final result
 * @param {string} endpoint - API endpoint path
 * @param {object} payload - Request payload
 * @param {function} onProgress - Optional callback for progress events
 * @returns {Promise<any>} Final result data
 */
export async function readSSEWithResult(endpoint, payload, onProgress = null) {
  let finalResult = null;

  await readSSE(endpoint, payload, (event) => {
    if (event.type === "result" || event.type === "complete") {
      finalResult = event.data || event;
    }

    if (onProgress) {
      onProgress(event);
    }
  });

  return finalResult;
}
