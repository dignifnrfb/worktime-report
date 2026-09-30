"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const DATA_ROOT = process.env.WORKTIME_DATA_ROOT || path.join(
  process.env.LOCALAPPDATA || os.homedir(), "MechMindWorktimeAssistant",
);
const CONFIG_PATH = path.join(DATA_ROOT, "worktime.config.json");
const EXPORT_PATH = path.join(DATA_ROOT, "已办工时.csv");
const PROJECTS_PATH = path.join(DATA_ROOT, "projects.json");
const WORK_TYPES_PATH = path.join(DATA_ROOT, "work-types.json");
const PROFILE_ROOT = path.join(DATA_ROOT, "browser-profile");
const STATE_PATH = path.join(DATA_ROOT, "storage-state.json");
const LOGIN_STATUS_PATH = path.join(DATA_ROOT, "login-status.json");
const LOGIN_QR_PATH = path.join(DATA_ROOT, "login-qr.png");
const LOG_ROOT = path.join(DATA_ROOT, "logs");

const DEFAULT_CONFIG = {
  baseUrl: "https://oa.mech-mind.com.cn",
  workflowId: 197,
  workType: { name: "展会", code: "002" },
  projectCode: "B221009999",
  projectId: "B221009999",
  projectName: "展会组日常运维（仅工时使用）",
  hours: "8.0",
  remark: "",
  skipWeekends: true,
  workdayOverrides: {},
};

function normalizeBaseUrl(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_CONFIG.baseUrl;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("OA 地址无效，请使用完整的 http:// 或 https:// 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OA 地址必须是 HTTP 或 HTTPS 地址，且不能包含用户名和密码。");
  }
  if ((url.hostname === "54.223.138.50" && url.port === "8089") ||
      (url.hostname === "oa.mech-mind.com.cn" && !url.port)) {
    return DEFAULT_CONFIG.baseUrl;
  }
  // Routes are built by the assistant; copied OA links may carry temporary SSO codes.
  return url.origin;
}

function loadConfig() {
  const custom = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const baseUrl = normalizeBaseUrl(custom.baseUrl);
  if (Object.hasOwn(custom, "baseUrl") && custom.baseUrl !== baseUrl) {
    writeJsonAtomic(CONFIG_PATH, { ...custom, baseUrl });
  }
  return { ...DEFAULT_CONFIG, ...custom, baseUrl, workType: { ...DEFAULT_CONFIG.workType, ...custom.workType } };
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLoginStatus(status) {
  writeJsonAtomic(LOGIN_STATUS_PATH, { ...status, updatedAt: new Date().toISOString() });
  try {
    require("./worktime-log.cjs").logSessionChange(status);
  } catch {
    // Isolated copies used by tests may not ship the logger.
  }
}

function accountKey(account = {}) {
  if (account.employeeNo) return `employee:${String(account.employeeNo).trim()}`;
  if (account.oaUserId) return `oa:${String(account.oaUserId).trim()}`;
  return account.name ? `name:${account.name}|${account.organization || ""}` : "";
}

function accountsMatch(left = {}, right = {}) {
  if (left.employeeNo && right.employeeNo) return String(left.employeeNo) === String(right.employeeNo);
  if (left.oaUserId && right.oaUserId) return String(left.oaUserId) === String(right.oaUserId);
  return Boolean(left.name && right.name && left.name === right.name &&
    (!left.organization || !right.organization || left.organization === right.organization));
}

// Keep the active files compatible with older releases, and archive each account
// before switching so records and defaults never cross account boundaries.
function syncAccount(account) {
  if (!account.name) throw new Error("未能识别当前 OA 账户，请重新登录后再试。");
  const current = loadConfig();
  if (!accountsMatch(current.account, account)) {
    const accountDirectory = (owner) => path.join(DATA_ROOT, "accounts",
      Buffer.from(accountKey(owner) || "unknown", "utf8").toString("base64url"));
    const previousDirectory = accountDirectory(current.account);
    const nextDirectory = accountDirectory(account);
    const cachePaths = [EXPORT_PATH, PROJECTS_PATH, WORK_TYPES_PATH];
    fs.mkdirSync(previousDirectory, { recursive: true });
    writeJsonAtomic(path.join(previousDirectory, "worktime.config.json"), current);
    for (const file of cachePaths) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(previousDirectory, path.basename(file)));
    }
    const savedConfig = path.join(nextDirectory, "worktime.config.json");
    const restored = fs.existsSync(savedConfig)
      ? JSON.parse(fs.readFileSync(savedConfig, "utf8")) : DEFAULT_CONFIG;
    for (const file of cachePaths) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const saved = path.join(nextDirectory, path.basename(file));
      if (fs.existsSync(saved)) fs.copyFileSync(saved, file);
    }
    writeJsonAtomic(CONFIG_PATH, {
      ...DEFAULT_CONFIG, ...restored, baseUrl: normalizeBaseUrl(restored.baseUrl), account,
    });
  } else if (!Object.entries(account).every(([key, value]) => current.account?.[key] === value)) {
    writeJsonAtomic(CONFIG_PATH, { ...current, account });
  }
  return account;
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function isLeaveWorkType(workType) {
  return workType?.code === "004" && workType?.name === "休假";
}

function withoutLeaveProject(config) {
  return isLeaveWorkType(config.workType)
    ? { ...config, projectCode: "", projectId: "", projectName: "" } : config;
}

function isWorkday(date, config) {
  const override = config.workdayOverrides?.[date];
  if (override === "work") return true;
  if (override === "rest") return false;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return config.skipWeekends === false || (day !== 0 && day !== 6);
}

function mergePendingRecords(records, previous) {
  const dates = new Set(records.map((record) => record.workDate));
  return [...records, ...previous.filter((record) =>
    record.status === "已提交·同步中" && !dates.has(record.workDate))];
}

function looksLikeProjectCode(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 40) return false;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk <= 2 && /[A-Za-z0-9]/.test(text);
}

function normalizeProjectKey(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2010-\u2015\u2212\u30FC\uFF0D]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .toLocaleLowerCase("zh-CN");
}

function projectKeysMatch(left, right) {
  const a = normalizeProjectKey(left);
  const b = normalizeProjectKey(right);
  return Boolean(a) && a === b;
}

function canonicalProject(project) {
  const code = String(project?.code || "").trim();
  const name = String(project?.name || "").trim();
  const id = String(project?.id || code).trim();
  if (!code || !id) return null;
  if (!looksLikeProjectCode(code) && looksLikeProjectCode(name)) {
    return { id, code: name, name: code };
  }
  return { id, code, name };
}

function normalizeProjects(rows) {
  const projects = new Map();
  for (const row of rows || []) {
    const rawCode = String(row?.xmbm || row?.code || row?.randomFieldId || "").trim();
    const rawName = String(row?.xmmc || row?.name || "").trim();
    const rawId = String(row?.randomFieldId || row?.id || rawCode).trim();
    const project = canonicalProject({ id: rawId, code: rawCode, name: rawName });
    if (!project || projects.has(project.code)) continue;
    projects.set(project.code, project);
  }
  return [...projects.values()];
}

module.exports = {
  DATA_ROOT, CONFIG_PATH, EXPORT_PATH, PROJECTS_PATH, WORK_TYPES_PATH,
  PROFILE_ROOT, STATE_PATH, LOGIN_STATUS_PATH, LOGIN_QR_PATH, LOG_ROOT, DEFAULT_CONFIG,
  normalizeBaseUrl, loadConfig, writeTextAtomic, writeJsonAtomic, writeLoginStatus,
  accountKey, accountsMatch, syncAccount, todayIso, isWorkday, mergePendingRecords,
  looksLikeProjectCode, canonicalProject, normalizeProjects, normalizeProjectKey, projectKeysMatch,
  isLeaveWorkType, withoutLeaveProject,
};
