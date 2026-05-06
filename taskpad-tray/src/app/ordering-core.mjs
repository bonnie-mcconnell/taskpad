const DEFAULT_RENORM_GAP = 0.01;
const DEFAULT_RENORM_STEP = 100;

export function orderValue(task) {
  return task.order ?? task.createdAt;
}

export function sortedUndoneInPriority(tasks, priority, excludeId = null) {
  return tasks
    .filter(t => t.priority === priority && !t.done && (excludeId == null || t.id !== excludeId))
    .sort((a, b) => orderValue(a) - orderValue(b));
}

export function moveWithinPriority(tasks, id, direction) {
  const task = tasks.find(t => t.id === id);
  if (!task || task.done) return { moved: false, reason: 'missing-or-done' };

  const active = sortedUndoneInPriority(tasks, task.priority);
  const index = active.findIndex(t => t.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= active.length) {
    return { moved: false, reason: 'out-of-range' };
  }

  const other = active[targetIndex];
  const original = orderValue(task);
  task.order = orderValue(other);
  other.order = original;

  return { moved: true, priority: task.priority };
}

export function applyDropOrdering(tasks, targetPriority, id, insertBeforeId = null, insertAfterId = null) {
  const task = tasks.find(t => t.id === id);
  if (!task) return { moved: false, reason: 'missing' };

  const oldPriority = task.priority;
  task.priority = targetPriority;

  const undone = sortedUndoneInPriority(tasks, targetPriority, id);
  const before = insertBeforeId == null ? null : tasks.find(t => t.id === insertBeforeId);
  const after = insertAfterId == null ? null : tasks.find(t => t.id === insertAfterId);

  let orderAssigned = false;

  if (before) {
    const idx = undone.findIndex(t => t.id === before.id);
    if (idx >= 0) {
      const prev = idx > 0 ? undone[idx - 1] : null;
      task.order = prev ? (orderValue(prev) + orderValue(before)) / 2 : orderValue(before) - 1;
      orderAssigned = true;
    }
  }

  if (!orderAssigned && after) {
    const idx = undone.findIndex(t => t.id === after.id);
    if (idx >= 0) {
      const next = idx < undone.length - 1 ? undone[idx + 1] : null;
      task.order = next ? (orderValue(after) + orderValue(next)) / 2 : orderValue(after) + 1;
      orderAssigned = true;
    }
  }

  if (!orderAssigned) {
    task.order = undone.length > 0 ? orderValue(undone[undone.length - 1]) + 1 : 1;
  }

  renormalizePriority(tasks, targetPriority, DEFAULT_RENORM_GAP, DEFAULT_RENORM_STEP);

  return {
    moved: true,
    oldPriority,
    newPriority: targetPriority,
  };
}

export function renormalizePriority(tasks, priority, minGap = DEFAULT_RENORM_GAP, step = DEFAULT_RENORM_STEP) {
  const allUndone = sortedUndoneInPriority(tasks, priority);
  if (allUndone.length < 2) return false;

  let gap = Infinity;
  for (let i = 1; i < allUndone.length; i += 1) {
    const currentGap = orderValue(allUndone[i]) - orderValue(allUndone[i - 1]);
    if (currentGap < gap) gap = currentGap;
  }

  if (gap >= minGap) return false;

  allUndone.forEach((t, i) => {
    t.order = (i + 1) * step;
  });
  return true;
}
