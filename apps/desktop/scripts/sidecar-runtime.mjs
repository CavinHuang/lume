export function shellQuote(value) {
  return JSON.stringify(value);
}

export function buildMacSidecarCommand(options) {
  const {
    nodeBin = "node",
    bunBin,
    sidecarDir,
    entry,
    bridgePath,
    echoMode = false
  } = options;

  if (echoMode) {
    return `exec ${shellQuote(bunBin)} ${shellQuote(entry)}`;
  }

  return [
    "exec",
    shellQuote(nodeBin),
    shellQuote(bridgePath),
    "--bun",
    shellQuote(bunBin),
    "--cwd",
    shellQuote(sidecarDir),
    "--entry",
    shellQuote(entry)
  ].join(" ");
}
