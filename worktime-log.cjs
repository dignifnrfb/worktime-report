"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { DATA_ROOT, todayIso } = require("./worktime-common.cjs");

const LOG_ROOT = path.join(DATA_ROOT, "logs");
const RETENTION_DAYS = 14;
const DIAGNOSTIC_DAYS = 7;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /cookie|authorization|password|passwd|token|secret|storage.?state|em_auth|qrcode|qrVersion|html|pageText|bodyHtml|headers|screenshot/i;
const LOG_NAME = /^(app|error)\.(\d{4}-\d{2}-\d{2})\.jsonl$/;
const CRASH_NAME = /^(crash\.err|service\.(out|err)|installed-service\.(out|err))\.log$/;

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xEDB88320 : 0);
  CRC_TABLE[index] = value >>> 0;
}

let runId = process.env.WORKTIME_RUN_ID || randomUUID();
let proc = process.env.WORKTIME_PROC || "assistant";
let cmd = process.env.WORKTIME_CMD || "";
let minLevel = LEVELS[String(process.env.WORKTIME_LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
let lastSessionKey = "";
let pruned = false;
let handlersInstalled = false;

function appVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim() || "source";
  } catch {
    return "source";
  }
}

function createRunId() {
  return randomUUID();
}

function configureLogger(options = {}) {
  if (options.runId) runId = options.runId;
  if (options.proc) proc = options.proc;
  if (Object.hasOwn(options, "cmd")) cmd = options.cmd || "";
  if (options.level && LEVELS[options.level]) minLevel = LEVELS[options.level];
}

function setRunContext(options = {}) {
  configureLogger(options);
}

function channelForCommand(command) {
  if (["login", "login-qr", "session-check"].includes(command)) return "session";
  if (["list", "work-types", "projects", "startup-sync"].includes(command)) return "sync";
  if (["preview", "submit", "batch-preview", "batch-submit"].includes(command)) return "fill";
  return "lifecycle";
}

function shiftDays(iso, delta) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    const redacted = value
      .replace(/em_auth_code=[^&\s]+/gi, "em_auth_code=*")
      .replace(/authorization:\s*\S+/gi, "authorization: *");
    return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    if (depth > 4) return "[object]";
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      result[key] = sanitize(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function pruneOldLogs() {
  if (pruned) return;
  pruned = true;
  try {
    if (!fs.existsSync(LOG_ROOT)) return;
    const cutoff = shiftDays(todayIso(), -RETENTION_DAYS);
    for (const name of fs.readdirSync(LOG_ROOT)) {
      const match = name.match(LOG_NAME);
      if (match && match[2] < cutoff) fs.unlinkSync(path.join(LOG_ROOT, name));
    }
  } catch {
    // Retention must never block login or fill.
  }
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function writeLog(level, channel, event, msg, data, extra = {}) {
  if ((LEVELS[level] || LEVELS.info) < minLevel) return null;
  pruneOldLogs();
  const record = {
    ts: new Date().toISOString(),
    level,
    channel,
    event,
    runId,
    pid: process.pid,
    proc,
    ...(cmd ? { cmd } : {}),
    ...extra,
    msg: String(msg || event || "").slice(0, 500),
  };
  if (data && typeof data === "object" && Object.keys(data).length) record.data = sanitize(data);
  try {
    const day = todayIso();
    appendJsonl(path.join(LOG_ROOT, `app.${day}.jsonl`), record);
    if (level === "warn" || level === "error") {
      appendJsonl(path.join(LOG_ROOT, `error.${day}.jsonl`), record);
    }
  } catch {
    // A full disk or missing permission must not fail the user action.
  }
  return record;
}

function info(channel, event, msg, data, extra) {
  return writeLog("info", channel, event, msg, data, extra);
}

function warn(channel, event, msg, data, extra) {
  return writeLog("warn", channel, event, msg, data, extra);
}

function error(channel, event, msg, data, extra) {
  return writeLog("error", channel, event, msg, data, extra);
}

function logError(channel, event, caught, msg, data, extra) {
  const failure = caught instanceof Error ? caught : new Error(String(caught || msg || event));
  return writeLog("error", channel, event, msg || failure.message, {
    ...data,
    error: failure.message,
    stack: String(failure.stack || "").split("\n").slice(0, 8).join("\n"),
  }, extra);
}

function logSessionChange(status = {}) {
  const key = `${status.state || ""}:${status.reason || ""}`;
  if (key === lastSessionKey && ["waiting", "checking", "verifying"].includes(status.state)) return null;
  lastSessionKey = key;
  const event = status.state === "error"
    ? (status.reason === "expired" ? "login.expired" : status.reason === "account" ? "login.account_mismatch" : "login.fail")
    : status.state === "connected" ? "login.connected"
    : status.state === "waiting" ? "login.waiting"
    : status.state === "confirming" ? "login.confirming"
    : status.state === "cancelled" ? "login.cancelled"
    : `login.${status.state || "update"}`;
  const level = status.state === "error" ? "error" : status.state === "unavailable" ? "warn" : "info";
  return writeLog(level, "session", event, status.message || event, {
    state: status.state,
    reason: status.reason || undefined,
    account: status.account
      ? { name: status.account.name || "", employeeNo: status.account.employeeNo || "" }
      : undefined,
  });
}

function installProcessHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("uncaughtException", (caught) => {
    logError("lifecycle", "process.uncaught", caught, "未捕获异常");
    console.error(caught);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError("lifecycle", "process.unhandled", reason instanceof Error ? reason : new Error(String(reason)), "未处理的 Promise 拒绝");
  });
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1 << 11, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(1 << 11, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function listDiagnosticFiles(days = DIAGNOSTIC_DAYS) {
  if (!fs.existsSync(LOG_ROOT)) return [];
  const cutoff = shiftDays(todayIso(), -days);
  return fs.readdirSync(LOG_ROOT)
    .filter((name) => {
      const match = name.match(LOG_NAME);
      if (match) return match[2] >= cutoff;
      return CRASH_NAME.test(name);
    })
    .sort()
    .map((name) => ({ name, path: path.join(LOG_ROOT, name) }))
    .filter((file) => {
      try {
        return fs.statSync(file.path).isFile();
      } catch {
        return false;
      }
    });
}

function readTodayRecords(kind = "app") {
  const filePath = path.join(LOG_ROOT, `${kind}.${todayIso()}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function buildDiagnosticArchive() {
  pruneOldLogs();
  const files = listDiagnosticFiles();
  const manifest = {
    generatedAt: new Date().toISOString(),
    version: appVersion(),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    proc,
    logRoot: LOG_ROOT,
    retentionDays: RETENTION_DAYS,
    files: files.map((file) => file.name),
    note: "本包只含本机日志。不含 Cookie、登录会话、二维码、浏览器配置或完整项目库。",
  };
  const entries = [
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    ...files.map((file) => ({ name: file.name, data: fs.readFileSync(file.path) })),
  ];
  return {
    fileName: `worktime-diagnostics-${todayIso()}.zip`,
    buffer: zipStore(entries),
    manifest,
  };
}

function resetLoggerForTests(options = {}) {
  runId = options.runId || randomUUID();
  proc = options.proc || "test";
  cmd = options.cmd || "";
  minLevel = LEVELS[options.level || "info"] || LEVELS.info;
  lastSessionKey = "";
  pruned = false;
}

// Temporary, locally enabled diagnostics expire automatically.
function diagnosticEnabled() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "temporary-diagnostics.json"), "utf8"));
    return settings.enabled === true && Date.parse(settings.expiresAt) > Date.now();
  } catch { return false; }
}

function diagnostic(event, data) {
  if (diagnosticEnabled()) info("diagnostic", `diagnostic.${event}`, event, data);
}

function diagnosticUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return "unknown"; }
}

function diagnosticFailure(error) {
  const message = String(error?.message || error || "");
  return {
    kind: String(error?.name || "Error").slice(0, 80),
    codes: [...new Set(message.match(/\b(?:ERR_[A-Z_]+|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE))\b/g) || [])],
    timeout: /timeout|timed out/i.test(message),
    certificate: /certificate|ssl|tls/i.test(message),
  };
}

module.exports = {
  diagnosticEnabled, diagnostic, diagnosticUrl, diagnosticFailure,
  LOG_ROOT, RETENTION_DAYS, DIAGNOSTIC_DAYS,
  createRunId, configureLogger, setRunContext, channelForCommand,
  writeLog, info, warn, error, logError, logSessionChange,
  installProcessHandlers, buildDiagnosticArchive, listDiagnosticFiles,
  readTodayRecords, sanitize, resetLoggerForTests, appVersion, zipStore,
};
