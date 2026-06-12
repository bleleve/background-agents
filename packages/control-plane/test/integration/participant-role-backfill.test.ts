import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { initSession, queryDO } from "./helpers";
import { MIGRATIONS } from "../../src/session/schema";
import type { SqlStorage } from "../../src/session/repository";
import type { SessionDO } from "../../src/session/durable-object";

const backfill = MIGRATIONS.find((m) => m.id === 35);
if (!backfill || typeof backfill.run !== "function") {
  throw new Error("migration 35 (participant role backfill) is missing or not a function");
}
const runBackfill = backfill.run as (sql: SqlStorage) => void;

describe("migration 35: demote viewer-like members to viewer", () => {
  it("demotes members with no messages but keeps owners, real members, system, and viewers", async () => {
    // initSession creates the owner (user-1) and runs all migrations.
    const { stub } = await initSession({ userId: "user-1", scmLogin: "owner-user" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const sql = instance.ctx.storage.sql;
      const insertParticipant = (id: string, userId: string, role: string) =>
        sql.exec(
          "INSERT INTO participants (id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
          id,
          userId,
          role,
          1
        );

      // Pre-fix state: ws-token used to create viewers as "member".
      insertParticipant("p-ghost", "user-ghost", "member"); // never prompted -> viewer
      insertParticipant("p-real", "user-real", "member"); // authored a prompt -> stays member
      insertParticipant("p-system", "system", "member"); // system user -> untouched
      insertParticipant("p-viewer", "user-viewer", "viewer"); // already a viewer -> unchanged

      // A message authored by p-real makes it a genuine participant.
      sql.exec(
        "INSERT INTO messages (id, author_id, content, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        "m-1",
        "p-real",
        "fix the bug",
        "web",
        "completed",
        2
      );

      // Run twice to assert idempotency.
      runBackfill(sql as unknown as SqlStorage);
      runBackfill(sql as unknown as SqlStorage);
    });

    const rows = await queryDO<{ id: string; user_id: string; role: string }>(
      stub,
      "SELECT id, user_id, role FROM participants"
    );
    const roleById = Object.fromEntries(rows.map((r) => [r.id, r.role]));

    expect(roleById["p-ghost"]).toBe("viewer");
    expect(roleById["p-real"]).toBe("member");
    expect(roleById["p-system"]).toBe("member");
    expect(roleById["p-viewer"]).toBe("viewer");

    // The session owner must never be demoted.
    const owner = rows.find((r) => r.user_id === "user-1");
    expect(owner?.role).toBe("owner");
  });
});
