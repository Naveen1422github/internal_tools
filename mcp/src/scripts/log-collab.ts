import { getDb, migrate, addEntryAsync, initModule, closeDb, type EntryType, type Category, formatEntryRef } from "@collab-mcp/core";

const [type, title, summary, description, moduleName, category, status] = process.argv.slice(2);

if (!type || !title || !summary) {
  console.error("Usage: tsx log-collab.ts <type> <title> <summary> [description] [moduleName] [category] [status]");
  process.exit(1);
}

// Same DB resolution as every other entry point (COLLAB_DB_PATH), never ./collab.db (E-550, E-689).
const db = getDb();
try {
  migrate(db);
  if (moduleName && !db.prepare("SELECT 1 FROM modules WHERE slug = ?").get(moduleName)) {
    initModule(db, { slug: moduleName, name: moduleName });
    console.log(`Created placeholder module: ${moduleName}`);
  }
  const { id } = await addEntryAsync(db, {
    type: type as EntryType,
    title,
    summary,
    description: description || undefined,
    status: (status as "draft" | "active") || "active",
    agent: "Gemini",
    module: moduleName || undefined,
    category: (category as Category) || undefined,
  });
  console.log(`Inserted entry ${formatEntryRef(id)}`);
} catch (e) {
  console.error("Error logging to DB:", e);
  process.exitCode = 1;
} finally {
  closeDb();
}
