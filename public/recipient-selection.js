const installedIds = (agents) => agents
  .filter((agent) => agent.status === 'installed')
  .map((agent) => agent.id);

export function createRecipientSelection() {
  const selectedIds = new Set();
  let mode = 'everyone';

  function sync(agents) {
    const available = installedIds(agents);
    const availableSet = new Set(available);

    if (mode === 'everyone') {
      selectedIds.clear();
      available.forEach((id) => selectedIds.add(id));
    } else {
      for (const id of selectedIds) {
        if (!availableSet.has(id)) selectedIds.delete(id);
      }
    }

    return snapshot();
  }

  function select(target, agents) {
    sync(agents);
    const available = new Set(installedIds(agents));

    if (target === 'room') {
      mode = 'custom';
      selectedIds.clear();
    } else if (target === 'everyone') {
      if (mode === 'everyone') {
        mode = 'custom';
        selectedIds.clear();
      } else {
        mode = 'everyone';
        selectedIds.clear();
        available.forEach((id) => selectedIds.add(id));
      }
    } else if (available.has(target)) {
      mode = 'custom';
      if (selectedIds.has(target)) selectedIds.delete(target);
      else selectedIds.add(target);
    }

    return snapshot();
  }

  function snapshot() {
    return {
      selectedIds: [...selectedIds],
      everyoneActive: mode === 'everyone' && selectedIds.size > 0
    };
  }

  return { select, sync, snapshot };
}
