"use strict";

const fs = require("node:fs");
const path = require("node:path");
const log = require("./worktime-log.cjs");
const { STATE_PATH, normalizeBaseUrl, normalizeProjects } = require("./worktime-common.cjs");

function runtimeModule(name) {
  try { return require(name); }
  catch { return require(path.join(__dirname, "dashboard", "node_modules", name)); }
}

const { parseFragment } = runtimeModule("parse5");

class ApiUnavailable extends Error {}

function incomplete(message) {
  return Object.assign(new Error(message), { code: "INCOMPLETE_SYNC" });
}

function htmlText(value) {
  const walk = (node) => node.nodeName === "#text" ? node.value : node.tagName === "br" ? " " :
    ["script", "style"].includes(node.tagName) ? "" : (node.childNodes || []).map(walk).join("");
  return walk(parseFragment(String(value ?? ""))).replace(/\s+/g, " ").trim();
}

async function createOaApi(config, options = {}) {
  const storageState = options.storageState ?? STATE_PATH;
  if (typeof storageState === "string" && !fs.existsSync(storageState)) throw new Error("LOGIN_REQUIRED");
  const { request } = runtimeModule("playwright");
  const context = await request.newContext({ storageState, timeout: 15_000 });
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  return {
    config,
    context,
    account: null,
    async query(pathname, parameters = {}, method = "GET") {
      let response;
      const started = Date.now();
      const endpoint = log.diagnosticUrl(new URL(pathname, baseUrl).toString());
      log.diagnostic("api.start", { endpoint, method });
      try {
        response = await context.fetch(new URL(pathname, baseUrl).toString(), {
          method, maxRedirects: 0,
          ...(method === "GET" ? { params: parameters } : { form: parameters }),
        });
      } catch (cause) {
        log.diagnostic("api.network_failure", { endpoint, method, durationMs: Date.now() - started, failure: log.diagnosticFailure(cause), cause: log.diagnosticFailure(cause?.cause) });
        throw Object.assign(new Error("无法连接 OA 数据接口，请检查网络后重试。", { cause }), { code: "OA_NETWORK" });
      }
      log.diagnostic("api.response", { endpoint, method, status: response.status(), durationMs: Date.now() - started });
      try {
        if (response.status() === 401 || [301, 302, 303].includes(response.status())) throw new Error("LOGIN_REQUIRED");
        if (!response.ok()) {
          if ([404, 405, 501].includes(response.status())) throw new ApiUnavailable(`OA 接口暂不可用：${pathname}`);
          throw new Error(`OA 接口返回 HTTP ${response.status()}，已保留原缓存。`);
        }
        let payload;
        try { payload = await response.json(); }
        catch { throw new ApiUnavailable("OA 接口未返回可识别的数据。"); }
        if (payload?.errorCode === "002" || /登录.*失效|重新登录|未登录/.test(String(payload?.msg || ""))) {
          throw new Error("LOGIN_REQUIRED");
        }
        if (!payload || payload.status === false || payload.api_status === false) {
          throw new ApiUnavailable("OA 数据接口未完成查询，已保留原缓存。");
        }
        return payload;
      } finally {
        await response.dispose();
      }
    },
    dispose: () => context.dispose(),
  };
}

async function verifyApiSession(api) {
  const payload = await api.query("/api/ecode/sync");
  if (!payload._data || typeof payload._data !== "object") throw new ApiUnavailable("OA 登录检查接口无法识别。");
  const user = payload._data._user;
  if (!user?.resourceId || !user.resourceName) throw new Error("LOGIN_REQUIRED");
  const expected = api.config.account || {};
  const matches = expected.oaUserId
    ? String(expected.oaUserId) === String(user.resourceId)
    : expected.name === user.resourceName &&
      String(expected.oaLoginId || expected.employeeNo || "") === String(user.loginId || "");
  if (!matches) {
    throw Object.assign(new Error("OA 会话账户与本机账户不一致，请重新扫码登录。"), { code: "ACCOUNT_MISMATCH" });
  }
  api.account = { ...expected, oaUserId: String(user.resourceId), oaLoginId: String(user.loginId || "") };
  return api.account;
}

// Use the server's actual page size: OA browser fields can cap a larger request.
async function collectApiPages(first, total, fetchPage, keyOf) {
  const pageSize = Number(first.pageSize) || first.datas?.length || 1;
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 ||
      !Array.isArray(first.datas) || first.datas.length !== Math.min(pageSize, total)) {
    throw incomplete("OA 列表数量或分页信息不完整，已保留原缓存。");
  }
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount > 10_000) throw incomplete("OA 列表超过同步范围，已保留原缓存。");
  const pages = [first.datas];
  let nextPage = 2;
  let failed = false;
  const workers = Array.from({ length: Math.min(4, pageCount - 1) }, async () => {
    while (!failed && nextPage <= pageCount) {
      const current = nextPage++;
      try {
        const payload = await fetchPage(current, pageSize);
        const expected = Math.min(pageSize, total - (current - 1) * pageSize);
        if (!Array.isArray(payload.datas) || payload.datas.length !== expected ||
            (payload.pageSize != null && Number(payload.pageSize) !== pageSize) ||
            (payload.total != null && Number(payload.total) !== total)) {
          throw incomplete("OA 分页数据不完整或同步期间发生变化，已保留原缓存，请重新同步。");
        }
        pages[current - 1] = payload.datas;
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const rows = pages.flat();
  const keys = rows.map(keyOf).map((key) => String(key ?? ""));
  if (rows.length !== total || keys.some((key) => !key) || new Set(keys).size !== total) {
    throw incomplete("OA 返回了重复或缺失的记录，已保留原缓存，请重新同步。");
  }
  return rows;
}

function parseDoneRows(rows, columns, workflowId) {
  const fieldFor = (name) => columns.find((column) => column.dbField?.toLowerCase() === name.toLowerCase())?.dataIndex;
  const operationField = fieldFor("operatedateNew") || "operatedateNew";
  return rows.filter((row) => String(row.workflowid) === String(workflowId)).map((row) => {
    const title = htmlText(row.requestnamespan ?? row.requestname);
    const workDate = title.match(/工时日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    const parsed = workDate ? new Date(`${workDate}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== workDate || !/^\d+$/.test(String(row.requestid))) {
      throw new ApiUnavailable("OA 工时字段无法完整解析，正在改用页面核对。");
    }
    const node = htmlText(row.currentnodeidspan);
    return {
      workDate,
      documentNo: String(row.requestmark || ""),
      requestId: String(row.requestid),
      operationTime: htmlText(row[`${operationField}span`] ?? row[operationField]).match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0] || "",
      status: node.match(/(\d+-归档|归档|处理中|已办)/)?.[1] || String(row.status || ""),
      title,
    };
  });
}

async function collectDoneApi(api) {
  const { sessionkey } = await api.query("/api/workflow/reqlist/splitPageKey", {
    method: "all", offical: "", officalType: "-1", hideNoDataTab: "false",
    viewScope: "done", complete: "2", date2during: "0", viewcondition: "10",
    defaultTabVal: "-1", menuIds: "1,90", menuPathIds: "1,90", loadDefTab: "false",
    actiontype: "splitpage", workflowid: String(api.config.workflowId),
  }, "POST");
  if (!sessionkey) throw new ApiUnavailable("OA 已办查询接口未返回列表标识。");
  const fetchPage = (current, pageSize) => api.query("/api/ec/dev/table/datas", {
    dataKey: sessionkey, current: String(current), pageSize: String(pageSize), sortParams: "[]",
  }, "POST");
  const [first, count] = await Promise.all([
    fetchPage(1, 200), api.query("/api/ec/dev/table/counts", { dataKey: sessionkey }, "POST"),
  ]);
  if (count.count == null || !Array.isArray(first.columns)) throw new ApiUnavailable("OA 已办列表格式无法识别。");
  const rows = await collectApiPages(first, Number(count.count), fetchPage, (row) => row.requestid);
  if (rows.some((row) => row.workflowid == null)) throw new ApiUnavailable("OA 已办流程类别无法识别。");
  const after = await api.query("/api/ec/dev/table/counts", { dataKey: sessionkey }, "POST");
  if (Number(after.count) !== rows.length) throw incomplete("同步期间 OA 已办数量发生变化，请重新同步。");
  return { records: parseDoneRows(rows, first.columns, api.config.workflowId), sourceTotal: rows.length };
}

async function searchCatalogApi(api, kind, query, options = {}) {
  if (!api.account) throw new Error("必须先验证当前 OA 账户。");
  const fields = {
    "work-types": { type: "browser.gzlx", fieldid: "12653" },
    projects: { type: "browser.xmh", fieldid: "12654" },
  };
  const field = fields[kind];
  if (!field || Number(api.config.workflowId) !== 197) throw new ApiUnavailable("该工时表单需要通过页面获取选项。");
  const term = String(query || "").trim();
  if (!term) return { rows: [], sourceTotal: 0 };
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 40));
  const payload = await api.query("/api/public/browser/data/161", {
    ...field, fielddbtype: field.type, pageSize: String(pageSize), current: "1",
    min: "1", max: String(pageSize),
    companyId: "1", currenttime: String(Date.now()), nodataloading: "0", requestid: "-1",
    workflowid: String(api.config.workflowId), wfid: String(api.config.workflowId), billid: "-154", isbill: "1",
    f_weaver_belongto_userid: api.account.oaUserId, f_weaver_belongto_usertype: "0",
    wf_isagent: "0", wf_beagenter: "0", wfTestStr: "", viewtype: "1", fromModule: "workflow",
    wfCreater: api.account.oaUserId, disabledConditionCache: "true", __random__: String(Date.now()),
    q: term,
  });
  if (!Array.isArray(payload.datas)) throw new ApiUnavailable("OA 选项接口格式无法识别。");
  return { rows: payload.datas, sourceTotal: Number(payload.total) || payload.datas.length };
}

async function collectCatalogApi(api, kind) {
  if (!api.account) throw new Error("必须先验证当前 OA 账户。");
  // These are the same browser fields used by this application's worktime form.
  const fields = {
    "work-types": { type: "browser.gzlx", fieldid: "12653" },
    projects: { type: "browser.xmh", fieldid: "12654" },
  };
  const field = fields[kind];
  if (!field || Number(api.config.workflowId) !== 197) throw new ApiUnavailable("该工时表单需要通过页面获取选项。");
  const fetchPage = (current, pageSize) => api.query("/api/public/browser/data/161", {
    ...field, fielddbtype: field.type, pageSize: String(pageSize), current: String(current),
    min: String((current - 1) * pageSize + 1), max: String(current * pageSize),
    companyId: "1", currenttime: String(Date.now()), nodataloading: "0", requestid: "-1",
    workflowid: String(api.config.workflowId), wfid: String(api.config.workflowId), billid: "-154", isbill: "1",
    f_weaver_belongto_userid: api.account.oaUserId, f_weaver_belongto_usertype: "0",
    wf_isagent: "0", wf_beagenter: "0", wfTestStr: "", viewtype: "1", fromModule: "workflow",
    wfCreater: api.account.oaUserId, disabledConditionCache: "true", __random__: String(Date.now()),
  });
  const first = await fetchPage(1, 500);
  if (!Array.isArray(first.datas) || first.total == null) throw new ApiUnavailable("OA 选项接口格式无法识别。");
  const rows = await collectApiPages(first, Number(first.total), fetchPage, (row) => row.randomFieldId);
  return { rows, sourceTotal: Number(first.total) };
}

module.exports = {
  ApiUnavailable, createOaApi, verifyApiSession, collectApiPages, parseDoneRows,
  collectDoneApi, collectCatalogApi, searchCatalogApi, normalizeProjects,
};
