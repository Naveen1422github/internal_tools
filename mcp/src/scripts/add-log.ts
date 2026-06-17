import { getDb, addEntry } from "@collab-mcp/core";

const [type, title, summary, description, moduleName] = process.argv.slice(2);

if (!type || !title || !summary) {
  console.error("Usage: tsx add-log.ts <type> <title> <summary> [description] [moduleName]");
  process.exit(1);
}

try {
  const db = getDb();
  const res = addEntry(db, {
    type: type as any,
    title,
    summary,
    description: description || undefined,
    module: moduleName || "workspace-redesign",
    agent: "Gemini",
  });
  console.log("Logged entry:", res);
} catch (e) {
  console.error("Failed to log entry:", e);
  process.exit(1);
}
