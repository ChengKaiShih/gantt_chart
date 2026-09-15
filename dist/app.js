import {
  RELATION_TYPES,
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
  if (scale === "day") {
    start = startOfMonth(bounds.start);
    finish = endOfMonth(bounds.finish);
  } else if (scale === "week") {
    start = startOfWeek(addDays(bounds.start, -config.pad));
    finish = addDays(startOfWeek(addDays(bounds.finish, config.pad)), 6);
  } else {
    start = startOfYear(addDays(bounds.start, -config.pad));
    finish = endOfYear(addDays(bounds.finish, config.pad));
  }
  const totalDays = daysBetween(start, finish) + 1;
  const width = Math.max(760, Math.ceil(totalDays * config.pxPerDay));
  const actualPxPerDay = width / totalDays;
  return { ...config, scale, start, finish, totalDays, width, pxPerDay: actualPxPerDay };
}

function monthLabel(date) {
  return `${date.getUTCMonth() + 1}月`;
}

function segment(start, finishExclusive, model, label) {
  const leftDays = daysBetween(model.start, start);
  const widthDays = daysBetween(start, finishExclusive);
  const left = Math.max(0, leftDays * model.pxPerDay);
  const right = Math.min(model.width, (leftDays + widthDays) * model.pxPerDay);
  if (right <= left) return "";
  return `<span class="time-segment" style="left:${left}px;width:${right - left}px">${escapeHtml(label)}</span>`;
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
    .map((label) => `<span>${label}</span>`)
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
    ? `<span class="today-line" style="left:${todayOffset * model.pxPerDay}px" title="今天"></span>`
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
    const duration = inclusiveDuration(item.start, item.finish);
    const selected = item.id === selectedId;
    const conflict = conflictIds.has(item.id);
    const collapseControl = summary
      ? `<button class="collapse-button" type="button" data-action="collapse" title="${raw.collapsed ? "展開" : "收合"}">${raw.collapsed ? "▸" : "▾"}</button>`
      : `<span class="collapse-spacer"></span>`;
    const calculated = metric
      ? `系統計算：${metric.calculatedStart}～${metric.calculatedFinish}；總浮時 ${metric.totalFloat} 日`
      : "";
    const floatText = summary || !metric ? "—" : `${metric.totalFloat}日`;
    const barLeft = duration === null ? 0 : daysBetween(model.start, parseDate(item.start)) * model.pxPerDay;
    const barWidth = duration === null ? 0 : Math.max(3, duration * model.pxPerDay);
    const barClass = summary ? "summary" : metric?.critical ? "critical" : "";
    const bar = duration === null
      ? ""
      : `<span class="gantt-bar ${barClass}" style="left:${barLeft}px;width:${barWidth}px" title="${escapeHtml(item.name)}｜${item.start}～${item.finish}｜${duration}日${calculated ? `｜${calculated}` : ""}"></span>`;
    html += `
      <div class="schedule-row ${selected ? "selected" : ""} ${summary ? "summary-row" : ""} ${conflict ? "conflict-row" : ""}" data-id="${escapeHtml(item.id)}" style="--timeline-width:${model.width}px">
        <div class="task-cell">
          <div class="row-number">${escapeHtml(wbs.get(item.id))}</div>
          <div class="task-name-wrap" style="padding-left:${5 + item.level * 18}px">
            ${collapseControl}
            <input class="task-input" data-field="name" value="${escapeHtml(item.name)}" aria-label="工項名稱" />
            ${conflict ? `<span class="warning-mark" title="計畫日期與前置關係衝突">!</span>` : ""}
          </div>
          <div><input class="date-input" type="date" data-field="start" value="${escapeHtml(item.start)}" ${summary ? "disabled" : ""} aria-label="開始日期" /></div>
          <div><input class="date-input" type="date" data-field="finish" value="${escapeHtml(item.finish)}" ${summary ? "disabled" : ""} aria-label="完成日期" /></div>
          <div class="duration-cell">${duration === null ? "—" : `${duration}日`}</div>
          <div class="relation-cell"><button class="relation-button" type="button" data-action="relations" ${summary ? "disabled" : ""}>${summary ? "彙整" : escapeHtml(relationLabel(raw))}</button></div>
          <div class="float-cell ${metric?.critical ? "critical-text" : ""}" title="${escapeHtml(calculated)}">${floatText}</div>
          <div><input class="note-input" data-field="notes" value="${escapeHtml(raw.notes)}" aria-label="主要控制或說明" /></div>
        </div>
        <div class="timeline-cell" style="--grid-size:${primaryDays * model.pxPerDay}px;--minor-grid-size:${minorDays * model.pxPerDay}px">
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
  const displayTasks = deriveSummaryDates(state.tasks);
  const cpm = computeCPM(state.tasks);
  elements.projectName.value = state.name;
  elements.scaleButtons.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.scale === state.scale);
  });
  renderSummary(displayTasks, cpm);
  renderAlert(cpm);
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
  selectedId = item.id;
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
  selectedId = item.id;
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
  saveProject();
  renderRelationDialog();
  renderApp();
}

function removeRelation(index) {
  const item = state.tasks.find((taskItem) => taskItem.id === relationTaskId);
  if (!item) return;
  item.predecessors.splice(index, 1);
  saveProject();
  renderRelationDialog();
  renderApp();
}

function exportProject() {
  const contents = JSON.stringify({ format: "engineering-gantt-v1", exportedAt: new Date().toISOString(), ...state }, null, 2);
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
  item[field] = event.target.value;
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
  item.predecessors[index][field] = value;
  saveProject();
  renderApp();
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

renderApp();
registerWebMcpTools();
