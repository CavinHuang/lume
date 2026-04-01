process.stdin.setEncoding("utf8");
process.stdin.resume();
console.error(
  `[echo-sidecar] booted pid=${process.pid} isTTY=${String(process.stdin.isTTY)} readable=${String(process.stdin.readable)}`
);

let buffer = "";

process.stdin.on("data", (chunk) => {
  console.error(`[echo-sidecar] stdin data bytes=${Buffer.byteLength(chunk, "utf8")}`);
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    console.error(`[echo-sidecar] stdin line=${line}`);

    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      console.error("[echo-sidecar] bad json");
      process.stdout.write(JSON.stringify({ error: { message: "bad json" } }) + "\n");
      continue;
    }

    console.error(`[echo-sidecar] stdout response id=${String(payload.id)}`);
    process.stdout.write(
      JSON.stringify({
        id: payload.id,
        result: {
          ok: true,
          echoMethod: payload.method ?? null
        }
      }) + "\n"
    );
  }
});

process.stdin.on("end", () => {
  console.error("[echo-sidecar] stdin end");
});
