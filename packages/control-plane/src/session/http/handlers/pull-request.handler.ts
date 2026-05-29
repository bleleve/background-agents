import type { CreatePullRequestInput, CreatePullRequestResult } from "../../pull-request-service";
import type { ParticipantRow, SessionRow } from "../../types";

interface CreatePrRequest {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch?: string;
}

type PromptingParticipantResult =
  | { participant: ParticipantRow; error?: never; status?: never }
  | { participant?: never; error: string; status: number };

export interface PullRequestHandlerDeps {
  getSession: () => SessionRow | null;
  getPromptingParticipantForPR: () => Promise<PromptingParticipantResult>;
  getSessionUrl: (session: SessionRow) => string;
  createPullRequest: (input: CreatePullRequestInput) => Promise<CreatePullRequestResult>;
}

export interface PullRequestHandler {
  createPr: (request: Request) => Promise<Response>;
}

export function createPullRequestHandler(deps: PullRequestHandlerDeps): PullRequestHandler {
  return {
    async createPr(request: Request): Promise<Response> {
      const body = (await request.json()) as CreatePrRequest;

      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const promptingParticipantResult = await deps.getPromptingParticipantForPR();
      if (!promptingParticipantResult.participant) {
        return Response.json(
          { error: promptingParticipantResult.error },
          { status: promptingParticipantResult.status }
        );
      }

      const promptingParticipant = promptingParticipantResult.participant;

      const result = await deps.createPullRequest({
        ...body,
        baseBranch: body.baseBranch || session.base_branch,
        promptingUserId: promptingParticipant.user_id,
        sessionUrl: deps.getSessionUrl(session),
      });

      if (result.kind === "error") {
        return Response.json({ error: result.error }, { status: result.status });
      }

      return Response.json({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        state: result.state,
      });
    },
  };
}
