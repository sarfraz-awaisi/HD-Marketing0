// Stop accepting requests; give already accepted writes time to finish.
export function gracefulShutdown(
  server,
  lifecycle,
  {
    signals = process,
    timeout = 300000,
    exit = (code) => process.exit(code),
  } = {},
) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    lifecycle.draining = true;
    const deadline = setTimeout(() => exit(1), timeout);
    deadline.unref?.();
    server.close(() => {
      clearTimeout(deadline);
      exit(0);
    });
    server.closeIdleConnections?.();
  };
  signals.once("SIGTERM", stop);
  signals.once("SIGINT", stop);
  return stop;
}
