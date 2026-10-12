import { readFile } from "node:fs/promises";
const areas = {
  brand: ["design-system/aelune/MASTER.md", "docs/AELUNE-PRODUCTION.md"],
  ui: ["design-system/senmiva/MASTER.md", "docs/DESIGN-PRINCIPLES.md"],
  database: ["docs/SUPABASE-SETUP.md", "docs/DATABASE.md"],
  ml: ["docs/ML-PLAN.md", "services/analysis/README.md"],
  llm: ["docs/LLM-SETUP.md"],
  vision: ["docs/VISION-COMPARISON.md"],
  skin: ["docs/OPENAI-SKIN-SETUP.md", "services/analysis/README.md"],
  color: ["docs/PERSONAL-COLOR.md"],
  beauty: ["docs/BEAUTY-CONTEXT.md", "design-system/aelune/BEAUTY-KIOSK.md"],
  architecture: ["docs/ARCHITECTURE.md"],
};
const area = process.argv[2];
if (area && !areas[area]) {
  process.stderr.write(
    "Choose brand, ui, database, ml, llm, vision, skin, color, beauty or architecture.\n",
  );
  process.exitCode = 1;
} else {
  for (const path of [
    "AGENTS.md",
    "docs/STATUS.md",
    ...(area ? areas[area] : []),
  ]) {
    try {
      process.stdout.write(`\n${path}\n${await readFile(path, "utf8")}\n`);
    } catch {
      process.stderr.write(`Missing context file: ${path}\n`);
      process.exitCode = 1;
    }
  }
}
