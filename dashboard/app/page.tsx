"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WorktimeRecord = {
  workDate: string;
  documentNo: string;
  requestId: string;
  operationTime: string;
  status: string;
  title: string;
};

type ProjectOption = { id: string; code: string; name: string };
type ProjectCatalog = { count: number; sourceTotal: number; fetchedAt: string | null };
type WorkTypeOption = { code: string; name: string };
type WorkTypeCatalog = { count: number; sourceTotal: number; fetchedAt: string | null };
type UpdateStatus = {
  status: "idle" | "not_configured" | "checking" | "up_to_date" | "available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string; latestVersion: string | null; repository: string; canInstall: boolean;
  releaseNotes: string; percent: number; error: string | null;
  lastInstall: { success: boolean; version: string; error: string | null } | null;
};

type BatchProgress = {
  runId: string;
  mode: "preview" | "submit";
  status: "running" | "completed" | "failed" | "timed_out";
  total: number;
  completed: number;
  percent: number;
  currentDate: string | null;
  stage: string;
  startedAt: string;
  error: string | null;
  days: { date: string; status: string; error: string | null }[];
};

type DashboardData = {
  workdayOverrides?: Record<string, "work" | "rest">;
  account: {
    oaUserId?: string;
    name?: string;
    employeeNo?: string;
    department?: string;
    organization?: string;
  };
  defaults: {
    workType: { name: string; code: string };
    projectCode: string;
    projectId: string;
    projectName: string;
    hours: string;
    remark: string;
    skipWeekends: boolean;
  };
  workTypes: WorkTypeOption[];
  workTypeCatalog: WorkTypeCatalog;
  session: {
    connected: boolean;
    state?: LoginStatus["state"];
    lastSyncedAt: string | null;
    busy: string | null;
  };
  projectCatalog: ProjectCatalog;
  records: WorktimeRecord[];
  batchProgress?: BatchProgress | null;
  previousBatchProgress?: BatchProgress | null;
  update?: UpdateStatus;
};

type FormSettings = {
  workTypeName: string;
  workTypeCode: string;
  projectCode: string;
  projectId: string;
  projectName: string;
  hours: string;
  remark: string;
};

type LoginStatus = {
  state: "idle" | "verifying" | "unavailable" | "checking" | "waiting" | "confirming" | "connected" | "error" | "cancelled";
  reason?: "expired" | "account";
  message: string;
  updatedAt?: string | null;
  qrVersion?: number;
  account?: DashboardData["account"];
};

type CalendarDay = { date: Date; iso: string; inMonth: boolean };

const API_BASE =
  typeof window !== "undefined" && window.location.port !== "3000"
    ? window.location.origin
    : "http://127.0.0.1:3088";
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toIso(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function parseMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function shiftMonth(value: string, amount: number) {
  const current = parseMonth(value);
  return monthKey(new Date(current.getFullYear(), current.getMonth() + amount, 1));
}

function monthLabel(value: string) {
  const date = parseMonth(value);
  return `${date.getFullYear()}年 ${date.getMonth() + 1}月`;
}

function isWeekend(date: Date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function isWorkday(date: Date, data: DashboardData) {
  const override = data.workdayOverrides?.[toIso(date)];
  if (override === "work") return true;
  if (override === "rest") return false;
  return data.defaults.skipWeekends === false || !isWeekend(date);
}

function daysInMonth(value: string) {
  const month = parseMonth(value);
  return new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
}

function getCalendarDays(value: string): CalendarDay[] {
  const month = parseMonth(value);
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(month.getFullYear(), month.getMonth(), index - mondayOffset + 1);
    return { date, iso: toIso(date), inMonth: date.getMonth() === month.getMonth() };
  });
}

function monthWorkdays(value: string, data: DashboardData, through?: string) {
  const month = parseMonth(value);
  const result: string[] = [];
  for (let day = 1; day <= daysInMonth(value); day += 1) {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    const iso = toIso(date);
    if (isWorkday(date, data) && (!through || iso <= through)) result.push(iso);
  }
  return result;
}

function shortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function formatSyncTime(value: string | null) {
  if (!value) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function greeting(hour: number) {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function friendlyName(name?: string) {
  if (!name) return "你";
  return name.length > 2 ? name.slice(-2) : name;
}

async function api<T>(pathname: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "操作失败，请稍后重试。");
  return payload;
}

function WorkTypeSelect({
  label,
  code,
  name,
  options,
  catalog,
  disabled,
  refreshDisabled,
  refreshing,
  onChange,
  onRefresh,
}: {
  label: string;
  code: string;
  name: string;
  options: WorkTypeOption[];
  catalog: WorkTypeCatalog;
  disabled: boolean;
  refreshDisabled: boolean;
  refreshing: boolean;
  onChange: (workType: WorkTypeOption) => void;
  onRefresh: () => void;
}) {
  const choices = options;
  const selectedCode = choices.some((option) => option.code === code) ? code : "";

  return (
    <div className="work-type-field">
      <div className="field-label-row">
        <span>{label}</span>
        <button type="button" onClick={onRefresh} disabled={disabled || refreshDisabled || refreshing} title="从当前 OA 账户重新同步">
          {refreshing ? "同步中…" : catalog.count ? `更新 · ${catalog.count} 种` : "同步 OA 选项"}
        </button>
      </div>
      <select
        aria-label={label}
        value={selectedCode}
        disabled={disabled || !choices.length}
        onChange={(event) => {
          const selected = choices.find((option) => option.code === event.target.value);
          if (selected) onChange(selected);
        }}
      >
        {!selectedCode && <option value="" disabled>{choices.length ? `请重新选择（原：${name || "未选择"}）` : `等待同步工作类型${name ? `（原：${name}）` : ""}`}</option>}
        {choices.map((option) => <option key={option.code} value={option.code}>{option.name}（{option.code}）</option>)}
      </select>
    </div>
  );
}

function ProjectPicker({
  id,
  code,
  name,
  catalog,
  disabled,
  refreshDisabled,
  refreshing,
  onChange,
  onRefresh,
}: {
  id: string;
  code: string;
  name: string;
  catalog: ProjectCatalog;
  disabled: boolean;
  refreshDisabled: boolean;
  refreshing: boolean;
  onChange: (project: ProjectOption) => void;
  onRefresh: () => void;
}) {
  const query = code;
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api<{ catalog: ProjectCatalog; projects: ProjectOption[] }>(
          `/api/projects?query=${encodeURIComponent(query.trim())}&limit=40`,
        );
        if (cancelled) return;
        setProjects(result.projects);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [catalog.fetchedAt, query]);

  function choose(project: ProjectOption) {
    onChange(project);
    setOpen(false);
  }

  return (
    <div className="project-field full-field">
      <div className="field-label-row">
        <span>项目号 / 项目名称</span>
        <button type="button" onClick={onRefresh} disabled={disabled || refreshDisabled || refreshing} title="可选：把全部项目缓存到本机，断网时仍能按名称搜索">
          {refreshing ? "同步中…" : catalog.count ? `缓存项目库 · ${catalog.count}` : "缓存全部项目库"}
        </button>
      </div>
      <div className="project-picker">
        <input
          className="mono-input"
          value={query}
          disabled={disabled}
          autoComplete="off"
          placeholder="输入项目号，按 OA 实时搜索"
          role="combobox"
          aria-label="项目号 / 项目名称"
          aria-expanded={open}
          aria-controls={id}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 140)}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ id: "", code: value, name: "" });
            setOpen(true);
          }}
        />
        <span className="project-search-state">{loading ? "搜索中" : "⌕"}</span>
        {open && (
          <div className="project-results" id={id} role="listbox">
            {projects.map((project) => (
              <button type="button" role="option" aria-selected={project.code === code && project.name === name} key={`${project.id}-${project.code}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(project)}>
                <strong>{project.code}</strong><span>{project.name || "未命名项目"}</span>
              </button>
            ))}
            {!loading && !projects.length && (
              <p>{query.trim() ? "OA 没有匹配的项目号，可再试名称关键词或缓存项目库" : "输入项目号后显示 OA 搜索结果"}</p>
            )}
          </div>
        )}
      </div>
      <small className={name ? "project-selected" : "project-selection-hint"}>
        {name ? `已选择：${name}` : "从实时搜索结果中点选一个项目，无需先同步全部项目库"}
      </small>
    </div>
  );
}

function defaultsToSettings(data: DashboardData): FormSettings {
  const leave = data.defaults.workType.code === "004" && data.defaults.workType.name === "休假";
  return {
    workTypeName: data.defaults.workType.name,
    workTypeCode: data.defaults.workType.code,
    projectCode: leave ? "" : data.defaults.projectCode,
    projectId: leave ? "" : data.defaults.projectId || data.defaults.projectCode,
    projectName: leave ? "" : data.defaults.projectName || "",
    hours: data.defaults.hours,
    remark: data.defaults.remark,
  };
}

const batchStageLabels: Record<string, string> = {
  starting: "准备处理", waiting: "等待处理", loading: "加载表单", checking: "核对字段",
  submitting: "发起提交", preview_passed: "预演通过", skipped: "跳过",
  submitted_pending: "已发起·待确认", confirmed: "OA 已确认", failed: "失败",
  unknown: "结果待核对", unprocessed: "未处理", finished: "处理结束", stopped: "处理已停止",
};

function BatchProgressPanel({ batch }: { batch: BatchProgress }) {
  const currentIndex = batch.days.findIndex((day) => day.date === batch.currentDate);
  const active = batch.status === "running";
  return (
    <article className="panel batch-progress-panel" aria-label="批量处理进度">
      <div className="panel-header compact"><div><p className="section-kicker">批量{batch.mode === "preview" ? "预演" : "提交"}进度</p>
        <h3>{active ? currentIndex >= 0 ? `正在处理第 ${currentIndex + 1}／${batch.total} 天` : "正在准备处理" : batch.status === "completed" ? "本批次处理结束" : batch.status === "timed_out" ? "本批次处理超时" : "本批次已停止"}</h3>
      </div><b>{batch.percent}%</b></div>
      <div className="batch-progress-track" role="progressbar" aria-label="已处理日期比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={batch.percent}><i style={{ width: `${batch.percent}%` }} /></div>
      <p className="batch-progress-meta" role="status">已处理 {batch.completed}／{batch.total} 天{active && batch.currentDate ? ` · ${batch.currentDate} · ${batchStageLabels[batch.stage] || batch.stage}` : ""}</p>
      <p className="batch-progress-note">进度表示日期处理情况；“已发起·待确认”需同步已办后核对。</p>
      {batch.error && <p className="batch-progress-error" role="alert">{batch.error}</p>}
      <ol className="batch-progress-days">{batch.days.map((day) => <li key={day.date} className={`batch-day-${day.status}`}>
        <time>{day.date}</time><span>{batchStageLabels[day.status] || day.status}</span>{day.error && <small>{day.error}</small>}
      </li>)}</ol>
    </article>
  );
}

function accountIdentity(account: DashboardData["account"]) {
  if (account.oaUserId) return `oa:${account.oaUserId.trim()}`;
  if (account.employeeNo) return `employee:${account.employeeNo.trim()}`;
  return account.name ? `name:${account.name}|${account.organization || ""}` : "";
}

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<FormSettings | null>(null);
  const [defaultDraft, setDefaultDraft] = useState<FormSettings | null>(null);
  const previousProjectRef = useRef<Pick<FormSettings, "projectCode" | "projectId" | "projectName"> | null>(null);
  const draftProjectRef = useRef<Pick<FormSettings, "projectCode" | "projectId" | "projectName"> | null>(null);
  const accountRef = useRef<string | null>(null);
  const loginAttemptedRef = useRef(false);
  const loginStartingRef = useRef(false);
  const loginInProgressRef = useRef(false);
  const loginAlertRef = useRef<string | null>(null);
  const dashboardRef = useRef<DashboardData | null>(null);
  const dashboardVersionRef = useRef(0);
  const dashboardRequestRef = useRef(0);
  const syncAttemptsRef = useRef({ workTypes: false, projects: false });
  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [inspectedDate, setInspectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [serviceOffline, setServiceOffline] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarEditing, setCalendarEditing] = useState(false);
  const [adjustmentDates, setAdjustmentDates] = useState<string[]>([]);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [projectRefreshing, setProjectRefreshing] = useState(false);
  const [workTypeRefreshing, setWorkTypeRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const [updateConfirming, setUpdateConfirming] = useState(false);
  const updateRequestRef = useRef(false);
  const installing = data?.update?.status === "installing";
  const [now, setNow] = useState(() => new Date());

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const thisMonth = today.slice(0, 7);
  const currentHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(now));
  const previousMonth = shiftMonth(thisMonth, -1);

  function applyDashboard(dashboard: DashboardData) {
    dashboardVersionRef.current += 1;
    const account = accountIdentity(dashboard.account);
    if (accountRef.current !== null && accountRef.current !== account) {
      previousProjectRef.current = null;
      draftProjectRef.current = null;
      syncAttemptsRef.current = { workTypes: false, projects: false };
      setSettings(defaultsToSettings(dashboard));
      setSelectedDates([]);
      setInspectedDate("");
      setConfirming(false);
      setSettingsOpen(false);
      setCalendarEditing(false);
      setAdjustmentDates([]);
      setDefaultDraft(null);
    }
    accountRef.current = account;
    dashboardRef.current = dashboard;
    setData(dashboard);
    setSettings((current) => {
      if (!current) return defaultsToSettings(dashboard);
      if (!(current.workTypeCode === "004" && current.workTypeName === "休假") && !current.projectName && dashboard.defaults.projectName && current.projectCode === dashboard.defaults.projectCode) {
        return { ...current, projectId: dashboard.defaults.projectId, projectName: dashboard.defaults.projectName };
      }
      return current;
    });
    const filled = new Set(dashboard.records.map((record) => record.workDate));
    setSelectedDates((current) => current.filter((date) => !filled.has(date) && isWorkday(new Date(`${date}T00:00:00`), dashboard)));
  }

  async function loadDashboard(initial = false) {
    const version = dashboardVersionRef.current;
    const request = ++dashboardRequestRef.current;
    const isCurrent = () => version === dashboardVersionRef.current && request === dashboardRequestRef.current;
    try {
      const dashboard = await api<DashboardData>("/api/dashboard");
      // A delayed poll must not undo a completed save or a newer response.
      if (!isCurrent()) return;
      applyDashboard(dashboard);
      setServiceOffline(false);
      setSelectedMonth((current) => current || thisMonth);
      if (initial) setError(null);
      if (dashboard.session.connected && !dashboard.session.busy) {
        if ((!dashboard.workTypeCatalog.count || dashboard.workTypeCatalog.count < dashboard.workTypeCatalog.sourceTotal) && !syncAttemptsRef.current.workTypes) {
          syncAttemptsRef.current.workTypes = true;
          void refreshWorkTypes();
        }
      }
    } catch (caught) {
      if (!isCurrent()) return;
      setServiceOffline(true);
      if (initial) setError(caught instanceof Error ? caught.message : "无法连接本地工时服务。");
    } finally {
      if (initial) setLoading(false);
    }
  }

  async function loadLoginStatus() {
    try {
      const status = await api<LoginStatus>("/api/login/status");
      if (loginStartingRef.current) return;
      setLoginStatus(status);
      if (status.state === "error" && status.reason && loginAlertRef.current !== (status.updatedAt || status.reason)) {
        loginAlertRef.current = status.updatedAt || status.reason;
        setLoginOpen(true);
        setConfirming(false);
        void loadDashboard(false);
      }
      if (status.state === "waiting" || status.state === "checking" || status.state === "confirming") {
        loginInProgressRef.current = true;
        setLoginInProgress(true);
        setLoginOpen(true);
      } else if (status.state === "connected" && loginInProgressRef.current) {
        loginInProgressRef.current = false;
        setLoginInProgress(false);
        setLoginOpen(false);
        setToast(`${status.message || "钉钉扫码登录成功。"}\n正在自动同步已办工时…`);
        void loadDashboard(false);
      } else if (status.state === "error" || status.state === "cancelled" || status.state === "idle" || status.state === "unavailable") {
        loginInProgressRef.current = false;
        setLoginInProgress(false);
      }
      if (status.state === "idle" && dashboardRef.current && !dashboardRef.current.session.connected && !loginAttemptedRef.current) {
        loginAttemptedRef.current = true;
        void startLogin(false);
      }
    } catch {
      // Dashboard connectivity is reported by the main status banner.
    }
  }

  async function checkLoginSession() {
    try {
      await api<LoginStatus>("/api/session/check", { method: "POST", body: "{}" });
      await loadLoginStatus();
      await loadDashboard(false);
    } catch {
      // The dashboard poll reports a local service outage.
    }
  }

  useEffect(() => {
    // The first load updates state only after the API promise resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDashboard(true);
    void loadLoginStatus();
    void checkLoginSession();
    const clock = window.setInterval(() => setNow(new Date()), 60_000);
    const live = window.setInterval(() => void loadDashboard(false), 3_000);
    const loginPoll = window.setInterval(() => void loadLoginStatus(), 1_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(live);
      window.clearInterval(loginPoll);
    };
    // The live refresh intentionally keeps the user's month and form edits intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const recordsByDate = useMemo(
    () => new Map((data?.records || []).map((record) => [record.workDate, record])),
    [data?.records],
  );
  const calendarDays = useMemo(
    () => (selectedMonth ? getCalendarDays(selectedMonth) : []),
    [selectedMonth],
  );
  const selectedMonthRecords = useMemo(
    () => (data?.records || []).filter((record) => record.workDate.startsWith(selectedMonth)),
    [data?.records, selectedMonth],
  );
  const missingDates = useMemo(() => {
    if (!data || !selectedMonth || selectedMonth > thisMonth) return [];
    const through = selectedMonth === thisMonth ? today : undefined;
    return monthWorkdays(selectedMonth, data, through).filter((date) => !recordsByDate.has(date));
  }, [data, recordsByDate, selectedMonth, thisMonth, today]);

  const thisMonthFilled = data ? monthWorkdays(thisMonth, data, today).filter((date) => recordsByDate.has(date)).length : 0;
  const previousMonthFilled = data ? monthWorkdays(previousMonth, data).filter((date) => recordsByDate.has(date)).length : 0;
  const selectedMonthFilled = data && selectedMonth ? monthWorkdays(selectedMonth, data).filter((date) => recordsByDate.has(date)).length : 0;
  const thisMonthElapsed = data ? monthWorkdays(thisMonth, data, today).length : 0;
  const previousMonthTotal = data ? monthWorkdays(previousMonth, data).length : 0;
  const selectedMonthTotal = data && selectedMonth ? monthWorkdays(selectedMonth, data).length : 0;
  const inspectedRecord = inspectedDate ? recordsByDate.get(inspectedDate) : undefined;
  const selectedSet = useMemo(() => new Set(selectedDates), [selectedDates]);
  const allMissingSelected = missingDates.length > 0 && missingDates.every((date) => selectedSet.has(date));

  function changeMonth(value: string) {
    if (installing || action || confirming) return;
    setSelectedMonth(value);
    setSelectedDates([]);
    setAdjustmentDates([]);
    setInspectedDate("");
  }

  function toggleCalendarEditing() {
    if (installing || action || confirming || !data?.account.name) return;
    setCalendarEditing((current) => !current);
    setAdjustmentDates([]);
    setSelectedDates([]);
    setInspectedDate("");
  }

  async function saveCalendar(mode: "work" | "rest" | "default") {
    if (!data?.account.name || !adjustmentDates.length || installing || action || data.session.busy || serviceOffline) return;
    setAction("calendar");
    setError(null);
    try {
      const result = await api<{ message: string; dashboard: DashboardData }>("/api/calendar", {
        method: "POST", body: JSON.stringify({ dates: adjustmentDates, mode, account: data.account }),
      });
      applyDashboard(result.dashboard);
      setAdjustmentDates([]);
      setToast(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "调整失败，请重试。");
    } finally {
      setAction(null);
    }
  }

  function toggleDate(date: string) {
    if (installing || action || confirming) return;
    setInspectedDate("");
    setSelectedDates((current) =>
      current.includes(date) ? current.filter((item) => item !== date) : [...current, date].sort(),
    );
  }

  function toggleAllMissing() {
    if (installing || action || confirming) return;
    setInspectedDate("");
    setSelectedDates(allMissingSelected ? [] : missingDates);
  }

  function validateSettings(settingsToValidate = settings) {
    const settings = settingsToValidate;
    if (!settings?.workTypeName.trim() || !settings.workTypeCode.trim()) return "请从下拉框选择工作类型。";
    if (
      data?.workTypeCatalog.count &&
      !data.workTypes.some((workType) => workType.code === settings.workTypeCode && workType.name === settings.workTypeName)
    ) return "请从当前 OA 工作类型中重新选择。";
    if (!isLeaveSettings(settings)) {
      if (!settings.projectCode.trim()) return "请填写项目号。";
      if (!settings.projectId.trim() || !settings.projectName.trim()) return "请从项目搜索结果中选择项目号。";
    }
    const hours = Number(settings.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return "工时必须大于 0 且不超过 24 小时。";
    if (settings.remark.length > 500) return "备注不能超过 500 个字。";
    return "";
  }

  function validateForm() {
    if (!selectedDates.length) return "请先选择至少一个待补日期。";
    if (!data?.workTypeCatalog.count || data.workTypeCatalog.count < data.workTypeCatalog.sourceTotal) return "请先同步当前 OA 工作类型。";
    return validateSettings();
  }

  function settingsPayload(settingsToSend = settings) {
    const settings = settingsToSend;
    const leave = isLeaveSettings(settings);
    return {
      workType: { name: settings?.workTypeName, code: settings?.workTypeCode },
      projectCode: leave ? "" : settings?.projectCode,
      projectId: leave ? "" : settings?.projectId,
      projectName: leave ? "" : settings?.projectName,
      hours: settings?.hours,
      remark: settings?.remark,
    };
  }

  function isLeaveSettings(value: FormSettings | null) {
    return Boolean(value?.workTypeCode === "004" && value.workTypeName === "休假" &&
      data?.workTypes.some((option) => option.code === "004" && option.name === "休假"));
  }

  function changeWorkType(workType: WorkTypeOption, draft = false) {
    const current = draft ? defaultDraft : settings;
    if (!current) return;
    const memory = draft ? draftProjectRef : previousProjectRef;
    const leave = workType.code === "004" && workType.name === "休假";
    const emptyProject = { projectCode: "", projectId: "", projectName: "" };
    if (leave && !isLeaveSettings(current)) memory.current = {
      projectCode: current.projectCode, projectId: current.projectId, projectName: current.projectName,
    };
    const project = leave ? emptyProject : isLeaveSettings(current) ? memory.current || emptyProject : {
      projectCode: current.projectCode, projectId: current.projectId, projectName: current.projectName,
    };
    const next = { ...current, workTypeName: workType.name, workTypeCode: workType.code, ...project };
    if (draft) setDefaultDraft(next); else setSettings(next);
    setError(null);
  }

  async function startLogin(force: boolean) {
    if (loginStartingRef.current || dashboardRef.current?.update?.status === "installing") return;
    loginStartingRef.current = true;
    loginAttemptedRef.current = true;
    loginInProgressRef.current = true;
    setLoginOpen(true);
    setLoginInProgress(true);
    setLoginStatus({ state: "checking", message: force ? "正在准备切换 OA 账户…" : "正在准备钉钉二维码…" });
    try {
      const status = await api<LoginStatus>("/api/login/start", {
        method: "POST",
        body: JSON.stringify({ force }),
      });
      setLoginStatus(status);
    } catch (caught) {
      loginInProgressRef.current = false;
      setLoginInProgress(false);
      setLoginStatus({ state: "error", message: caught instanceof Error ? caught.message : "无法开始登录。" });
    } finally {
      loginStartingRef.current = false;
    }
  }

  async function cancelLogin() {
    try {
      setLoginStatus(await api<LoginStatus>("/api/login/cancel", { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消登录失败，请重试。");
    } finally {
      loginInProgressRef.current = false;
      setLoginInProgress(false);
      setLoginOpen(false);
    }
  }

  async function refreshProjects() {
    if (projectRefreshing || installing) return;
    setProjectRefreshing(true);
    setError(null);
    try {
      const result = await api<{
        message: string;
        catalog: ProjectCatalog;
        projects: ProjectOption[];
        dashboard: DashboardData;
      }>("/api/projects/refresh", {
        method: "POST",
        body: JSON.stringify({ query: settings?.projectCode || "", limit: 40 }),
      });
      applyDashboard(result.dashboard);
      setSettings((current) => {
        if (!current) return defaultsToSettings(result.dashboard);
        const selected = result.projects.find((project) => project.code === current.projectCode);
        return selected ? { ...current, projectId: selected.id, projectName: selected.name } : current;
      });
      setToast(`项目库已同步：${result.catalog.count} 个项目号及名称。`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "项目库同步失败。";
      if (message.includes("正在执行")) {
        syncAttemptsRef.current.projects = false;
      } else {
        setError(message);
      }
    } finally {
      setProjectRefreshing(false);
    }
  }

  async function refreshWorkTypes() {
    if (workTypeRefreshing || installing) return;
    setWorkTypeRefreshing(true);
    setError(null);
    try {
      const result = await api<{
        message: string;
        catalog: WorkTypeCatalog;
        dashboard: DashboardData;
      }>("/api/work-types/refresh", { method: "POST", body: "{}" });
      applyDashboard(result.dashboard);
      setSettings((current) => {
        if (!current) return defaultsToSettings(result.dashboard);
        const selected = result.dashboard.workTypes.find((workType) => workType.code === current.workTypeCode)
          || result.dashboard.workTypes.find((workType) => workType.name === current.workTypeName);
        return selected
          ? { ...current, workTypeCode: selected.code, workTypeName: selected.name }
          : current;
      });
      setToast(`工作类型已同步：${result.catalog.count} 种。`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "工作类型同步失败。";
      if (message.includes("正在执行")) {
        syncAttemptsRef.current.workTypes = false;
      } else {
        setError(message);
      }
    } finally {
      setWorkTypeRefreshing(false);
    }
  }

  async function saveDefaultSettings() {
    if (installing) return;
    const validation = validateSettings(defaultDraft);
    if (validation) {
      setError(validation);
      return;
    }
    setAction("defaults");
    setError(null);
    try {
      const result = await api<{ message: string; dashboard: DashboardData }>("/api/defaults", {
        method: "POST",
        body: JSON.stringify({ settings: settingsPayload(defaultDraft), account: data?.account }),
      });
      applyDashboard(result.dashboard);
      setSettings(defaultsToSettings(result.dashboard));
      setSettingsOpen(false);
      setToast(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "默认设置保存失败。");
    } finally {
      setAction(null);
    }
  }

  async function runAction(kind: "refresh" | "preview" | "submit") {
    if (action || installing || data?.session.busy || serviceOffline) return;
    const validation = kind === "refresh" ? "" : validateForm();
    if (validation) {
      setError(validation);
      return;
    }
    setAction(kind);
    setError(null);
    if (kind === "submit") setConfirming(false);
    try {
      const body = kind === "refresh" ? undefined : JSON.stringify({
        dates: selectedDates,
        confirm: kind === "submit",
        settings: settingsPayload(),
        account: data?.account,
      });
      const result = await api<{ message: string; dashboard: DashboardData; result?: { submittedDates: string[]; skippedDates: string[] } }>(`/api/${kind}`, {
        method: "POST",
        body,
      });
      applyDashboard(result.dashboard);
      const summary = kind === "submit" && result.result
        ? `已发起 ${result.result.submittedDates.length} 天，待 OA 确认${result.result.skippedDates.length ? `；跳过已填 ${result.result.skippedDates.length} 天` : ""}，页面已更新。`
        : result.message.split("\n").at(-1) || "操作完成";
      setToast(summary);
      if (kind === "submit") {
        setConfirming(false);
        setSelectedDates([]);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "操作失败。";
      setError(kind === "preview" || kind === "submit"
        ? `${message} 失败详情已写入本机日志，可在「默认设置」中导出诊断包查看发生在哪一天。`
        : message);
      if (/登录|扫码/.test(message)) void startLogin(false);
      setConfirming(false);
      await loadDashboard(false);
    } finally {
      setAction(null);
    }
  }

  async function exportDiagnostics() {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/diagnostics`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "导出诊断包失败。" })) as { error?: string };
        throw new Error(payload.error || "导出诊断包失败。");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const headerName = response.headers.get("content-disposition")?.match(/filename="?([^"]+)"?/i)?.[1];
      link.href = url;
      link.download = headerName || `worktime-diagnostics-${today}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setToast("诊断包已导出到下载目录；不含登录会话和二维码。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导出诊断包失败。");
    } finally {
      setExporting(false);
    }
  }

  async function updateAction(kind: "check" | "download" | "install") {
    if (updateRequestRef.current || installing || serviceOffline) return;
    if (kind === "install" && (action || data?.session.busy || loginInProgress || projectRefreshing || workTypeRefreshing)) return;
    updateRequestRef.current = true;
    setUpdatePending(true);
    setError(null);
    try {
      const update = await api<UpdateStatus>(`/api/updates/${kind}`, { method: "POST", body: JSON.stringify({ confirm: kind !== "check" }) });
      if (dashboardRef.current) applyDashboard({ ...dashboardRef.current, update });
      setUpdateConfirming(false);
      if (kind === "install") { setConfirming(false); setSettingsOpen(false); setLoginOpen(false); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新操作失败。");
      await loadDashboard(false);
    } finally {
      updateRequestRef.current = false;
      setUpdatePending(false);
    }
  }

  function openDefaultSettings() {
    if (!settings) return;
    draftProjectRef.current = previousProjectRef.current ? { ...previousProjectRef.current } : null;
    setDefaultDraft({ ...settings });
    setSettingsOpen(true);
  }

  if (loading && !data) {
    return <main className="loading-page"><div className="loading-mark">时</div><p>正在整理工时记录…</p></main>;
  }

  if (!data || !settings) {
    return (
      <main className="loading-page">
        <div className="loading-mark error-mark">!</div>
        <h1>工时面板暂时无法连接</h1>
        <p>{error || "请先启动本地工时服务。"}</p>
        <button className="primary-button" onClick={() => void loadDashboard(true)}>重新连接</button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">时</div>
          <div><strong>工时台</strong><span>Workday Console</span></div>
        </div>
        <div className="topbar-actions">
          <button className="settings-button" onClick={() => setUpdatesOpen(true)}>版本与更新{data.update?.status === "available" || data.update?.status === "ready" ? " · 有新版" : ""}</button>
          <button className="settings-button" onClick={openDefaultSettings} disabled={Boolean(action || installing)}>⚙ 默认设置</button>
          <button className={`connection-pill account-login-button ${data.session.connected ? "online" : "offline"}`} onClick={() => setLoginOpen(true)}>
            <span className="status-dot" />
            {data.session.state === "verifying" || data.session.busy === "session-check" ? "正在验证登录" : data.session.busy?.startsWith("login-qr") ? "等待钉钉扫码" : data.session.busy ? "正在自动同步" : data.session.connected ? `${data.account.name || "账户"} · 已连接` : loginStatus?.reason === "expired" ? "登录已过期" : data.session.state === "unavailable" ? "暂时无法验证登录" : "点击扫码登录"}
          </button>
          <button className="secondary-button" onClick={() => void runAction("refresh")} disabled={Boolean(action || installing || data.session.busy || serviceOffline || !data.session.connected)}>
            <span className={action === "refresh" || data.session.busy ? "spin" : ""}>↻</span>
            {action === "refresh" || data.session.busy ? "同步中" : "同步已办"}
          </button>
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">工时概览 · {monthLabel(thisMonth)}</p>
          <h1>{greeting(currentHour)}，{friendlyName(data.account.name)}<span className="accent-dot">。</span></h1>
          <p>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full" }).format(now)}</p>
        </div>
        <article className="account-card">
          <div className="avatar">{data.account.name?.slice(0, 1) || "我"}</div>
          <div className="account-copy">
            <div className="account-name-row"><strong>{data.account.name || "当前账户"}</strong><span>{data.account.employeeNo}</span></div>
            <p>{data.account.department} <em className="account-source">由当前 OA 账户自动识别</em></p>
            <small>{data.account.organization}</small>
          </div>
          <div className="sync-meta"><span>当前 OA 账户 · 上次同步</span><strong>{formatSyncTime(data.session.lastSyncedAt)}</strong></div>
        </article>
      </section>

      <section className="stat-grid" aria-label="工时统计">
        <article className="stat-card featured"><div className="stat-label">当前查看</div><div className="stat-value">{selectedMonthFilled}<span> / {selectedMonthTotal}</span></div><div className="stat-foot">{monthLabel(selectedMonth)} 已填工作日</div></article>
        <article className="stat-card"><div className="stat-label">本月进度</div><div className="stat-value">{thisMonthFilled}<span> / {thisMonthElapsed}</span></div><div className="progress-track"><i style={{ width: `${thisMonthElapsed ? Math.min(100, (thisMonthFilled / thisMonthElapsed) * 100) : 0}%` }} /></div><div className="stat-foot">截至今天应填天数</div></article>
        <article className="stat-card"><div className="stat-label">上月完成</div><div className="stat-value">{previousMonthFilled}<span> / {previousMonthTotal}</span></div><div className="stat-foot">{previousMonthFilled === previousMonthTotal ? "已全部完成" : `还有 ${Math.max(0, previousMonthTotal - previousMonthFilled)} 天未填`}</div></article>
        <article className="stat-card warning"><div className="stat-label">已选择 / 待补</div><div className="stat-value">{selectedDates.length}<span> / {missingDates.length} 天</span></div><div className="stat-foot">按调整后的工作日计算</div></article>
      </section>

      {(error || serviceOffline) && <div className="error-banner" role="alert"><span>!</span><p>{installing ? "正在安装更新，服务暂时断开。完成后会重新打开工时助手。" : error || "本地工时服务连接中断，正在重新连接；当前显示的是上次读取的数据。"}</p>{error && <button onClick={() => setError(null)} aria-label="关闭提示">×</button>}</div>}
      {data.update && ["available", "downloading", "ready", "installing"].includes(data.update.status) && <div className="update-banner" role="status"><p>{installing ? "正在安装更新，完成后自动重新打开" : data.update.status === "downloading" ? `正在下载新版 · ${data.update.percent}%` : data.update.status === "ready" ? "新版已下载并校验，可安装更新" : `发现新版 ${data.update.latestVersion}`}</p><button className="text-button" onClick={() => setUpdatesOpen(true)}>查看更新</button></div>}

      <section className="workspace-grid">
        <article className="panel calendar-panel">
          <div className="panel-header">
            <div><p className="section-kicker">{calendarEditing ? "工作日安排" : "月度日历"}</p><h2>{monthLabel(selectedMonth)}</h2></div>
            <div className="calendar-actions">
              <button className="select-all-button" onClick={toggleCalendarEditing} disabled={Boolean(action || installing || confirming || !data.account.name)} aria-pressed={calendarEditing}>{calendarEditing ? "完成调整" : "调整工作日"}</button>
              {!calendarEditing && <button className="select-all-button" onClick={toggleAllMissing} disabled={!missingDates.length || Boolean(action || installing)}>{allMissingSelected ? "清空选择" : `全选待补 ${missingDates.length} 天`}</button>}
              <div className="month-controls" aria-label="切换月份">
                <button onClick={() => changeMonth(shiftMonth(selectedMonth, -1))} aria-label="上个月">←</button>
                <button className="today-button" onClick={() => changeMonth(thisMonth)}>本月</button>
                <button onClick={() => changeMonth(shiftMonth(selectedMonth, 1))} aria-label="下个月">→</button>
              </div>
            </div>
          </div>
          <div className="calendar-legend"><span><i className="legend-dot filled-dot" />已填</span><span><i className="legend-dot missing-dot" />待补</span><span><i className="legend-dot selected-dot" />已选</span><span><i className="legend-dot weekend-dot" />休息</span></div>
          <div className="calendar-grid weekdays-row">{weekdays.map((day, index) => <div className={index > 4 ? "weekend-label" : ""} key={day}>周{day}</div>)}</div>
          <div className="calendar-grid day-grid">
            {calendarDays.map(({ date, iso, inMonth }) => {
              const record = recordsByDate.get(iso);
              const rest = !isWorkday(date, data);
              const override = data.workdayOverrides?.[iso];
              const missing = inMonth && !rest && iso <= today && !record;
              const selected = calendarEditing ? adjustmentDates.includes(iso) : selectedSet.has(iso);
              const className = ["day-cell", !inMonth ? "outside" : "", rest ? "weekend" : "", record ? "filled" : "", missing ? "missing" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
              return (
                <button
                  key={iso}
                  className={className}
                  disabled={!inMonth || (!calendarEditing && ((rest && !record) || iso > today)) || Boolean(action || installing)}
                  onClick={() => calendarEditing
                    ? setAdjustmentDates((current) => current.includes(iso) ? current.filter((date) => date !== iso) : [...current, iso].sort())
                    : record ? (setInspectedDate(iso), setSelectedDates([])) : missing && toggleDate(iso)}
                  aria-pressed={selected}
                  aria-label={`${iso}${calendarEditing ? ` ${rest ? "休息" : "上班"}${selected ? " 已选择" : ""}` : record ? " 已填" : rest ? " 休息" : missing ? selected ? " 已选择" : " 待补" : ""}`}
                >
                  <span className="day-number">{date.getDate()}</span>
                  {override && inMonth && <span className="override-marker" title={override === "work" ? "手动设为上班" : "手动设为休息"}>{override === "work" ? "班" : "休"}</span>}
                  {rest && inMonth && !record && <span className="day-state">{selected ? "✓ 已选" : "休"}</span>}
                  {record && <span className="day-state">{record.status.includes("同步中") ? "待确认" : "已填"}</span>}
                  {missing && <span className="day-state">{selected ? "✓ 已选" : "待补"}</span>}
                  {calendarEditing && selected && !rest && !record && !missing && <span className="day-state">✓ 已选</span>}
                  {iso === today && <span className="today-marker">今天</span>}
                </button>
              );
            })}
          </div>
        </article>

        <aside className={`right-rail${calendarEditing ? " calendar-edit-rail" : ""}`}>
          {data.batchProgress && <BatchProgressPanel batch={data.batchProgress} />}
          {data.previousBatchProgress && <details className="previous-batch"><summary>查看上一次批次</summary><BatchProgressPanel batch={data.previousBatchProgress} /></details>}
          {calendarEditing ? <article className="panel action-panel calendar-edit-panel">
            <p className="section-kicker">调整工作日</p>
            <h2>{adjustmentDates.length ? `已选 ${adjustmentDates.length} 天` : "未选择日期"}</h2>
            <p>{data.account.name} · 个人日历</p>
            <div className="selected-date-strip">{adjustmentDates.map((date) => <button key={date} disabled={Boolean(action || installing)} onClick={() => setAdjustmentDates((current) => current.filter((item) => item !== date))}>{shortDate(date)} ×</button>)}</div>
            <div className="calendar-edit-buttons">
              <button className="primary-button" onClick={() => void saveCalendar("work")} disabled={!adjustmentDates.length || Boolean(action || installing || data.session.busy || serviceOffline)}>设为上班</button>
              <button className="secondary-button" onClick={() => void saveCalendar("rest")} disabled={!adjustmentDates.length || Boolean(action || installing || data.session.busy || serviceOffline)}>设为休息</button>
              <button className="text-button" onClick={() => void saveCalendar("default")} disabled={!adjustmentDates.length || Boolean(action || installing || data.session.busy || serviceOffline)}>恢复默认</button>
            </div>
            {action === "calendar" && <p className="safety-note" role="status">正在保存工作日安排…</p>}
          </article> : <>
          <article className="panel action-panel">
            <div className="action-title-row">
              <div><p className="section-kicker">本次填报</p><h2>{selectedDates.length ? `已选 ${selectedDates.length} 天` : inspectedRecord ? shortDate(inspectedDate) : "选择待补日期"}</h2></div>
              {selectedDates.length > 0 && <button className="clear-button" disabled={Boolean(action || installing)} onClick={() => setSelectedDates([])}>清空</button>}
            </div>
            {selectedDates.length ? (
              <>
                <div className="selected-date-strip">{selectedDates.slice(0, 5).map((date) => <button key={date} disabled={Boolean(action || installing)} onClick={() => toggleDate(date)}>{shortDate(date)} ×</button>)}{selectedDates.length > 5 && <span>另 {selectedDates.length - 5} 天</span>}</div>
                <div className="editable-form">
                  <WorkTypeSelect label="工作类型" code={settings.workTypeCode} name={settings.workTypeName} options={data.workTypes} catalog={data.workTypeCatalog} disabled={Boolean(action || installing)} refreshDisabled={Boolean(installing || data.session.busy || !data.session.connected)} refreshing={workTypeRefreshing || Boolean(data.session.busy?.startsWith("work-types"))} onChange={(workType) => changeWorkType(workType)} onRefresh={() => void refreshWorkTypes()} />
                  <label><span>每天工时</span><div className="hours-input"><input type="number" min="0.1" max="24" step="0.5" disabled={Boolean(action || installing)} value={settings.hours} onChange={(event) => setSettings({ ...settings, hours: event.target.value })} /><b>小时</b></div></label>
                  {isLeaveSettings(settings) ? <p className="leave-project-note full-field">休假无需选择项目</p> : <ProjectPicker id="action-project-results" code={settings.projectCode} name={settings.projectName} catalog={data.projectCatalog} disabled={Boolean(action || installing)} refreshDisabled={Boolean(installing || data.session.busy || !data.session.connected)} refreshing={projectRefreshing || data.session.busy === "projects"} onChange={(project) => setSettings({ ...settings, projectId: project.id, projectCode: project.code, projectName: project.name })} onRefresh={() => void refreshProjects()} />}
                  <label className="full-field"><span>备注</span><textarea rows={2} maxLength={500} disabled={Boolean(action || installing)} value={settings.remark} onChange={(event) => setSettings({ ...settings, remark: event.target.value })} placeholder="选填；将应用到所有已选日期" /></label>
                </div>
                <div className="form-helper"><span>组别跟随登录账户，不需要手工修改。</span><button onClick={openDefaultSettings} disabled={Boolean(action || installing)}>管理默认值</button></div>
                <div className="action-buttons">
                  <button className="secondary-button full" onClick={() => void runAction("preview")} disabled={Boolean(action || installing || data.session.busy || serviceOffline || !data.session.connected)}>{action === "preview" ? `正在预演 ${selectedDates.length} 天…` : `预演 ${selectedDates.length} 天`}</button>
                  <button className="primary-button full" onClick={() => { const validation = validateForm(); if (validation) setError(validation); else setConfirming(true); }} disabled={Boolean(action || installing || data.session.busy || serviceOffline || !data.session.connected)}>提交 {selectedDates.length} 天</button>
                </div>
                <p className="safety-note">只启动一次填报会话；已发起的日期会标为待确认，请同步已办核对。</p>
              </>
            ) : inspectedRecord ? (
              <div className="completed-state"><span className="complete-check">✓</span><strong>这一天已经填过</strong><p>{inspectedRecord.documentNo || inspectedRecord.requestId || inspectedRecord.workDate}</p><small>{inspectedRecord.status.includes("同步中") ? "已发起·待确认" : inspectedRecord.status || "已办"}</small></div>
            ) : (
              <div className="empty-state"><span>↖</span><p>点击一个或多个“待补”日期，或使用“全选待补”。</p></div>
            )}
          </article>

          <article className="panel missing-panel">
            <div className="panel-header compact"><div><p className="section-kicker">缺失清单</p><h3>{missingDates.length ? `${missingDates.length} 个工作日` : selectedMonth > thisMonth ? "尚未到填报日期" : "本月已齐"}</h3></div><button className="count-badge selectable" onClick={toggleAllMissing} disabled={!missingDates.length || Boolean(action || installing)}>{selectedDates.length}/{missingDates.length}</button></div>
            <div className="missing-list">
              {missingDates.slice(0, 8).map((date) => <button key={date} className={selectedSet.has(date) ? "active" : ""} onClick={() => toggleDate(date)}><i className="check-box">{selectedSet.has(date) ? "✓" : ""}</i><span>{shortDate(date)}</span><small>{new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${date}T00:00:00`))}</small></button>)}
              {!missingDates.length && <div className="all-done"><span>✓</span><p>没有发现缺报工作日</p></div>}
              {missingDates.length > 8 && <p className="more-missing">另有 {missingDates.length - 8} 天，可点击上方“全选待补”</p>}
            </div>
          </article>
          </>}
        </aside>
      </section>

      <section className="panel records-panel">
        <div className="panel-header"><div><p className="section-kicker">已填信息</p><h2>{monthLabel(selectedMonth)} · {selectedMonthRecords.length} 条</h2></div><button className="text-button" onClick={() => changeMonth(previousMonth)}>查看上月 →</button></div>
        <div className="records-table" role="table" aria-label="已填工时">
          <div className="records-row records-head" role="row"><span>工时日期</span><span>单据编号</span><span>提交时间</span><span>状态</span></div>
          {selectedMonthRecords.map((record) => <button className="records-row" role="row" disabled={Boolean(action || installing)} key={record.requestId || record.workDate} onClick={() => { setInspectedDate(record.workDate); setSelectedDates([]); }}><span className="record-date"><i />{record.workDate}</span><span className="mono">{record.documentNo || "等待同步"}</span><span>{record.operationTime || "—"}</span><span><b className={`status-badge ${record.status.includes("同步中") ? "syncing" : ""}`}>{record.status.includes("同步中") ? "已发起·待确认" : record.status || "已办"}</b></span></button>)}
          {!selectedMonthRecords.length && <div className="no-records">这个月还没有已填记录</div>}
        </div>
      </section>

      <footer><span>仅在本机运行 · 按工作日安排填报 · 每 3 秒自动刷新</span><span>本次设置：{settings.workTypeName} / {isLeaveSettings(settings) ? "无需项目" : settings.projectCode} / {settings.hours}h</span></footer>

      {updatesOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !updatePending && setUpdatesOpen(false)}>
        <section className="confirm-modal update-modal" role="dialog" aria-modal="true" aria-labelledby="updates-title">
          <h2 id="updates-title">版本与更新</h2>
          <p>当前版本 {data.update?.currentVersion || "未知"}{data.update?.latestVersion && ` · 最新版本 ${data.update.latestVersion}`}</p>
          <p className="safety-note">每次启动检查一次更新。下载安装由你确认，个人设置和登录数据会保留。</p>
          {data.update?.status === "not_configured" && <p>发布仓库尚未配置，暂时无法检查更新。</p>}
          {data.update?.status === "checking" && <p role="status">正在检查新版本…</p>}
          {data.update?.status === "up_to_date" && <p role="status">当前已是最新可用版本。</p>}
          {data.update?.error && <p className="update-error" role="alert">{data.update.error}</p>}
          {data.update?.lastInstall && <p className={data.update.lastInstall.success ? "safety-note" : "update-error"}>{data.update.lastInstall.success ? `上次更新已完成：${data.update.lastInstall.version}` : `上次更新未完成：${data.update.lastInstall.error}`}</p>}
          {data.update?.releaseNotes && <div className="update-notes"><strong>更新说明</strong><p>{data.update.releaseNotes}</p></div>}
          {data.update?.status === "downloading" && <div role="status"><p>正在下载 · {data.update.percent}%</p><div className="progress-track" role="progressbar" aria-label="更新下载进度" aria-valuenow={data.update.percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${data.update.percent}%` }} /></div></div>}
          {installing && <p role="status">正在安装，请稍候。完成后自动重新打开；若长时间未恢复，请从桌面启动工时助手。</p>}
          {data.update?.status === "ready" && !data.update.canInstall && <p>当前为源码运行，请使用新版安装包安装。</p>}
          {data.update?.status === "ready" && Boolean(action || installing || data.session.busy || loginInProgress) && <p>正在处理工时或登录，任务结束后才能安装。</p>}
          {updateConfirming && <p className="update-confirmation">安装将暂时关闭工时助手，完成后自动重新打开。确认现在安装？</p>}
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => { setUpdatesOpen(false); setUpdateConfirming(false); }} disabled={updatePending}>关闭</button>
            {!installing && <button className="secondary-button" onClick={() => void updateAction("check")} disabled={Boolean(updatePending || serviceOffline || !data.update?.repository || ["checking", "downloading"].includes(data.update?.status || ""))}>检查更新</button>}
            {data.update?.status === "available" && <button className="primary-button" onClick={() => void updateAction("download")} disabled={updatePending || serviceOffline}>下载新版</button>}
            {data.update?.status === "ready" && data.update.canInstall && <button className="primary-button" onClick={() => updateConfirming ? void updateAction("install") : setUpdateConfirming(true)} disabled={Boolean(updatePending || action || data.session.busy || loginInProgress || projectRefreshing || workTypeRefreshing || serviceOffline)}>{updateConfirming ? "确认安装并重启" : "安装更新"}</button>}
          </div>
        </section>
      </div>}

      {settingsOpen && defaultDraft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !action && setSettingsOpen(false)}>
          <div className="confirm-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-icon settings-icon">⚙</div>
            <p className="section-kicker">其他人员也可使用</p>
            <h2 id="settings-title">本机默认填报设置</h2>
            <p>姓名、工号、公司和组别来自当前 OA 登录账户；这里只设置这个账户常用的填报内容。</p>
            <div className="settings-account-note"><b>{data.account.name || "当前账户"}</b><span>{data.account.department || "OA 所属组"}</span></div>
            <div className="editable-form settings-form">
              <WorkTypeSelect label="默认工作类型" code={defaultDraft.workTypeCode} name={defaultDraft.workTypeName} options={data.workTypes} catalog={data.workTypeCatalog} disabled={Boolean(action || installing)} refreshDisabled={Boolean(installing || data.session.busy || !data.session.connected)} refreshing={workTypeRefreshing || Boolean(data.session.busy?.startsWith("work-types"))} onChange={(workType) => changeWorkType(workType, true)} onRefresh={() => void refreshWorkTypes()} />
              <label><span>默认每天工时</span><div className="hours-input"><input type="number" min="0.1" max="24" step="0.5" disabled={Boolean(action || installing)} value={defaultDraft.hours} onChange={(event) => setDefaultDraft({ ...defaultDraft, hours: event.target.value })} /><b>小时</b></div></label>
              {isLeaveSettings(defaultDraft) ? <p className="leave-project-note full-field">休假无需选择项目</p> : <ProjectPicker id="settings-project-results" code={defaultDraft.projectCode} name={defaultDraft.projectName} catalog={data.projectCatalog} disabled={Boolean(action || installing)} refreshDisabled={Boolean(installing || data.session.busy || !data.session.connected)} refreshing={projectRefreshing || data.session.busy === "projects"} onChange={(project) => setDefaultDraft({ ...defaultDraft, projectId: project.id, projectCode: project.code, projectName: project.name })} onRefresh={() => void refreshProjects()} />}
              <label><span>默认备注</span><input value={defaultDraft.remark} maxLength={500} disabled={Boolean(action || installing)} onChange={(event) => setDefaultDraft({ ...defaultDraft, remark: event.target.value })} placeholder="选填" /></label>
            </div>
            <p className="settings-tip">休假无需选择项目；其他工作类型需选项目。预演会核对 OA 规则，不正确时停止。</p>
            <div className="settings-diagnostics">
              <button type="button" className="secondary-button full" onClick={() => void exportDiagnostics()} disabled={Boolean(action || exporting || serviceOffline)}>{exporting ? "正在打包…" : "导出诊断包"}</button>
              <p className="settings-tip">多天提交失败时导出最近日志。诊断包不含登录会话、二维码和项目库。</p>
            </div>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)} disabled={Boolean(action || installing)}>取消</button><button className="primary-button" onClick={() => void saveDefaultSettings()} disabled={Boolean(action || installing || data.session.busy || serviceOffline)}>{action === "defaults" ? "保存中…" : "保存为默认"}</button></div>
          </div>
        </div>
      )}

      {loginOpen && (
        <div className="modal-backdrop login-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loginInProgress && setLoginOpen(false)}>
          <div className="confirm-modal login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
            <div className="ding-mark">钉</div>
            <p className="section-kicker">安全登录 · 仅限本机</p>
            <h2 id="login-title">钉钉扫码登录 OA</h2>
            {loginStatus?.state === "waiting" ? (
              <>
                {/* The portable app displays a local, changing QR image without a Next image server. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <div className="qr-frame"><img src={`${API_BASE}/api/login/qr?v=${loginStatus.qrVersion || Date.now()}`} alt="钉钉登录二维码" /></div>
                <p className="login-instruction">打开手机钉钉，扫描上方二维码并在手机上确认登录。</p>
                <div className="login-steps"><span><b>1</b>打开钉钉扫一扫</span><span><b>2</b>确认当前账户</span><span><b>3</b>页面自动进入</span></div>
              </>
            ) : loginStatus?.state === "confirming" ? (
              <div className="login-wait"><i className="login-spinner" /><strong>已扫码，正在确认登录</strong><span>{loginStatus.message}</span></div>
            ) : loginStatus?.state === "verifying" ? (
              <div className="login-wait"><i className="login-spinner" /><strong>正在验证 OA 登录</strong></div>
            ) : loginStatus?.state === "unavailable" ? (
              <div className="login-wait login-error"><strong>暂时无法连接 OA</strong><span>{loginStatus.message}</span><button className="secondary-button" onClick={() => void checkLoginSession()}>重新验证</button></div>
            ) : loginStatus?.state === "checking" || loginInProgress ? (
              <div className="login-wait"><i className="login-spinner" /><strong>正在生成安全二维码</strong><span>通常只需要几秒钟</span></div>
            ) : loginStatus?.state === "error" ? (
              <div className="login-wait login-error"><strong>{loginStatus.reason === "expired" ? "OA 登录已过期" : loginStatus.reason === "account" ? "OA 账户需要重新确认" : "二维码暂时不可用"}</strong><span>{loginStatus.message}</span></div>
            ) : data.session.connected ? (
              <div className="current-login"><div className="avatar large">{data.account.name?.slice(0, 1) || "我"}</div><strong>{data.account.name || "当前账户"}</strong><span>{data.account.employeeNo} · {data.account.department}</span><small>当前脚本会话已经登录</small></div>
            ) : (
              <div className="login-wait"><strong>尚未登录 OA</strong><span>{loginStatus?.message || "请点击下方按钮扫码登录。"}</span></div>
            )}
            <p className="local-security-note">二维码和登录状态只保存在这台电脑，不会上传到其他服务。</p>
            <div className="modal-actions login-actions">
              {loginInProgress ? <button className="secondary-button" onClick={() => void cancelLogin()}>取消登录</button> : <button className="secondary-button" onClick={() => setLoginOpen(false)}>关闭</button>}
              {!loginInProgress && <button className="primary-button" onClick={() => void startLogin(data.session.connected)} disabled={Boolean(data.session.busy || action || serviceOffline)}>{data.session.connected ? "切换 OA 账户" : loginStatus?.state === "error" && !loginStatus.reason ? "重新生成二维码" : "扫码登录"}</button>}
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !action && setConfirming(false)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="modal-icon">!</div><p className="section-kicker">批量提交确认</p><h2 id="confirm-title">提交所选 {selectedDates.length} 天？</h2>
            <p>{selectedDates.join("、")}。将按日期逐条提交；任何一条失败都会停止后续日期，不会自动重试。</p>
            <div className="confirm-summary"><span>{settings.workTypeName}</span><span>{isLeaveSettings(settings) ? "休假无需选择项目" : `${settings.projectCode}${settings.projectName ? ` · ${settings.projectName}` : ""}`}</span><span>每天 {settings.hours} 小时</span>{settings.remark && <span>备注：{settings.remark}</span>}</div>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setConfirming(false)} disabled={Boolean(action || installing)}>取消</button><button className="primary-button" onClick={() => void runAction("submit")} disabled={Boolean(action || installing || data.session.busy || serviceOffline || !data.session.connected)}>{action === "submit" ? `正在提交 ${selectedDates.length} 天…` : `确认提交 ${selectedDates.length} 天`}</button></div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
