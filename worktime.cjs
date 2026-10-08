#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const {
  EXPORT_PATH, PROJECTS_PATH, WORK_TYPES_PATH, PROFILE_ROOT,
  STATE_PATH, LOGIN_QR_PATH, loadConfig, normalizeBaseUrl, writeTextAtomic, writeJsonAtomic,
  writeLoginStatus, syncAccount, todayIso, isWorkday, mergePendingRecords, accountsMatch,
  canonicalProject, normalizeProjects, projectKeysMatch,
  isLeaveWorkType, withoutLeaveProject,
} = require("./worktime-common.cjs");
const { ApiUnavailable, createOaApi, verifyApiSession, collectDoneApi, collectCatalogApi, searchCatalogApi } = require("./worktime-api.cjs");
const log = require("./worktime-log.cjs");
const { emitProgress } = require("./worktime-progress.cjs");
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(path.join(__dirname, "dashboard", "node_modules", "playwright"));
}
const { chromium } = playwright;

const args = process.argv.slice(2);
const command = (args[0] || "help").toLowerCase();
const targetDate = args[1];
const confirmed = args.includes("--yes");
const headed = args.includes("--headed");
const payloadArgument = args.find((argument) => argument.startsWith("--payload="));

function readPayload() {
  if (!payloadArgument) return {};
  try {
    return JSON.parse(Buffer.from(payloadArgument.slice("--payload=".length), "base64url").toString("utf8"));
  } catch {
    throw new Error("批量参数无法读取。");
  }
}

function applyOverrides(config, payload) {
  if (payload.account && !accountsMatch(config.account, payload.account)) {
    throw new Error("账户已变化，请刷新页面并重新确认填报内容。");
  }
  const settings = payload.settings || {};
  const workType = settings.workType || {};
  return {
    ...config,
    workType: {
      name: String(workType.name || config.workType.name).trim(),
      code: String(workType.code ?? config.workType.code).trim(),
    },
    projectCode: String(settings.projectCode ?? config.projectCode).trim(),
    projectId: String(settings.projectId ?? config.projectId ?? settings.projectCode ?? config.projectCode).trim(),
    projectName: String(settings.projectName ?? config.projectName ?? "").trim(),
    hours: String(settings.hours ?? config.hours).trim(),
    remark: String(settings.remark ?? config.remark).trim(),
  };
}

function validateSettings(config) {
  if (!config.workType.name || config.workType.name.length > 50) {
    throw new Error("工作类型不能为空，且不能超过 50 个字。");
  }
  if (!config.workType.code || config.workType.code.length > 80) {
    throw new Error("请从 OA 工作类型列表中选择有效类别。");
  }
  if (!isLeaveWorkType(config.workType)) {
    if (!config.projectCode || config.projectCode.length > 80) {
      throw new Error("项目号不能为空，且不能超过 80 个字符。");
    }
    if (!config.projectId || config.projectId.length > 120) throw new Error("项目选择值无效。");
    if (config.projectName.length > 200) throw new Error("项目名称不能超过 200 个字符。");
  }
  const hours = Number(config.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error("工时必须是大于 0 且不超过 24 的数字。");
  }
  if (config.remark.length > 500) throw new Error("备注不能超过 500 个字。");
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error("日期格式必须是 YYYY-MM-DD，例如 2026-08-06。");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`无效日期：${value}`);
  }
  return parsed;
}

function isWeekend(value) {
  const day = validateDate(value).getUTCDay();
  return day === 0 || day === 6;
}

function createUrls(config) {
  const stamp = Date.now();
  const base = normalizeBaseUrl(config.baseUrl);
  return {
    login: `${base}/wui/index.html#/?logintype=1`,
    add: `${base}/wui/index.html#/main/workflow/add?menuIds=1,12&menuPathIds=1,12&_key=worktime`,
    done: `${base}/wui/index.html#/main/workflow/listDone?menuIds=1,90&menuPathIds=1,90&_key=worktime-${stamp}`,
    create:
      `${base}/spa/workflow/static4form/index.html?_rdm=${stamp}` +
      `#/main/workflow/req?iscreate=1&workflowid=${config.workflowId}` +
      `&isagent=0&beagenter=0&f_weaver_belongto_userid=` +
      `&f_weaver_belongto_usertype=0&menuIds=1,12&menuPathIds=1,12` +
      `&preloadkey=${stamp}&timestamp=${stamp}&_key=worktime`,
  };
}

async function launch(config, visible = false) {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const browserCandidates = [
    chromium.executablePath(),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error("找不到可供脚本使用的 Edge、Chrome 或 Chromium。");
  const context = await chromium.launchPersistentContext(PROFILE_ROOT, {
    executablePath,
    headless: !visible,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  if (fs.existsSync(STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (Array.isArray(state.cookies) && state.cookies.length) {
      await context.addCookies(state.cookies);
    }
  }
  return context;
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
}

function isLoginPromptText(text) {
  return (
    text.includes("请使用钉钉扫描二维码以登录") ||
    text.includes("系统自动退出，需要重新登录") ||
    text.includes("登录失效")
  );
}

async function assertSignedIn(page, expectedText) {
  const text = await bodyText(page);
  if (
    text.includes("请使用钉钉扫描二维码以登录") ||
    text.includes("系统自动退出，需要重新登录") ||
    text.includes("登录失效")
  ) {
    throw new Error("LOGIN_REQUIRED");
  }
  if (expectedText && !text.includes(expectedText)) {
    throw new Error(`页面未正常加载，缺少“${expectedText}”。`);
  }
}

function parseDoneRecord(raw) {
  const workDate = raw.title.match(/工时日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const requestId = raw.onclick.match(/requestid=(\d+)/)?.[1] || "";
  const documentNo = raw.title.match(/单据编号\s*[:：]\s*([^,，)）]+)/)?.[1]?.trim() || "";
  const operationTime = raw.row.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1] || "";
  const status = raw.row.match(/(\d+-归档|归档|处理中|已办)/)?.[1] || "";
  return { workDate, documentNo, requestId, operationTime, status, title: raw.title };
}

async function extractCurrentDonePage(page) {
  const rows = await page.locator('a[onclick*="openSPA4Single"]').evaluateAll((links) =>
    links.map((link) => ({
      title: (link.innerText || "").replace(/\s+/g, " ").trim(),
      onclick: link.getAttribute("onclick") || "",
      row: (link.closest("tr")?.innerText || "").replace(/\s+/g, " ").trim(),
    })),
  );
  return rows.map(parseDoneRecord).filter((item) => item.workDate);
}

async function collectDoneRecords(page, config) {
  const urls = createUrls(config);
  await page.goto(urls.done, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("已办事宜") ||
      document.body.innerText.includes("请使用钉钉扫描二维码以登录") ||
      document.body.innerText.includes("系统自动退出，需要重新登录"),
    null,
    { timeout: 30_000 },
  );
  await assertSignedIn(page, "已办事宜");
  await page.waitForFunction(
    () => document.querySelectorAll('a[onclick*="openSPA4Single"]').length > 0 ||
      [...document.querySelectorAll(".ant-table-placeholder, .ant-empty, .wea-table-empty")]
        .some((element) => element.getClientRects().length && /暂无|没有|无数据|No data/i.test(element.textContent || "")),
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1_000);

  const records = [];
  for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
    const current = await extractCurrentDonePage(page);
    records.push(...current);

    let next = page.locator("li.ant-pagination-next").filter({ visible: true }).last();
    if (!(await next.count())) {
      next = page
        .getByRole("listitem", { name: "下一页", exact: true })
        .filter({ visible: true })
        .last();
    }
    if (!(await next.count())) {
      break;
    }
    const cls = (await next.getAttribute("class")) || "";
    const ariaDisabled = (await next.getAttribute("aria-disabled")) || "";
    if (cls.includes("ant-pagination-disabled") || ariaDisabled === "true") break;

    if (pageNo === 100) throw new Error("已办列表超过 100 页，未覆盖现有缓存；请联系维护者扩大同步范围。");
    const marker = await page.locator('a[onclick*="openSPA4Single"]').first().getAttribute("onclick");
    await next.click();
    await page.waitForFunction(
      (oldMarker) => {
        const first = document.querySelector('a[onclick*="openSPA4Single"]');
        return Boolean(
          first && first.getAttribute("onclick") !== oldMarker,
        );
      },
      marker,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(600);
  }

  return [...new Map(records.map((item) => [item.requestId || item.title, item])).values()];
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function exportDoneRecords(records) {
  const columns = ["工时日期", "单据编号", "请求ID", "操作时间", "状态", "流程标题"];
  const lines = [columns.map(csvCell).join(",")];
  for (const item of records) {
    lines.push(
      [item.workDate, item.documentNo, item.requestId, item.operationTime, item.status, item.title]
        .map(csvCell)
        .join(","),
    );
  }
  writeTextAtomic(EXPORT_PATH, `\uFEFF${lines.join("\r\n")}\r\n`);
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

function readExportedRecords() {
  if (!fs.existsSync(EXPORT_PATH)) return [];
  const raw = fs.readFileSync(EXPORT_PATH, "utf8").replace(/^\uFEFF/, "");
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
    .filter((record) => record.workDate);
}

function mergeExportedRecord(record) {
  const records = readExportedRecords().filter((item) => item.workDate !== record.workDate);
  exportDoneRecords([record, ...records]);
}

async function readAccountFromForm(page) {
  return page.evaluate(() => {
    const value = (selector) => document.querySelector(selector)?.value?.trim() || "";
    const nearby = (selector) =>
      (document.querySelector(selector)?.closest("td, .wea-field, .ant-row")?.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
    return {
      oaUserId: value("#field12642"),
      name: value("#field12648") || nearby("#field12642"),
      employeeNo: value("#field12643"),
      department: value("#field12649") || nearby("#field12645"),
      organization: nearby("#field12644"),
    };
  });
}

async function syncAccountFromForm(page) {
  return syncAccount(await readAccountFromForm(page));
}

async function clickExactTextInAnyFrame(page, text, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const matches = frame.getByText(text, { exact: true });
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = matches.nth(index);
        if (await item.isVisible().catch(() => false)) {
          await item.click();
          return;
        }
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`没有找到可选择的“${text}”。`);
}

async function readCalendarMonth(page) {
  const years = page.locator(".ant-calendar-year-select").filter({ visible: true });
  const months = page.locator(".ant-calendar-month-select").filter({ visible: true });
  if (await years.count() && await months.count()) {
    const year = Number((await years.first().textContent())?.match(/\d{4}/)?.[0]);
    const month = Number((await months.first().textContent())?.match(/\d{1,2}/)?.[0]);
    if (year && month >= 1 && month <= 12) return { year, month };
  }
  // Some OA themes localize the month heading. Full dates on current-month
  // cells still identify the displayed month without using the machine clock.
  const dates = await page.locator(
    "td.ant-calendar-cell:not(.ant-calendar-last-month-cell):not(.ant-calendar-next-month-btn-day):not(.ant-calendar-next-month-cell)",
  ).filter({ visible: true }).evaluateAll((cells) => cells.map((cell) => {
    const match = cell.title.match(/^(\d{4})(?:-|年)(\d{1,2})(?:-|月)\d{1,2}(?:日)?$/);
    return match ? `${Number(match[1])}-${Number(match[2])}` : null;
  }).filter(Boolean));
  const unique = [...new Set(dates)];
  if (unique.length !== 1) return null;
  const [year, month] = unique[0].split("-").map(Number);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

async function visibleDateCell(page, dateText) {
  const target = validateDate(dateText);
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  const targetDay = target.getUTCDate();
  const isoCell = page.locator(`td[title="${dateText}"]`).filter({ visible: true });
  if (await isoCell.count()) return isoCell.first();
  const cnCell = page
    .locator(`td[title="${targetYear}年${targetMonth}月${targetDay}日"]`)
    .filter({ visible: true });
  if (await cnCell.count()) return cnCell.first();
  const shown = await readCalendarMonth(page);
  if (!shown || shown.year !== targetYear || shown.month !== targetMonth) return null;
  const dayCell = page
    .locator(
      "td.ant-calendar-cell:not(.ant-calendar-last-month-cell):not(.ant-calendar-next-month-btn-day):not(.ant-calendar-next-month-cell)",
    )
    .filter({ hasText: new RegExp(`^${targetDay}$`), visible: true });
  return (await dayCell.count()) ? dayCell.first() : null;
}

async function openCalendarMonth(page, dateText) {
  const target = validateDate(dateText);
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  if (await visibleDateCell(page, dateText)) return;

  let shown = await readCalendarMonth(page);
  if (!shown) throw new Error("无法读取 OA 日期选择器当前年月，已停止填报。");
  const targetIndex = targetYear * 12 + targetMonth;
  const maxMoves = Math.abs(targetIndex - (shown.year * 12 + shown.month));
  for (let i = 0; i < maxMoves; i += 1) {
    if (await visibleDateCell(page, dateText)) return;
    const previousIndex = shown.year * 12 + shown.month;
    if (previousIndex === targetIndex) return;
    const selector = targetIndex < previousIndex ? ".ant-calendar-prev-month-btn" : ".ant-calendar-next-month-btn";
    await page.locator(selector).filter({ visible: true }).first().click();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      shown = await readCalendarMonth(page);
      if (shown && shown.year * 12 + shown.month !== previousIndex) break;
      await page.waitForTimeout(100);
    }
    if (!shown || shown.year * 12 + shown.month === previousIndex) {
      throw new Error("OA 日期选择器月份切换未完成，请稍后重试。");
    }
  }
}

async function selectDate(page, dateText) {
  validateDate(dateText);
  await diagnosticFormState(page, "date.before_click", dateText);
  await page.locator(".field12646_swapDiv .picker-icon").click({ timeout: 10_000 });
  log.diagnostic("date.opened", { date: dateText });
  await openCalendarMonth(page, dateText);
  const cell = await visibleDateCell(page, dateText);
  if (!cell) throw new Error(`日期选择器中找不到 ${dateText}。`);

  const duplicateValidation = page
    .waitForResponse(
      (response) =>
        response.url().includes("/api/workflow/linkage/reqFieldSqlResult") &&
        (response.request().postData() || "").includes(dateText),
      { timeout: 10_000 },
    )
    .catch(() => null);
  await cell.click();

  await page.waitForFunction(
    ({ selector, value }) => document.querySelector(selector)?.value === value,
    { selector: "#field12646", value: dateText },
    { timeout: 5_000 },
  ).catch(async () => {
    const actual = await page.locator("#field12646").inputValue().catch(() => "");
    throw new Error(`OA 日期选择未生效：目标 ${dateText}，实际 ${actual || "未读取到日期"}。已停止填报。`);
  });

  const validationResponse = await duplicateValidation;
  if (!validationResponse) {
    throw new Error("OA 日期重复校验未及时返回，请稍后重试。");
  }
  const validationResult = await validationResponse.json().catch(() => null);
  const expectedDuplicateCount =
    validationResult?.assignInfo_90?.changeValue?.field13685?.value;
  if (expectedDuplicateCount === undefined) {
    throw new Error("OA 日期重复校验结果无法读取，请稍后重试。");
  }
  await page.waitForFunction(
    (expected) => document.querySelector("#field13685")?.value === String(expected),
    expectedDuplicateCount,
    { timeout: 5_000 },
  );
}

async function waitForWfForm(page) {
  await page.waitForFunction(
    () => typeof window.WfForm?.changeFieldValue === "function",
    null,
    { timeout: 5_000 },
  ).catch(() => {});
}

async function changeBrowserFieldFast(page, fieldId, value, displayName) {
  if (!value) return false;
  const changed = await page.evaluate(
    ({ fieldId: id, value: fieldValue, displayName: name }) => {
      if (typeof window.WfForm?.changeFieldValue !== "function") return false;
      window.WfForm.changeFieldValue(id, {
        value: fieldValue,
        specialobj: [{ id: fieldValue, name: name || fieldValue }],
      });
      return true;
    },
    { fieldId, value, displayName },
  );
  if (!changed) return false;
  return page
    .waitForFunction(
      ({ selector, expected }) => {
        const normalize = (item) => String(item || "")
          .trim()
          .replace(/[\u2010-\u2015\u2212\u30FC\uFF0D]/g, "-")
          .replace(/\s*-\s*/g, "-");
        const actual = normalize(document.querySelector(selector)?.value);
        return expected.some((item) => item && actual === normalize(item));
      },
      { selector: `#${fieldId}`, expected: [value, displayName].filter(Boolean) },
      { timeout: 1_500 },
    )
    .then(() => true)
    .catch(() => false);
}

async function selectWorkType(page, config) {
  if (
    config.workType.code &&
    (await changeBrowserFieldFast(page, "field12653_0", config.workType.code, config.workType.name))
  ) {
    return;
  }
  await page.locator("#field12653_0span button").click({ timeout: 10_000 });
  await clickExactTextInAnyFrame(page, config.workType.name);
  if (config.workType.code) {
    await page.waitForFunction(
      (code) => document.querySelector("#field12653_0")?.value === code,
      config.workType.code,
      { timeout: 8_000 },
    );
  } else {
    await page.waitForFunction(
      () => Boolean(document.querySelector("#field12653_0")?.value),
      null,
      { timeout: 8_000 },
    );
  }
  config.workType.code = await page.locator("#field12653_0").inputValue();
}

async function findSearchFrame(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const text = await frame.locator("body").innerText({ timeout: 300 }).catch(() => "");
      const visibleInputs = frame
        .locator(
          'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])',
        )
        .filter({ visible: true });
      const searchButtons = frame.getByRole("button", { name: /搜\s*索/ }).filter({ visible: true });
      if (
        text.includes("搜索") &&
        (await visibleInputs.count().catch(() => 0)) > 0 &&
        (await searchButtons.count().catch(() => 0)) > 0
      ) {
        return frame;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error("项目号选择窗口没有正常打开。");
}

async function clickProjectChoice(page, labels, timeoutMs = 8_000) {
  const wanted = [...new Set(labels.map((label) => String(label || "").trim()).filter(Boolean))];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const cells = frame.locator("td, [role='cell'], [role='gridcell'], a").filter({ visible: true });
      const count = await cells.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const text = (await cells.nth(index).innerText().catch(() => "")).trim();
        const firstToken = text.split(/\s+/)[0] || "";
        if (wanted.some((label) => text === label || firstToken === label)) {
          await cells.nth(index).click();
          return;
        }
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`没有找到可选择的“${wanted[0] || "项目号"}”。`);
}

async function selectProject(page, projectCode, projectId = projectCode, projectName = "") {
  const display = projectName || projectCode;
  if (await changeBrowserFieldFast(page, "field12654_0", projectId, display)) return;
  if (projectId !== projectCode && (await changeBrowserFieldFast(page, "field12654_0", projectCode, display))) return;
  await page.locator("#field12654_0span button").click({ timeout: 10_000 });
  const frame = await findSearchFrame(page);
  const dialogs = frame.locator('[role="dialog"]').filter({ visible: true });
  const scope = (await dialogs.count()) ? dialogs.last() : frame.locator("body");
  const inputs = scope
    .locator(
      'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])',
    )
    .filter({ visible: true });
  await inputs.first().fill(projectCode);
  const search = scope.getByRole("button", { name: /搜\s*索/ }).filter({ visible: true });
  if (!(await search.count())) throw new Error("项目选择窗口中没有找到搜索按钮。");
  await search.first().click();
  await clickProjectChoice(page, [projectCode, projectId]);
  const accepted = await page.waitForFunction(
    ({ expected }) => {
      const normalize = (item) => String(item || "")
        .trim()
        .replace(/[\u2010-\u2015\u2212\u30FC\uFF0D]/g, "-")
        .replace(/\s*-\s*/g, "-");
      const actual = normalize(document.querySelector("#field12654_0")?.value);
      return expected.some((item) => item && actual === normalize(item));
    },
    { expected: [projectId, projectCode] },
    { timeout: 8_000 },
  ).then(() => true).catch(() => false);
  if (!accepted) throw new Error("项目号核对失败。");
}

async function clearLeaveProject(page) {
  // Observe OA's own linkage; never change its mandatory/editable attributes.
  const readable = await page.waitForFunction(() => {
    const form = window.WfForm;
    const attr = form?.getFieldCurViewAttr?.("field12654_0");
    return attr != null && Number(attr) !== 3;
  }, null, { timeout: 3000 }).then(() => true).catch(() => false);
  if (!readable) {
    const attr = await page.evaluate(() => window.WfForm?.getFieldCurViewAttr?.("field12654_0") ?? null);
    throw new Error(Number(attr) === 3
      ? "OA 原表单选择休假后仍要求项目，已停止；请联系 OA 管理员确认休假规则。"
      : "无法核对 OA 休假项目字段规则，已停止；不会绕过 OA 校验。");
  }
  await page.evaluate(() => window.WfForm.changeFieldValue("field12654_0", { value: "", specialobj: [] }));
  await page.waitForFunction(() => {
    const form = window.WfForm;
    const field = document.querySelector("#field12654_0");
    return (!field || !field.value) && !form.getFieldValue?.("field12654_0");
  }, null, { timeout: 5000 });
  if (Number(await page.evaluate(() => window.WfForm.getFieldCurViewAttr("field12654_0"))) === 3) {
    throw new Error("OA 仍要求休假项目，已停止；没有修改 OA 必填规则。");
  }
}

async function diagnosticFormState(page, stage, date) {
  if (!log.diagnosticEnabled()) return;
  let timer;
  try {
    const frames = await Promise.race([
      Promise.all(page.frames().slice(0, 8).map(async (frame) => ({
        location: log.diagnosticUrl(frame.url()),
        state: await frame.evaluate(() => {
          const describe = (element) => ({
            tag: element.tagName, id: element.id, classes: String(element.className || "").slice(0, 200),
            type: element.getAttribute("type"), disabled: !!element.disabled, readOnly: !!element.readOnly,
            visible: !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden",
            display: getComputedStyle(element).display,
          });
          const field = document.querySelector("#field12646");
          return {
            ready: document.readyState, wfFormReady: !!window.WfForm,
            dateFields: document.querySelectorAll("#field12646").length,
            expectedIcons: document.querySelectorAll(".field12646_swapDiv .picker-icon").length,
            pickerIcons: document.querySelectorAll(".picker-icon").length,
            field: field ? describe(field) : null,
            nearby: field ? [...(field.closest(".field12646_swapDiv") || field.parentElement).querySelectorAll("*")].slice(0, 30).map(describe) : [],
            dateWrappers: [...document.querySelectorAll('[class*="field12646"]')].slice(0, 10).map(describe),
          };
        }).catch(() => ({ unavailable: true })),
      }))),
      new Promise((resolve) => { timer = setTimeout(() => resolve([{ unavailable: true, timeout: true }]), 2000); }),
    ]);
    // Flatten frame state to remain within the logger's safe nesting limit.
    for (const [index, frame] of frames.entries()) log.diagnostic(stage, { date, frame: index, location: frame.location, ...frame.state, timeout: frame.timeout });
  } catch { log.diagnostic(stage, { date, unavailable: true }); }
  finally { clearTimeout(timer); }
}

async function prepareForm(page, config, dateText, options = {}) {
  if (!log.diagnosticEnabled()) return prepareFormCore(page, config, dateText, options);
  let count = 0;
  const emit = (event, data) => { if (count++ < 100) log.diagnostic(event, { date: dateText, ...data }); };
  const onFailure = (request) => emit("page.request_failed", { endpoint: log.diagnosticUrl(request.url()), resource: request.resourceType(), failure: log.diagnosticFailure(request.failure()?.errorText) });
  const onResponse = (response) => {
    if (response.status() >= 400 || response.request().resourceType() === "document") emit("page.response", { endpoint: log.diagnosticUrl(response.url()), status: response.status() });
  };
  const onError = (error) => emit("page.script_error", { failure: log.diagnosticFailure(error) });
  page.on("requestfailed", onFailure);
  page.on("response", onResponse);
  page.on("pageerror", onError);
  log.diagnostic("form.start", { date: dateText });
  try {
    const result = await prepareFormCore(page, config, dateText, options);
    log.diagnostic("form.ready", { date: dateText });
    return result;
  } catch (error) {
    await diagnosticFormState(page, "form.failure_state", dateText);
    throw error;
  } finally {
    page.off("requestfailed", onFailure);
    page.off("response", onResponse);
    page.off("pageerror", onError);
  }
}

async function loadFormPage(page, config, dateText) {
  const urls = createUrls(config);
  await page.goto(urls.create, { waitUntil: "domcontentloaded", timeout: 30_000 });
  log.diagnostic("form.navigated", { date: dateText, location: log.diagnosticUrl(page.url()) });
  await Promise.race([
    page.waitForSelector("#field12646", { state: "attached", timeout: 30_000 }),
    page.waitForFunction(
      () =>
        document.body.innerText.includes("请使用钉钉扫描二维码以登录") ||
        document.body.innerText.includes("系统自动退出，需要重新登录"),
      null,
      { timeout: 30_000 },
    ),
  ]);
}

async function prepareFormCore(page, config, dateText, options = {}) {
  options.onStage?.("loading");
  if (!options.preloaded) await loadFormPage(page, config, dateText);
  options.onStage?.("checking");
  // Preloading never authorizes filling: recheck the live account and OA's
  // duplicate-date validation only when this date reaches its turn.
  await assertSignedIn(page, "工时填报");
  log.diagnostic("form.date_field_attached", { date: dateText });
  const account = await readAccountFromForm(page);
  log.diagnostic("form.account_loaded", { date: dateText });
  if (config.account && !accountsMatch(config.account, account)) {
    writeLoginStatus({ state: "error", reason: "account", message: "OA 账户已变化，请重新扫码登录后再填报。" });
    throw new Error("OA 账户已变化，已停止填报；请重新扫码登录后再试。");
  }
  syncAccount(account);

  await selectDate(page, dateText);
  log.diagnostic("form.date_selected", { date: dateText });
  await waitForWfForm(page);
  await selectWorkType(page, config);
  log.diagnostic("form.work_type_selected", { date: dateText });
  if (isLeaveWorkType(config.workType)) await clearLeaveProject(page);
  else await selectProject(page, config.projectCode, config.projectId, config.projectName);
  log.diagnostic("form.project_selected", { date: dateText });
  await page.locator("#field12655_0").fill(String(config.hours));
  await page.locator("#field12655_0").press("Tab");
  await page.locator("#field12656_0").fill(config.remark);

  await page.waitForFunction(
    (hours) => Number(document.querySelector("#field12647")?.value) === Number(hours),
    String(config.hours),
    { timeout: 8_000 },
  );

  const values = await page.evaluate(() => ({
    date: document.querySelector("#field12646")?.value || "",
    workType: document.querySelector("#field12653_0")?.value || "",
    project: document.querySelector("#field12654_0")?.value || "",
    hours: document.querySelector("#field12655_0")?.value || "",
    total: document.querySelector("#field12647")?.value || "",
    duplicateCount: document.querySelector("#field13685")?.value ?? "",
  }));

  if (isLeaveWorkType(config.workType)) {
    const attr = await page.evaluate(() => window.WfForm?.getFieldCurViewAttr?.("field12654_0") ?? null);
    if (attr == null || Number(attr) === 3) throw new Error("OA 休假项目规则未通过核对，已停止填报。");
  }

  if (values.date !== dateText) throw new Error(`日期核对失败：${values.date}`);
  if (config.workType.code && values.workType !== config.workType.code) {
    throw new Error("工作类型核对失败。");
  }
  if (isLeaveWorkType(config.workType) ? Boolean(values.project.trim()) :
      !projectKeysMatch(values.project, config.projectId) && !projectKeysMatch(values.project, config.projectCode)) {
    throw new Error("项目号核对失败。");
  }
  if (Number(values.hours) !== Number(config.hours) || Number(values.total) !== Number(config.hours)) {
    throw new Error("工时或工时合计核对失败。");
  }
  if (!values.duplicateCount.trim() || Number(values.duplicateCount) !== 0) {
    throw new Error("系统重复校验未通过，已停止。");
  }
  return { ...values, account };
}

async function* iterateWorktimeForms(context, firstPage, config, dates, options = {}) {
  let next = null;
  try {
    for (const [index, dateText] of dates.entries()) {
      const current = next;
      next = null;
      let page = current?.page || (!options.submit || index === 0 ? firstPage : await context.newPage());
      let preloaded = false;
      if (current) {
        const outcome = await current.ready;
        preloaded = outcome.ok;
        if (!preloaded) {
          // A failed navigation can still commit Chrome's error document after
          // goto rejects. Discard that page before loading a fresh blank form.
          await page.close().catch(() => {});
          page = await context.newPage();
          log.warn("fill", "form.preload.fallback", "表单预加载未完成，按原流程重新加载", { date: dateText });
        }
      }
      if (options.submit && options.preload !== false && index + 1 < dates.length) {
        let ahead;
        try {
          ahead = await context.newPage();
          const nextDate = dates[index + 1];
          const started = Date.now();
          log.info("fill", "form.preload.start", "提前加载下一天空白表单", { date: nextDate });
          // Observe failures immediately so a rejected speculative load cannot
          // become an unhandled rejection while the current date is submitting.
          const ready = loadFormPage(ahead, config, nextDate).then(() => {
            log.info("fill", "form.preload.ready", "下一天空白表单已加载", { date: nextDate }, { durationMs: Date.now() - started });
            return { ok: true };
          }, (error) => {
            log.diagnostic("form.preload.failed", { date: nextDate, failure: log.diagnosticFailure(error) });
            return { ok: false };
          });
          next = { page: ahead, ready };
        } catch {
          await ahead?.close().catch(() => {});
          log.warn("fill", "form.preload.unavailable", "无法提前打开表单，继续按顺序处理", { date: dates[index + 1] });
        }
      }
      // Activate a preloaded page when its turn arrives; background tabs may
      // throttle animation-frame based field checks even in headless mode.
      if (options.submit) await page.bringToFront();
      yield { page, dateText, index, preloaded };
    }
  } finally {
    // A failure/stop in the caller must discard the speculative blank page.
    // Pages already submitted remain open for OA to finish, as before.
    if (next) {
      await next.page.close().catch(() => {});
      await next.ready;
    }
  }
}

async function clickVisibleButton(page, pattern) {
  const buttons = page.getByRole("button", { name: pattern }).filter({ visible: true });
  const count = await buttons.count().catch(() => 0);
  if (!count) return false;
  await buttons.last().click();
  return true;
}

function readSubmitResult() {
  const url = location.href;
  const text = document.body?.innerText || "";
  if ((/requestid=\d+/.test(url) && !url.includes("iscreate=1")) ||
      text.includes("提交成功") || text.includes("操作成功")) {
    return { url, text };
  }
  return null;
}

function readSubmitError() {
  const toast = document.querySelector(".ant-message-error, .ant-notification-notice-error, .wea-message-error");
  const toastText = toast?.textContent?.replace(/\s+/g, " ").trim() || "";
  if (toastText) return toastText;
  const text = document.body?.innerText || "";
  return text.match(/提交失败|校验不通过|流程提交失败|该项目不能|该项目无法|项目已关闭/)?.[0] || null;
}

function isOaSubmitRequest(request) {
  if (request.method() === "GET") return false;
  return /RequestOperation|requestSubmit|doSubmit|requestOperate|wfSubmit/i.test(request.url());
}

async function submitPreparedForm(page) {
  let dialogError = null;
  let requestSeen = false;
  const onDialog = async (dialog) => {
    try {
      await dialog.accept();
    } catch (error) {
      dialogError = error;
    }
  };
  page.on("dialog", onDialog);
  page.waitForRequest(isOaSubmitRequest, { timeout: 3_000 }).then(() => {
    requestSeen = true;
  }).catch(() => {});
  try {
    await page.locator('button[title="提交"]').click({ timeout: 10_000 });
    const clickedLabels = new Set();
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline && !page.isClosed()) {
      if (dialogError) throw dialogError;
      const done = await page.evaluate(readSubmitResult).catch(() => null);
      if (done) return done;
      const submitError = await page.evaluate(readSubmitError).catch(() => null);
      if (submitError) throw new Error(submitError);
      for (const [key, pattern] of [
        ["confirm", /^确\s*定$/],
        ["continue", /继续提交/],
        ["yes", /^是$/],
      ]) {
        if (!clickedLabels.has(key) && (await clickVisibleButton(page, pattern))) clickedLabels.add(key);
      }
      if (requestSeen) break;
      await page.waitForTimeout(50);
    }
    if (dialogError) throw dialogError;
    return { url: page.url(), text: "" };
  } finally {
    page.off("dialog", onDialog);
  }
}

function createOptimisticRecord(dateText, submission, accountName) {
  const requestId = submission.url.match(/requestid=(\d+)/)?.[1] || "";
  const documentNo = submission.text.match(/GSTB-\d+-\d+/)?.[0] || "";
  const operationTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replaceAll("/", "-");
  return {
    workDate: dateText,
    documentNo,
    requestId,
    operationTime,
    status: "已提交·同步中",
    title: `工时填报-${accountName || "当前账户"}（工时日期:${dateText}）`,
  };
}

async function runQrLogin(config) {
  const force = args.includes("--force");
  if (force && fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  writeLoginStatus({ state: "checking", message: "正在检查 OA 登录状态…" });
  const context = await launch(config, false);
  try {
    const page = context.pages()[0] || (await context.newPage());
    if (force) {
      await context.clearCookies();
      await page.goto(normalizeBaseUrl(config.baseUrl), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      }).catch(() => {});
    }

    if (!force && fs.existsSync(STATE_PATH)) {
      const account = await tryFinalizeQrLogin(context, config);
      if (account) return;
    }
    const account = await waitForQrLogin(context, page, config);
    console.log(`网页登录成功：${account.name || "当前账户"}`);
    log.info("session", "login.ok", `网页登录成功：${account.name || "当前账户"}`, {
      name: account.name, employeeNo: account.employeeNo,
    });
  } catch (error) {
    writeLoginStatus({ state: "error", message: error.message || "登录失败。" });
    throw error;
  } finally {
    await context.close();
  }
}

async function waitForQrLogin(context, page, config, {
  timeoutMs = 5 * 60_000, pollIntervalMs = 800, probeIntervalMs = 5_000,
} = {}) {
  const origin = normalizeBaseUrl(config.baseUrl);
  let loginAccepted = false;
  let loginError = "";
  // OA can accept the QR login without closing its re-login dialog. Observe the
  // actual response before navigation, rather than waiting for its text to vanish.
  const onResponse = async (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== origin || url.pathname !== "/api/hrm/login/qrcode/getQCLoginStatus") return;
      if (!response.ok()) return;
      const result = await response.json();
      if (String(result.status) === "1") loginAccepted = true;
      else if (String(result.status) === "-1" && !loginAccepted) {
        loginError = String(result.msg || "二维码已失效，请重新生成后扫码。");
      }
    } catch {
      // A transient polling failure is retried by OA; it is not a successful login.
    }
  };
  page.on("response", onResponse);
  try {
    // Opening a protected workflow while signed out invokes OA's expired-session
    // popup. Use its normal login page so QR polling and the redirect are initialized.
    await page.goto(createUrls(config).login, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const deadline = Date.now() + timeoutMs;
    let lastQrCapture = 0;
    let sawLoginPrompt = false;
    let confirmingSince = 0;
    let lastSessionProbe = 0;
    while (Date.now() < deadline) {
      if (loginError && !loginAccepted) throw new Error(loginError);
      const text = await bodyText(page);
      const loginPrompt = isLoginPromptText(text);
      const signedIn =
        !loginPrompt &&
        text.includes("工时填报");

      if (loginAccepted || signedIn || (!loginPrompt && sawLoginPrompt)) {
        if (!confirmingSince) {
          confirmingSince = Date.now();
          writeLoginStatus({
            state: "confirming",
            message: loginAccepted ? "手机确认已收到，正在验证 OA 会话和账户信息…" : "正在检查 OA 登录结果…",
          });
        }
      }

      if ((loginAccepted || signedIn || confirmingSince) && Date.now() - lastSessionProbe >= probeIntervalMs) {
        lastSessionProbe = Date.now();
        const account = await tryFinalizeQrLogin(context, config);
        if (account) return account;
      }

      if (!loginAccepted && loginPrompt && Date.now() - lastQrCapture > 4_000) {
        sawLoginPrompt = true;
        confirmingSince = 0;
        const canvases = page.locator("canvas").filter({ visible: true });
        if (await canvases.count().catch(() => 0)) {
          await canvases.first().screenshot({ path: LOGIN_QR_PATH });
          const qrVersion = fs.statSync(LOGIN_QR_PATH).mtimeMs;
          writeLoginStatus({
            state: "waiting",
            message: "请打开钉钉，扫描二维码登录。",
            qrVersion,
          });
          lastQrCapture = Date.now();
        }
      }
      await page.waitForTimeout(pollIntervalMs);
    }
    throw new Error(loginAccepted
      ? "已收到手机确认，但 OA 会话或账户信息未能加载，请重新登录。"
      : "二维码已超时，请重新发起登录。");
  } finally {
    page.off("response", onResponse);
  }
}

async function tryFinalizeQrLogin(context, config) {
  const probePage = await context.newPage();
  try {
    await probePage.goto(createUrls(config).create, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await probePage.locator("#field12646").count().catch(() => 0)) {
        const details = await readAccountFromForm(probePage);
        // The date field may render before the current user's identity is loaded.
        if (!details.name || !details.employeeNo) {
          await probePage.waitForTimeout(500);
          continue;
        }
        const account = syncAccount(details);
        await context.storageState({ path: STATE_PATH });
        writeLoginStatus({
          state: "connected",
          message: `已登录：${account.name || "当前账户"}`,
          verifiedAt: new Date().toISOString(),
          account,
        });
        return account;
      }
      if (isLoginPromptText(await bodyText(probePage))) return null;
      await probePage.waitForTimeout(500);
    }
    return null;
  } catch {
    return null;
  } finally {
    await probePage.close().catch(() => {});
  }
}

async function runLogin(config) {
  const context = await launch(config, true);
  try {
    const page = context.pages()[0] || (await context.newPage());
    console.log("已打开脚本专用登录窗口，请用钉钉扫码。此窗口与您当前浏览器相互独立。");
    console.log("等待登录，最长 10 分钟……");
    const account = await waitForQrLogin(context, page, config, { timeoutMs: 10 * 60_000 });
    console.log(`登录成功：${account.name || "当前账户"}，脚本会记住本次会话。`);
  } finally {
    await context.close();
  }
}

async function runSessionCheck(config) {
  const api = await createOaApi(config);
  try {
    const account = syncAccount(await verifyApiSession(api));
    writeLoginStatus({ state: "connected", message: "OA 登录有效。", account, verifiedAt: new Date().toISOString() });
    console.log("OA 登录有效。");
  } finally {
    await api.dispose();
  }
}

function catalogIsFresh(filePath, itemsKey, account) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const items = Array.isArray(data[itemsKey]) ? data[itemsKey] : [];
    const fetchedAt = Date.parse(data.fetchedAt || "");
    if (account && data.account && !accountsMatch(data.account, account)) return false;
    return Boolean(items.length && items.length >= Number(data.sourceTotal || 0) &&
      Number.isFinite(fetchedAt) && Date.now() - fetchedAt < 24 * 60 * 60 * 1_000);
  } catch {
    return false;
  }
}

async function applyApiSync(api, account, kind) {
  const startedAt = Date.now();
  if (kind === "list") {
    const { records } = await collectDoneApi(api);
    syncAccount(account);
    exportDoneRecords(mergePendingRecords(records, readExportedRecords()));
    const durationMs = Date.now() - startedAt;
    console.log(`已办同步完成：${records.length} 条，接口读取耗时 ${(durationMs / 1000).toFixed(1)} 秒。`);
    log.info("sync", "done.ok", `已办同步完成：${records.length} 条`, { count: records.length, source: "api", durationMs });
    return;
  }
  const { rows, sourceTotal } = await collectCatalogApi(api, kind);
  const items = kind === "projects" ? normalizeProjects(rows) : normalizeWorkTypes(rows);
  if (!items.length || items.length !== sourceTotal) {
    log.warn("sync", "catalog.incomplete", "OA 选项列表不完整，已保留原有缓存", {
      kind, fetched: items.length, sourceTotal, source: "api",
    });
    throw new Error("OA 选项列表不完整，已保留原有缓存，请重新同步。");
  }
  syncAccount(account);
  writeJsonAtomic(kind === "projects" ? PROJECTS_PATH : WORK_TYPES_PATH, {
    fetchedAt: new Date().toISOString(), sourceTotal, account,
    [kind === "projects" ? "projects" : "workTypes"]: items,
  });
  const durationMs = Date.now() - startedAt;
  const label = kind === "projects" ? "项目列表" : "工作类型";
  console.log(`${label}同步完成：${items.length} 条，接口读取耗时 ${(durationMs / 1000).toFixed(1)} 秒。`);
  log.info("sync", kind === "projects" ? "projects.ok" : "worktypes.ok", `${label}同步完成：${items.length} 条`, {
    count: items.length, sourceTotal, source: "api", durationMs,
  });
}

async function tryApiSync(config, kind) {
  if (headed) return false;
  let api;
  try {
    api = await createOaApi(config);
    const account = await verifyApiSession(api);
    await applyApiSync(api, account, kind);
    writeLoginStatus({ state: "connected", message: "OA 登录有效。", account, verifiedAt: new Date().toISOString() });
    return true;
  } catch (error) {
    if (!(error instanceof ApiUnavailable)) throw error;
    console.log("OA 接口格式暂不兼容，正在通过页面同步…");
    log.warn("sync", "api.fallback", "OA 接口格式暂不兼容，正在通过页面同步", { kind });
    return false;
  } finally {
    await api?.dispose();
  }
}

async function runStartupSync(config) {
  const kinds = [];
  if (!catalogIsFresh(WORK_TYPES_PATH, "workTypes", config.account)) kinds.push("work-types");
  kinds.push("list");
  log.info("sync", "startup.start", `登录后同步：${kinds.join("、")}`, { kinds });
  if (headed) {
    for (const kind of kinds) {
      if (kind === "list") await runList(config);
      else await runWorkTypes(config);
    }
    return;
  }
  let api;
  try {
    api = await createOaApi(config);
    const account = await verifyApiSession(api);
    writeLoginStatus({ state: "connected", message: "OA 登录有效。", account, verifiedAt: new Date().toISOString() });
    for (const [index, kind] of kinds.entries()) {
      try {
        await applyApiSync(api, account, kind);
      } catch (error) {
        if (!(error instanceof ApiUnavailable)) throw error;
        console.log("OA 接口格式暂不兼容，正在通过页面同步…");
        log.warn("sync", "api.fallback", "OA 接口格式暂不兼容，正在通过页面同步", { kind });
        await api.dispose();
        api = null;
        for (const remaining of kinds.slice(index)) {
          if (remaining === "list") await runList(config);
          else await runWorkTypes(config);
        }
        return;
      }
    }
    writeLoginStatus({ state: "connected", message: "OA 登录有效。", account, verifiedAt: new Date().toISOString() });
  } finally {
    await api?.dispose();
  }
}

async function runList(config) {
  if (await tryApiSync(config, "list")) return;
  const context = await launch(config, headed);
  try {
    const page = context.pages()[0] || (await context.newPage());
    const records = mergePendingRecords(await collectDoneRecords(page, config), readExportedRecords());
    exportDoneRecords(records);
    const dates = records.map((item) => item.workDate).sort();
    console.log(`已获取 ${records.length} 条已办工时。`);
    if (dates.length) console.log(`工时日期范围：${dates[0]} 至 ${dates.at(-1)}`);
    console.log(`已导出：${EXPORT_PATH}`);
    log.info("sync", "done.ok", `已获取 ${records.length} 条已办工时`, {
      count: records.length, source: "page", from: dates[0], to: dates.at(-1),
    });
  } finally {
    await context.close();
  }
}

function normalizeWorkTypes(rows) {
  const workTypes = new Map();
  for (const row of rows) {
    const code = String(row?.bm || row?.randomFieldId || "").trim();
    const name = String(row?.mc || "").trim();
    if (!code || !name || workTypes.has(code)) continue;
    workTypes.set(code, { code, name });
  }
  return [...workTypes.values()];
}

async function runWorkTypes(config) {
  if (await tryApiSync(config, "work-types")) return;
  const context = await launch(config, headed);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(createUrls(config).create, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await Promise.race([
      page.waitForSelector("#field12653_0span button", { state: "attached", timeout: 30_000 }),
      page.waitForFunction(
        () =>
          document.body.innerText.includes("请使用钉钉扫描二维码以登录") ||
          document.body.innerText.includes("系统自动退出，需要重新登录"),
        null,
        { timeout: 30_000 },
      ),
    ]);
    await assertSignedIn(page, "工时填报");
    const account = await syncAccountFromForm(page);

    const responsePromise = page.waitForResponse(
      (response) => matchesBrowserResponse(response, "12653", "browser.gzlx"),
      { timeout: 20_000 },
    );
    const [response] = await Promise.all([
      responsePromise,
      page.locator("#field12653_0span button").click({ timeout: 10_000 }),
    ]);
    const { rows, sourceTotal } = await collectBrowserRows(page, response, "工作类型");
    const workTypes = normalizeWorkTypes(rows);
    if (!workTypes.length) throw new Error("OA 没有返回可用工作类型。");
    if (workTypes.length < sourceTotal) throw new Error("工作类型列表不完整，已保留原有选项，请重新同步。");
    writeJsonAtomic(WORK_TYPES_PATH, {
          fetchedAt: new Date().toISOString(),
          sourceTotal,
          account: {
            name: account.name || "",
            employeeNo: account.employeeNo || "",
            department: account.department || "",
          },
          workTypes,
    });
    console.log(`工作类型同步完成：${workTypes.length} 种。`);
    log.info("sync", "worktypes.ok", `工作类型同步完成：${workTypes.length} 种`, { count: workTypes.length, source: "page" });
  } finally {
    await context.close();
  }
}

function projectPageUrl(sourceUrl, pageNumber, pageSize) {
  const url = new URL(sourceUrl);
  const min = (pageNumber - 1) * pageSize + 1;
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("current", String(pageNumber));
  url.searchParams.set("min", String(min));
  url.searchParams.set("max", String(min + pageSize - 1));
  url.searchParams.set("__random__", String(Date.now() + pageNumber));
  return url.toString();
}

function matchesBrowserResponse(response, fieldId, type) {
  if (!response.url().includes("/api/public/browser/data/161") || response.status() !== 200) return false;
  const query = new URL(response.url()).searchParams;
  const body = browserRequestParameters(response.request());
  return query.get("fieldid") === fieldId || body.get("fieldid") === fieldId ||
    Boolean(type && (query.get("type") === type || body.get("type") === type));
}

function browserRequestParameters(request) {
  const raw = request.postData() || "";
  try {
    return new URLSearchParams(raw.trim().startsWith("{") ? JSON.parse(raw) : raw);
  } catch {
    return new URLSearchParams();
  }
}

async function collectBrowserRows(page, firstResponse, label) {
  const payload = await firstResponse.json();
  if (!Array.isArray(payload?.datas)) throw new Error(`OA ${label}列表返回格式无法识别。`);
  const pageSize = Math.max(1, Math.floor(Number(payload.pageSize) || payload.datas.length || 1));
  const sourceTotal = Math.max(payload.datas.length, Number(payload.total) || 0);
  const pageCount = Math.max(1, Math.ceil(sourceTotal / pageSize));
  if (!Number.isFinite(pageCount) || pageCount > 10_000) throw new Error(`OA ${label}分页数量异常。`);
  const sourceUrl = firstResponse.url();
  const firstPage = Number(new URL(sourceUrl).searchParams.get("current") || browserRequestParameters(firstResponse.request()).get("current")) || 1;
  const rows = [...payload.datas];
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1).filter((number) => number !== firstPage);
  for (let start = 0; start < pages.length; start += 4) {
    const payloads = await fetchProjectPages(page, firstResponse, pages.slice(start, start + 4), pageSize);
    for (const next of payloads) {
      if (!Array.isArray(next?.datas) || !next.datas.length) throw new Error(`OA ${label}分页数据不完整，请重新同步。`);
      rows.push(...next.datas);
    }
  }
  if (rows.length < sourceTotal) throw new Error(`OA ${label}分页数据不完整，请重新同步。`);
  return { rows, sourceTotal };
}

function readProjectChoices(config) {
  if (!fs.existsSync(PROJECTS_PATH)) return [];
  try {
    const catalog = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
    if (!accountsMatch(config.account, catalog.account) || !Array.isArray(catalog.projects)) return [];
    return catalog.projects.map(canonicalProject).filter(Boolean);
  } catch {
    return [];
  }
}

function resolveSelectedProject(config) {
  const wantedCode = String(config.projectCode || "").trim();
  const wantedId = String(config.projectId || "").trim();
  const local = readProjectChoices(config);
  const match = local.find((project) => projectKeysMatch(project.code, wantedCode) || projectKeysMatch(project.id, wantedId))
    || local.find((project) => projectKeysMatch(project.name, wantedCode));
  if (match) return match;
  const selected = canonicalProject({
    id: wantedId || wantedCode,
    code: wantedCode,
    name: String(config.projectName || "").trim(),
  });
  if (selected) return selected;
  throw new Error("请先搜索并选择项目号。");
}

async function fetchProjectPages(page, sourceResponse, pageNumbers, pageSize) {
  const original = sourceResponse.request();
  const method = original.method();
  const contentType = original.headers()["content-type"] || "application/x-www-form-urlencoded";
  const targets = pageNumbers.map((pageNumber) => {
    const url = projectPageUrl(sourceResponse.url(), pageNumber, pageSize);
    if (method === "GET") return { url, method };
    if (method !== "POST") throw new Error(`无法同步 ${method} 类型的 OA 列表。`);
    const params = browserRequestParameters(original);
    const pageParams = new URL(url).searchParams;
    for (const key of ["current", "pageSize", "min", "max", "__random__"]) params.set(key, pageParams.get(key));
    return {
      url, method, headers: { "Content-Type": contentType },
      body: contentType.includes("application/json") ? JSON.stringify(Object.fromEntries(params)) : params.toString(),
    };
  });
  return page.evaluate(async (targets) =>
    Promise.all(
      targets.map(async (target) => {
        const { url, ...options } = target;
        const response = await fetch(url, { ...options, credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
    ),
  targets);
}

async function runProjects(config) {
  if (await tryApiSync(config, "projects")) return;
  const context = await launch(config, headed);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(createUrls(config).create, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await Promise.race([
      page.waitForSelector("#field12654_0span button", { state: "attached", timeout: 30_000 }),
      page.waitForFunction(
        () =>
          document.body.innerText.includes("请使用钉钉扫描二维码以登录") ||
          document.body.innerText.includes("系统自动退出，需要重新登录"),
        null,
        { timeout: 30_000 },
      ),
    ]);
    await assertSignedIn(page, "工时填报");
    const account = await syncAccountFromForm(page);

    const firstResponsePromise = page.waitForResponse(
      (response) => matchesBrowserResponse(response, "12654"),
      { timeout: 20_000 },
    );
    const [firstResponse] = await Promise.all([
      firstResponsePromise,
      page.locator("#field12654_0span button").click({ timeout: 10_000 }),
    ]);
    const { rows, sourceTotal } = await collectBrowserRows(page, firstResponse, "项目");

    const projects = normalizeProjects(rows);
    if (!projects.length) throw new Error("OA 没有返回可用项目。");
    if (projects.length < sourceTotal) throw new Error("项目列表不完整，已保留原有项目库，请重新同步。");
    writeJsonAtomic(PROJECTS_PATH, {
          fetchedAt: new Date().toISOString(),
          sourceTotal,
          account: {
            name: account.name || "",
            employeeNo: account.employeeNo || "",
            department: account.department || "",
          },
          projects,
    });
    console.log(`项目列表同步完成：${projects.length} 个项目号及项目名称。`);
    log.info("sync", "projects.ok", `项目列表同步完成：${projects.length} 个项目号及项目名称`, { count: projects.length, source: "page" });
  } finally {
    await context.close();
  }
}

function fillContext(config, extra = {}) {
  return {
    workType: config.workType?.name,
    workTypeCode: config.workType?.code,
    projectCode: config.projectCode,
    hours: config.hours,
    ...extra,
  };
}

function normalizeTargetDates(values, config) {
  const unique = [...new Set(values.map((value) => String(value || "").trim()))].sort();
  if (!unique.length) throw new Error("至少选择一个日期。");
  if (unique.length > 31) throw new Error("一次最多处理 31 个日期。");
  unique.forEach(validateDate);
  if (unique.some((date) => date > todayIso())) throw new Error("不能填报未来日期的工时。");
  const restDays = unique.filter((date) => !isWorkday(date, config));
  const workdays = unique.filter((date) => isWorkday(date, config));
  if (restDays.length) {
    console.log(`已自动跳过休息日：${restDays.join("、")}`);
    log.info("fill", "rest.skipped", `已自动跳过休息日：${restDays.join("、")}`, { dates: restDays });
  }
  if (!workdays.length) throw new Error("所选日期都是休息日（含未调整的周末），无需填报。");
  return workdays;
}

function resolveCatalogSelections(config) {
  if (!fs.existsSync(WORK_TYPES_PATH)) throw new Error("请先同步工作类型：工时助手.cmd work-types");
  const catalog = JSON.parse(fs.readFileSync(WORK_TYPES_PATH, "utf8"));
  const workTypes = Array.isArray(catalog.workTypes) ? catalog.workTypes : [];
  if (!accountsMatch(config.account, catalog.account) || !workTypes.length || workTypes.length < Number(catalog.sourceTotal || 0)) {
    throw new Error("当前账户的工作类型缓存不可用，请先运行：工时助手.cmd work-types");
  }
  const workType = workTypes.find((item) => item.code === config.workType.code && item.name === config.workType.name);
  if (!workType) throw new Error("所选工作类型不在当前 OA 列表中，请重新选择。");
  if (isLeaveWorkType(workType)) return withoutLeaveProject({ ...config, workType });
  const project = resolveSelectedProject(config);
  return { ...config, workType, projectId: project.id, projectCode: project.code, projectName: project.name || "" };
}

async function resolveProjectFromOa(config) {
  if (isLeaveWorkType(config.workType)) return withoutLeaveProject(config);
  if (headed) return config;
  let api;
  try {
    api = await createOaApi(config);
    const account = await verifyApiSession(api);
    const { rows } = await searchCatalogApi(api, "projects", config.projectCode, { pageSize: 20 });
    const matches = normalizeProjects(rows);
    const project = matches.find((item) => projectKeysMatch(item.code, config.projectCode) || projectKeysMatch(item.id, config.projectId))
      || matches.find((item) => projectKeysMatch(item.name, config.projectCode));
    if (!project) {
      if (config.projectId && config.projectName) {
        log.warn("fill", "project.search.miss", "OA 按项目号未搜到，沿用已选项目", {
          projectCode: config.projectCode, projectId: config.projectId,
        });
        return config;
      }
      throw new Error("OA 中没有找到所选项目号，请重新搜索选择。");
    }
    syncAccount(account);
    return { ...config, projectId: project.id, projectCode: project.code, projectName: project.name || config.projectName };
  } catch (error) {
    if (error instanceof ApiUnavailable) {
      log.warn("fill", "project.search.fallback", "OA 项目搜索接口暂不可用，改用已选项目", {
        projectCode: config.projectCode,
      });
      return config;
    }
    throw error;
  } finally {
    await api?.dispose();
  }
}

async function runWorktimes(config, submit, requestedDates, options = {}) {
  config = resolveCatalogSelections(config);
  config = await resolveProjectFromOa(config);
  validateSettings(config);
  const dates = normalizeTargetDates(requestedDates, config);
  const eligible = new Set(dates);
  for (const date of new Set(requestedDates)) if (!eligible.has(date)) emitProgress(date, "skipped");
  if (submit && !confirmed) {
    throw new Error("实际提交必须在命令末尾加 --yes。可先运行 preview 预演。");
  }

  const context = await launch(config, headed);
  const submitted = [];
  const result = { requestedDates: dates, skippedDates: [], processedDates: [], submittedDates: [] };
  let currentDate = null;
  const batchStarted = Date.now();
  log.info("fill", submit ? "submit.start" : "preview.start", `${submit ? "开始提交" : "开始预演"} ${dates.length} 天`, fillContext(config, {
    dates, fast: Boolean(options.fast), headed,
  }));
  try {
    let formPage = context.pages()[0] || (await context.newPage());
    let records = readExportedRecords();
    if (!options.fast) {
      records = mergePendingRecords(await collectDoneRecords(formPage, config), records);
      exportDoneRecords(records);
    }
    const existingByDate = new Map(records.map((record) => [record.workDate, record]));
    const pendingDates = dates.filter((date) => {
      const existing = existingByDate.get(date);
      if (existing) {
        emitProgress(date, "skipped");
        result.skippedDates.push(date);
        console.log(`已存在 ${date} 的工时：${existing.documentNo || existing.requestId || "已办"}，已跳过。`);
        log.info("fill", "day.skipped", `已存在 ${date} 的工时，已跳过`, fillContext(config, {
          date, documentNo: existing.documentNo || "", requestId: existing.requestId || "",
        }));
        return false;
      }
      return true;
    });
    if (!pendingDates.length) {
      console.log("所选日期均已填报，没有执行提交。");
      log.info("fill", submit ? "submit.none" : "preview.none", "所选日期均已填报，没有执行提交", fillContext(config, {
        skippedDates: result.skippedDates,
      }));
      return result;
    }

    for await (const { page, dateText, index, preloaded } of iterateWorktimeForms(context, formPage, config, pendingDates, {
      submit, preload: options.preload,
    })) {
      currentDate = dateText;
      formPage = page;
      const dayStarted = Date.now();
      log.info("fill", "day.prepare", `开始核对 ${dateText}`, fillContext(config, {
        date: dateText, index: index + 1, total: pendingDates.length,
      }));
      const values = await prepareForm(formPage, config, dateText, { preloaded, onStage: (stage) => emitProgress(dateText, stage) });
      console.log(
        `[${index + 1}/${pendingDates.length}] 核对通过：${values.date} / ${config.workType.name} / ${config.projectCode} / ${values.hours} 小时。`,
      );
      result.processedDates.push(dateText);
      log.info("fill", submit ? "day.checked" : "preview.day.ok", `核对通过：${dateText}`, fillContext(config, {
        date: dateText, index: index + 1, total: pendingDates.length,
      }), { durationMs: Date.now() - dayStarted });
      if (!submit) { emitProgress(dateText, "preview_passed"); continue; }

      const submitStarted = Date.now();
      emitProgress(dateText, "submitting");
      log.info("fill", "day.submit.start", `开始提交 ${dateText}`, fillContext(config, {
        date: dateText, index: index + 1, total: pendingDates.length,
      }));
      const submission = await submitPreparedForm(formPage);
      const record = createOptimisticRecord(dateText, submission, values.account?.name);
      mergeExportedRecord(record);
      submitted.push(record);
      result.submittedDates.push(dateText);
      emitProgress(dateText, "submitted_pending");
      console.log(`[${index + 1}/${pendingDates.length}] 已提交：${dateText}${record.documentNo ? ` / ${record.documentNo}` : ""}`);
      log.info("fill", "submit.day.ok", `已提交 ${dateText}`, fillContext(config, {
        date: dateText, documentNo: record.documentNo || "", requestId: record.requestId || "",
        index: index + 1, total: pendingDates.length,
      }), { durationMs: Date.now() - submitStarted });
    }

    if (submit) {
      console.log(`批量提交完成：成功 ${submitted.length} 天。最新状态正在后台自动同步。`);
      log.info("fill", "submit.done", `批量提交完成：成功 ${submitted.length} 天`, fillContext(config, {
        submittedDates: result.submittedDates, skippedDates: result.skippedDates,
      }), { durationMs: Date.now() - batchStarted });
    } else {
      console.log(`批量预演完成：${pendingDates.length} 天核对通过，没有保存或提交任何数据。`);
      log.info("fill", "preview.done", `批量预演完成：${pendingDates.length} 天核对通过`, fillContext(config, {
        processedDates: result.processedDates, skippedDates: result.skippedDates,
      }), { durationMs: Date.now() - batchStarted });
    }
    return result;
  } catch (error) {
    if (currentDate) emitProgress(currentDate, "failed", error.message);
    console.log(`WORKTIME_RESULT:${JSON.stringify(result)}`);
    log.logError("fill", submit ? "submit.fail" : "preview.fail", error, error.message, fillContext(config, {
      date: currentDate,
      processedDates: result.processedDates,
      submittedDates: result.submittedDates,
      skippedDates: result.skippedDates,
      remainingCount: dates.length - result.skippedDates.length - result.processedDates.length,
    }), { durationMs: Date.now() - batchStarted });
    if (submitted.length) {
      throw new Error(`${error.message}\n已成功提交 ${submitted.length} 天，已写入本地记录；失败日期及其后日期未继续处理。`);
    }
    throw error;
  } finally {
    if (submitted.length) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await context.close();
  }
}

async function runWorktime(config, submit) {
  return runWorktimes(config, submit, [targetDate]);
}

function printHelp() {
  console.log(`
工时助手

  工时助手.cmd login
      首次使用或登录失效时，用脚本自己的窗口扫码登录。

  网页内扫码登录由工时台自动调用，二维码只保存在本机临时目录。

  工时助手.cmd list
      获取全部已办工时并导出“已办工时.csv”。
  工时助手.cmd projects
      从当前 OA 账户同步全部可选项目号及项目名称到本机缓存。
  工时助手.cmd work-types
      从当前 OA 账户同步可选工作类型到本机缓存。

  工时助手.cmd preview 2026-08-06
      后台填写并核对表单，但绝不保存或提交。

  工时助手.cmd submit 2026-08-06 --yes
      检查重复后实际提交一次。

  批量模式由本地工时面板调用：同一次登录会话可连续处理多个日期。
  提交后不等待 OA 成功页，本地先记为已提交，再由同步确认结果。

可选参数：--headed（显示脚本自己的浏览器窗口，用于排查问题）
`);
}

async function selfTest() {
  if (isWeekend("2026-08-06")) throw new Error("工作日判断失败。");
  if (!isWeekend("2026-08-08") || !isWeekend("2026-08-09")) {
    throw new Error("周末判断失败。");
  }
  const record = parseDoneRecord({
    title: "工时填报-测试用户（单据编号:GSTB-20260903-001, 提交人:测试用户, 工时日期:2026-08-05）",
    onclick: "openSPA4Single('/main/workflow/req?requestid=123456',123456,0)",
    row: "工时填报 测试用户 2026-09-03 17:27:02 2-归档",
  });
  if (record.workDate !== "2026-08-05" || record.requestId !== "123456") {
    throw new Error("已办记录解析失败。");
  }
  console.log("自检通过。");
}

async function main() {
  const payload = readPayload();
  const config = applyOverrides(loadConfig(), payload);
  log.info("lifecycle", "assistant.main", `执行命令 ${command}`, {
    command, headed, confirmed, dates: payload.dates || (targetDate ? [targetDate] : undefined),
  });
  if (command === "login") return runLogin(config);
  if (command === "login-qr") return runQrLogin(config);
  if (command === "session-check") return runSessionCheck(config);
  if (command === "list") return runList(config);
  if (command === "projects") return runProjects(config);
  if (command === "work-types") return runWorkTypes(config);
  if (command === "startup-sync") return runStartupSync(config);
  if (command === "preview") return runWorktime(config, false);
  if (command === "submit") return runWorktime(config, true);
  if (command === "batch-preview") {
    return runWorktimes(config, false, payload.dates || [], { fast: Boolean(payload.fast) });
  }
  if (command === "batch-submit") {
    return runWorktimes(config, true, payload.dates || [], { fast: Boolean(payload.fast) });
  }
  if (command === "self-test") return selfTest();
  printHelp();
}

if (require.main === module) {
  log.configureLogger({ proc: "assistant", cmd: command });
  log.installProcessHandlers();
  main().then((result) => {
    if (result?.requestedDates) console.log(`WORKTIME_RESULT:${JSON.stringify(result)}`);
  }).catch((error) => {
    const channel = log.channelForCommand(command);
    if (error.message === "LOGIN_REQUIRED") {
      writeLoginStatus({ state: "error", reason: "expired", message: "OA 登录已过期，请重新扫码登录。" });
      console.error("脚本登录态已失效，请先运行：工时助手.cmd login");
    } else if (error.code === "ACCOUNT_MISMATCH") {
      writeLoginStatus({ state: "error", reason: "account", message: error.message });
      log.logError("session", "login.account_mismatch", error, error.message, { command });
      console.error(error.message);
    } else {
      if (command === "session-check") writeLoginStatus({ state: "unavailable", message: "暂时无法验证 OA 登录，请检查网络后重试。" });
      if (!/已成功提交 \d+ 天/.test(error.message)) {
        log.logError(channel, command.includes("submit") ? "submit.fail" : "command.fail", error, error.message, { command });
      }
      console.error(`失败：${error.message}`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  iterateWorktimeForms,
  createUrls,
  waitForQrLogin, tryFinalizeQrLogin,
  parseDoneRecord, validateDate, normalizeTargetDates, validateSettings,
  normalizeWorkTypes, normalizeProjects, projectPageUrl, matchesBrowserResponse,
  collectBrowserRows, collectDoneRecords, prepareForm, submitPreparedForm,
  resolveCatalogSelections, clearLeaveProject, runWorktimes,
};
