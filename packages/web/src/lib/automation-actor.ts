import type { Session } from "next-auth";

export function buildAutomationActorQueryParams(session: Session): URLSearchParams {
  const params = new URLSearchParams();
  const user = session.user;
  if (!user) return params;

  if (user.id) params.set("scmUserId", user.id);
  if (user.login) params.set("scmLogin", user.login);

  const actorUserId = user.id || user.email;
  if (actorUserId) params.set("actorUserId", actorUserId);

  return params;
}

export function buildAutomationDeleteBody(session: Session): {
  scmUserId?: string;
  scmLogin?: string;
  userId: string;
} {
  const user = session.user!;
  return {
    scmUserId: user.id,
    scmLogin: user.login,
    userId: user.id || user.email || "anonymous",
  };
}
