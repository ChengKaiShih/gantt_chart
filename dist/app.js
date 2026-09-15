import {
  RELATION_TYPES,
  autoSchedule,
  relationWeight,
  addDays,
  computeCPM,
  daysBetween,
  deriveSummaryDates,
  formatDate,
  inclusiveDuration,
  isSummaryTask,
  parseDate,
  scheduleBounds,
  taskSubtreeRange,
  visibleTasks,
} from "./schedule-core.js";

const STORAGE_KEY = "engineering-gantt-planner-v1";
const SCALE_CONFIG = {
  day: { label: "日", pxPerDay: 26, pad: 2 },
  week: { label: "週", pxPerDay: 11, pad: 7 },
  month: { label: "月", pxPerDay: 3.2, pad: 14 },
  quarter: { label: "季", pxPerDay: 1.35, pad: 31 },
  year: { label: "年", pxPerDay: 0.58, pad: 60 },
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  projectName: $("#projectName"),
  saveStatus: $("#saveStatus"),
  scheduleGrid: $("#scheduleGrid"),
  alertArea: $("#alertArea"),
  projectRange: $("#projectRange"),
  leafCount: $("#leafCount"),
  criticalCount: $("#criticalCount"),
  networkDuration: $("#networkDuration"),
  scaleButtons: $("#scaleButtons"),
  relationDialog: $("#relationDialog"),
  relationTitle: $("#relationTitle"),
  relationList: $("#relationList"),
  addRelation: $("#addRelation"),
  importFile: $("#importFile"),
  toast: $("#toast"),
};

function uid() {
  return globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sampleProject() {
  return {
    name: "道路工程整體期程（範例）",
    scale: "quarter",
    tasks: [
      task("p1", "前期規劃與審議", 0, "", "", [], "上位作業與審議程序"),
      task("a1", "可行性研究", 1, "2026-10-01", "2027-03-29", [], "完成建設必要性及方案評估"),
      task("a2", "綜合規劃", 1, "2027-03-30", "2027-09-25", [rel("a1", "FS", 0)], "確認路線、工程配置及經費"),
      task("a3", "環境影響評估", 1, "2027-05-29", "2028-01-23", [rel("a2", "SS", 60)], "與綜合規劃交疊辦理"),
      task("p2", "設計與用地作業", 0, "", "", [], "設計及用地程序併行推動"),
      task("b1", "基本設計", 1, "2027-03-30", "2027-08-26", [rel("a1", "FS", 0)], "建立主要工程配置及設計原則"),
      task("b2", "細部設計", 1, "2027-08-27", "2028-02-22", [rel("b1", "FS", 0)], "完成施工圖說及工程預算"),
      task("b3", "都市計畫變更及用地取得", 1, "2027-08-27", "2028-03-23", [rel("b1", "FS", 0)], "配合設計成果推動用地作業"),
      task("p3", "工程招標及施工", 0, "", "", [], "施工期以橋梁工程控制"),
      task("c1", "工程招標", 1, "2028-03-24", "2028-06-21", [rel("b2", "FS", 0), rel("b3", "FS", 0)], "完成招標文件及決標程序"),
      task("c2", "橋梁基礎工程", 1, "2028-06-22", "2028-12-18", [rel("c1", "FS", 0)], "基樁及基礎施工"),
      task("c3", "橋梁下部結構", 1, "2028-12-19", "2029-05-27", [rel("c2", "FS", 0)], "橋墩、橋台及支承墊施工"),
      task("c4", "橋梁上部結構", 1, "2029-05-28", "2030-01-22", [rel("c3", "FS", 0)], "上部結構施工為主要控制工項"),
      task("c5", "附屬工程及驗收", 1, "2030-01-23", "2030-05-22", [rel("c4", "FS", 0)], "鋪面、排水、交維及驗收"),
    ],
  };
}

function task(id, name, level, start, finish, predecessors = [], notes = "") {
  return { id, name, level, start, finish, predecessors, notes, collapsed: false };
}

function rel(taskId, type = "FS", lag = 0) {
  return { taskId, type, lag };
}

function normalizeProject(value) {
  if (!value || !Array.isArray(value.tasks)) throw new Error("檔案中找不到工項資料。");
  let previousLevel = 0;
  const tasks = value.tasks.map((item, index) => {
    let level = Math.max(0, Math.floor(Number(item.level) || 0));
    if (index === 0) level = 0;
    level = Math.min(level, previousLevel + 1);
    previousLevel = level;
    return {
      id: typeof item.id === "string" && item.id ? item.id : uid(),
      name: typeof item.name === "string" ? item.name : "未命名工項",
      level,
      start: typeof item.start === "string" ? item.start : "",
      finish: typeof item.finish === "string" ? item.finish : "",
      notes: typeof item.notes === "string" ? item.notes : "",
      collapsed: Boolean(item.collapsed),
      rowHeight: Number.isFinite(Number(item.rowHeight)) ? Math.max(48, Math.min(1200, Number(item.rowHeight))) : undefined,
      milestone: Boolean(item.milestone),
      duration: item.milestone ? 0 : (item.duration ?? inclusiveDuration(item.start, item.finish)),
      notBefore: typeof item.notBefore === "string" ? item.notBefore : "",
      predecessors: Array.isArray(item.predecessors)
        ? item.predecessors.map((relation) => ({
            taskId: String(relation.taskId || ""),
            type: RELATION_TYPES.includes(relation.type) ? relation.type : "FS",
            lag: Number.isFinite(Number(relation.lag)) ? Number(relation.lag) : 0,
          }))
        : [],
    };
  });
  const validIds = new Set(tasks.map((item) => item.id));
  if (validIds.size !== tasks.length) throw new Error("工項 ID 不可重複。");
  tasks.forEach((item) => {
    item.predecessors = item.predecessors.filter(
      (relation, index, array) =>
        validIds.has(relation.taskId) &&
        relation.taskId !== item.id &&
        array.findIndex((candidate) => candidate.taskId === relation.taskId) === index,
    );
  });
  return {
    name: typeof value.name === "string" && value.name.trim() ? value.name : "未命名工程期程",
    scale: SCALE_CONFIG[value.scale] ? value.scale : "quarter",
    rangeMode: value.rangeMode || "auto",
    columnWidths: value.columnWidths,
    timelineWidths: Object.fromEntries(Object.entries(value.timelineWidths || {}).filter(([key,val]) => SCALE_CONFIG[key] && Number.isFinite(val)).map(([key,val]) => [key,Math.max(24,Math.min(400,val))])),
    tasks,
  };
}

function loadProject() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeProject(JSON.parse(stored)) : sampleProject();
  } catch {
    return sampleProject();
  }
}

let state = loadProject();
let lastCommitted = structuredClone(state);
let selectedId = state.tasks[0]?.id || null;
let relationTaskId = null;
let toastTimer = null;
let saveTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function saveProject() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  elements.saveStatus.textContent = "儲存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    elements.saveStatus.textContent = "已儲存於此瀏覽器";
  }, 350);
}

function commit({ render = true, message = "" } = {}) {
  const scheduled = autoSchedule(state.tasks);
  if (scheduled.ok) state.tasks = scheduled.tasks;
  else { state = structuredClone(lastCommitted); showToast(scheduled.error); renderApp(); return; }
  lastCommitted = structuredClone(state);
  saveProject();
  if (render) renderApp();
  if (message) showToast(message);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function wbsNumbers(tasks) {
  const result = new Map();
  const counters = [];
  tasks.forEach((item) => {
    while (counters.length <= item.level) counters.push(0);
    counters.length = item.level + 1;
    counters[item.level] += 1;
    result.set(item.id, counters.join("."));
  });
  return result;
}

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date) {
  return addDays(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)), -1);
}

function startOfYear(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function endOfYear(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), 11, 31));
}

function startOfWeek(date) {
  const day = date.getUTCDay() || 7;
  return addDays(date, 1 - day);
}

function timelineModel(tasks, scale) {
  const config = SCALE_CONFIG[scale];
  const bounds = scheduleBounds(tasks);
  let start;
  let finish;
  if (state.rangeMode === "year" || scale === "year") {
    start = startOfYear(bounds.start); finish = endOfYear(bounds.finish);
  } else if (scale === "day") {
    start = bounds.start; finish = bounds.finish;
  } else if (scale === "week") {
    start = startOfWeek(bounds.start); finish = addDays(startOfWeek(bounds.finish), 6);
  } else if (scale === "month") {
    start = startOfMonth(bounds.start); finish = endOfMonth(bounds.finish);
  } else {
    start = new Date(Date.UTC(bounds.start.getUTCFullYear(), Math.floor(bounds.start.getUTCMonth()/3)*3, 1));
    finish = addDays(new Date(Date.UTC(bounds.finish.getUTCFullYear(), Math.floor(bounds.finish.getUTCMonth()/3)*3+3, 1)), -1);
  }
  if (scale === 'week') { start=startOfWeek(start); finish=addDays(startOfWeek(finish),6); }
  const totalDays = daysBetween(start, finish) + 1;
  const units = timeUnitPosition(addDays(finish,1),scale)-timeUnitPosition(start,scale);
  const unitWidth=state.timelineWidths?.[scale] || Math.min(400,Math.max(24,Math.max(760,totalDays*config.pxPerDay)/units));
  const width=units*unitWidth;
  return { ...config, scale, start, finish, totalDays, width, unitWidth };
}

function timeUnitPosition(value,scale) {
  const date=typeof value === 'string'?parseDate(value):value;
  if (!date) return 0;
  if(scale==='day'||scale==='week')return date.getTime()/86400000/(scale==='week'?7:1);
  const span=scale==='month'?1:scale==='quarter'?3:12;
  const month=Math.floor(date.getUTCMonth()/span)*span;
  const start=new Date(Date.UTC(date.getUTCFullYear(),month,1));
  const end=new Date(Date.UTC(date.getUTCFullYear(),month+span,1));
  return (date.getUTCFullYear()*12+month)/span+daysBetween(start,date)/daysBetween(start,end);
}
function timelineX(model,date) {
  return (timeUnitPosition(date,model.scale)-timeUnitPosition(model.start,model.scale))*model.unitWidth;
}
function timelineBarWidth(model,t) {
  return t.milestone?0:timelineX(model,addDays(t.finish,1))-timelineX(model,t.start);
}

function monthLabel(date) {
  return `${date.getUTCMonth() + 1}月`;
}

function segment(start, finishExclusive, model, label) {
  const left = Math.max(0, timelineX(model,start));
  const right = Math.min(model.width, timelineX(model,finishExclusive));
  if (right <= left) return "";
  return `<span class="time-segment" style="left:${left}px;width:${right - left}px">${escapeHtml(label)}<i class="time-resize-handle" title="拖曳同步調整時間格寬；雙擊恢復預設"></i></span>`;
}

function monthSegments(model, row = "bottom") {
  const segments = [];
  let cursor = startOfMonth(model.start);
  while (cursor <= model.finish) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const label = row === "top" ? `${cursor.getUTCFullYear()}年 ${monthLabel(cursor)}` : monthLabel(cursor);
    segments.push(segment(cursor, next, model, label));
    cursor = next;
  }
  return segments.join("");
}

function yearSegments(model) {
  const segments = [];
  let cursor = startOfYear(model.start);
  while (cursor <= model.finish) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1));
    segments.push(segment(cursor, next, model, `${cursor.getUTCFullYear()}年`));
    cursor = next;
  }
  return segments.join("");
}

function timelineHeader(model) {
  let top = "";
  let bottom = "";
  if (model.scale === "day") {
    top = monthSegments(model, "top");
    let cursor = model.start;
    while (cursor <= model.finish) {
      bottom += segment(cursor, addDays(cursor, 1), model, `${cursor.getUTCDate()}`);
      cursor = addDays(cursor, 1);
    }
  } else if (model.scale === "week") {
    top = monthSegments(model, "top");
    let cursor = model.start;
    while (cursor <= model.finish) {
      bottom += segment(cursor, addDays(cursor, 7), model, `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`);
      cursor = addDays(cursor, 7);
    }
  } else if (model.scale === "month") {
    top = yearSegments(model);
    bottom = monthSegments(model);
  } else if (model.scale === "quarter") {
    top = yearSegments(model);
    let cursor = startOfYear(model.start);
    while (cursor <= model.finish) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, 1));
      bottom += segment(cursor, next, model, `第${Math.floor(cursor.getUTCMonth() / 3) + 1}季`);
      cursor = next;
    }
  } else {
    top = segment(model.start, addDays(model.finish, 1), model, "計畫年度");
    bottom = yearSegments(model);
  }
  return `<div class="time-head-row top">${top}</div><div class="time-head-row bottom">${bottom}</div>`;
}

function tableHeader() {
  return ["項次", "工作項目", "開始日期", "完成日期", "工期", "前置關係", "浮時", "主要控制／說明"]
    .map((label, i) => `<span>${label}<i class="resize-handle" data-column="${i}" title="拖曳調整欄寬；雙擊自動適配"></i></span>`)
    .join("");
}

function relationLabel(task) {
  if (!(task.predecessors || []).length) return "設定";
  if (task.predecessors.length === 1) {
    const item = task.predecessors[0];
    const lag = Number(item.lag) || 0;
    return `${item.type}${lag === 0 ? "" : lag > 0 ? ` +${lag}` : ` ${lag}`}`;
  }
  return `${task.predecessors.length} 項關係`;
}

function renderGrid(displayTasks, cpm) {
  const model = timelineModel(displayTasks, state.scale);
  const wbs = wbsNumbers(state.tasks);
  const visible = visibleTasks(displayTasks);
  const conflictIds = new Set(cpm.conflicts?.map((item) => item.taskId) || []);
  const today = parseDate(formatDate(new Date()));
  const todayOffset = today ? daysBetween(model.start, today) : -1;
  const todayHtml = todayOffset >= 0 && todayOffset < model.totalDays
    ? `<span class="today-line" style="left:${timelineX(model,today)}px" title="今天"></span>`
    : "";
  const primaryDays = model.scale === "day" ? 1 : model.scale === "week" ? 7 : model.scale === "month" ? 30 : model.scale === "quarter" ? 91 : 365;
  const minorDays = model.scale === "day" ? 1 : model.scale === "week" ? 1 : model.scale === "month" ? 7 : model.scale === "quarter" ? 30 : 91;

  let html = `
    <div class="schedule-row" style="--timeline-width:${model.width}px">
      <div class="table-head">${tableHeader()}</div>
      <div class="timeline-head">${timelineHeader(model)}</div>
    </div>`;

  visible.forEach((item) => {
    const raw = state.tasks.find((taskItem) => taskItem.id === item.id);
    const summary = isSummaryTask(raw, state.tasks);
    const metric = cpm.metrics?.get(item.id);
    const duration = item.milestone ? 0 : inclusiveDuration(item.start, item.finish);
    const selected = item.id === selectedId;
    const conflict = conflictIds.has(item.id);
    const collapseControl = summary
      ? `<button class="collapse-button" type="button" data-action="collapse" title="${raw.collapsed ? "展開" : "收合"}">${raw.collapsed ? "▸" : "▾"}</button>`
      : `<span class="collapse-spacer"></span>`;
    const calculated = metric
      ? `系統計算：${metric.calculatedStart}～${metric.calculatedFinish}；總浮時 ${metric.totalFloat} 日`
      : "";
    const floatText = summary || !metric ? "—" : `${metric.totalFloat}日`;
    const barLeft = duration === null ? 0 : timelineX(model,item.start);
    const barWidth = duration === null ? 0 : Math.max(3, timelineBarWidth(model,item));
    const barClass = `${summary ? "summary" : metric?.critical ? "critical" : ""} ${item.milestone ? "milestone" : ""}`;
    const bar = duration === null
      ? ""
      : `<span class="gantt-bar ${barClass}" style="left:${barLeft}px;width:${barWidth}px" title="${escapeHtml(item.name)}｜${item.start}～${item.finish}｜${duration}日${calculated ? `｜${calculated}` : ""}"></span>`;
    html += `
      <div class="schedule-row ${selected ? "selected" : ""} ${summary ? "summary-row" : ""} ${conflict ? "conflict-row" : ""}" data-id="${escapeHtml(item.id)}" style="--timeline-width:${model.width}px">
        <div class="task-cell">
          <div class="row-number">${escapeHtml(wbs.get(item.id))}<span class="row-resize-handle" title="拖曳調整列高；雙擊恢復自動列高" aria-hidden="true"></span></div>
          <div class="task-name-wrap" style="padding-left:${5 + item.level * 18}px">
            ${collapseControl}
            <textarea class="task-input" data-field="name" rows="1" aria-label="工項名稱">${escapeHtml(item.name)}</textarea>
            ${conflict ? `<span class="warning-mark" title="計畫日期與前置關係衝突">!</span>` : ""}
          </div>
          <div><input class="date-input" type="date" data-field="start" value="${escapeHtml(item.start)}" ${summary ? "disabled" : ""} aria-label="開始日期" /></div>
          <div><input class="date-input" type="date" data-field="finish" value="${escapeHtml(item.finish)}" ${summary ? "disabled" : ""} aria-label="完成日期" /></div>
          <div class="duration-cell">${summary ? `${duration}日` : `<input class="duration-input" type="number" min="${item.milestone ? 0 : 1}" step="1" data-field="duration" value="${duration ?? 1}" aria-label="工期（日曆天）" ${item.milestone ? "disabled" : ""} />`}</div>
          <div class="relation-cell"><button class="relation-button" type="button" data-action="relations" ${summary ? "disabled" : ""}>${summary ? "彙整" : escapeHtml(relationLabel(raw))}</button></div>
          <div class="float-cell ${metric?.critical ? "critical-text" : ""}" title="${escapeHtml(calculated)}">${floatText}</div>
          <div><textarea class="note-input" data-field="notes" aria-label="主要控制或說明">${escapeHtml(raw.notes)}</textarea></div>
        </div>
        <div class="timeline-cell" style="--grid-size:${model.unitWidth}px;--minor-grid-size:${model.unitWidth}px">
          ${todayHtml}${bar}
        </div>
      </div>`;
  });

  if (!visible.length) {
    html += `
      <div class="schedule-row" style="--timeline-width:${model.width}px">
        <div class="task-cell"><div class="row-number">—</div><div class="task-name-wrap">尚無工項，請按「新增工項」。</div></div>
        <div class="timeline-cell"></div>
      </div>`;
  }
  elements.scheduleGrid.innerHTML = html;
  elements.scheduleGrid.style.setProperty("--timeline-width", `${model.width}px`);
  applyWidths();
  fitRows();
  drawArrows(model, displayTasks);
}

function renderSummary(displayTasks, cpm) {
  const bounds = scheduleBounds(displayTasks);
  const leaves = state.tasks.filter((item) => !isSummaryTask(item, state.tasks));
  const critical = leaves.filter((item) => cpm.metrics?.get(item.id)?.critical);
  elements.projectRange.textContent = `${formatDate(bounds.start).replaceAll("-", "/")}－${formatDate(bounds.finish).replaceAll("-", "/")}`;
  elements.leafCount.textContent = `${leaves.length}項`;
  elements.criticalCount.textContent = cpm.ok ? `${critical.length}項` : "—";
  elements.networkDuration.textContent = cpm.ok ? `${cpm.projectDuration}日` : "無法計算";
}

function renderAlert(cpm) {
  if (!cpm.ok) {
    elements.alertArea.innerHTML = `<div class="alert">${escapeHtml(cpm.error)}</div>`;
    return;
  }
  const invalidDates = state.tasks.filter((item) => !isSummaryTask(item, state.tasks) && inclusiveDuration(item.start, item.finish) === null);
  const messages = [];
  if (invalidDates.length) messages.push(`${invalidDates.length}項工項的起訖日期不完整或完成日早於開始日`);
  if (cpm.conflicts.length) messages.push(`${cpm.conflicts.length}組計畫日期不符合前置關係`);
  elements.alertArea.innerHTML = messages.length
    ? `<div class="alert">${escapeHtml(messages.join("；"))}。紅色驚嘆號標示需檢查的工項。</div>`
    : "";
}

function updateButtonStates() {
  const index = state.tasks.findIndex((item) => item.id === selectedId);
  const disabled = index < 0;
  ["addChild", "moveUp", "moveDown", "outdent", "indent", "deleteTask"].forEach((id) => {
    $(`#${id}`).disabled = disabled;
  });
  if (!disabled) {
    $("#outdent").disabled = state.tasks[index].level === 0;
    $("#indent").disabled = findPreviousSibling(index) === null;
    $("#moveUp").disabled = findPreviousSibling(index) === null;
    $("#moveDown").disabled = findNextSibling(index) === null;
  }
}

function renderApp() {
  const scheduled = autoSchedule(state.tasks);
  if (scheduled.ok) state.tasks = scheduled.tasks;
  const displayTasks = deriveSummaryDates(state.tasks);
  const cpm = computeCPM(state.tasks);
  elements.projectName.value = state.name;
  elements.scaleButtons.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.scale === state.scale);
  });
  renderSummary(displayTasks, cpm);
  renderAlert(cpm);
  if (!scheduled.ok) elements.alertArea.innerHTML = `<div class="alert">${escapeHtml(scheduled.error)}</div>`;
  renderGrid(displayTasks, cpm);
  updateButtonStates();
}

function currentTask() {
  return state.tasks.find((item) => item.id === selectedId) || null;
}

function defaultDates() {
  const selected = currentTask();
  if (selected && inclusiveDuration(selected.start, selected.finish) !== null) {
    return { start: selected.start, finish: selected.finish };
  }
  const today = formatDate(new Date());
  return { start: today, finish: formatDate(addDays(today, 29)) };
}

function findPreviousSibling(index) {
  const level = state.tasks[index]?.level;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (state.tasks[cursor].level === level) return cursor;
    if (state.tasks[cursor].level < level) return null;
  }
  return null;
}

function findNextSibling(index) {
  const level = state.tasks[index]?.level;
  const { end } = taskSubtreeRange(state.tasks, index);
  return state.tasks[end]?.level === level ? end : null;
}

function addTopLevelTask() {
  const dates = defaultDates();
  const item = task(uid(), "新增工項", 0, dates.start, dates.finish, [], "");
  state.tasks.push(item);
  selectedId ||= item.id;
  commit({ message: "已新增工項" });
}

function addChildTask() {
  const index = state.tasks.findIndex((item) => item.id === selectedId);
  if (index < 0) return;
  const parent = state.tasks[index];
  const wasSummary = isSummaryTask(parent, state.tasks);
  const dates = inclusiveDuration(parent.start, parent.finish) !== null ? parent : defaultDates();
  const { end } = taskSubtreeRange(state.tasks, index);
  const inheritedRelations = wasSummary ? [] : parent.predecessors.map((relation) => ({ ...relation }));
  const item = task(uid(), "新增下階工項", parent.level + 1, dates.start, dates.finish, inheritedRelations, "");
  if (!wasSummary) parent.predecessors = [];
  state.tasks.splice(end, 0, item);
  parent.collapsed = false;
  selectedId = parent.id;
  commit({ message: "已新增下階工項" });
}

function moveSelected(direction) {
  const index = state.tasks.findIndex((item) => item.id === selectedId);
  if (index < 0) return;
  const previous = findPreviousSibling(index);
  const next = findNextSibling(index);
  if ((direction === "up" && previous === null) || (direction === "down" && next === null)) return;
  const currentRange = taskSubtreeRange(state.tasks, index);
  const block = state.tasks.splice(currentRange.start, currentRange.end - currentRange.start);
  if (direction === "up") {
    state.tasks.splice(previous, 0, ...block);
  } else {
    const insertion = taskSubtreeRange(state.tasks, index).end;
    state.tasks.splice(insertion, 0, ...block);
  }
  commit();
}

function indentSelected() {
  const index = state.tasks.findIndex((item) => item.id === selectedId);
  const previous = findPreviousSibling(index);
  if (index < 0 || previous === null) return;
  const range = taskSubtreeRange(state.tasks, index);
  for (let cursor = range.start; cursor < range.end; cursor += 1) state.tasks[cursor].level += 1;
  state.tasks[previous].collapsed = false;
  commit();
}

function outdentSelected() {
  const index = state.tasks.findIndex((item) => item.id === selectedId);
  if (index < 0 || state.tasks[index].level === 0) return;
  const range = taskSubtreeRange(state.tasks, index);
  for (let cursor = range.start; cursor < range.end; cursor += 1) state.tasks[cursor].level -= 1;
  commit();
}

function deleteSelected() {
  const index = state.tasks.findIndex((item) => item.id === selectedId);
  if (index < 0) return;
  const range = taskSubtreeRange(state.tasks, index);
  const count = range.end - range.start;
  const suffix = count > 1 ? `及其 ${count - 1} 項下階工項` : "";
  if (!window.confirm(`確定刪除「${state.tasks[index].name}」${suffix}？`)) return;
  const removedIds = new Set(state.tasks.slice(range.start, range.end).map((item) => item.id));
  state.tasks.splice(range.start, count);
  state.tasks.forEach((item) => {
    item.predecessors = item.predecessors.filter((relation) => !removedIds.has(relation.taskId));
  });
  selectedId = state.tasks[Math.min(index, state.tasks.length - 1)]?.id || null;
  commit({ message: "已刪除工項" });
}

function openRelations(id) {
  const item = state.tasks.find((taskItem) => taskItem.id === id);
  if (!item || isSummaryTask(item, state.tasks)) return;
  relationTaskId = id;
  renderApp();
  renderRelationDialog();
  elements.relationDialog.showModal();
}

function relationCandidates(item) {
  return state.tasks.filter(
    (candidate) => candidate.id !== item.id && !isSummaryTask(candidate, state.tasks),
  );
}

function renderRelationDialog() {
  const item = state.tasks.find((taskItem) => taskItem.id === relationTaskId);
  if (!item) return;
  elements.relationTitle.textContent = `設定「${item.name}」的前置工項`;
  const candidates = relationCandidates(item);
  $("#relationResult").textContent = `排程結果：${item.start} 開始 → ${item.finish} 完成，工期 ${item.milestone ? 0 : item.duration ?? inclusiveDuration(item.start,item.finish)} 日。多個前置條件取最晚允許日期。`;
  $("#notBefore").value = item.notBefore || "";
  $("#relationError").textContent = "";
  if (!item.predecessors.length) {
    elements.relationList.innerHTML = `<div class="relation-empty">尚未設定前置工項，此工項將視為網圖起始工項。</div>`;
    return;
  }
  elements.relationList.innerHTML = item.predecessors.map((relation, index) => {
    const options = candidates.map((candidate) =>
      `<option value="${escapeHtml(candidate.id)}" ${candidate.id === relation.taskId ? "selected" : ""}>${escapeHtml(candidate.name)}</option>`,
    ).join("");
    const types = RELATION_TYPES.map((type) =>
      `<option value="${type}" ${type === relation.type ? "selected" : ""}>${type}</option>`,
    ).join("");
    return `
      <div class="relation-row" data-index="${index}">
        <select data-relation-field="taskId" aria-label="前置工項">${options}</select>
        <select data-relation-field="type" aria-label="關係類型">${types}</select>
        <input data-relation-field="lag" type="number" step="1" value="${Number(relation.lag) || 0}" aria-label="時間間隔（日）" title="時間間隔（日）" />
        <button class="remove-relation" type="button" data-action="remove-relation" aria-label="移除前置關係">×</button>
        <p class="relation-explanation">${escapeHtml(explainRelation(item, relation))}</p>
      </div>`;
  }).join("");
}

function addRelation() {
  const item = state.tasks.find((taskItem) => taskItem.id === relationTaskId);
  if (!item) return;
  const used = new Set(item.predecessors.map((relation) => relation.taskId));
  const candidate = relationCandidates(item).find((entry) => !used.has(entry.id));
  if (!candidate) {
    showToast("沒有其他可加入的最下階工項");
    return;
  }
  item.predecessors.push(rel(candidate.id, "FS", 0));
  const trial = autoSchedule(state.tasks);
  if (!trial.ok) { item.predecessors.pop(); relationError(trial.error); return; }
  state.tasks = trial.tasks; commit(); renderRelationDialog();
}

function removeRelation(index) {
  const item = state.tasks.find((taskItem) => taskItem.id === relationTaskId);
  if (!item) return;
  item.predecessors.splice(index, 1);
  commit();
  renderRelationDialog();
}

function exportProject() {
  const contents = JSON.stringify({ format: "engineering-gantt-v2", exportedAt: new Date().toISOString(), ...state }, null, 2);
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeName = state.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 50) || "工程期程";
  anchor.href = url;
  anchor.download = `${safeName}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("專案資料已匯出");
}

async function importProject(file) {
  try {
    const imported = normalizeProject(JSON.parse(await file.text()));
    const checked = autoSchedule(imported.tasks);
    if (!checked.ok) throw new Error(checked.error);
    imported.tasks = checked.tasks;
    state = imported;
    selectedId = state.tasks[0]?.id || null;
    commit({ message: "專案資料已匯入" });
  } catch (error) {
    showToast(`匯入失敗：${error.message}`);
  } finally {
    elements.importFile.value = "";
  }
}

elements.scheduleGrid.addEventListener("pointerdown", (event) => {
  const row = event.target.closest(".schedule-row[data-id]");
  if (!row) return;
  selectedId = row.dataset.id;
  elements.scheduleGrid.querySelectorAll(".schedule-row.selected").forEach((item) => item.classList.remove("selected"));
  row.classList.add("selected");
  updateButtonStates();
});

elements.scheduleGrid.addEventListener("click", (event) => {
  const row = event.target.closest(".schedule-row[data-id]");
  if (!row) return;
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "collapse") {
    const item = state.tasks.find((taskItem) => taskItem.id === row.dataset.id);
    item.collapsed = !item.collapsed;
    commit();
  }
  if (action === "relations") openRelations(row.dataset.id);
});

elements.scheduleGrid.addEventListener("change", (event) => {
  const field = event.target.dataset.field;
  const row = event.target.closest(".schedule-row[data-id]");
  if (!field || !row) return;
  const item = state.tasks.find((taskItem) => taskItem.id === row.dataset.id);
  const before = structuredClone(state.tasks);
  if (field === "duration") item.duration = Number(event.target.value);
  else if (field === "start") { item.start = event.target.value; item.notBefore = event.target.value; }
  else if (field === "finish") {
    item.duration = inclusiveDuration(item.start, event.target.value);
    if (item.duration === null) { state.tasks = before; showToast("完成日不得早於開始日。"); renderApp(); return; }
  } else item[field] = event.target.value;
  const trial = autoSchedule(state.tasks);
  if (!trial.ok) { state.tasks = before; showToast(trial.error); renderApp(); return; }
  commit();
});

elements.projectName.addEventListener("input", () => {
  state.name = elements.projectName.value || "未命名工程期程";
  saveProject();
});

elements.scaleButtons.addEventListener("click", (event) => {
  const scale = event.target.dataset.scale;
  if (!SCALE_CONFIG[scale] || scale === state.scale) return;
  state.scale = scale;
  commit();
});

$("#addTask").addEventListener("click", addTopLevelTask);
$("#addChild").addEventListener("click", addChildTask);
$("#moveUp").addEventListener("click", () => moveSelected("up"));
$("#moveDown").addEventListener("click", () => moveSelected("down"));
$("#indent").addEventListener("click", indentSelected);
$("#outdent").addEventListener("click", outdentSelected);
$("#deleteTask").addEventListener("click", deleteSelected);
$("#exportButton").addEventListener("click", exportProject);
$("#importButton").addEventListener("click", () => elements.importFile.click());
elements.importFile.addEventListener("change", () => {
  if (elements.importFile.files[0]) importProject(elements.importFile.files[0]);
});
$("#sampleButton").addEventListener("click", () => {
  if (!window.confirm("載入範例會取代目前瀏覽器中的專案資料，是否繼續？")) return;
  state = sampleProject();
  selectedId = state.tasks[0].id;
  commit({ message: "已載入道路工程範例" });
});

elements.addRelation.addEventListener("click", addRelation);
elements.relationList.addEventListener("click", (event) => {
  if (event.target.dataset.action !== "remove-relation") return;
  const index = Number(event.target.closest(".relation-row")?.dataset.index);
  if (Number.isInteger(index)) removeRelation(index);
});
elements.relationList.addEventListener("change", (event) => {
  const row = event.target.closest(".relation-row");
  const field = event.target.dataset.relationField;
  const item = state.tasks.find((taskItem) => taskItem.id === relationTaskId);
  if (!row || !field || !item) return;
  const index = Number(row.dataset.index);
  const value = field === "lag" ? Number(event.target.value) || 0 : event.target.value;
  if (field === "taskId" && item.predecessors.some((relation, relationIndex) => relationIndex !== index && relation.taskId === value)) {
    showToast("同一個前置工項不可重複設定");
    renderRelationDialog();
    return;
  }
  const before = structuredClone(item.predecessors);
  item.predecessors[index][field] = value;
  const trial = autoSchedule(state.tasks);
  if (!trial.ok) { item.predecessors = before; renderRelationDialog(); relationError(trial.error); return; }
  state.tasks = trial.tasks;
  commit(); renderRelationDialog();
});

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => {
    try { void Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch { /* Unsupported preview context. */ }
  };
  register({
    name: "get_schedule_summary",
    title: "讀取工程期程摘要",
    description: "讀取目前甘特圖的專案期間、工項數量、要徑工項及網圖計算工期，不修改資料。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      const display = deriveSummaryDates(state.tasks);
      const cpm = computeCPM(state.tasks);
      const bounds = scheduleBounds(display);
      return {
        project: state.name,
        start: formatDate(bounds.start),
        finish: formatDate(bounds.finish),
        taskCount: state.tasks.filter((item) => !isSummaryTask(item, state.tasks)).length,
        networkDurationDays: cpm.ok ? cpm.projectDuration : null,
        criticalTasks: cpm.ok
          ? state.tasks.filter((item) => cpm.metrics.get(item.id)?.critical).map((item) => item.name)
          : [],
        error: cpm.ok ? null : cpm.error,
      };
    },
  });
  register({
    name: "add_schedule_task",
    title: "新增工程工項",
    description: "在目前工程期程新增一個最下階工項，可指定名稱、起訖日期及上階工項。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        finish: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        parentId: { type: "string" },
      },
      required: ["name", "start", "finish"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input || typeof input.name !== "string" || inclusiveDuration(input.start, input.finish) === null) {
        throw new Error("請提供有效的工項名稱及起訖日期，且完成日不得早於開始日。");
      }
      const parentIndex = input.parentId ? state.tasks.findIndex((item) => item.id === input.parentId) : -1;
      const item = task(uid(), input.name.trim(), parentIndex >= 0 ? state.tasks[parentIndex].level + 1 : 0, input.start, input.finish, [], "");
      const insertAt = parentIndex >= 0 ? taskSubtreeRange(state.tasks, parentIndex).end : state.tasks.length;
      state.tasks.splice(insertAt, 0, item);
      if (parentIndex >= 0) state.tasks[parentIndex].collapsed = false;
      selectedId = item.id;
      commit();
      return { id: item.id, name: item.name, start: item.start, finish: item.finish };
    },
  });
}

setupV2();
renderApp();
registerWebMcpTools();

function relationError(message) { $("#relationError").textContent = message; }
function explainRelation(item, r) {
  const pre = state.tasks.find(t => t.id === r.taskId);
  if (!pre) return "請選擇有效的前置工項。";
  const pd = pre.milestone ? 0 : pre.duration ?? inclusiveDuration(pre.start,pre.finish);
  const d = item.milestone ? 0 : item.duration ?? inclusiveDuration(item.start,item.finish);
  const start = formatDate(addDays(pre.start, relationWeight(r.type,pd,d,Number(r.lag))));
  const end = formatDate(addDays(start,Math.max(1,d)-1));
  const source = r.type[0] === 'F' ? '完成日' : '開始日';
  const target = r.type[1] === 'F' ? '完成日' : '開始日';
  const lag = Number(r.lag);
  const phrase = r.type === 'FS' && !pre.milestone ? `完成隔日起${lag >= 0 ? '延後' : '提前'} ${Math.abs(lag)} 日` : `${source}${lag >= 0 ? '加' : '減'} ${Math.abs(lag)} 日`;
  return `「${pre.name}」${phrase}：本工項${target}不得早於 ${r.type[1] === 'F' ? end : start}。依此條件推算 ${start}～${end}；實際排程須同時滿足其他關係及日期限制。`;
}
function widths() { return state.columnWidths || [44,228,112,112,72,106,62,220]; }
function applyWidths() {
  document.documentElement.style.setProperty('--columns', widths().map(n=>`${n}px`).join(' '));
  document.documentElement.style.setProperty('--left-width',`${widths().reduce((a,b)=>a+b,0)}px`);
}
function fitRows() {
  elements.scheduleGrid.querySelectorAll('.schedule-row[data-id]').forEach(row=>{
    let height = 48;
    row.querySelectorAll('textarea').forEach(el=>{
      el.style.height='0px';
      const contentHeight=Math.max(34,el.scrollHeight+2);
      el.style.height=`${contentHeight}px`;
      height=Math.max(height,contentHeight+12);
    });
    const task=state.tasks.find(t=>t.id===row.dataset.id);
    row.style.minHeight=`${Math.max(height,task?.rowHeight||48)}px`;
  });
}
function refreshArrows() {
  const tasks=deriveSummaryDates(state.tasks);
  drawArrows(timelineModel(tasks,state.scale),tasks);
}
function arrowPaths() {
  return [...elements.scheduleGrid.querySelectorAll('.dependency-path')].map(p=>({d:p.getAttribute('d'),color:p.getAttribute('stroke')}));
}
function drawArrows(model, tasks) {
  elements.scheduleGrid.querySelector('.dependency-layer')?.remove();
  if (!$('#showArrows').checked) return;
  const gridRect = elements.scheduleGrid.getBoundingClientRect();
  const rows = new Map([...elements.scheduleGrid.querySelectorAll('[data-id]')].map(row=>[row.dataset.id,row]));
  const points = new Map();
  rows.forEach((row,id)=>{
    const t=tasks.find(t=>t.id===id), rect=row.getBoundingClientRect();
    const x=widths().reduce((a,b)=>a+b,0)+timelineX(model,t.start);
    points.set(id,{s:x,f:x+(t.milestone?0:timelineBarWidth(model,t)),y:rect.top-gridRect.top+rect.height/2});
  });
  let paths='';
  tasks.forEach(t=>(t.predecessors||[]).forEach(r=>{
    const a=points.get(r.taskId), b=points.get(t.id); if(!a||!b) return;
    const x1=r.type[0]==='F'?a.f:a.s, x2=r.type[1]==='F'?b.f:b.s;
    const bend=Math.max(2,Math.min(x1,x2)-10);
    const d=`M ${x1} ${a.y} L ${bend} ${a.y} L ${bend} ${b.y} L ${x2} ${b.y}`;
    paths+=`<path class="dependency-path" d="${d}" fill="none" stroke="#63819b" stroke-width="1.2" marker-end="url(#arrow)"/>`;
  }));
  elements.scheduleGrid.insertAdjacentHTML('beforeend',`<svg class="dependency-layer" width="${model.width+widths().reduce((a,b)=>a+b,0)}" height="${elements.scheduleGrid.offsetHeight}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#63819b"/></marker></defs>${paths}</svg>`);
}
function setupV2() {
  elements.scheduleGrid.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.bottom .time-resize-handle');if(!handle)return;
    e.preventDefault();
    const scale=state.scale,model=timelineModel(deriveSummaryDates(state.tasks),scale),initial=e.clientX;
    const scroll=$('#scheduleScroll'),scrollLeft=scroll.scrollLeft;
    const move=ev=>{
      state.timelineWidths ||= {};
      state.timelineWidths[scale]=Math.max(24,Math.min(400,model.unitWidth+ev.clientX-initial));
      renderApp();scroll.scrollLeft=scrollLeft;
    };
    const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);commit();};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
  });
  elements.scheduleGrid.addEventListener('dblclick',e=>{
    if(!e.target.closest('.bottom .time-resize-handle'))return;
    if(state.timelineWidths)delete state.timelineWidths[state.scale];commit();
  });
  $('#rangeMode').value=state.rangeMode || 'auto';
  $('#rangeMode').onchange=e=>{state.rangeMode=e.target.value;commit();};
  $('#showArrows').onchange=()=>renderApp();
  $('#reportMode').onchange=e=>document.body.classList.toggle('report-mode',e.target.checked);
  $('#milestoneToggle').onclick=()=>{
    const t=currentTask(); if(!t||isSummaryTask(t,state.tasks)) {showToast('請選擇最下階工項。');return;}
    t.milestone=!t.milestone; t.duration=t.milestone?0:1; commit();
  };
  $('#notBefore').onchange=e=>{
    const t=state.tasks.find(t=>t.id===relationTaskId); if(!t)return;
    t.notBefore=e.target.value; commit();renderRelationDialog();
  };
  $('#downloadPng').onclick=()=>exportImage(false);
  $('#copyPng').onclick=()=>exportImage(true);
  elements.scheduleGrid.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.resize-handle'); if(!handle)return;
    e.preventDefault(); const index=Number(handle.dataset.column), initial=e.clientX, original=widths()[index];
    const move=ev=>{state.columnWidths=[...widths()];state.columnWidths[index]=Math.max(44,Math.min(700,original+ev.clientX-initial));applyWidths();fitRows();refreshArrows();};
    const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);commit();};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);
  });
  elements.scheduleGrid.addEventListener('input',e=>{
    if(!e.target.matches('textarea'))return;
    fitRows();refreshArrows();
  });
  elements.scheduleGrid.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.row-resize-handle');if(!handle)return;
    e.preventDefault();
    const row=handle.closest('[data-id]'),task=state.tasks.find(t=>t.id===row.dataset.id);
    const initial=e.clientY,original=row.getBoundingClientRect().height;
    const move=ev=>{
      task.rowHeight=Math.max(48,Math.min(1200,original+ev.clientY-initial));
      fitRows();refreshArrows();
    };
    const end=()=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);commit();
    };
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
  });
  elements.scheduleGrid.addEventListener('dblclick',e=>{
    const h=e.target.closest('.row-resize-handle');if(!h)return;
    const task=state.tasks.find(t=>t.id===h.closest('[data-id]').dataset.id);
    delete task.rowHeight;commit();
  });
  elements.scheduleGrid.addEventListener('dblclick',e=>{
    const h=e.target.closest('.resize-handle');if(!h)return;
    const i=Number(h.dataset.column), c=document.createElement('canvas').getContext('2d');c.font='13px "Microsoft JhengHei", sans-serif';
    const cells=[...elements.scheduleGrid.querySelectorAll('.task-cell')].map(el=>el.children[i]).filter(Boolean);
    state.columnWidths=[...widths()];state.columnWidths[i]=Math.min(600,Math.max(80,...cells.map(el=>c.measureText(el.querySelector('input,textarea')?.value||el.textContent).width+40)));commit();
  });
}
function wrapText(ctx,text,width) {
  const lines=[]; for(const paragraph of String(text).split('\n')) {
    let line='';for(const ch of paragraph){if(line && ctx.measureText(line+ch).width>width){lines.push(line);line='';}line+=ch;}lines.push(line);
  }return lines;
}
async function exportImage(copy) {
  try {
    const blobPromise=renderPng();
    if(copy && navigator.clipboard?.write && globalThis.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({'image/png':blobPromise})]);showToast('圖片已複製，可貼入 Word 或 PowerPoint');
    } else {
      const blob=await blobPromise, url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=`${state.name.replace(/[\\/:*?"<>|]/g,'-')}-V2.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      showToast(copy?'瀏覽器不支援複製，已改為下載 PNG':'PNG 已下載');
    }
  }catch(e){showToast(`圖片輸出失敗：${e.message}。可嘗試下載 PNG 或改用較大時間尺度。`);}
}
async function renderPng() {
  await document.fonts.ready;
  const tasks=deriveSummaryDates(state.tasks), model=timelineModel(tasks,state.scale), cpm=computeCPM(state.tasks);
  const exportColumns=[0,1,2,3,4,7];
  const left=$('#exportScope').value==='chart'?0:exportColumns.reduce((sum,i)=>sum+widths()[i],0);
  const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d');
  ctx.font='13px "Microsoft JhengHei", sans-serif';
  const rows=visibleTasks(tasks).map(t=>({t, lines:wrapText(ctx,t.notes||'',widths()[7]-16),nameLines:wrapText(ctx,t.name,widths()[1]-20-t.level*16)}));
  rows.forEach(r=>r.h=Math.max(48,r.t.rowHeight||48,(Math.max(r.lines.length,r.nameLines.length))*20+16));
  const w=left+model.width+32,h=rows.reduce((n,r)=>n+r.h,0)+144;
  if(w*2>16000||h*2>16000||w*h*4>60000000)throw new Error('圖面過大，請收合工項或切換至月／季／年尺度');
  canvas.width=Math.ceil(w*2);canvas.height=Math.ceil(h*2);ctx.scale(2,2);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
  ctx.fillStyle='#10233e';ctx.font='bold 20px "Microsoft JhengHei", sans-serif';ctx.fillText(state.name,16,30);
  ctx.font='12px "Microsoft JhengHei", sans-serif';ctx.fillText('一般工項：金色　要徑：紅色　里程碑：◆　工期：日曆天',16,54);
  ctx.translate(16,64);ctx.fillStyle='#183454';ctx.fillRect(0,0,w-32,72);
  if(left){let x=0;['項次','工作項目','開始日期','完成日期','工期','前置關係','浮時','主要控制／說明'].forEach((label,i)=>{if(!exportColumns.includes(i))return;ctx.fillStyle='#fff';ctx.fillText(label,x+6,40);x+=widths()[i];});}
  const header=document.createElement('div');header.innerHTML=timelineHeader(model);
  header.querySelectorAll('.time-segment').forEach(el=>{
    const x=left+parseFloat(el.style.left),sw=parseFloat(el.style.width),top=el.parentElement.classList.contains('top');
    ctx.strokeStyle='#60738a';ctx.strokeRect(x,top?0:36,sw,36);ctx.fillStyle=top?'#f8d88e':'#fff';ctx.save();ctx.beginPath();ctx.rect(x,top?0:36,sw,36);ctx.clip();ctx.fillText(el.textContent,x+Math.max(3,(sw-ctx.measureText(el.textContent).width)/2),top?23:59);ctx.restore();
  });
  let y=72;const coords=new Map(),wbs=wbsNumbers(state.tasks);
  rows.forEach(({t,lines,nameLines,h:rh},i)=>{
    ctx.fillStyle=isSummaryTask(t,tasks)?'#e9eff5':i%2?'#fff':'#f7f9fb';ctx.fillRect(0,y,w-32,rh);
    ctx.strokeStyle='#dce3eb';ctx.strokeRect(0,y,w-32,rh);
    if(left){let x=0;const values=[wbs.get(t.id),nameLines,t.start,t.finish,`${t.milestone?0:inclusiveDuration(t.start,t.finish)}日`,relationLabel(t),`${cpm.metrics.get(t.id)?.totalFloat??'—'}`,lines];
      values.forEach((v,j)=>{if(!exportColumns.includes(j))return;ctx.strokeRect(x,y,widths()[j],rh);ctx.fillStyle='#183454';ctx.save();ctx.beginPath();ctx.rect(x+2,y,widths()[j]-4,rh);ctx.clip();(Array.isArray(v)?v:[v]).forEach((line,k)=>ctx.fillText(String(line),x+6+(j===1?t.level*16:0),y+22+k*20));ctx.restore();x+=widths()[j];});}
    header.querySelectorAll('.bottom .time-segment').forEach(el=>{const x=left+parseFloat(el.style.left);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y+rh);ctx.stroke();});
    const x=left+timelineX(model,t.start),bw=t.milestone?0:timelineBarWidth(model,t);
    coords.set(t.id,{s:x,f:x+bw,y:y+rh/2});y+=rh;
  });
  if($('#showArrows').checked)rows.forEach(({t})=>(t.predecessors||[]).forEach(r=>{
    const a=coords.get(r.taskId),b=coords.get(t.id);if(!a||!b)return;const x1=r.type[0]==='F'?a.f:a.s,x2=r.type[1]==='F'?b.f:b.s,bend=Math.max(left+1,Math.min(x1,x2)-10);
    ctx.strokeStyle='#63819b';ctx.beginPath();ctx.moveTo(x1,a.y);ctx.lineTo(bend,a.y);ctx.lineTo(bend,b.y);ctx.lineTo(x2,b.y);ctx.stroke();ctx.beginPath();ctx.moveTo(x2-5,b.y-3);ctx.lineTo(x2,b.y);ctx.lineTo(x2-5,b.y+3);ctx.stroke();
  }));
  rows.forEach(({t})=>{const c=coords.get(t.id);ctx.fillStyle=cpm.metrics.get(t.id)?.critical?'#c83f43':'#f0a51a';
    if(t.milestone){ctx.beginPath();ctx.moveTo(c.s,c.y-7);ctx.lineTo(c.s+7,c.y);ctx.lineTo(c.s,c.y+7);ctx.lineTo(c.s-7,c.y);ctx.closePath();ctx.fill();}
    else if(isSummaryTask(t,tasks)){ctx.fillStyle='#365b78';ctx.fillRect(c.s,c.y-3,c.f-c.s,6);ctx.fillRect(c.s,c.y-3,3,12);ctx.fillRect(c.f-3,c.y-3,3,12);}
    else ctx.fillRect(c.s,c.y-10,Math.max(2,c.f-c.s),20);
  });
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('無法產生圖片')),'image/png'));
}
