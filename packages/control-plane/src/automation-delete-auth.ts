/**
 * Authorization for automation soft-delete (option 3: creator OR delete-admin).
 */

import type { AutomationRow } from "./db/automation-store";
import { UserStore } from "./db/user-store";
import type { Env } from "./types";

export interface AutomationDeleteActor {
  scmUserId?: string;
  scmLogin?: string;
  userId?: string;
}

function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

export function parseAutomationDeleteAdmins(env: Env): string[] {
  const raw = env.AUTOMATION_DELETE_ADMINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => normalizeLogin(item))
    .filter(Boolean);
}

function isDeleteAdmin(env: Env, scmLogin: string | undefined): boolean {
  if (!scmLogin) return false;
  const admins = parseAutomationDeleteAdmins(env);
  if (admins.length === 0) return false;
  return admins.includes(normalizeLogin(scmLogin));
}

function matchesLegacyCreatedBy(automation: AutomationRow, actor: AutomationDeleteActor): boolean {
  if (automation.user_id) return false;
  const createdBy = automation.created_by.trim().toLowerCase();
  if (!createdBy) return false;

  const candidates = [actor.userId, actor.scmUserId, actor.scmLogin]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());

  return candidates.some((candidate) => candidate === createdBy);
}

export async function canDeleteAutomation(
  env: Env,
  db: D1Database,
  automation: AutomationRow,
  actor: AutomationDeleteActor
): Promise<boolean> {
  if (isDeleteAdmin(env, actor.scmLogin)) {
    return true;
  }

  if (actor.scmUserId) {
    const identity = await new UserStore(db).getIdentity("github", actor.scmUserId);
    if (identity && automation.user_id && identity.userId === automation.user_id) {
      return true;
    }
  }

  if (matchesLegacyCreatedBy(automation, actor)) {
    return true;
  }

  return false;
}

export function parseAutomationDeleteActorFromSearchParams(
  searchParams: URLSearchParams
): AutomationDeleteActor {
  return {
    scmUserId: searchParams.get("scmUserId") ?? undefined,
    scmLogin: searchParams.get("scmLogin") ?? undefined,
    userId: searchParams.get("actorUserId") ?? undefined,
  };
}
