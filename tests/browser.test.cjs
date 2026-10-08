"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { ROOT, temporaryDirectory, removeTemporary, dashboard, defaults, account } = require("./test-support.cjs");
const { chromium } = require("../dashboard/node_modules/playwright");

const directory = temporaryDirectory("browser");
process.env.WORKTIME_DATA_ROOT = directory;
const assistant = require("../worktime.cjs");
const common = require("../worktime-common.cjs");
let browser;
before(async () => {
  const executablePath = [
    chromium.executablePath(),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find((file) => fs.existsSync(file));
  assert.ok(executablePath, "Edge, Chrome or Playwright Chromium is required for browser regression tests");
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => {
  await browser?.close();
  removeTemporary(directory);
});

async function oaPage(t, handler) {
  const context = await browser.newContext({ timezoneId: "Asia/Shanghai" });
  context.setDefaultTimeout(8_000);
  t.after(() => context.close());
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, "oa.test", "The regression suite must never contact real OA");
    await handler(route, url);
  });
  return context.newPage();
}

test("temporary diagnostics capture a missing date button without submitting or logging field values", async (t) => {
  const flag = path.join(directory, "temporary-diagnostics.json");
  fs.writeFileSync(flag, JSON.stringify({ enabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  t.after(() => fs.unlinkSync(flag));
  const log = require("../worktime-log.cjs");
  log.resetLoggerForTests({ runId: "date-diagnostics" });
  const page = await oaPage(t, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<body>工时填报
    <input id="field12648" value="测试甲"><input id="field12643" value="TEST001">
    <div class="field12646_swapDiv"><input id="field12646" value="PRIVATE_FIELD_VALUE" readonly><span class="new-date-icon"></span></div>
  </body>` }));
  await assert.rejects(assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test" }, "2020-01-06"), /Timeout/);
  const records = log.readTodayRecords().filter((item) => item.runId === "date-diagnostics");
  const failure = records.find((item) => item.event === "diagnostic.form.failure_state");
  assert.equal(failure.data.dateFields, 1);
  assert.equal(failure.data.expectedIcons, 0);
  assert.equal(failure.data.field.readOnly, true);
  assert.ok(failure.data.nearby.some((item) => item.classes === "new-date-icon"));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_FIELD_VALUE/);
  assert.equal(page.listenerCount("requestfailed"), 0);
  assert.equal(page.listenerCount("pageerror"), 0);
});

test("QR confirmation completes even when OA keeps the QR text and never redirects", async (t) => {
  let accepted = false;
  let probeCount = 0;
  const page = await oaPage(t, async (route, url) => {
    if (url.pathname === "/api/hrm/login/qrcode/getQCLoginStatus") {
      // Model the phone completing login while the original page stays unchanged.
      accepted = true;
      return route.fulfill({ json: { status: "1" } });
    }
    if (url.pathname === "/spa/workflow/static4form/index.html") {
      probeCount++;
      assert.equal(accepted, true, "Do not create more QR sessions while awaiting a scan");
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<body>
        <input id="field12646"><input id="field12648"><input id="field12643">
        <script>setTimeout(() => {
          document.getElementById('field12648').value = '测试甲';
          document.getElementById('field12643').value = 'TEST001';
        }, 200);</script></body>` });
    }
    assert.equal(url.pathname, "/wui/index.html");
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<title>Mech-Mind</title>
      <body>请使用钉钉扫描二维码以登录<canvas width="200" height="200"></canvas>
      <script>setTimeout(() => fetch('/api/hrm/login/qrcode/getQCLoginStatus', { method: 'POST' }), 300);</script></body>` });
  });
  const result = await assistant.waitForQrLogin(page.context(), page, { baseUrl: "http://oa.test", workflowId: 197 }, {
    timeoutMs: 6_000, pollIntervalMs: 30, probeIntervalMs: 50,
  });
  assert.equal(result.employeeNo, "TEST001");
  assert.equal(result.name, "测试甲");
  assert.equal(probeCount, 1);
  assert.match(page.url(), /#\/\?logintype=1$/);
  assert.match(await page.locator("body").innerText(), /请使用钉钉扫描二维码以登录/);
  assert.equal(JSON.parse(fs.readFileSync(common.LOGIN_STATUS_PATH, "utf8")).state, "connected");
  assert.ok(fs.existsSync(common.STATE_PATH));
  assert.equal(page.listenerCount("response"), 0);
});

test("an expired QR returns OA's error instead of staying in waiting", async (t) => {
  const page = await oaPage(t, (route, url) => route.fulfill(url.pathname.includes("getQCLoginStatus")
    ? { json: { status: -1, msg: "二维码已失效" } }
    : { contentType: "text/html; charset=utf-8", body: `<body>请使用钉钉扫描二维码以登录<canvas></canvas>
      <script>setTimeout(() => fetch('/api/hrm/login/qrcode/getQCLoginStatus', { method: 'POST' }), 100);</script></body>` }));
  await assert.rejects(assistant.waitForQrLogin(page.context(), page, { baseUrl: "http://oa.test" }, {
    timeoutMs: 2_000, pollIntervalMs: 30,
  }), /二维码已失效/);
  assert.equal(page.listenerCount("response"), 0);
});

test("a QR that has not been confirmed never becomes connected or opens extra login pages", async (t) => {
  let formProbes = 0;
  const page = await oaPage(t, (route, url) => {
    if (url.pathname.includes("static4form")) formProbes++;
    return route.fulfill(url.pathname.includes("getQCLoginStatus")
      ? { json: { status: "0" } }
      : { contentType: "text/html; charset=utf-8", body: `<title>Mech-Mind 协同</title>
        <body>请使用钉钉扫描二维码以登录<canvas></canvas>
        <script>fetch('/api/hrm/login/qrcode/getQCLoginStatus', { method: 'POST' });</script></body>` });
  });
  await assert.rejects(assistant.waitForQrLogin(page.context(), page, { baseUrl: "http://oa.test" }, {
    timeoutMs: 700, pollIntervalMs: 30, probeIntervalMs: 50,
  }), /二维码已超时/);
  assert.equal(formProbes, 0);
  assert.equal(JSON.parse(fs.readFileSync(common.LOGIN_STATUS_PATH, "utf8")).state, "waiting");
});

test("a first-time user with no completed workflows gets an empty list", async (t) => {
  const page = await oaPage(t, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<body>已办事宜<div class="ant-table-placeholder">暂无数据</div></body>' }));
  assert.deepEqual(await assistant.collectDoneRecords(page, { baseUrl: "http://oa.test", workflowId: 197 }), []);
});

test("pagination advances even when the first page has no worktime workflows", async (t) => {
  const html = `<body>已办事宜<table><tbody><tr><td><a id="item" onclick="openSPA4Single('?requestid=100')">其他流程</a></td></tr></tbody></table>
    <ul><li id="next" class="ant-pagination-next">下一页</li></ul>
    <script>document.getElementById('next').onclick = function () {
      document.getElementById('item').setAttribute('onclick', "openSPA4Single('?requestid=200')");
      document.getElementById('item').textContent = '工时填报（工时日期：2020-01-06）';
      this.classList.add('ant-pagination-disabled');
    };</script></body>`;
  const page = await oaPage(t, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  const records = await assistant.collectDoneRecords(page, { baseUrl: "http://oa.test", workflowId: 197 });
  assert.equal(records.length, 1);
  assert.equal(records[0].workDate, "2020-01-06");
  assert.equal(records[0].requestId, "200");
});

for (const method of ["GET", "POST"]) {
  test(`work types include later pages when OA uses ${method} and omits pageSize`, async (t) => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ bm: `00${index + 1}`, mc: `类别${index + 1}` }));
    const seen = [];
    const page = await oaPage(t, async (route, url) => {
      if (!url.pathname.includes("/api/public/browser/data/161")) return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<body>工时填报</body>" });
      assert.equal(route.request().method(), method);
      const params = method === "POST" ? new URLSearchParams(route.request().postData()) : url.searchParams;
      assert.equal(params.get("fieldid"), "12653");
      const current = Number(params.get("current") || 1);
      seen.push(current);
      return route.fulfill({ json: { datas: rows.slice((current - 1) * 2, current * 2), total: 5 } });
    });
    await page.goto("http://oa.test/");
    const responsePromise = page.waitForResponse((response) => response.url().includes("/api/public/browser/data/161"));
    await page.evaluate(async (method) => {
      const params = "fieldid=12653&type=browser.gzlx&current=1";
      await fetch("/api/public/browser/data/161" + (method === "GET" ? `?${params}` : ""), {
        method,
        ...(method === "POST" ? { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params } : {}),
      });
    }, method);
    const first = await responsePromise;
    assert.equal(assistant.matchesBrowserResponse(first, "12653", "browser.gzlx"), true);
    assert.equal(assistant.matchesBrowserResponse(first, "12654"), false);
    const result = await assistant.collectBrowserRows(page, first, "工作类型");
    assert.equal(result.sourceTotal, 5);
    assert.equal(assistant.normalizeWorkTypes(result.rows).length, 5);
    assert.deepEqual(seen.sort(), [1, 2, 3]);
  });
}

async function formPage(t, duplicateCount = "0", options = {}) {
  const date = common.todayIso().slice(0, 8) + "01";
  const assign = options.unicodeProjectDash
    ? 'document.getElementById(id).value = String(field.value || "").replace(/-/g, "\\u2010");'
    : "document.getElementById(id).value = field.value;";
  const html = `<body>工时填报
    <input id="field12648" value="测试甲"><input id="field12643" value="TEST001"><input id="field12649" value="测试组">
    <div class="field12646_swapDiv"><button class="picker-icon">选择日期</button></div>
    <input id="field12646"><input id="field12653_0"><input id="field12654_0">
    <input id="field12655_0" oninput="document.getElementById('field12647').value = Number(this.value).toFixed(1)">
    <input id="field12647"><input id="field13685"><textarea id="field12656_0">OA 默认备注</textarea>
    <table><tr><td title="${date}" id="date-cell">1</td></tr></table>
    <script>
      window.WfForm = { getFieldCurViewAttr() { return ${options.projectRequired ? 3 : 2}; },
        getFieldValue(id) { return document.getElementById(id).value; }, changeFieldValue(id, field) { ${assign} } };
      document.getElementById('date-cell').onclick = async () => {
        document.getElementById('field12646').value = '${date}';
        const response = await fetch('/api/workflow/linkage/reqFieldSqlResult', {method:'POST',body:'${date}'});
        const data = await response.json();
        document.getElementById('field13685').value = data.assignInfo_90.changeValue.field13685.value;
      };
    </script></body>`;
  const page = await oaPage(t, (route, url) => url.pathname.includes("reqFieldSqlResult")
    ? route.fulfill({ json: { assignInfo_90: { changeValue: { field13685: { value: duplicateCount } } } } })
    : route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  return { page, date };
}

test("8 and 8.00 hours match OA's 8.0 total and empty remarks clear the OA default", async (t) => {
  const { page, date } = await formPage(t);
  for (const hours of ["8", "8.00"]) {
    const values = await assistant.prepareForm(page, {
      ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test", workType: { name: "研发", code: "006" }, hours,
    }, date);
    assert.equal(values.total, "8.0");
    assert.equal(values.workType, "006");
    assert.equal(await page.locator("#field12656_0").inputValue(), "");
  }
});

test("hyphenated project numbers still pass form check when OA stores a unicode dash", async (t) => {
  const { page, date } = await formPage(t, "0", { unicodeProjectDash: true });
  const values = await assistant.prepareForm(page, {
    ...common.DEFAULT_CONFIG,
    baseUrl: "http://oa.test",
    projectCode: "T1908-PA103",
    projectId: "T1908-PA103",
    projectName: "川崎-施格",
    workType: { name: "研发", code: "006" },
  }, date);
  assert.equal(values.project, "T1908\u2010PA103");
});

test("leave clears OA's stale project and emits loading/checking stages without project search", async (t) => {
  const { page, date } = await formPage(t);
  await page.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => { document.getElementById("field12654_0").value = "OLD-PROJECT"; }); });
  const stages = [];
  const values = await assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, account, baseUrl: "http://oa.test", workType: { code: "004", name: "休假" }, projectCode: "", projectId: "", projectName: "" }, date, { onStage: (stage) => stages.push(stage) });
  assert.equal(values.project, "");
  assert.equal(values.workType, "004");
  assert.deepEqual(stages, ["loading", "checking"]);
});

test("leave cannot bypass OA's mandatory project rule or an unknown field rule", async (t) => {
  for (const required of [true, false]) {
    const { page, date } = await formPage(t, "0", { projectRequired: required });
    if (!required) await page.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => { delete window.WfForm.getFieldCurViewAttr; }); });
    await assert.rejects(assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, account, baseUrl: "http://oa.test", workType: { code: "004", name: "休假" } }, date), required ? /仍要求项目/ : /无法核对/);
    assert.equal(await page.locator("#field12654_0").inputValue(), "");
  }
});

test("project dialog clicks the exact dashed code instead of a longer -S sibling", async (t) => {
  const date = common.todayIso().slice(0, 8) + "01";
  const html = `<body>工时填报
    <input id="field12648" value="测试甲"><input id="field12643" value="TEST001"><input id="field12649" value="测试组">
    <div class="field12646_swapDiv"><button class="picker-icon">选择日期</button></div>
    <input id="field12646"><input id="field12653_0"><input id="field12654_0">
    <span id="field12654_0span"><button type="button">浏览</button></span>
    <input id="field12655_0" oninput="document.getElementById('field12647').value = Number(this.value).toFixed(1)">
    <input id="field12647"><input id="field13685"><textarea id="field12656_0"></textarea>
    <table><tr><td title="${date}" id="date-cell">1</td></tr></table>
    <div role="dialog">搜索 <input><button>搜索</button>
      <table><tr><td>T1908-PA103-S</td></tr><tr><td>T1908-PA103</td></tr></table>
    </div>
    <script>
      window.WfForm = { changeFieldValue(id, field) {
        if (id === "field12654_0") return;
        document.getElementById(id).value = field.value;
      } };
      document.getElementById("date-cell").onclick = async () => {
        document.getElementById("field12646").value = "${date}";
        const response = await fetch("/api/workflow/linkage/reqFieldSqlResult", {method:"POST",body:"${date}"});
        const data = await response.json();
        document.getElementById("field13685").value = data.assignInfo_90.changeValue.field13685.value;
      };
      for (const cell of document.querySelectorAll("[role=dialog] td")) {
        cell.onclick = () => { document.getElementById("field12654_0").value = cell.textContent.trim(); };
      }
    </script></body>`;
  const page = await oaPage(t, (route, url) => url.pathname.includes("reqFieldSqlResult")
    ? route.fulfill({ json: { assignInfo_90: { changeValue: { field13685: { value: "0" } } } } })
    : route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  const values = await assistant.prepareForm(page, {
    ...common.DEFAULT_CONFIG,
    baseUrl: "http://oa.test",
    projectCode: "T1908-PA103",
    projectId: "T1908-PA103",
    projectName: "川崎-施格",
    workType: { name: "研发", code: "006" },
  }, date);
  assert.equal(values.project, "T1908-PA103");
});

test("submit surfaces OA project errors instead of waiting", async (t) => {
  const html = `<body>工时填报
    <button title="提交">提交</button>
    <div id="err" class="ant-message-error" hidden>该项目不能用于工时填报</div>
    <script>
      document.querySelector('button[title="提交"]').onclick = () => {
        document.getElementById('err').hidden = false;
      };
    </script></body>`;
  const page = await oaPage(t, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto("http://oa.test/");
  const started = Date.now();
  await assert.rejects(assistant.submitPreparedForm(page), /该项目不能用于工时填报/);
  assert.ok(Date.now() - started < 4_000, "OA project errors must not look like a hung submit");
});

test("OA duplicate validation still stops a prepared form", async (t) => {
  const { page, date } = await formPage(t, "1");
  await assert.rejects(assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test" }, date), /重复校验未通过/);
});

async function calendarFormPage(t, options) {
  const validations = [];
  const html = `<body>工时填报
    <input id="field12648" value="测试甲"><input id="field12643" value="TEST001">
    <div class="field12646_swapDiv"><button class="picker-icon">选择日期</button></div>
    <input id="field12646"><input id="field12653_0"><input id="field12654_0">
    <input id="field12655_0" oninput="document.getElementById('field12647').value = Number(this.value).toFixed(1)">
    <input id="field12647"><input id="field13685"><textarea id="field12656_0"></textarea>
    <div class="ant-calendar">
      <span class="ant-calendar-year-select"></span><span class="ant-calendar-month-select"></span>
      <button class="ant-calendar-prev-month-btn">上一月</button><button class="ant-calendar-next-month-btn">下一月</button>
      <table><tbody id="calendar-days"></tbody></table>
    </div>
    <script>
      const options = ${JSON.stringify(options)};
      let current = new Date(options.initial + '-01T00:00:00Z');
      window.monthMoves = 0;
      window.WfForm = { changeFieldValue(id, field) { document.getElementById(id).value = field.value; } };
      function render() {
        const year = current.getUTCFullYear(), month = current.getUTCMonth() + 1;
        document.querySelector('.ant-calendar-year-select').textContent = options.unknownMonth ? '' : year + '年';
        document.querySelector('.ant-calendar-month-select').textContent = options.unknownMonth ? '' : options.localizedHeading ? 'Localized month' : month + '月';
        const prefix = year + '-' + String(month).padStart(2, '0') + '-';
        let cells = '<td class="ant-calendar-cell ant-calendar-last-month-cell">3</td>';
        for (let day = 1; day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); day++) {
          const iso = prefix + String(day).padStart(2, '0');
          const title = options.dayOnly || options.unknownMonth ? '' : options.chineseTitles ? year + '年' + month + '月' + day + '日' : iso;
          cells += '<td class="ant-calendar-cell" title="' + title + '" data-date="' + iso + '">' + day + '</td>';
        }
        cells += '<td class="ant-calendar-cell ant-calendar-next-month-btn-day">3</td>';
        document.getElementById('calendar-days').innerHTML = '<tr>' + cells + '</tr>';
        document.querySelectorAll('td[data-date]').forEach(cell => cell.onclick = async () => {
          const value = options.wrongValue || cell.dataset.date;
          document.getElementById('field12646').value = value;
          const response = await fetch('/api/workflow/linkage/reqFieldSqlResult', { method: 'POST', body: value });
          const data = await response.json();
          document.getElementById('field13685').value = data.assignInfo_90.changeValue.field13685.value;
        });
      }
      function move(delta) {
        window.monthMoves++;
        setTimeout(() => { current.setUTCMonth(current.getUTCMonth() + delta); render(); }, 75);
      }
      document.querySelector('.ant-calendar-prev-month-btn').onclick = () => move(-1);
      document.querySelector('.ant-calendar-next-month-btn').onclick = () => move(1);
      render();
    </script></body>`;
  const page = await oaPage(t, (route, url) => {
    if (url.pathname.includes("reqFieldSqlResult")) {
      validations.push(route.request().postData());
      return route.fulfill({ json: { assignInfo_90: { changeValue: { field13685: { value: options.duplicateCount || "0" } } } } });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
  });
  return { page, validations };
}

for (const scenario of [
  { name: "current month", initial: "2026-10", target: "2026-10-03", moves: 0 },
  { name: "previous month with the same day number", initial: "2026-10", target: "2026-09-03", moves: 1 },
  { name: "three months earlier", initial: "2026-10", target: "2026-07-03", moves: 3 },
  { name: "previous year", initial: "2026-01", target: "2025-12-03", moves: 1 },
  { name: "next year", initial: "2025-12", target: "2026-01-03", moves: 1 },
  { name: "actual initial month differs from the machine month", initial: "2026-06", target: "2026-09-03", moves: 3 },
  { name: "day-only cells exclude adjacent months", initial: "2026-10", target: "2026-09-03", moves: 1, dayOnly: true },
  { name: "localized headings infer month from Chinese full dates", initial: "2026-10", target: "2026-09-03", moves: 1, localizedHeading: true, chineseTitles: true },
]) {
  test(`OA calendar selects the full target date: ${scenario.name}`, async (t) => {
    const { page, validations } = await calendarFormPage(t, scenario);
    const values = await assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test" }, scenario.target);
    assert.equal(values.date, scenario.target);
    assert.equal(await page.evaluate(() => window.monthMoves), scenario.moves);
    assert.deepEqual(validations, [scenario.target], "Only validate the correct date after switching months");
  });
}

test("cross-month selection retains OA duplicate-date validation", async (t) => {
  const { page, validations } = await calendarFormPage(t, { initial: "2026-10", duplicateCount: "1" });
  await assert.rejects(assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test" }, "2026-09-03"), /重复校验未通过/);
  assert.deepEqual(validations, ["2026-09-03"]);
});

test("unknown calendar month stops instead of guessing a matching day number", async (t) => {
  const { page, validations } = await calendarFormPage(t, { initial: "2026-10", unknownMonth: true });
  await assert.rejects(assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test" }, "2026-09-03"), /无法读取 OA 日期选择器当前年月/);
  assert.deepEqual(validations, []);
  assert.equal(await page.locator("#field12646").inputValue(), "");
});

test("calendar date mismatch reports target and actual date and stops", async (t) => {
  const { page } = await calendarFormPage(t, { initial: "2026-10", wrongValue: "2026-10-03" });
  await assert.rejects(assistant.prepareForm(page, { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test" }, "2026-09-03"), /目标 2026-09-03，实际 2026-10-03/);
  assert.equal(await page.locator("#field12653_0").inputValue(), "");
});

async function batchFormFixture(t, options = {}) {
  const dates = ["2020-01-06", "2020-01-07", "2020-01-08"];
  const stats = { loads: 0, loading: 0, peakLoading: 0, validations: [], submissions: [] };
  let page;
  let failedAhead = false;
  const html = `<body>工时填报
    <input id="field12648" value="测试甲"><input id="field12643" value="TEST001">
    <div class="field12646_swapDiv"><button class="picker-icon">选择日期</button></div>
    <input id="field12646"><input id="field12653_0"><input id="field12654_0">
    <input id="field12655_0" oninput="document.getElementById('field12647').value = Number(this.value).toFixed(1)">
    <input id="field12647"><input id="field13685"><textarea id="field12656_0"></textarea>
    <table><tr>${dates.map((date) => `<td title="${date}">${date}</td>`).join("")}</tr></table>
    <button title="提交">提交</button>
    <script>
      window.WfForm = { changeFieldValue(id, field) { document.getElementById(id).value = field.value; } };
      document.querySelectorAll('td').forEach(cell => cell.onclick = async () => {
        document.getElementById('field12646').value = cell.title;
        const response = await fetch('/api/workflow/linkage/reqFieldSqlResult', {method:'POST',body:cell.title});
        const data = await response.json();
        document.getElementById('field13685').value = data.assignInfo_90.changeValue.field13685.value;
      });
      document.querySelector('button[title="提交"]').onclick = async () => {
        await fetch('/api/workflow/RequestOperation', {method:'POST',body:document.getElementById('field12646').value});
        document.body.append('提交成功');
      };
    </script></body>`;
  page = await oaPage(t, async (route, url) => {
    if (url.pathname.includes("reqFieldSqlResult")) {
      stats.validations.push(route.request().postData());
      const duplicate = options.duplicate || options.duplicateDate === route.request().postData();
      return route.fulfill({ json: { assignInfo_90: { changeValue: { field13685: { value: duplicate ? "1" : "0" } } } } });
    }
    if (url.pathname.includes("RequestOperation")) {
      stats.submissions.push(route.request().postData());
      return route.fulfill({ json: { success: true } });
    }
    if (!url.pathname.includes("/spa/workflow/static4form/index.html")) return route.fulfill({ body: "" });
    stats.loads++;
    if (options.failAhead && route.request().frame().page() !== page && !failedAhead) {
      failedAhead = true;
      return route.abort("connectionfailed");
    }
    stats.loading++;
    stats.peakLoading = Math.max(stats.peakLoading, stats.loading);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs || 10));
    stats.loading--;
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: html }).catch(() => {});
  });
  return { page, dates, stats, config: { ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test", account } };
}

test("batch preloading overlaps only blank-page loads and still fills and submits in order", async (t) => {
  for (const preload of [false, true]) {
    const { page, dates, stats, config } = await batchFormFixture(t, { delayMs: 700 });
    const started = Date.now();
    for await (const item of assistant.iterateWorktimeForms(page.context(), page, config, dates.slice(0, 2), { submit: true, preload })) {
      assert.equal(stats.submissions.length, item.index);
      assert.equal(item.preloaded, preload && item.index > 0);
      await assistant.prepareForm(item.page, config, item.dateText, { preloaded: item.preloaded });
      // No following date has been filled or duplicate-checked by preloading.
      assert.deepEqual(stats.validations, dates.slice(0, item.index + 1));
      await assistant.submitPreparedForm(item.page);
      await item.page.waitForFunction(() => document.body.innerText.includes("提交成功"));
    }
    assert.deepEqual(stats.submissions, dates.slice(0, 2));
    assert.equal(stats.loads, 2, "A preloaded form must not navigate a second time");
    assert.equal(stats.peakLoading, preload ? 2 : 1);
    t.diagnostic(`${preload ? "preloaded" : "sequential"} two-day mock: ${Date.now() - started} ms`);
  }
});

test("a failed speculative load falls back to normal loading without retrying submission", async (t) => {
  const { page, dates, stats, config } = await batchFormFixture(t, { failAhead: true });
  let failedPage;
  for await (const item of assistant.iterateWorktimeForms(page.context(), page, config, dates.slice(0, 2), { submit: true })) {
    assert.equal(item.preloaded, false);
    if (item.index === 0) failedPage = page.context().pages().find(candidate => candidate !== page);
    else {
      assert.ok(failedPage.isClosed(), "Discard the failed speculative navigation before fallback");
      assert.notEqual(item.page, failedPage);
    }
    await assistant.prepareForm(item.page, config, item.dateText, { preloaded: item.preloaded });
    await assistant.submitPreparedForm(item.page);
    await item.page.waitForFunction(() => document.body.innerText.includes("提交成功"));
  }
  assert.equal(stats.loads, 3);
  assert.deepEqual(stats.submissions, dates.slice(0, 2));
});

test("duplicate validation aborts the batch and closes the unused preloaded form", async (t) => {
  const { page, dates, stats, config } = await batchFormFixture(t, { duplicate: true });
  await assert.rejects(async () => {
    for await (const item of assistant.iterateWorktimeForms(page.context(), page, config, dates, { submit: true })) {
      await assistant.prepareForm(item.page, config, item.dateText, { preloaded: item.preloaded });
      await assistant.submitPreparedForm(item.page);
    }
  }, /重复校验未通过/);
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(stats.validations, [dates[0]]);
  assert.deepEqual(stats.submissions, []);
  assert.equal(stats.loads, 2, "At most one upcoming form may be preloaded");
});

test("a preloaded form rechecks the current account before filling and closes the following page on failure", async (t) => {
  const { page, dates, stats, config } = await batchFormFixture(t);
  await assert.rejects(async () => {
    for await (const item of assistant.iterateWorktimeForms(page.context(), page, config, dates, { submit: true })) {
      if (item.index === 0) continue;
      assert.equal(item.preloaded, true);
      await item.page.locator("#field12643").fill("OTHER_ACCOUNT");
      await assistant.prepareForm(item.page, config, item.dateText, { preloaded: item.preloaded });
    }
  }, /账户已变化/);
  assert.equal(page.context().pages().length, 2);
  assert.deepEqual(stats.validations, []);
  assert.deepEqual(stats.submissions, []);
});

test("a duplicate discovered on the preloaded day preserves the earlier submission and stops later dates", async (t) => {
  const { page, dates, stats, config } = await batchFormFixture(t, { duplicateDate: "2020-01-07" });
  await assert.rejects(async () => {
    for await (const item of assistant.iterateWorktimeForms(page.context(), page, config, dates, { submit: true })) {
      await assistant.prepareForm(item.page, config, item.dateText, { preloaded: item.preloaded });
      await assistant.submitPreparedForm(item.page);
      await item.page.waitForFunction(() => document.body.innerText.includes("提交成功"));
    }
  }, /重复校验未通过/);
  assert.deepEqual(stats.submissions, [dates[0]]);
  assert.deepEqual(stats.validations, dates.slice(0, 2));
  assert.equal(page.context().pages().length, 2);
});

test("submit clicks OA confirms and does not wait for a success page", async (t) => {
  let submitted = 0;
  const html = `<body>工时填报
    <button title="提交">提交</button>
    <button id="ok" hidden>确定</button>
    <script>
      document.querySelector('button[title="提交"]').onclick = () => {
        document.getElementById('ok').hidden = false;
      };
      document.getElementById('ok').onclick = () => {
        fetch('/workflow/request/RequestOperation.jsp', { method: 'POST', body: 'src=submit' });
      };
    </script></body>`;
  const page = await oaPage(t, (route, url) => {
    if (url.pathname.includes("RequestOperation")) {
      submitted += 1;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
  });
  await page.goto("http://oa.test/");
  const started = Date.now();
  const result = await assistant.submitPreparedForm(page);
  assert.ok(Date.now() - started < 4_000, "submit must not wait for OA's success page");
  assert.equal(submitted, 1);
  assert.ok(result.url);
  assert.doesNotMatch(await page.locator("body").innerText(), /提交成功|操作成功/);
});

test("a changed OA form account stops before filling any date or changing local ownership", async (t) => {
  const { page, date } = await formPage(t);
  const before = fs.readFileSync(common.CONFIG_PATH, "utf8");
  await assert.rejects(assistant.prepareForm(page, {
    ...common.DEFAULT_CONFIG, baseUrl: "http://oa.test", account: { ...account, employeeNo: "OTHER" },
    workdayOverrides: { [date]: "work" },
  }, date), /账户已变化/);
  assert.equal(await page.locator("#field12646").inputValue(), "");
  assert.equal(fs.readFileSync(common.CONFIG_PATH, "utf8"), before);
});

async function uiPage(t, state) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: state.timezoneId || "Asia/Shanghai" });
  context.setDefaultTimeout(8_000);
  t.after(() => context.close());
  state.requests = [];
  state.loginStatus ??= { state: "connected", account };
  const staticRoot = path.join(ROOT, "dashboard", "portable-dist");
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, "dashboard.test", "Only mocked dashboard requests are allowed");
    if (url.pathname.startsWith("/api/")) {
      const body = route.request().postData() ? JSON.parse(route.request().postData()) : {};
      state.requests.push({ pathname: url.pathname, body });
      if (url.pathname === "/api/dashboard") {
        if (state.offlineDashboard) return route.abort("connectionrefused");
        const snapshot = structuredClone(state.dashboard);
        if (state.holdNextDashboard) {
          state.holdNextDashboard = false;
          await new Promise((resolve) => { state.releaseDashboard = resolve; });
        }
        return route.fulfill({ json: snapshot });
      }
      if (url.pathname === "/api/login/status") return route.fulfill({ json: state.loginStatus });
      if (url.pathname === "/api/session/check") return route.fulfill({ json: state.loginStatus });
      if (url.pathname.startsWith("/api/updates/")) {
        if (state.updateError) return route.fulfill({ status: 409, json: { error: state.updateError } });
        const stage = url.pathname.split("/").at(-1);
        if (stage !== "check") assert.equal(body.confirm, true);
        if (stage === "install" && state.holdInstall) await new Promise(resolve => { state.releaseInstall = resolve; });
        state.dashboard.update.status = { check: "checking", download: "downloading", install: "installing" }[stage];
        return route.fulfill({ status: 202, json: state.dashboard.update });
      }
      if (url.pathname === "/api/login/start") {
        state.loginStatus = { state: "checking", message: "测试登录准备中" };
        return route.fulfill({ json: state.loginStatus });
      }
      if (url.pathname === "/api/login/cancel") {
        state.loginStatus = { state: "cancelled", message: "已取消登录" };
        return route.fulfill({ json: state.loginStatus });
      }
      if (url.pathname === "/api/projects") return route.fulfill({ json: {
        projects: [{ id: defaults.projectId, code: defaults.projectCode, name: defaults.projectName }], catalog: state.dashboard.projectCatalog,
      } });
      if (url.pathname === "/api/submit") {
        assert.equal(body.confirm, true);
        if (state.holdSubmit) await new Promise((resolve) => { state.releaseSubmit = resolve; });
        return route.fulfill({ json: { message: "所选日期已经填报。", dashboard: state.dashboard, result: { submittedDates: [], skippedDates: body.dates } } });
      }
      if (url.pathname === "/api/preview") return route.fulfill({ json: { message: "预演通过", dashboard: state.dashboard } });
      if (url.pathname === "/api/defaults") {
        state.dashboard.defaults = { ...state.dashboard.defaults, ...body.settings };
        return route.fulfill({ json: { message: "默认值已保存", dashboard: state.dashboard } });
      }
      if (url.pathname === "/api/calendar") {
        if (state.calendarError) return route.fulfill({ status: 409, json: { error: state.calendarError } });
        assert.deepEqual(body.account, state.dashboard.account);
        const overrides = { ...state.dashboard.workdayOverrides };
        for (const date of body.dates) {
          if (body.mode === "default") delete overrides[date];
          else overrides[date] = body.mode;
        }
        state.dashboard.workdayOverrides = overrides;
        return route.fulfill({ json: { message: "日历调整已保存", dashboard: state.dashboard } });
      }
      throw new Error(`Unexpected API request in test: ${url.pathname}`);
    }
    const file = path.resolve(staticRoot, url.pathname === "/" ? "index.html" : "." + url.pathname);
    assert.ok(file.startsWith(staticRoot + path.sep));
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
    return route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] || "application/octet-stream" });
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(state.time || "2026-09-06T04:00:00Z") });
  await page.goto("http://dashboard.test/");
  await page.getByRole("heading", { name: "2026年 9月", exact: true }).waitFor();
  return page;
}

test("work type can change during background sync, and cancelling defaults preserves the current form", async (t) => {
  const state = { dashboard: structuredClone(dashboard()) };
  state.dashboard.session.busy = "projects";
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  const select = page.getByLabel("工作类型", { exact: true });
  assert.equal(await select.isEnabled(), true);
  assert.equal(await select.locator("option").count(), 7);
  await select.selectOption("006");
  assert.equal(await page.getByRole("button", { name: "提交 1 天", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "⚙ 默认设置" }).click();
  await page.getByLabel("默认工作类型").selectOption("003");
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await select.inputValue(), "006");
  state.dashboard.session.busy = null;
  await page.clock.runFor(3100);
  await page.getByRole("button", { name: "预演 1 天", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "预演通过" }).waitFor();
  const request = state.requests.find((item) => item.pathname === "/api/preview");
  assert.deepEqual(request.body.settings.workType, { name: "研发", code: "006" });
  await page.screenshot({ path: path.join(directory, "preview.png"), fullPage: true });
});

test("statistics count distinct workdays and changing accounts resets selected dates and fields", async (t) => {
  const record = (date, id) => ({ workDate: date, requestId: id, documentNo: id, operationTime: "", title: "测试记录", status: "归档" });
  const state = { dashboard: structuredClone(dashboard({ records: [record("2026-09-01", "1"), record("2026-09-01", "2"), record("2026-09-05", "3")] })) };
  const page = await uiPage(t, state);
  assert.match(await page.locator(".stat-card.featured .stat-value").innerText(), /^1\s*\//);
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  await page.getByLabel("工作类型", { exact: true }).selectOption("006");
  state.dashboard.account = { ...account, name: "测试乙", employeeNo: "TEST002" };
  state.dashboard.defaults.workType = { name: "office work", code: "005" };
  state.dashboard.records = [];
  await page.clock.runFor(3100);
  await page.getByText("选择待补日期", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  assert.equal(await page.getByLabel("工作类型", { exact: true }).inputValue(), "005");
  assert.match(await page.locator(".stat-card.featured .stat-value").innerText(), /^0\s*\//);
});

test("login failure replaces the spinner with a retry action", async (t) => {
  const state = { dashboard: structuredClone(dashboard()), loginStatus: { state: "checking", message: "准备二维码" } };
  state.dashboard.session.connected = false;
  state.dashboard.session.busy = "login-qr";
  const page = await uiPage(t, state);
  await page.getByText("正在生成安全二维码", { exact: true }).waitFor();
  state.loginStatus = { state: "error", message: "模拟网络故障" };
  state.dashboard.session.busy = null;
  await page.clock.runFor(1200);
  await page.getByRole("button", { name: "重新生成二维码" }).waitFor();
  assert.equal(await page.getByText("正在生成安全二维码", { exact: true }).count(), 0);
});

test("cancelling first-time login does not immediately start it again", async (t) => {
  const state = { dashboard: structuredClone(dashboard()), loginStatus: { state: "idle", message: "尚未登录" } };
  state.dashboard.session.connected = false;
  const page = await uiPage(t, state);
  await page.clock.runFor(1200);
  await page.getByRole("button", { name: "取消登录" }).click();
  await page.clock.runFor(4100);
  assert.equal(state.requests.filter((item) => item.pathname === "/api/login/start").length, 1);
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("expired saved login opens a notice once on desktop and mobile without starting another QR", async (t) => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const state = { dashboard: structuredClone(dashboard()), loginStatus: {
      state: "error", reason: "expired", message: "OA 登录已过期，请重新扫码登录。", updatedAt: "2026-09-06T04:00:00Z",
    } };
    state.dashboard.session.connected = false;
    state.dashboard.session.state = "error";
    const page = await uiPage(t, state);
    await page.setViewportSize(viewport);
    await page.getByText("OA 登录已过期", { exact: true }).waitFor();
    const dialog = page.getByRole("dialog");
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
    assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
    await page.screenshot({ path: path.join(ROOT, "diagnostics", `login-expired-${viewport.width}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.clock.runFor(3100);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.ok(state.requests.some((item) => item.pathname === "/api/session/check"));
    assert.equal(state.requests.filter((item) => item.pathname === "/api/login/start").length, 0);
  }
});

test("network failure is shown as unverified rather than expired", async (t) => {
  const state = { dashboard: structuredClone(dashboard()), loginStatus: {
    state: "unavailable", message: "暂时无法验证 OA 登录，请检查网络后重试。",
  } };
  state.dashboard.session.connected = false;
  state.dashboard.session.state = "unavailable";
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: "暂时无法验证登录" }).click();
  await page.getByText("暂时无法连接 OA", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重新验证", exact: true }).click();
  assert.equal(await page.getByText("OA 登录已过期", { exact: true }).count(), 0);
  assert.equal(state.requests.filter((item) => item.pathname === "/api/login/start").length, 0);
});

test("submission toast reports initiated counts awaiting confirmation rather than selected day count", async (t) => {
  const state = { dashboard: structuredClone(dashboard()) };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  await page.getByRole("button", { name: /^2026-09-03/ }).click();
  await page.getByRole("button", { name: "提交 2 天", exact: true }).click();
  await page.getByRole("button", { name: "确认提交 2 天", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已发起 0 天，待 OA 确认；跳过已填 2 天" }).waitFor();
});

test("submission confirmation closes while a batch runs so live progress remains visible", async (t) => {
  const state = { dashboard: structuredClone(dashboard()), holdSubmit: true };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  await page.getByRole("button", { name: "提交 1 天", exact: true }).click();
  const submitted = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/submit");
  await page.getByRole("button", { name: "确认提交 1 天", exact: true }).click();
  await submitted;
  assert.equal(await page.getByRole("dialog").count(), 0);
  state.dashboard.batchProgress = { runId: "pending-submit", mode: "submit", status: "running", total: 1, completed: 0, percent: 0,
    currentDate: "2026-09-02", stage: "checking", startedAt: "2026-09-06T04:00:00Z", error: null, days: [{ date: "2026-09-02", status: "checking", error: null }] };
  await page.clock.runFor(3100);
  await page.getByRole("article", { name: "批量处理进度" }).getByRole("heading", { name: "正在处理第 1／1 天" }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  state.releaseSubmit();
  await page.getByRole("status").filter({ hasText: "已发起 0 天" }).waitFor();
});

test("the same OA user losing employee number during polling keeps the form and remembered work project", async (t) => {
  const owner = { ...account, oaUserId: "stable-test-oa" };
  const state = { dashboard: structuredClone(dashboard({ account: owner })) };
  const page = await uiPage(t, state);
  const day = page.getByRole("button", { name: /^2026-09-02/ });
  await day.click();
  await page.getByRole("combobox", { name: "工作类型", exact: true }).selectOption("004");
  state.dashboard.account.employeeNo = "";
  await page.clock.runFor(3100);
  assert.equal(await day.getAttribute("aria-pressed"), "true");
  const type = page.getByRole("combobox", { name: "工作类型", exact: true });
  assert.equal(await type.inputValue(), "004");
  await type.selectOption("006");
  assert.equal(await page.getByRole("combobox", { name: "项目号 / 项目名称" }).inputValue(), defaults.projectCode);
  state.dashboard.account = { ...owner, oaUserId: "other-test-oa" };
  await page.clock.runFor(3100);
  await page.getByText("选择待补日期", { exact: true }).waitFor();
  assert.equal(await day.getAttribute("aria-pressed"), "false");
});

test("leave UI hides projects, sends empty values, restores work projects, and saves empty defaults", async (t) => {
  const state = { dashboard: structuredClone(dashboard()) };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /^2026-09-01 / }).click();
  const workType = page.getByRole("combobox", { name: "工作类型", exact: true });
  await workType.selectOption("004");
  await page.getByText("休假无需选择项目", { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "项目号 / 项目名称" }).count(), 0);
  await page.getByRole("button", { name: "预演 1 天", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "预演通过" }).waitFor();
  const sent = state.requests.findLast((request) => request.pathname === "/api/preview").body.settings;
  assert.deepEqual([sent.projectCode, sent.projectId, sent.projectName], ["", "", ""]);
  await workType.selectOption("006");
  assert.equal(await page.getByRole("combobox", { name: "项目号 / 项目名称" }).inputValue(), defaults.projectCode);
  await page.getByRole("button", { name: "⚙ 默认设置" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "默认工作类型" }).selectOption("004");
  assert.equal(await dialog.getByRole("combobox", { name: "项目号 / 项目名称" }).count(), 0);
  await dialog.getByRole("combobox", { name: "默认工作类型" }).selectOption("006");
  assert.equal(await dialog.getByRole("combobox", { name: "项目号 / 项目名称" }).inputValue(), defaults.projectCode);
  await dialog.getByRole("combobox", { name: "默认工作类型" }).selectOption("004");
  await dialog.getByRole("button", { name: "保存为默认" }).click();
  await page.locator(".toast").filter({ hasText: "默认值已保存" }).waitFor();
  assert.equal(state.dashboard.defaults.projectCode, "");
  await page.getByRole("button", { name: "提交 1 天", exact: true }).click();
  assert.match(await page.getByRole("dialog").locator(".confirm-summary").innerText(), /休假无需选择项目/);
  assert.doesNotMatch(await page.getByRole("dialog").locator(".confirm-summary").innerText(), /TEST-P001/);
});

test("switching accounts clears the remembered project even when the new account defaults to leave", async (t) => {
  const state = { dashboard: structuredClone(dashboard()) };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /^2026-09-01 / }).click();
  await page.getByRole("combobox", { name: "工作类型", exact: true }).selectOption("004");
  state.dashboard = structuredClone(dashboard({ account: { ...account, employeeNo: "TEST002", name: "测试乙" }, defaults: { ...defaults, workType: { code: "004", name: "休假" }, projectCode: "", projectId: "", projectName: "" } }));
  await page.clock.runFor(3100);
  await page.getByText("测试乙", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^2026-09-01 / }).click();
  await page.getByRole("combobox", { name: "工作类型", exact: true }).selectOption("006");
  assert.equal(await page.getByRole("combobox", { name: "项目号 / 项目名称" }).inputValue(), "");
  await page.getByRole("button", { name: "预演 1 天", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "请填写项目号" }).waitFor();
});

test("batch progress updates, survives page reload, distinguishes pending from confirmed and fits narrow screens", async (t) => {
  const batch = { runId: "ui-batch", mode: "submit", status: "running", total: 3, completed: 1, percent: 33, currentDate: "2026-09-02", stage: "checking", startedAt: "2026-09-06T04:00:00Z", error: null,
    days: [{ date: "2026-09-01", status: "submitted_pending", error: null }, { date: "2026-09-02", status: "checking", error: null }, { date: "2026-09-03", status: "waiting", error: null }] };
  const state = { dashboard: structuredClone(dashboard({ batchProgress: batch })) };
  const page = await uiPage(t, state);
  const panel = page.getByRole("article", { name: "批量处理进度" });
  await panel.getByRole("heading", { name: "正在处理第 2／3 天" }).waitFor();
  assert.equal(await panel.getByRole("progressbar").getAttribute("aria-valuenow"), "33");
  await page.reload();
  await panel.getByRole("heading", { name: "正在处理第 2／3 天" }).waitFor();
  const outputRoot = path.join(ROOT, "diagnostics", "release-1.2.7");
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await panel.screenshot({ path: path.join(outputRoot, `batch-progress-${width}.png`), animations: "disabled" });
    assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  }
  state.dashboard.batchProgress = { ...batch, status: "failed", percent: 66, completed: 2, stage: "stopped", error: "9月2日校验失败，后续停止。", days: [{ ...batch.days[0], status: "confirmed" }, { ...batch.days[1], status: "failed", error: "校验失败" }, { ...batch.days[2], status: "unprocessed" }] };
  await page.clock.runFor(3100);
  await panel.getByRole("heading", { name: "本批次已停止" }).waitFor();
  assert.match(await panel.innerText(), /OA 已确认/);
  assert.match(await panel.innerText(), /未处理/);
  await panel.screenshot({ path: path.join(outputRoot, "batch-progress-failure.png"), animations: "disabled" });
  state.dashboard.batchProgress = { ...batch, mode: "preview", status: "completed", percent: 100, completed: 3, days: batch.days.map((day) => ({ ...day, status: "preview_passed" })) };
  await page.clock.runFor(3100);
  await panel.getByRole("heading", { name: "本批次处理结束" }).waitFor();
  assert.match(await panel.innerText(), /批量预演/);
  assert.equal(await panel.getByText("预演通过", { exact: true }).count(), 3);
});

test("calendar editing supports weekend work, weekday rest, retained records, and restoring defaults", async (t) => {
  const record = { workDate: "2026-09-01", requestId: "saved", documentNo: "saved", operationTime: "", title: "测试记录", status: "归档" };
  const state = { dashboard: structuredClone(dashboard({ records: [record] })) };
  const page = await uiPage(t, state);
  const day = (date) => page.getByRole("button", { name: new RegExp(`^${date}`) });
  const edit = () => page.getByRole("button", { name: "调整工作日", exact: true }).click();
  const finish = () => page.getByRole("button", { name: "完成调整", exact: true }).click();
  const save = async (label) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
  };
  assert.equal(await day("2026-09-05").isEnabled(), false);
  await edit();
  await day("2026-09-05").click();
  await save("设为上班");
  await day("2026-09-01").click();
  await day("2026-09-02").click();
  await save("设为休息");
  assert.deepEqual(state.dashboard.records, [record]);
  await finish();
  assert.equal(await day("2026-09-02").isEnabled(), false);
  assert.equal(await day("2026-09-05").isEnabled(), true);
  assert.match(await day("2026-09-01").innerText(), /已填/);
  assert.match(await page.locator(".stat-card.featured .stat-value").innerText(), /^0\s*\/\s*21$/);
  assert.match(await page.locator(".stat-card").nth(1).locator(".stat-value").innerText(), /^0\s*\/\s*3$/);
  await page.getByRole("button", { name: "全选待补 3 天", exact: true }).click();
  await page.getByRole("button", { name: "预演 3 天", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "预演通过" }).waitFor();
  assert.deepEqual(state.requests.findLast((r) => r.pathname === "/api/preview").body.dates, ["2026-09-03", "2026-09-04", "2026-09-05"]);
  assert.deepEqual(state.requests.findLast((r) => r.pathname === "/api/preview").body.account, account);
  await page.reload();
  await page.getByRole("button", { name: "调整工作日", exact: true }).waitFor();
  assert.match(await day("2026-09-05").locator(".override-marker").innerText(), /班/);
  await day("2026-09-01").click();
  await page.getByText("这一天已经填过", { exact: true }).waitFor();
  await edit();
  for (const date of ["2026-09-01", "2026-09-02", "2026-09-05"]) await day(date).click();
  await save("恢复默认");
  await finish();
  assert.deepEqual(state.dashboard.workdayOverrides, {});
  assert.match(await page.locator(".stat-card.featured .stat-value").innerText(), /^1\s*\/\s*22$/);
  assert.equal(await day("2026-09-05").isEnabled(), false);
});

test("future calendar dates can be planned but not filled, and month/account switches clear editing selections", async (t) => {
  const state = { dashboard: structuredClone(dashboard()) };
  const page = await uiPage(t, state);
  const edit = page.getByRole("button", { name: "调整工作日", exact: true });
  await edit.click();
  await page.getByRole("button", { name: /^2026-09-12/ }).click();
  await page.getByRole("button", { name: "设为上班", exact: true }).click();
  await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
  assert.equal(state.dashboard.workdayOverrides["2026-09-12"], "work");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /^2026-09-12/ }).isEnabled(), false);
  assert.match(await page.locator(".stat-card.featured .stat-value").innerText(), /^0\s*\/\s*23$/);
  assert.match(await page.locator(".stat-card").nth(1).locator(".stat-value").innerText(), /^0\s*\/\s*4$/);
  await edit.click();
  await page.getByRole("button", { name: /^2026-09-07/ }).click();
  await page.getByRole("button", { name: "上个月", exact: true }).click();
  await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
  await page.getByRole("button", { name: /^2026-08-01/ }).click();
  await page.getByRole("button", { name: "设为上班", exact: true }).click();
  await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
  assert.match(await page.locator(".stat-card").nth(2).locator(".stat-value").innerText(), /^0\s*\/\s*22$/);
  await page.getByRole("button", { name: /^2026-08-02/ }).click();
  state.dashboard.account = { ...account, name: "测试乙", employeeNo: "TEST002" };
  state.dashboard.workdayOverrides = {};
  await page.clock.runFor(3100);
  await edit.waitFor();
  await edit.click();
  assert.equal(await page.getByRole("button", { name: "设为上班", exact: true }).isEnabled(), false);
  assert.equal(await page.locator(".override-marker").count(), 0);
});

test("calendar save failures retain selections and background changes remove newly resting fill dates", async (t) => {
  const state = { dashboard: structuredClone(dashboard()), calendarError: "账户已变化，请刷新后重新调整。" };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: "调整工作日", exact: true }).click();
  await page.getByRole("button", { name: /^2026-09-05/ }).click();
  await page.getByRole("button", { name: "设为上班", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: state.calendarError }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^2026-09-05/ }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".override-marker").count(), 0);
  state.dashboard.session.busy = "projects";
  await page.clock.runFor(3100);
  await page.waitForFunction(() => document.querySelector(".calendar-edit-buttons .primary-button").disabled);
  for (const label of ["设为上班", "设为休息", "恢复默认"]) assert.equal(await page.getByRole("button", { name: label, exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  state.dashboard.workdayOverrides = { "2026-09-02": "rest" };
  state.dashboard.session.busy = null;
  await page.clock.runFor(3100);
  await page.getByText("选择待补日期", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^2026-09-02/ }).isEnabled(), false);
});

test("calendar uses the legacy all-days default when restoring an override", async (t) => {
  const state = { dashboard: structuredClone(dashboard({ defaults: { ...defaults, skipWeekends: false }, workdayOverrides: { "2026-09-05": "rest" } })) };
  const page = await uiPage(t, state);
  assert.equal(await page.getByRole("button", { name: /^2026-09-05/ }).isEnabled(), false);
  await page.getByRole("button", { name: "调整工作日", exact: true }).click();
  await page.getByRole("button", { name: /^2026-09-05/ }).click();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /^2026-09-05/ }).isEnabled(), true);
  assert.match(await page.locator(".stat-card.featured .stat-value").innerText(), /^0\s*\/\s*30$/);
});

test("a delayed dashboard poll cannot undo a saved calendar or clear newly selected workdays", async (t) => {
  const state = { dashboard: structuredClone(dashboard()) };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: "调整工作日", exact: true }).click();
  await page.getByRole("button", { name: /^2026-09-05/ }).click();
  state.holdNextDashboard = true;
  const poll = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/dashboard");
  await page.clock.runFor(3100);
  await poll;
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/dashboard");
  await page.getByRole("button", { name: "设为上班", exact: true }).click();
  await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  const day = page.getByRole("button", { name: /^2026-09-05/ });
  await day.click();
  state.releaseDashboard();
  await response;
  await page.clock.runFor(200);
  assert.equal(await day.getAttribute("aria-pressed"), "true");
  assert.equal(await day.locator(".override-marker").count(), 1);
});

test("same-name account changes discard calendar selections using OA ID or organization", async (t) => {
  for (const owners of [
    [{ name: "同名", oaUserId: "1" }, { name: "同名", oaUserId: "2" }],
    [{ name: "同名", organization: "甲公司" }, { name: "同名", organization: "乙公司" }],
  ]) {
    const state = { dashboard: structuredClone(dashboard({ account: owners[0] })) };
    const page = await uiPage(t, state);
    await page.getByRole("button", { name: "调整工作日", exact: true }).click();
    await page.getByRole("button", { name: /^2026-09-05/ }).click();
    state.dashboard.account = owners[1];
    await page.clock.runFor(3100);
    await page.getByRole("button", { name: "调整工作日", exact: true }).click();
    await page.getByRole("heading", { name: "未选择日期", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "设为上班", exact: true }).isEnabled(), false);
  }
});

test("calendar month and fill cutoff use Shanghai dates in other browser timezones", async (t) => {
  for (const timezoneId of ["America/Los_Angeles", "Pacific/Kiritimati"]) {
    const state = { dashboard: structuredClone(dashboard()), timezoneId, time: "2026-08-31T16:30:00Z" };
    const page = await uiPage(t, state);
    assert.equal(await page.getByRole("button", { name: /^2026-09-01/ }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: /^2026-09-02/ }).isEnabled(), false);
    assert.match(await page.locator(".stat-card").nth(1).locator(".stat-value").innerText(), /^0\s*\/\s*1$/);
  }
});

test("selected calendar dates stay readable on hover in fill and adjustment modes", async (t) => {
  const page = await uiPage(t, { dashboard: structuredClone(dashboard()) });
  await page.addStyleTag({ content: ".day-cell { transition: none !important; }" });
  for (const editing of [false, true]) {
    if (editing) await page.getByRole("button", { name: "调整工作日", exact: true }).click();
    const cell = page.getByRole("button", { name: /^2026-09-02/ });
    await cell.click();
    await page.mouse.move(0, 0);
    const background = await cell.evaluate((element) => getComputedStyle(element).backgroundColor);
    await cell.hover();
    assert.equal(await cell.getAttribute("aria-pressed"), "true");
    assert.equal(await cell.evaluate((element) => getComputedStyle(element).backgroundColor), background);
  }
});

test("calendar controls and labels fit desktop, tablet, and mobile viewports", async (t) => {
  for (const width of [1440, 1024, 390, 320]) {
    const state = { dashboard: structuredClone(dashboard({ workdayOverrides: { "2026-09-01": "rest", "2026-09-06": "work" } })) };
    const page = await uiPage(t, state);
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole("button", { name: "调整工作日", exact: true }).click();
    for (const date of ["2026-09-01", "2026-09-06", "2026-09-12"]) await page.getByRole("button", { name: new RegExp(`^${date}`) }).click();
    const issues = await page.evaluate(() => {
      const issues = [];
      for (const element of document.querySelectorAll(".calendar-panel, .calendar-grid, .calendar-edit-panel, .calendar-actions button, .calendar-edit-buttons button, .topbar-actions button")) {
        const rect = element.getBoundingClientRect();
        if (rect.left < 0 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) issues.push(element.className + " overflows");
      }
      for (const button of document.querySelectorAll(".topbar-actions button")) {
        const parent = button.getBoundingClientRect();
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          const text = range.getBoundingClientRect();
          if (text.top < parent.top || text.bottom > parent.bottom || text.left < parent.left || text.right > parent.right) issues.push(button.className + " text outside");
        }
      }
      for (const cell of document.querySelectorAll(".day-cell")) {
        const labels = [...cell.querySelectorAll("span")];
        const parent = cell.getBoundingClientRect();
        for (let i = 0; i < labels.length; i++) {
          const a = labels[i].getBoundingClientRect();
          if (a.left < parent.left || a.right > parent.right || a.top < parent.top || a.bottom > parent.bottom) issues.push(cell.getAttribute("aria-label") + " label outside");
          for (let j = i + 1; j < labels.length; j++) {
            const b = labels[j].getBoundingClientRect();
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) issues.push(cell.getAttribute("aria-label") + " labels overlap");
          }
        }
      }
      return issues;
    });
    assert.deepEqual(issues, [], `Calendar layout at ${width}px`);
    await page.screenshot({ path: path.join(ROOT, "diagnostics", `calendar-${width}.png`), fullPage: true, animations: "disabled" });
  }
});


function updateState(status = "available") {
  return { status, currentVersion: "1.3.0", latestVersion: "1.4.0", repository: "test-owner/worktime", canInstall: true,
    releaseNotes: "修复说明\n" + "更新内容 ".repeat(100), error: null, percent: 0, lastInstall: null };
}

test("updates show download progress on a narrow screen and require explicit installation confirmation", async (t) => {
  const state = { dashboard: dashboard({ update: updateState() }) };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /版本与更新/ }).click();
  const dialog = page.getByRole("dialog", { name: "版本与更新" });
  assert.match(await dialog.innerText(), /当前版本 1.3.0/);
  const screenshotRoot = path.join(ROOT, "diagnostics", "release-1.3.0");
  fs.mkdirSync(screenshotRoot, { recursive: true });
  await page.screenshot({ path: path.join(screenshotRoot, "更新界面-桌面.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "下载新版" }).click();
  await dialog.getByText("正在下载 · 0%", { exact: true }).waitFor();
  state.dashboard.update.percent = 47;
  await page.clock.runFor(3100);
  await dialog.getByText("正在下载 · 47%", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshotRoot, "更新界面-窄屏.png") });
  assert.equal(await dialog.getByRole("progressbar").getAttribute("aria-valuenow"), "47");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  state.dashboard.update.status = "ready"; state.dashboard.update.percent = 100;
  await page.clock.runFor(3100);
  await dialog.getByRole("button", { name: "安装更新", exact: true }).click();
  assert.equal(state.requests.some(r => r.pathname === "/api/updates/install"), false);
  await dialog.getByRole("button", { name: "确认安装并重启" }).click();
  await dialog.getByText(/正在安装，请稍候/).waitFor();
  assert.equal(state.requests.filter(r => r.pathname === "/api/updates/install").length, 1);
  assert.equal(await page.getByRole("button", { name: "⚙ 默认设置" }).isEnabled(), false);
});

test("busy OA work blocks update installation and an update error leaves ordinary submission available", async (t) => {
  const state = { dashboard: dashboard({ update: updateState("ready") }) };
  state.dashboard.session.busy = "batch-submit";
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /版本与更新/ }).click();
  const dialog = page.getByRole("dialog", { name: "版本与更新" });
  assert.equal(await dialog.getByRole("button", { name: "安装更新", exact: true }).isEnabled(), false);
  state.dashboard.session.busy = null; state.dashboard.update.status = "error"; state.dashboard.update.error = "检查更新超时";
  await page.clock.runFor(3100);
  await dialog.getByText("检查更新超时", { exact: true }).waitFor();
  assert.match(await dialog.innerText(), /检查更新超时/);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: /^2026-09-02/ }).click();
  assert.equal(await page.getByRole("button", { name: "提交 1 天", exact: true }).isEnabled(), true);
});

for (const status of ["restart_required", "attention_required"]) {
  test(`update ${status} explains the next step and prevents another installation`, async (t) => {
    const update = updateState(status);
    update.error = status === "attention_required" ? "未收到安装完成结果，请检查安装进程和版本后重新打开工时助手。" : null;
    const state = { dashboard: dashboard({ update }) };
    const page = await uiPage(t, state);
    await page.getByRole("button", { name: /版本与更新/ }).click();
    const dialog = page.getByRole("dialog", { name: "版本与更新" });
    const text = status === "restart_required" ? "更新已安装完成，请关闭旧窗口，从桌面重新打开工时助手。" : update.error;
    await dialog.getByText(text, { exact: true }).first().waitFor();
    assert.doesNotMatch(await dialog.innerText(), /正在安装，请稍候/);
    assert.equal(await dialog.getByRole("button", { name: "安装更新", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "⚙ 默认设置" }).isEnabled(), false);
    state.dashboard.update = { ...updateState("up_to_date"), currentVersion: "1.4.0", lastInstall: { success: true, version: "1.4.0", error: null } };
    await page.clock.runFor(3100);
    await dialog.getByText("上次更新已完成：1.4.0", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "⚙ 默认设置" }).isEnabled(), true);
  });
}

test("an offline old page stops indefinite installation wording and recovers on the new service", async (t) => {
  const state = { dashboard: dashboard({ update: updateState("installing") }) };
  const page = await uiPage(t, state);
  await page.getByRole("button", { name: /版本与更新/ }).click();
  const dialog = page.getByRole("dialog", { name: "版本与更新" });
  state.offlineDashboard = true;
  await page.clock.runFor(151_000);
  await dialog.getByText(/安装结果尚未确认，请检查是否仍有安装程序运行/).waitFor();
  assert.doesNotMatch(await dialog.innerText(), /正在安装，请稍候/);
  assert.equal(state.requests.filter((r) => r.pathname === "/api/updates/install").length, 0);
  assert.equal(await page.getByRole("button", { name: "⚙ 默认设置" }).isEnabled(), false);
  state.offlineDashboard = false;
  state.dashboard.update = { ...updateState("up_to_date"), currentVersion: "1.4.0", lastInstall: { success: true, version: "1.4.0", error: null } };
  await page.clock.runFor(3100);
  await dialog.getByText("上次更新已完成：1.4.0", { exact: true }).waitFor();
  assert.doesNotMatch(await dialog.innerText(), /安装结果尚未确认/);
  assert.equal(await page.getByRole("button", { name: "⚙ 默认设置" }).isEnabled(), true);
});
