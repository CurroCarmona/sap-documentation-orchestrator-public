import { apiUrl } from "./shared.js";

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
        eventPayload = { type: "detail", msg: raw };
      }

      await Promise.resolve(onEvent(eventPayload));
    }
  }
}
