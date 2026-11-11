// Engine: default mover for the review column. Ported from pi-home's
// src/addons/github-review.ts. Requested/submitted review moves Dev work
// into Awaiting/review, and changes-requested or human feedback on the
// current head returns Awaiting/review work to Dev. Everything after a merge
// belongs to the deployment-pipeline mover.

import type { TaskMover } from "./addons.js";
import { observePullRequest } from "./pull-request-observation.js";

export const githubReviewMover: TaskMover = {
  async decide(input) {
    const pr = input.task.pr;
    if (!pr) return { type: "stay" };
    const outcome = observePullRequest(
      input.task.state,
      input.task.awaiting,
      pr,
    );
    if (outcome === "enter_review") return { type: "review" };
    if (outcome === "return_to_dev") return { type: "dev" };
    return { type: "stay" };
  },
};
