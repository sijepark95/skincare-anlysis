/** Synthetic local-server fixture; starts no Torch/model/data access. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const pointer = path.join(root, ".local/ml-workspace.json");
let python =
  process.env.SENMIVA_TEST_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
if (!process.env.SENMIVA_TEST_PYTHON && existsSync(pointer)) {
  const workspace = JSON.parse(readFileSync(pointer, "utf8")).workspace_path;
  const candidate = path.join(
    workspace,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if (existsSync(candidate)) python = candidate;
}
const child = spawn(
  python,
  ["-u", path.join(root, "ml/tests/browser/serve_fixture.py")],
  {
    cwd: root,
    env: { ...process.env, PYTHONPATH: path.join(root, "ml/src") },
    stdio: "inherit",
    windowsHide: true,
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill());
child.on("error", () => {
  process.stderr.write("Synthetic photo-test fixture could not start.\n");
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
