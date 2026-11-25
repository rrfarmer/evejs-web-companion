"use strict";

const Database = require("better-sqlite3");

/** SQLite supplies durable commits inside the existing plugin permission model. */
function createDocumentStore(filePath) {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec("CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const select = db.prepare("SELECT value FROM documents WHERE name = ?");
  const put = db.prepare(
    "INSERT INTO documents (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
  );
  const remove = db.prepare("DELETE FROM documents WHERE name = ?");
  const removePrefix = db.prepare("DELETE FROM documents WHERE substr(name, 1, length(?)) = ?");
  const names = db.prepare("SELECT name FROM documents WHERE substr(name, 1, length(?)) = ?");
  return {
    document(name) {
      return {
        read() {
          const row = select.get(name);
          return row ? JSON.parse(row.value) : null;
        },
        write(value) {
          put.run(name, JSON.stringify(value));
        },
      };
    },
    transaction(action) {
      return db.transaction(action)();
    },
    documentNames(prefix) {
      return names.all(prefix, prefix).map((row) => row.name);
    },
    deleteDocuments(names, prefixes) {
      for (const name of names) remove.run(name);
      for (const prefix of prefixes) removePrefix.run(prefix, prefix);
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createDocumentStore };
