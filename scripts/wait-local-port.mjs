const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);

try {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(2500),
    redirect: "manual",
  });
  process.exit(response.status >= 200 && response.status < 500 ? 0 : 1);
} catch {
  process.exit(1);
}
