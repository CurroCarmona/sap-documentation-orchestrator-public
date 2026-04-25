/**
 * Shared utility functions for all BBP frontend applications
 * Centralized to avoid code duplication across app.js, generate.js, sit.js, etc.
 */

/**
 * Log a message to the log panel with timestamp and styling
 * @param {string} msg - Message to log
 * @param {string} type - Type of log: "info", "error", "warn", "success", "section", "detail", "dim"
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

/**
 * Clear all log messages
 */
export function clearLog() {
  const el = document.getElementById("log");
  if (el) el.innerHTML = "";
}

/**
 * Escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str || "");
  return div.innerHTML;
}

/**
 * Get API origin from query params, localStorage, or default
 * @returns {string} API origin URL (without trailing slash)
 */
export function getApiOrigin() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = (params.get("api") || "").trim();
  if (fromQuery) return fromQuery.replace(/\/$/, "");

  const fromStorage = (localStorage.getItem("bbp_api_origin") || "").trim();
  if (fromStorage) return fromStorage.replace(/\/$/, "");

  // If opened as file:///..., fallback to local backend
  if (window.location.protocol === "file:") return "http://localhost:3000";
  return "";
}

/**
 * Build full API URL for an endpoint
 * @param {string} endpoint - API endpoint (e.g., "/api/scenarios/generate")
 * @returns {string} Full URL
 */
export function apiUrl(endpoint) {
  const origin = getApiOrigin();
  return origin ? `${origin}${endpoint}` : endpoint;
}

/**
 * Format network error message with backend URL
 * @param {Error} err - Error object from fetch
 * @returns {string} Formatted error message
 */
export function networkErrorMessage(err) {
  const base = `Network error: ${err?.message || "Failed to fetch"}`;
  const origin = getApiOrigin() || window.location.origin;
  return `${base}. Verify backend is running at ${origin}.`;
}

/**
 * Set progress bar value and label
 * @param {number} value - Progress value between 0 and 1
 * @param {string} label - Label text to display
 */
export function setProgress(value, label = "") {
  const bar = document.getElementById("progress-bar");
  const labelEl = document.getElementById("progress-label");
  if (bar) bar.style.width = (value * 100) + "%";
  if (labelEl) labelEl.textContent = label;
}

/**
 * Parse CSV string into array
 * @param {string} value - CSV string
 * @returns {string[]} Array of trimmed non-empty values
 */
export function csvToList(value) {
  return String(value || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * Format file size in bytes to human-readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size (e.g., "1.5 MB")
 */
export function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Get file icon text based on file extension
 * @param {string} fileName - Name of the file
 * @returns {string} Icon text (e.g., "[PDF]", "[DOC]")
 */
export function getFileIcon(fileName) {
  const ext = fileName.split(".").pop().toLowerCase();
  const icons = {
    pdf: "[PDF]", doc: "[DOC]", docx: "[DOC]", xlsx: "[XLS]", xls: "[XLS]",
    pptx: "[PPT]", ppt: "[PPT]", txt: "[TXT]", md: "[MD]", csv: "[CSV]",
    png: "[IMG]", jpg: "[IMG]", jpeg: "[IMG]", gif: "[IMG]", svg: "[IMG]",
    json: "[JSON]", xml: "[XML]", html: "[HTML]", css: "[CSS]", js: "[JS]"
  };
  return icons[ext] || "[FILE]";
}
