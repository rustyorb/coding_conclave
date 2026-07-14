export function createRefreshScheduler(refresh, { delay = 90, onError = () => {} } = {}) {
  let timer = null;
  let running = false;
  let requested = false;

  const run = async () => {
    timer = null;
    if (running || !requested) return;
    requested = false;
    running = true;
    try {
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (requested) schedule();
    }
  };

  function schedule() {
    requested = true;
    if (!timer && !running) timer = setTimeout(run, delay);
  }

  function cancel() {
    clearTimeout(timer);
    timer = null;
    requested = false;
  }

  return { schedule, cancel };
}
