#!/usr/bin/env node

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { StringDecoder } = require("node:string_decoder");
const progress = require("./worktime-progress.cjs");
const { UpdateManager } = require("./worktime-update.cjs");
const {
  DATA_ROOT, CONFIG_PATH, EXPORT_PATH: CSV_PATH, PROJECTS_PATH, WORK_TYPES_PATH,
  STATE_PATH, LOGIN_STATUS_PATH, LOGIN_QR_PATH, LOG_ROOT, loadConfig: readConfig,
  writeJsonAtomic, writeLoginStatus, accountsMatch, accountKey, todayIso,
  canonicalProject, normalizeProjects,
  isLeaveWorkType, withoutLeaveProject,
} = require("./worktime-common.cjs");
const log = require("./worktime-log.cjs");

log.configureLogger({ proc: "server" });
log.installProcessHandlers();

const ROOT = __dirname;
const ASSISTANT_PATH = path.join(ROOT, "worktime.cjs");
const STATIC_ROOT = process.env.WORKTIME_STATIC_ROOT || path.join(ROOT, "dashboard", "portable-dist");
const PORT = Number(process.env.WORKTIME_DASHBOARD_PORT || 3088);
const HOST = "127.0.0.1";

let activeAction = null;
let activeChild = null;
let loginCancelled = false;
let loginGeneration = 0;
let refreshTimer = null;
let sessionChecked = false;
let sessionCheckedAt = 0;
let sessionCheckPromise = null;
let projectCatalogCache = { mtimeMs: -1, data: null };
let workTypeCatalogCache = { mtimeMs: -1, data: null };
const batchProgressByAccount = new Map();
const updates = new UpdateManager({ appRoot: ROOT, dataRoot: DATA_ROOT, isBusy: () => Boolean(activeAction) });

// OA synchronization may omit the employee number; the OA user ID stays stable.
function batchAccountKey(account = {}) {
  return account.oaUserId ? `oa:${String(account.oaUserId).trim()}` : accountKey(account);
}

function qrLoginIsRunning() {
  return activeAction === "login-qr" || activeAction === "login-qr --force";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function readRecords() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const raw = fs.readFileSync(CSV_PATH, "utf8").replace(/^\uFEFF/, "");
  const [headers, ...rows] = parseCsv(raw);
  if (!headers) return [];
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])))
    .map((row) => ({
      workDate: row["工时日期"] || "",
      documentNo: row["单据编号"] || "",
      requestId: row["请求ID"] || "",
      operationTime: row["操作时间"] || "",
      status: row["状态"] || "",
      title: row["流程标题"] || "",
    }))
    .filter((record) => record.workDate)
    .sort((left, right) => right.workDate.localeCompare(left.workDate));
}

function emptyProjectCatalog() {
  return { fetchedAt: null, sourceTotal: 0, account: {}, projects: [] };
}

function readProjectCatalog() {
  if (!fs.existsSync(PROJECTS_PATH)) {
    projectCatalogCache = { mtimeMs: -1, data: null };
    return emptyProjectCatalog();
  }
  try {
    const stat = fs.statSync(PROJECTS_PATH);
    if (projectCatalogCache.data && projectCatalogCache.mtimeMs === stat.mtimeMs) {
      return projectCatalogCache.data;
    }
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
    const data = {
      fetchedAt: parsed.fetchedAt || null,
      sourceTotal: Number(parsed.sourceTotal) || 0,
      account: parsed.account || {},
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.map(canonicalProject).filter(Boolean)
        : [],
    };
    projectCatalogCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return emptyProjectCatalog();
  }
}

function projectCatalogFor(config) {
  const catalog = readProjectCatalog();
  return accountsMatch(config.account, catalog.account) ? catalog : emptyProjectCatalog();
}

function projectCatalogSummary(config) {
  const catalog = projectCatalogFor(config);
  return {
    count: catalog.projects.length,
    sourceTotal: catalog.sourceTotal,
    fetchedAt: catalog.fetchedAt,
  };
}

function searchProjectsLocal(config, query = "", limit = 40) {
  const catalog = projectCatalogFor(config);
  const term = String(query || "").trim().toLocaleLowerCase("zh-CN");
  const score = (project) => {
    const code = project.code.toLocaleLowerCase("zh-CN");
    const name = project.name.toLocaleLowerCase("zh-CN");
    if (!term) return 5;
    if (code === term) return 0;
    if (name === term) return 1;
    if (code.startsWith(term)) return 2;
    if (name.startsWith(term)) return 3;
    return 4;
  };
  return catalog.projects
    .map(canonicalProject)
    .filter(Boolean)
    .filter((project) => !term || project.code.toLocaleLowerCase("zh-CN").includes(term) || project.name.toLocaleLowerCase("zh-CN").includes(term))
    .sort((left, right) => score(left) - score(right) || left.code.localeCompare(right.code, "zh-CN"))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 40)));
}

function hasUsableLoginState() {
  if (!fs.existsSync(STATE_PATH)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return Array.isArray(state.cookies) && state.cookies.length > 0;
  } catch {
    return false;
  }
}

let liveProjectApi = null;
let liveProjectApiKey = "";

async function disposeLiveProjectApi() {
  await liveProjectApi?.dispose().catch(() => {});
  liveProjectApi = null;
  liveProjectApiKey = "";
}

async function withLiveProjectApi(config, fn) {
  const { createOaApi, verifyApiSession } = require("./worktime-api.cjs");
  const key = `${accountKey(config.account)}|${STATE_PATH}`;
  if (!liveProjectApi || liveProjectApiKey !== key) {
    await disposeLiveProjectApi();
    liveProjectApi = await createOaApi(config);
    await verifyApiSession(liveProjectApi);
    liveProjectApiKey = key;
  }
  try {
    return await fn(liveProjectApi);
  } catch (error) {
    if (error.message === "LOGIN_REQUIRED" || error.code === "OA_NETWORK") await disposeLiveProjectApi();
    throw error;
  }
}

function mergeProjectResults(primary, secondary, limit) {
  const seen = new Set();
  const merged = [];
  for (const project of [...primary, ...secondary]) {
    const item = canonicalProject(project);
    if (!item || seen.has(item.code)) continue;
    seen.add(item.code);
    merged.push(item);
    if (merged.length >= limit) break;
  }
  return merged;
}

async function searchProjects(config, query = "", limit = 40) {
  const size = Math.max(1, Math.min(100, Number(limit) || 40));
  const term = String(query || "").trim();
  const local = searchProjectsLocal(config, term, size);
  if (!term || !hasUsableLoginState()) return local;
  try {
    const remote = await withLiveProjectApi(config, async (api) => {
      const { searchCatalogApi } = require("./worktime-api.cjs");
      const { rows } = await searchCatalogApi(api, "projects", term, { pageSize: size });
      return normalizeProjects(rows);
    });
    return mergeProjectResults(remote, local, size);
  } catch (error) {
    log.warn("sync", "project.search.fallback", "OA 实时搜索暂不可用，改用本机缓存", {
      query: term, error: error.message,
    });
    return local;
  }
}

function emptyWorkTypeCatalog() {
  return { fetchedAt: null, sourceTotal: 0, account: {}, workTypes: [] };
}

function readWorkTypeCatalog() {
  if (!fs.existsSync(WORK_TYPES_PATH)) {
    workTypeCatalogCache = { mtimeMs: -1, data: null };
    return emptyWorkTypeCatalog();
  }
  try {
    const stat = fs.statSync(WORK_TYPES_PATH);
    if (workTypeCatalogCache.data && workTypeCatalogCache.mtimeMs === stat.mtimeMs) {
      return workTypeCatalogCache.data;
    }
    const parsed = JSON.parse(fs.readFileSync(WORK_TYPES_PATH, "utf8"));
    const data = {
      fetchedAt: parsed.fetchedAt || null,
      sourceTotal: Number(parsed.sourceTotal) || 0,
      account: parsed.account || {},
      workTypes: Array.isArray(parsed.workTypes)
        ? parsed.workTypes
            .map((workType) => ({
              code: String(workType.code || "").trim(),
              name: String(workType.name || "").trim(),
            }))
            .filter((workType) => workType.code && workType.name)
        : [],
    };
    workTypeCatalogCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return emptyWorkTypeCatalog();
  }
}

function workTypeCatalogFor(config) {
  const catalog = readWorkTypeCatalog();
  return accountsMatch(config.account, catalog.account) ? catalog : emptyWorkTypeCatalog();
}

function workTypeCatalogSummary(config) {
  const catalog = workTypeCatalogFor(config);
  return {
    count: catalog.workTypes.length,
    sourceTotal: catalog.sourceTotal,
    fetchedAt: catalog.fetchedAt,
  };
}

function readLoginStatus() {
  if (!fs.existsSync(LOGIN_STATUS_PATH)) {
    return {
      state: fs.existsSync(STATE_PATH) ? "verifying" : "idle",
      message: fs.existsSync(STATE_PATH) ? "正在验证 OA 登录…" : "尚未登录。",
      updatedAt: null,
    };
  }
  try {
    const status = JSON.parse(fs.readFileSync(LOGIN_STATUS_PATH, "utf8"));
    if (status.state === "connected" && !fs.existsSync(STATE_PATH)) return { state: "idle", message: "尚未登录。" };
    if (status.state === "connected" && !sessionChecked) return { ...status, state: "verifying", message: "正在验证 OA 登录…" };
    if (["checking", "waiting", "confirming"].includes(status.state) && !qrLoginIsRunning()) {
      return {
        state: "idle",
        message: "上一次登录已结束，正在重新生成二维码。",
        updatedAt: status.updatedAt || null,
      };
    }
    return status;
  } catch {
    return { state: "error", message: "登录状态无法读取。", updatedAt: null };
  }
}

function checkSession(force = false) {
  if (sessionCheckPromise) return sessionCheckPromise;
  if (activeAction || updates.installing() || !fs.existsSync(STATE_PATH)) return Promise.resolve(readLoginStatus());
  if (!force && Date.now() - sessionCheckedAt < 5 * 60_000) return Promise.resolve(readLoginStatus());
  const status = readLoginStatus();
  if (!force && sessionChecked && ["error", "cancelled", "idle"].includes(status.state)) return Promise.resolve(status);
  writeLoginStatus({ state: "verifying", message: "正在验证 OA 登录…" });
  sessionCheckPromise = runAssistant(["session-check"], 25_000)
    .then(() => { sessionChecked = true; })
    .catch(() => {
      sessionChecked = true;
      if (readLoginStatus().state === "verifying") {
        writeLoginStatus({ state: "unavailable", message: "暂时无法验证 OA 登录，请检查网络后重试。" });
      }
    })
    .then(() => {
      sessionCheckedAt = Date.now();
      sessionCheckPromise = null;
      return readLoginStatus();
    });
  return sessionCheckPromise;
}

function buildDashboard() {
  const config = readConfig();
  const catalog = projectCatalogFor(config);
  const workTypeCatalog = workTypeCatalogFor(config);
  const selectedProject = catalog.projects.find((project) => project.code === config.projectCode);
  const csvStat = fs.existsSync(CSV_PATH) ? fs.statSync(CSV_PATH) : null;
  const loginStatus = readLoginStatus();
  const records = readRecords();
  const batches = batchProgressByAccount.get(batchAccountKey(config.account));
  progress.confirmProgress(batches?.current, records);
  progress.confirmProgress(batches?.last, records);
  return {
    account: config.account || loginStatus.account || {},
    workdayOverrides: config.workdayOverrides || {},
    defaults: {
      workType: config.workType,
      projectCode: config.projectCode,
      projectId: config.projectId || selectedProject?.id || config.projectCode,
      projectName: config.projectName || selectedProject?.name || "",
      hours: config.hours,
      remark: config.remark,
      skipWeekends: config.skipWeekends,
    },
    workTypes: workTypeCatalog.workTypes,
    workTypeCatalog: workTypeCatalogSummary(config),
    session: {
      connected: loginStatus.state === "connected" && fs.existsSync(STATE_PATH),
      state: loginStatus.state,
      lastSyncedAt: csvStat ? csvStat.mtime.toISOString() : null,
      busy: activeAction,
    },
    projectCatalog: projectCatalogSummary(config),
    records,
    batchProgress: batches?.current || batches?.last || null,
    previousBatchProgress: batches?.current ? batches.last : null,
    update: updates.snapshot(),
  };
}

function runAssistant(argumentsList, timeoutMs = 180_000) {
  if (updates.installing()) return Promise.reject(Object.assign(new Error("正在安装更新，请安装完成后再操作。"), { statusCode: 409 }));
  if (activeAction) {
    const error = new Error(`正在执行“${activeAction}”，请稍后再试。`);
    error.statusCode = 409;
    return Promise.reject(error);
  }
  const command = argumentsList[0];
  const channel = log.channelForCommand(command);
  const runId = log.createRunId();
  const startedAt = Date.now();
  let batch = null;
  let ownerKey = null;
  if (["batch-preview", "batch-submit"].includes(command)) {
    const encoded = argumentsList.find((arg) => arg.startsWith("--payload="));
    const payload = encoded ? JSON.parse(Buffer.from(encoded.slice(10), "base64url").toString("utf8")) : {};
    ownerKey = batchAccountKey(payload.account);
    batch = progress.createBatchProgress(runId, payload.account || {}, command === "batch-submit" ? "submit" : "preview", payload.dates || []);
    const previous = batchProgressByAccount.get(ownerKey);
    batchProgressByAccount.set(ownerKey, { current: batch, last: previous?.last || null });
  }
  const finishBatch = (status, error, result) => {
    if (!batch || batch.status !== "running") return;
    progress.finishProgress(batch, status, error, result);
    const owned = batchProgressByAccount.get(ownerKey);
    if (owned?.current === batch) { owned.current = null; owned.last = batch; }
  };
  activeAction = command + (argumentsList.includes("--force") ? " --force" : "");
  log.info(channel, "assistant.start", `开始执行 ${command}`, {
    command, timeoutMs, force: argumentsList.includes("--force"),
  }, { runId, cmd: command });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ASSISTANT_PATH, ...argumentsList], {
      cwd: ROOT,
      env: {
        ...process.env,
        WORKTIME_RUN_ID: runId,
        WORKTIME_PROC: "assistant",
        WORKTIME_CMD: command,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let bufferedLine = "";
    const consumeLine = (line) => {
      if (line.startsWith(progress.PREFIX)) {
        try { if (batch) progress.applyProgress(batch, JSON.parse(line.slice(progress.PREFIX.length))); } catch { /* Ignore malformed progress. */ }
      } else stdout += line + "\n";
    };
    const consumeStdout = (text) => {
      bufferedLine += text;
      let newline;
      while ((newline = bufferedLine.indexOf("\n")) !== -1) {
        consumeLine(bufferedLine.slice(0, newline).replace(/\r$/, ""));
        bufferedLine = bufferedLine.slice(newline + 1);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finishBatch("timed_out", "操作超时，后续日期已停止；提交结果不明确时请先同步已办核对。");
      log.logError(channel, "assistant.timeout", new Error("操作超时"), `执行 ${command} 超时`, {
        command, timeoutMs, pid: child.pid,
      }, { runId, cmd: command, durationMs: Date.now() - startedAt });
      child.kill();
      reject(new Error("操作超时，已停止等待；不会自动重试提交。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => consumeStdout(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk) => (stderr += stderrDecoder.write(chunk)));
    child.on("error", (error) => { finishBatch("failed", error.message); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      consumeStdout(stdoutDecoder.end());
      if (bufferedLine) consumeLine(bufferedLine);
      stderr += stderrDecoder.end();
      if (activeChild === child) {
        activeChild = null;
        activeAction = null;
      }
      let result = null;
      const lines = stdout.trim().split(/\r?\n/).filter((line) => {
        if (!line.startsWith("WORKTIME_RESULT:")) return true;
        try { result = JSON.parse(line.slice("WORKTIME_RESULT:".length)); } catch { /* Ignore malformed summaries. */ }
        return false;
      });
      const message = [lines.join("\n").trim(), stderr.trim()].filter(Boolean).join("\n");
      if (!timedOut) finishBatch(code === 0 ? "completed" : "failed", code === 0 ? null : message || "处理进程异常退出。", result);
      const extra = {
        command, exitCode: code,
        submittedDates: result?.submittedDates, skippedDates: result?.skippedDates,
        processedDates: result?.processedDates,
      };
      if (code === 0) {
        if (!timedOut) {
          log.info(channel, "assistant.ok", `完成 ${command}`, extra, { runId, cmd: command, durationMs: Date.now() - startedAt });
        }
        resolve({ message, result, runId });
      } else {
        const error = new Error(message || `操作失败，退出码 ${code}`);
        error.result = result;
        error.runId = runId;
        if (!timedOut) {
          log.logError(channel, "assistant.fail", error, error.message, extra, { runId, cmd: command, durationMs: Date.now() - startedAt });
        }
        reject(error);
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(response.corsOrigin ? { "Access-Control-Allow-Origin": response.corsOrigin } : {}),
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function sendBinary(response, buffer, contentType, fileName) {
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "Content-Disposition",
    ...(response.corsOrigin ? { "Access-Control-Allow-Origin": response.corsOrigin } : {}),
  });
  response.end(buffer);
}

function sendPng(response, filePath) {
  if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: "二维码尚未生成。" });
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": fs.statSync(filePath).size,
    "Cache-Control": "no-store, max-age=0",
    ...(response.corsOrigin ? { "Access-Control-Allow-Origin": response.corsOrigin } : {}),
  });
  fs.createReadStream(filePath).pipe(response);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendStatic(response, pathname) {
  if (!fs.existsSync(STATIC_ROOT)) return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filePath = path.resolve(STATIC_ROOT, relativePath);
  const staticRootWithSeparator = `${path.resolve(STATIC_ROOT)}${path.sep}`;
  if (filePath !== path.resolve(STATIC_ROOT) && !filePath.startsWith(staticRootWithSeparator)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (path.extname(relativePath)) return false;
    filePath = path.join(STATIC_ROOT, "index.html");
  }
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8_192) throw Object.assign(new Error("请求内容过大。"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error("请求内容必须是有效的 JSON 对象。"), { statusCode: 400 });
  }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeSettings(incoming = {}, requireCatalogs = false) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw Object.assign(new Error("填报设置格式无效。"), { statusCode: 400 });
  }
  const defaults = readConfig();
  const workTypeName = String(incoming.workType?.name || defaults.workType.name).trim();
  const unchangedWorkType = workTypeName === defaults.workType.name;
  const settings = {
    workType: {
      name: workTypeName,
      code: unchangedWorkType
        ? String(incoming.workType?.code ?? defaults.workType.code).trim()
        : String(incoming.workType?.code || "").trim(),
    },
    projectCode: String(incoming.projectCode ?? defaults.projectCode).trim(),
    projectId: String(incoming.projectId ?? defaults.projectId ?? incoming.projectCode ?? defaults.projectCode).trim(),
    projectName: String(incoming.projectName ?? defaults.projectName ?? "").trim(),
    hours: String(incoming.hours ?? defaults.hours).trim(),
    remark: String(incoming.remark ?? defaults.remark).trim(),
  };
  if (!settings.workType.name || settings.workType.name.length > 50 ||
      !settings.workType.code || settings.workType.code.length > 80) {
    const error = new Error("请填写正确的工作类型。");
    error.statusCode = 400;
    throw error;
  }
  const workTypeCatalog = workTypeCatalogFor(defaults);
  if ((requireCatalogs || isLeaveWorkType(settings.workType)) && (!workTypeCatalog.workTypes.length || workTypeCatalog.workTypes.length < workTypeCatalog.sourceTotal)) {
    throw Object.assign(new Error("请先同步当前 OA 工作类型，再进行填报。"), { statusCode: 400 });
  }
  if (workTypeCatalog.workTypes.length) {
    const selectedWorkType = workTypeCatalog.workTypes.find(
      (workType) => workType.code === settings.workType.code && workType.name === settings.workType.name,
    );
    if (!selectedWorkType) {
      const error = new Error("所选工作类型不在当前 OA 列表中，请从下拉框重新选择。");
      error.statusCode = 400;
      throw error;
    }
    settings.workType = { ...selectedWorkType };
  }
  if (!isLeaveWorkType(settings.workType)) {
    if (!settings.projectCode || settings.projectCode.length > 80) {
      const error = new Error("请填写正确的项目号。");
      error.statusCode = 400;
      throw error;
    }
    const catalog = projectCatalogFor(defaults);
    const selectedProject = catalog.projects.find((project) => project.code === settings.projectCode || project.id === settings.projectId)
      || catalog.projects.find((project) => project.name === settings.projectCode);
    if (selectedProject) {
      settings.projectId = selectedProject.id;
      settings.projectCode = selectedProject.code;
      settings.projectName = selectedProject.name;
    }
    if (requireCatalogs && (!settings.projectId || !settings.projectName)) {
      const error = new Error("请从项目搜索结果中选择项目号。");
      error.statusCode = 400;
      throw error;
    }
    if (!settings.projectId || settings.projectId.length > 120) {
      const error = new Error("项目选择值无效，请重新搜索选择。");
      error.statusCode = 400;
      throw error;
    }
    if (settings.projectName.length > 200) {
      const error = new Error("项目名称不能超过 200 个字符。");
      error.statusCode = 400;
      throw error;
    }
  }
  const hours = Number(settings.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    const error = new Error("工时必须是大于 0 且不超过 24 的数字。");
    error.statusCode = 400;
    throw error;
  }
  if (settings.remark.length > 500) {
    const error = new Error("备注不能超过 500 个字。");
    error.statusCode = 400;
    throw error;
  }
  return withoutLeaveProject(settings);
}

function normalizeActionPayload(body) {
  const sourceDates = Array.isArray(body.dates) ? body.dates : [body.date];
  const dates = [...new Set(sourceDates.map((value) => String(value || "").trim()))].sort();
  if (!dates.length || dates.some((date) => !validDate(date))) {
    const error = new Error("请选择有效日期。");
    error.statusCode = 400;
    throw error;
  }
  if (dates.length > 31) {
    const error = new Error("一次最多选择 31 个日期。");
    error.statusCode = 400;
    throw error;
  }
  if (dates.some((date) => date > todayIso())) {
    throw Object.assign(new Error("不能填报未来日期的工时。"), { statusCode: 400 });
  }
  const config = readConfig();
  if (!body.account || !accountsMatch(config.account, body.account)) {
    throw Object.assign(new Error("账户已变化或尚未登录，请刷新页面并重新确认填报内容。"), { statusCode: 409 });
  }
  return { dates, settings: normalizeSettings(body.settings, true), account: config.account, fast: true };
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function startQrLogin(force = false) {
  if (updates.installing()) throw Object.assign(new Error("正在安装更新，请安装完成后再登录。"), { statusCode: 409 });
  if (activeAction) {
    if (qrLoginIsRunning()) return;
    const error = new Error("当前正在处理工时，请完成后再登录或切换账户。");
    error.statusCode = 409;
    throw error;
  }
  loginCancelled = false;
  const generation = ++loginGeneration;
  log.info("session", "login.start", force ? "开始切换 OA 账户" : "开始钉钉扫码登录", { force });
  writeLoginStatus({ state: "checking", message: "正在准备钉钉二维码…" });
  void runAssistant(["login-qr", ...(force ? ["--force"] : [])], 6 * 60_000)
    .then(() => {
      if (!loginCancelled && generation === loginGeneration) {
        sessionChecked = true;
        sessionCheckedAt = Date.now();
        scheduleAutomaticRefresh();
      }
    })
    .catch((error) => {
      if (!loginCancelled && generation === loginGeneration) writeLoginStatus({ state: "error", message: error.message || "登录失败。" });
    });
}

function cancelQrLogin() {
  if (activeAction && !qrLoginIsRunning()) return;
  loginCancelled = true;
  loginGeneration += 1;
  if (qrLoginIsRunning()) activeChild?.kill();
  writeLoginStatus({ state: "cancelled", message: "已取消本次扫码登录，可手动重新开始。" });
}

function saveDefaults(settings) {
  const current = readConfig();
  const next = {
    ...current,
    workType: settings.workType,
    projectCode: settings.projectCode,
    projectId: settings.projectId,
    projectName: settings.projectName,
    hours: settings.hours,
    remark: settings.remark,
  };
  writeJsonAtomic(CONFIG_PATH, next);
  log.info("lifecycle", "defaults.save", "已保存默认填报设置", {
    workType: settings.workType?.name, workTypeCode: settings.workType?.code,
    projectCode: settings.projectCode, hours: settings.hours,
  });
}

function scheduleAutomaticRefresh(attempt = 0) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (activeAction) {
      if (attempt < 10) scheduleAutomaticRefresh(attempt + 1);
      return;
    }
    try {
      await runAssistant(["startup-sync"], 180_000);
    } catch (error) {
      console.error(`自动同步失败：${error.message}`);
      log.logError("sync", "auto.fail", error, "自动同步失败", { command: "startup-sync" });
    }
  }, attempt ? 1_000 : 250);
}

const server = http.createServer(async (request, response) => {
  try {
    const localPort = request.socket.localPort;
    const allowedHosts = new Set([`${HOST}:${localPort}`, `localhost:${localPort}`]);
    const allowedOrigins = new Set([
      `http://${HOST}:${localPort}`, `http://localhost:${localPort}`,
      "http://localhost:3000", "http://127.0.0.1:3000",
    ]);
    if (!allowedHosts.has(request.headers.host) ||
        (request.headers.origin && !allowedOrigins.has(request.headers.origin))) {
      return sendJson(response, 403, { error: "只接受工时助手本机页面的请求。" });
    }
    response.corsOrigin = request.headers.origin;
    if (request.method === "OPTIONS") return sendJson(response, 204, {});
    const url = new URL(request.url, `http://${HOST}:${localPort}`);
    if (request.method === "POST" && updates.installing()) {
      return sendJson(response, 409, { error: "正在安装更新，请安装完成后再操作。" });
    }
    if (request.method === "POST" && url.pathname === "/api/updates/check") {
      void updates.check();
      return sendJson(response, 202, updates.snapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/updates/source") {
      const body = await readBody(request);
      return sendJson(response, 200, updates.configure(body.repository));
    }
    if (request.method === "POST" && ["/api/updates/download", "/api/updates/install"].includes(url.pathname)) {
      const body = await readBody(request);
      if (body.confirm !== true) return sendJson(response, 400, { error: "请先确认本次更新操作。" });
      if (url.pathname.endsWith("/download")) {
        void updates.download();
        return sendJson(response, 202, updates.snapshot());
      }
      return sendJson(response, 202, await updates.install());
    }
    if (request.method === "GET" && url.pathname === "/api/login/status") {
      void checkSession();
      return sendJson(response, 200, readLoginStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/session/check") {
      return sendJson(response, 200, await checkSession(true));
    }
    if (request.method === "GET" && url.pathname === "/api/login/qr") {
      return sendPng(response, LOGIN_QR_PATH);
    }
    if (request.method === "POST" && url.pathname === "/api/login/start") {
      const body = await readBody(request);
      startQrLogin(body.force === true);
      return sendJson(response, 202, readLoginStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/login/cancel") {
      cancelQrLogin();
      return sendJson(response, 200, readLoginStatus());
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      return sendJson(response, 200, buildDashboard());
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      const config = readConfig();
      return sendJson(response, 200, {
        catalog: projectCatalogSummary(config),
        source: hasUsableLoginState() ? "oa" : "cache",
        projects: await searchProjects(config, url.searchParams.get("query") || "", url.searchParams.get("limit") || 40),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/work-types/refresh") {
      const result = await runAssistant(["work-types"]);
      const config = readConfig();
      return sendJson(response, 200, {
        ok: true,
        ...result,
        catalog: workTypeCatalogSummary(config),
        dashboard: buildDashboard(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/projects/refresh") {
      const body = await readBody(request);
      const result = await runAssistant(["projects"], 5 * 60_000);
      const config = readConfig();
      return sendJson(response, 200, {
        ok: true,
        ...result,
        catalog: projectCatalogSummary(config),
        projects: await searchProjects(config, body.query || "", body.limit || 40),
        dashboard: buildDashboard(),
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true, app: "MechMindWorktimeAssistant",
        installRoot: path.resolve(ROOT), dataRoot: path.resolve(DATA_ROOT), logsDir: path.resolve(LOG_ROOT),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/diagnostics") {
      const archive = log.buildDiagnosticArchive();
      log.info("lifecycle", "diagnostics.export", "已导出本机诊断包", { files: archive.manifest.files, bytes: archive.buffer.length });
      return sendBinary(response, archive.buffer, "application/zip", archive.fileName);
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      const result = await runAssistant(["list"]);
      return sendJson(response, 200, { ok: true, ...result, dashboard: buildDashboard() });
    }
    if (request.method === "POST" && url.pathname === "/api/defaults") {
      if (activeAction || updates.installing()) return sendJson(response, 409, { error: "正在处理工时或更新，请完成后再保存默认值。" });
      const body = await readBody(request);
      if (activeAction || updates.installing()) return sendJson(response, 409, { error: "正在处理工时或更新，请完成后再保存默认值。" });
      if (!body.account || !accountsMatch(readConfig().account, body.account)) {
        return sendJson(response, 409, { error: "账户已变化，请刷新页面后重新保存默认值。" });
      }
      const settings = normalizeSettings(body.settings);
      saveDefaults(settings);
      return sendJson(response, 200, {
        ok: true,
        message: "已保存为当前账户的本机默认值。",
        dashboard: buildDashboard(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/calendar") {
      const body = await readBody(request);
      if (activeAction || updates.installing()) return sendJson(response, 409, { error: "正在处理工时或更新，请完成后再调整工作日。" });
      if (!Array.isArray(body.dates) || !body.dates.length || body.dates.length > 31 ||
          body.dates.some((date) => typeof date !== "string" || !validDate(date)) ||
          !["work", "rest", "default"].includes(body.mode)) {
        return sendJson(response, 400, { error: "请选择 1 至 31 个有效日期，并选择上班、休息或恢复默认。" });
      }
      const config = readConfig();
      if (!body.account || !accountsMatch(config.account, body.account)) {
        return sendJson(response, 409, { error: "账户已变化或尚未登录，请刷新页面后重新调整。" });
      }
      const workdayOverrides = { ...config.workdayOverrides };
      for (const date of new Set(body.dates)) {
        if (body.mode === "default") delete workdayOverrides[date];
        else workdayOverrides[date] = body.mode;
      }
      writeJsonAtomic(CONFIG_PATH, { ...config, workdayOverrides });
      const label = { work: "设为上班", rest: "设为休息", default: "恢复默认" }[body.mode];
      log.info("calendar", "overrides.save", `已将 ${new Set(body.dates).size} 天${label}`, {
        dates: [...new Set(body.dates)], mode: body.mode, count: new Set(body.dates).size,
      });
      return sendJson(response, 200, {
        ok: true, message: `已将 ${new Set(body.dates).size} 天${label}。`, dashboard: buildDashboard(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/preview") {
      const body = await readBody(request);
      const payload = normalizeActionPayload(body);
      log.info("fill", "preview.request", `收到预演 ${payload.dates.length} 天`, {
        dates: payload.dates, workType: payload.settings.workType, projectCode: payload.settings.projectCode, hours: payload.settings.hours,
      });
      const result = await runAssistant(["batch-preview", `--payload=${encodePayload(payload)}`], 60_000 + payload.dates.length * 90_000);
      return sendJson(response, 200, { ok: true, ...result, dashboard: buildDashboard() });
    }
    if (request.method === "POST" && url.pathname === "/api/submit") {
      const body = await readBody(request);
      if (body.confirm !== true) return sendJson(response, 400, { error: "请先确认本次提交。" });
      const payload = normalizeActionPayload(body);
      log.info("fill", "submit.request", `收到提交 ${payload.dates.length} 天`, {
        dates: payload.dates, workType: payload.settings.workType, projectCode: payload.settings.projectCode, hours: payload.settings.hours,
      });
      const result = await runAssistant([
        "batch-submit",
        `--payload=${encodePayload(payload)}`,
        "--yes",
      ], 60_000 + payload.dates.length * 120_000);
      const dashboard = buildDashboard();
      scheduleAutomaticRefresh();
      return sendJson(response, 200, { ok: true, ...result, dashboard });
    }
    if ((request.method === "GET" || request.method === "HEAD") && sendStatic(response, url.pathname)) {
      return;
    }
    return sendJson(response, 404, { error: "未找到该功能。" });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500 || !error.statusCode) {
      log.logError("http", "request.fail", error, error.message, { method: request.method, path: request.url });
    }
    return sendJson(response, status, { error: error.message || "操作失败。", result: error.result || null, runId: error.runId || null });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const port = server.address().port;
    console.log(`工时面板服务已启动：http://${HOST}:${port}`);
    log.info("lifecycle", "service.start", `工时面板服务已启动：http://${HOST}:${port}`, {
      port, version: log.appVersion(), dataRoot: DATA_ROOT, logsDir: LOG_ROOT,
    });
    void checkSession();
    if (process.env.WORKTIME_DISABLE_UPDATE_CHECK !== "1" && process.env.WORKTIME_LAUNCHER_MANAGED !== "1") void updates.check();
  });
}

module.exports = { server, normalizeSettings, normalizeActionPayload, runAssistant, buildDashboard, updates };
