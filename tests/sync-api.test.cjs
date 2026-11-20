"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { test, before, after } = require("node:test");
const { ROOT, temporaryDirectory, removeTemporary, writeJson, defaults, account } = require("./test-support.cjs");
const { createOaApi, verifyApiSession, collectDoneApi, collectCatalogApi, searchCatalogApi, collectApiPages, parseDoneRows, ApiUnavailable } = require("../worktime-api.cjs");

const directory = temporaryDirectory("sync-api");
let mode = "valid";
let baseUrl;
let requests = [];
const rows = Array.from({ length: 11 }, (_, index) => ({
  requestid: String(index + 1), workflowid: "197", requestmark: `GSTB-${index + 1}`,
  requestnamespan: `<a>工时填报-A&amp;B<b>（工时日期:2020-01-${String(index + 1).padStart(2, "0")}）</b></a>`,
  currentnodeidspan: "2-归档", whenDate: "2020-02-01", whenTime: "12:34:56",
  operatedateNewspan: "2020-01-20<br>12:34:56",
}));
const columns = [{ dbField: "viewDate", dataIndex: "whenDate" }, { dbField: "viewTime", dataIndex: "whenTime" }];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, baseUrl);
  const parts = [];
  for await (const chunk of request) parts.push(chunk);
  const params = request.method === "POST" ? new URLSearchParams(Buffer.concat(parts).toString()) : url.searchParams;
  requests.push({ path: url.pathname, method: request.method, params: Object.fromEntries(params) });
  const send = (payload) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(payload)); };
  if (mode === "redirect") { response.writeHead(302, { Location: "/login" }); return response.end(); }
  if (mode === "expired") return send({ errorCode: "002", status: false, msg: "登录失效" });
  if (mode === "network") { request.socket.destroy(); return; }
  if (url.pathname === "/api/ecode/sync") return send({ status: true, _data: mode === "empty-user" ? {} : { _user: {
    resourceId: mode === "mismatch" ? "999" : "123", resourceName: account.name, loginId: account.employeeNo,
  } } });
  if (url.pathname.endsWith("/splitPageKey")) return send({ sessionkey: "TEST_KEY" });
  if (url.pathname.endsWith("/counts")) return send({ count: 11 });
  if (url.pathname.endsWith("/datas")) {
    const current = Number(params.get("current"));
    return send({ columns, pageSize: "3", datas: mode === "incomplete" && current === 2 ? [] : rows.slice((current - 1) * 3, current * 3) });
  }
  if (mode === "submit-no-request" && url.pathname === "/spa/workflow/static4form/index.html") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    return response.end(`<body>工时填报
      <input id="field12648" value="${account.name}"><input id="field12643" value="${account.employeeNo}">
      <div class="field12646_swapDiv"><button class="picker-icon">选择日期</button></div>
      <input id="field12646"><input id="field12653_0"><input id="field12654_0">
      <input id="field12655_0" oninput="document.getElementById('field12647').value = Number(this.value).toFixed(1)">
      <input id="field12647"><input id="field13685"><textarea id="field12656_0"></textarea>
      <table><tr><td title="2020-01-20">20</td><td title="2020-01-21">21</td></tr></table>
      <button title="提交">提交</button>
      <script>
        window.WfForm = {
          getFieldCurViewAttr() { return 2; },
          getFieldValue(id) { return document.getElementById(id).value; },
          changeFieldValue(id, field) { document.getElementById(id).value = field.value; },
        };
        for (const cell of document.querySelectorAll('td')) cell.onclick = async () => {
          document.getElementById('field12646').value = cell.title;
          await fetch('/api/workflow/linkage/reqFieldSqlResult', {method:'POST', body:cell.title});
          document.getElementById('field13685').value = '0';
        };
        document.querySelector('[title="提交"]').onclick = () => fetch('/test/submit-clicked');
      </script></body>`);
  }
  if (mode === "submit-no-request" && url.pathname === "/api/workflow/linkage/reqFieldSqlResult") {
    return send({ assignInfo_90: { changeValue: { field13685: { value: "0" } } } });
  }
  if (mode === "submit-no-request" && url.pathname === "/test/submit-clicked") return send({});
  if (url.pathname === "/api/public/browser/data/161") {
    const current = Number(params.get("current"));
    const query = String(params.get("q") || "");
    const catalog = Array.from({ length: 11 }, (_, index) => ({
      randomFieldId: String(index + 1), bm: String(index + 1), mc: `类别${index}`,
      xmbm: `P${String(index + 1).padStart(3, "0")}${index === 9 ? "#US" : ""}`,
      xmmc: index === 8 ? "Caterpillar(美国)-试验" : `项目${index}`,
    }));
    const matched = query ? catalog.filter((row) => row.xmbm.includes(query) || row.xmmc.includes(query)) : catalog;
    if (query) return send({ total: matched.length, pageSize: matched.length || 1, datas: matched });
    return send({ total: 11, pageSize: 2, datas: catalog.slice((current - 1) * 2, current * 2) });
  }
  response.writeHead(404); response.end();
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  removeTemporary(directory);
});

async function client(t) {
  requests = [];
  const api = await createOaApi({ ...defaults, baseUrl, workflowId: 197, account: { ...account, oaUserId: "123" } }, {
    storageState: { cookies: [], origins: [] },
  });
  t.after(() => api.dispose());
  return api;
}

test("API synchronization gets every completed record without opening a web page", async (t) => {
  mode = "valid";
  const api = await client(t);
  await verifyApiSession(api);
  const result = await collectDoneApi(api);
  assert.equal(result.records.length, 11);
  assert.equal(result.records.at(-1).workDate, "2020-01-11");
  assert.equal(result.records[0].title, "工时填报-A&B（工时日期:2020-01-01）");
  assert.equal(result.records[0].operationTime, "2020-01-20 12:34:56");
  assert.equal(result.records[0].status, "2-归档");
  assert.ok(requests.every((request) => request.path.startsWith("/api/")));
  const pages = requests.filter((request) => request.path.endsWith("/datas"));
  assert.deepEqual(pages.map((page) => page.params.current).sort(), ["1", "2", "3", "4"]);
  assert.equal(pages[0].params.pageSize, "200");
  assert.equal(pages[1].params.pageSize, "3");
});

test("project search uses OA's q parameter and keeps special project numbers", async (t) => {
  mode = "valid";
  requests = [];
  const api = await client(t);
  await verifyApiSession(api);
  const found = await searchCatalogApi(api, "projects", "P010#US");
  assert.equal(found.rows.length, 1);
  assert.equal(found.rows[0].xmbm, "P010#US");
  const america = await searchCatalogApi(api, "projects", "美国");
  assert.equal(america.rows.length, 1);
  assert.match(america.rows[0].xmmc, /Caterpillar/);
  assert.equal(requests.filter((request) => request.path.includes("/browser/")).at(-1).params.q, "美国");
});

test("catalog sync honors the server page cap and verified user identity", async (t) => {
  mode = "valid";
  const api = await client(t);
  await verifyApiSession(api);
  assert.equal((await collectCatalogApi(api, "work-types")).rows.length, 11);
  const pages = requests.filter((request) => request.path.includes("/browser/"));
  assert.equal(pages.length, 6);
  assert.equal(pages[0].params.pageSize, "500");
  assert.equal(pages[1].params.pageSize, "2");
  assert.equal(pages[1].params.min, "3");
  assert.equal(pages[1].params.max, "4");
  assert.ok(pages.every((page) => page.params.f_weaver_belongto_userid === "123"));
});

test("expiry and identity mismatch stop before any synchronization request", async (t) => {
  for (const scenario of ["expired", "empty-user", "redirect", "mismatch"]) {
    mode = scenario;
    const api = await client(t);
    await assert.rejects(verifyApiSession(api), (error) => scenario === "mismatch" ? error.code === "ACCOUNT_MISMATCH" : error.message === "LOGIN_REQUIRED");
    assert.equal(requests.length, 1);
  }
});

test("transport failure remains a network error instead of expiry", async (t) => {
  mode = "network";
  const api = await client(t);
  await assert.rejects(verifyApiSession(api), (error) => error.code === "OA_NETWORK");
});

test("bounded parallel requests retain page order and detect duplicate or changing data", async () => {
  let active = 0;
  let peak = 0;
  const rows = await collectApiPages({ pageSize: 1, datas: [1] }, 15, async (current) => {
    peak = Math.max(peak, ++active);
    await delay(current % 2 ? 2 : 8);
    active--;
    return { datas: [current], total: 15 };
  }, (row) => row);
  assert.deepEqual(rows, Array.from({ length: 15 }, (_, index) => index + 1));
  assert.equal(peak, 4);
  for (const second of [{ datas: [1] }, { datas: [] }, { datas: [2], total: 3 }, { datas: [2], pageSize: 3 }]) {
    await assert.rejects(collectApiPages({ pageSize: 1, datas: [1] }, 2, async () => second, (row) => row), (error) => error.code === "INCOMPLETE_SYNC");
  }
  assert.deepEqual(await collectApiPages({ pageSize: 200, datas: [] }, 0, async () => assert.fail(), (row) => row), []);
});

test("completed-workflow parsing filters other workflow types and rejects malformed dates", () => {
  assert.equal(parseDoneRows([{ ...rows[0], workflowid: "999" }], columns, 197).length, 0);
  assert.throws(() => parseDoneRows([{ ...rows[0], requestnamespan: "工时日期:2020-02-30" }], columns, 197), ApiUnavailable);
  assert.equal(parseDoneRows([{ ...rows[0], operatedateNewspan: " " }], columns, 197)[0].operationTime, "");
});

async function cli(command, ...args) {
  writeJson(path.join(directory, "worktime.config.json"), { ...defaults, baseUrl, workflowId: 197, account: { ...account, oaUserId: "123" } });
  writeJson(path.join(directory, "storage-state.json"), { cookies: [], origins: [] });
  const child = spawn(process.execPath, [path.join(ROOT, "worktime.cjs"), command, ...args], {
    env: { ...process.env, WORKTIME_DATA_ROOT: directory }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  return { code, output };
}

test("the actual CLI uses the fast path and preserves previous data on partial failure", async () => {
  mode = "valid";
  const complete = await cli("list");
  assert.equal(complete.code, 0, complete.output);
  assert.match(complete.output, /11 条/);
  const csv = path.join(directory, "已办工时.csv");
  const saved = fs.readFileSync(csv, "utf8");
  mode = "incomplete";
  const partial = await cli("list");
  assert.equal(partial.code, 1);
  assert.equal(fs.readFileSync(csv, "utf8"), saved);
});

test("pending review keeps old markers when OA cannot be verified and reconciles only the selected date", async () => {
  const csv = path.join(directory, "已办工时.csv");
  const time = "2020-02-01 08:00:00";
  const pending = ["2020-01-09", "2020-01-20", "2020-01-21"]
    .map((date) => `"${date}","","","${time}","已提交·同步中","待核对"`).join("\r\n");
  const original = `\uFEFF"工时日期","单据编号","请求ID","操作时间","状态","流程标题"\r\n${pending}\r\n`;
  const run = (date, operationTime = time) => cli("resolve-pending", `--payload=${Buffer.from(JSON.stringify({
    date, operationTime, confirm: true, account: { ...account, oaUserId: "123" },
  })).toString("base64url")}`);
  fs.writeFileSync(csv, original);
  for (const scenario of ["expired", "mismatch", "incomplete"]) {
    mode = scenario;
    assert.equal((await run("2020-01-20")).code, 1);
    assert.equal(fs.readFileSync(csv, "utf8"), original);
  }
  mode = "valid";
  assert.equal((await run("2020-01-20", "stale")).code, 1);
  assert.equal(fs.readFileSync(csv, "utf8"), original);
  const found = await run("2020-01-09");
  assert.equal(found.code, 0, found.output);
  assert.match(found.output, /"resolution":"confirmed"/);
  const updated = fs.readFileSync(csv, "utf8");
  assert.match(updated, /"2020-01-09","GSTB-9","9"/);
  assert.match(updated, /"2020-01-20","","","2020-02-01 08:00:00","已提交·同步中"/);
  const absent = await run("2020-01-20");
  assert.equal(absent.code, 0, absent.output);
  assert.match(absent.output, /"resolution":"released"/);
  const released = fs.readFileSync(csv, "utf8");
  assert.doesNotMatch(released, /"2020-01-20",""/);
  assert.match(released, /"2020-01-21","","","2020-02-01 08:00:00","已提交·同步中"/);
  assert.match(released, /"2020-01-09","GSTB-9","9"/);
});

test("a real batch command persists an unresolved date, stops the rest, and does not retry it", async () => {
  mode = "submit-no-request";
  requests = [];
  const dates = ["2020-01-20", "2020-01-21"];
  const owner = { ...account, oaUserId: "123" };
  const leave = { name: "休假", code: "004" };
  const csv = path.join(directory, "已办工时.csv");
  fs.writeFileSync(csv, '"工时日期","单据编号","请求ID","操作时间","状态","流程标题"\r\n');
  writeJson(path.join(directory, "work-types.json"), { account: owner, sourceTotal: 1, workTypes: [leave] });
  const submit = (selected) => cli("batch-submit", "--yes", `--payload=${Buffer.from(JSON.stringify({
    dates: selected, account: owner, fast: true, settings: { workType: leave },
  })).toString("base64url")}`);
  const result = await submit(dates);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /未检测到 OA 提交请求/);
  assert.match(result.output, /"submittedDates":\[\],"unconfirmedDates":\["2020-01-20"\]/);
  const persisted = fs.readFileSync(csv, "utf8");
  assert.match(persisted, /"2020-01-20","","","[^"]+","结果待核对"/);
  assert.doesNotMatch(persisted, /2020-01-21/);
  assert.equal(requests.filter((item) => item.path === "/test/submit-clicked").length, 1);
  assert.equal(requests.filter((item) => item.path.endsWith("reqFieldSqlResult")).length, 1);
  const repeat = await submit(dates.slice(0, 1));
  assert.equal(repeat.code, 0, repeat.output);
  assert.match(repeat.output, /"skippedDates":\["2020-01-20"\]/);
  assert.equal(requests.filter((item) => item.path === "/test/submit-clicked").length, 1);
});

test("startup check records expiry and network failures without discarding saved credentials", async () => {
  for (const [scenario, state, reason] of [["expired", "error", "expired"], ["network", "unavailable", undefined], ["valid", "connected", undefined]]) {
    mode = scenario;
    const result = await cli("session-check");
    assert.equal(result.code, state === "connected" ? 0 : 1, result.output);
    const status = JSON.parse(fs.readFileSync(path.join(directory, "login-status.json"), "utf8"));
    assert.equal(status.state, state);
    assert.equal(status.reason, reason);
    assert.ok(fs.existsSync(path.join(directory, "storage-state.json")));
  }
});
