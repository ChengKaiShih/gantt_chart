const DAY_MS = 86_400_000;

export const RELATION_TYPES = ["FS", "SS", "FF", "SF"];

export function parseDate(value) {
  if (!value || typeof value !== "string") return null;
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

export function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function addDays(value, days) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return null;
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(start, finish) {
  const a = start instanceof Date ? start : parseDate(start);
  const b = finish instanceof Date ? finish : parseDate(finish);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export function inclusiveDuration(start, finish) {
  const distance = daysBetween(start, finish);
  return distance === null || distance < 0 ? null : distance + 1;
}

export function isSummaryTask(task, tasks) {
  const index = tasks.findIndex((item) => item.id === task.id);
  const next = tasks[index + 1];
  return Boolean(next && next.level > task.level);
}

export function taskSubtreeRange(tasks, index) {
  const level = tasks[index]?.level ?? 0;
  let end = index + 1;
  while (end < tasks.length && tasks[end].level > level) end += 1;
  return { start: index, end };
}

export function deriveSummaryDates(tasks) {
  const output = tasks.map((task) => ({ ...task }));
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const task = output[index];
    const { end } = taskSubtreeRange(output, index);
    if (end === index + 1) continue;
    const descendants = output.slice(index + 1, end).filter((item) => {
      const duration = inclusiveDuration(item.start, item.finish);
      return duration !== null;
    });
    if (!descendants.length) continue;
    task.start = descendants.reduce(
      (minimum, item) => (!minimum || item.start < minimum ? item.start : minimum),
      "",
    );
    task.finish = descendants.reduce(
      (maximum, item) => (!maximum || item.finish > maximum ? item.finish : maximum),
      "",
    );
  }
  return output;
}

function relationWeight(type, predecessorDuration, successorDuration, lag) {
  switch (type) {
    case "SS": return lag;
    case "FF": return predecessorDuration + lag - successorDuration;
    case "SF": return lag - successorDuration;
    case "FS":
    default: return predecessorDuration + lag;
  }
}

export function computeCPM(tasks) {
  const leaves = tasks.filter((task) => !isSummaryTask(task, tasks));
  const usable = leaves.filter((task) => inclusiveDuration(task.start, task.finish) !== null);
  const byId = new Map(usable.map((task) => [task.id, task]));
  const durations = new Map(
    usable.map((task) => [task.id, inclusiveDuration(task.start, task.finish)]),
  );
  const incoming = new Map(usable.map((task) => [task.id, []]));
  const outgoing = new Map(usable.map((task) => [task.id, []]));
  const indegree = new Map(usable.map((task) => [task.id, 0]));
  const ignoredRelations = [];

  usable.forEach((task) => {
    (task.predecessors || []).forEach((relation) => {
      const predecessor = byId.get(relation.taskId);
      if (!predecessor || predecessor.id === task.id) {
        ignoredRelations.push({ taskId: task.id, relation });
        return;
      }
      const type = RELATION_TYPES.includes(relation.type) ? relation.type : "FS";
      const lag = Number.isFinite(Number(relation.lag)) ? Number(relation.lag) : 0;
      const edge = {
        from: predecessor.id,
        to: task.id,
        type,
        lag,
        weight: relationWeight(
          type,
          durations.get(predecessor.id),
          durations.get(task.id),
          lag,
        ),
      };
      incoming.get(task.id).push(edge);
      outgoing.get(predecessor.id).push(edge);
      indegree.set(task.id, indegree.get(task.id) + 1);
    });
  });

  const order = [];
  const queue = usable
    .filter((task) => indegree.get(task.id) === 0)
    .map((task) => task.id);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    outgoing.get(id).forEach((edge) => {
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    });
  }

  if (order.length !== usable.length) {
    return {
      ok: false,
      error: "前置關係形成循環，請移除相互依賴的設定。",
      metrics: new Map(),
      projectDuration: 0,
      ignoredRelations,
      conflicts: [],
    };
  }

  const earliest = new Map(usable.map((task) => [task.id, 0]));
  order.forEach((id) => {
    incoming.get(id).forEach((edge) => {
      earliest.set(id, Math.max(earliest.get(id), earliest.get(edge.from) + edge.weight));
    });
  });

  let minimumStart = Math.min(
    ...usable.map((task) => parseDate(task.start)?.getTime() ?? Number.POSITIVE_INFINITY),
  );
  if (!Number.isFinite(minimumStart)) minimumStart = Date.now();
  const projectDuration = Math.max(
    0,
    ...usable.map((task) => earliest.get(task.id) + durations.get(task.id)),
  );
  const latest = new Map(
    usable.map((task) => [task.id, projectDuration - durations.get(task.id)]),
  );
  [...order].reverse().forEach((id) => {
    outgoing.get(id).forEach((edge) => {
      latest.set(id, Math.min(latest.get(id), latest.get(edge.to) - edge.weight));
    });
  });

  const metrics = new Map();
  usable.forEach((task) => {
    const duration = durations.get(task.id);
    const es = earliest.get(task.id);
    const ls = latest.get(task.id);
    metrics.set(task.id, {
      duration,
      es,
      ef: es + duration,
      ls,
      lf: ls + duration,
      totalFloat: ls - es,
      critical: Math.abs(ls - es) < 1e-9,
      calculatedStart: formatDate(new Date(minimumStart + es * DAY_MS)),
      calculatedFinish: formatDate(new Date(minimumStart + (es + duration - 1) * DAY_MS)),
    });
  });

  const conflicts = [];
  usable.forEach((task) => {
    const taskStart = parseDate(task.start);
    if (!taskStart) return;
    incoming.get(task.id).forEach((edge) => {
      const predecessor = byId.get(edge.from);
      const predecessorStart = parseDate(predecessor.start);
      if (!predecessorStart) return;
      const actualGap = daysBetween(predecessorStart, taskStart);
      if (actualGap < edge.weight) {
        conflicts.push({
          taskId: task.id,
          predecessorId: predecessor.id,
          requiredStart: formatDate(addDays(predecessorStart, edge.weight)),
          type: edge.type,
          lag: edge.lag,
        });
      }
    });
  });

  return {
    ok: true,
    metrics,
    projectDuration,
    ignoredRelations,
    conflicts,
  };
}

export function visibleTasks(tasks) {
  const hiddenLevels = [];
  return tasks.filter((task) => {
    while (hiddenLevels.length && hiddenLevels.at(-1) >= task.level) hiddenLevels.pop();
    const hidden = hiddenLevels.length > 0;
    if (!hidden && task.collapsed) hiddenLevels.push(task.level);
    return !hidden;
  });
}

export function scheduleBounds(tasks) {
  const valid = tasks.filter((task) => inclusiveDuration(task.start, task.finish) !== null);
  if (!valid.length) {
    const today = new Date();
    const start = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
    return { start, finish: addDays(start, 90) };
  }
  const minimum = valid.reduce((value, task) => (task.start < value ? task.start : value), valid[0].start);
  const maximum = valid.reduce((value, task) => (task.finish > value ? task.finish : value), valid[0].finish);
  return { start: parseDate(minimum), finish: parseDate(maximum) };
}
