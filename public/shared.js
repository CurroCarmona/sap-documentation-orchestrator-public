/**
 * Shared utility functions for all BBP frontend applications
 */

export function log(msg, type = "info") {
  const el = document.getElementById("log");
  if (!el) return;

  const line = document.createElement("div");
  line.className = `log-line log-${type}`;

  if (type === "section") {
    line.textContent = `▸ ${msg}`;
  } else if (type === "detail" || type === "dim") {
    line.textContent = `    ${msg}`;
  } else {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    line.textContent = `[${ts}] ${msg}`;
  }

  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

export function clearLog() {
  const el = document.getElementById("log");
  if (el) el.innerHTML = "";
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str || "");
  return div.innerHTML;
}
