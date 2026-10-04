import { createSocket } from "node:dgram";
import type { DB } from "../db.js";
import { SYNCED_TABLES } from "./enable.js";
import { getSyncValue, isSyncEnabled } from "./state.js";

// Push on write (spec D4, collab E-720/E-722). A connection that writes a
// shared DB tells the courier "something changed" with one UDP byte to
// 127.0.0.1:<courier_port>. TEMP triggers (this connection only, never stored
// in the file) call a JS function registered on this connection, so every
// write path is covered: core ops, raw SQL, scripts. The ping is only a hint:
// the courier always pushes everything since its bookmark, so a lost ping
// costs delay, never data. It never blocks or fails a save.

/** sync_state key (local-only): the UDP port the courier listens on. Written by the courier. */
export const COURIER_PORT_KEY = "courier_port";
const FN = "collab_sync_ping";
const EVENTS = ["insert", "update", "delete"] as const;
const installed = new WeakSet<DB>();

export function readCourierPort(db: DB): number | null {
  const v = Number(getSyncValue(db, COURIER_PORT_KEY));
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : null;
}

/** Fire-and-forget. The socket stays referenced until the send completes, so a script that ends normally still gets it out. */
export function sendCourierPing(port: number): void {
  const sock = createSocket("udp4");
  const close = () => { try { sock.close(); } catch { /* already closed */ } };
  sock.on("error", close);
  try { sock.send(Buffer.from([1]), port, "127.0.0.1", close); } catch { close(); }
}

/** Installs the hook on a connection to a shared DB. false = sharing is off, nothing installed. */
export function installSyncPing(db: DB): boolean {
  if (installed.has(db)) return true;
  if (!isSyncEnabled(db)) return false;
  let port = readCourierPort(db);
  let queued = false;
  const fire = (): void => {
    // Triggers fire inside the transaction: wait for it to end (COMMIT or ROLLBACK).
    if (db.open && db.inTransaction) { setTimeout(fire, 25); return; }
    queued = false;
    if (db.open) { try { port = readCourierPort(db); } catch { /* keep the last known port */ } }
    if (port) sendCourierPing(port);
  };
  db.function(FN, { deterministic: false }, () => {
    if (!queued) { queued = true; setImmediate(fire); }
    return null;
  });
  for (const t of SYNCED_TABLES) {
    for (const ev of EVENTS) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${FN}_${t}_${ev} AFTER ${ev.toUpperCase()} ON main.${t} BEGIN SELECT ${FN}(); END`);
    }
  }
  installed.add(db);
  return true;
}
