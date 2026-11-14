// Engine: the default `rules.yaml`, written on first run. It reproduces
// the two retired movers exactly (github-review, deployment-pipeline; the
// parity test in tests/rules-parity.test.ts replays recorded PR states
// through both) plus the reviewer-task rules from docs/release-plan.md.
//
// Conditions read `facts`, not `event.data`, and listen to the board's own
// `harbormaster.task.*` events too, so a rule re-evaluates when a task
// enters the state it cares about (the movers were level-triggered: they
// looked at every task on every tick).

/** One default rule block and the retired mover it replaces. */
interface DefaultRuleBlock {
  mover: "github-review" | "deployment-pipeline";
  yaml: string;
}

const HEADER = `# Harbormaster rules: event → condition → action.
# Docs: docs/release-plan.md "Rules engine". Schema: packages/core/schemas/rules.schema.json
# Language reference (for you and your agents): AGENTS.md in this folder.
#
# This global list applies to every repository; a file at
# repos/<repository id>.yaml (e.g. repos/github.com/acme/api.yaml) replaces
# it for that repository. Rules run in order; per refresh tick a task makes
# at most one move (the first matching rule wins), every matching inbox /
# createTask / message action runs.
#
# Every rule needs a \`label\`: its name on the Rules page and the short tag
# the task's audit line and History show for its actions.
#
# CEL variables: event, task, facts (facts.github, facts["version-endpoint"],
# facts.harbormaster), repo. JS escape hatch: if: js:./checks.mjs#fn
`;

const BLOCKS: readonly DefaultRuleBlock[] = [
  {
    mover: "deployment-pipeline",
    yaml: `  # A merged PR enters the first deployment stage (or the stage-less
  # "Production deploy" wait when the repository has no pipeline).
  - id: pr-merged-enter-deploy
    label: PR merged
    on: [github.pr.*, harbormaster.task.*]
    if: >-
      task.pr != null && task.pr.role == "author" &&
      "state" in facts.github && facts.github.state == "merged" &&
      (task.state == "dev" || (task.state == "awaiting" && task.awaiting.kind == "review"))
    do:
      - action: move
        with: { to: await, kind: deploy }
`,
  },
  {
    mover: "github-review",
    yaml: `  # Changes requested (or human feedback) on the current head, or the PR
  # went back to draft: the work returns to Dev.
  - id: review-changes-requested
    label: Needs changes
    on: [github.pr.*, harbormaster.task.*]
    if: >-
      task.state == "awaiting" && task.awaiting.kind == "review" &&
      task.pr != null && task.pr.role == "author" &&
      "state" in facts.github && facts.github.state != "merged" &&
      (facts.github.state == "draft" ||
       (facts.github.reviewDecision == "changes_requested" && facts.github.changesRequestedOnHead != false) ||
       facts.github.humanFeedbackOnHead == true)
    do:
      - action: move
        with: { to: dev }
`,
  },
  {
    mover: "github-review",
    yaml: `  # A requested or submitted review moves Dev work into Awaiting review
  # (unless that review asked for changes on the current head).
  - id: review-requested-enter-review
    label: Review requested
    on: [github.pr.*, harbormaster.task.*]
    if: >-
      task.state == "dev" && task.pr != null && task.pr.role == "author" &&
      "state" in facts.github &&
      facts.github.state != "merged" && facts.github.state != "draft" &&
      !(facts.github.reviewDecision == "changes_requested" && facts.github.changesRequestedOnHead != false) &&
      facts.github.humanFeedbackOnHead != true &&
      (facts.github.reviewRequested == true || facts.github.reviewSubmitted == true)
    do:
      - action: move
        with: { to: await, kind: review }
`,
  },
  {
    mover: "deployment-pipeline",
    yaml: `  # A stage-less production wait in a repository that has since gained a
  # pipeline adopts its first stage.
  - id: deploy-adopt-first-stage
    label: Pipeline added
    on: [harbormaster.task.*]
    if: >-
      task.state == "awaiting" && task.awaiting.kind == "deploy" &&
      task.awaiting.stageId == "__production" &&
      repo != null && size(repo.deployment.stages) > 0
    do:
      - action: move
        with: { to: await, kind: deploy }
`,
  },
  {
    mover: "deployment-pipeline",
    yaml: `  # The version endpoint shows the merge commit deployed: enter the next
  # stage (scanning past consecutive hooked stages that already have it).
  - id: deploy-advance-stage
    label: Stage deployed
    on: [version-endpoint.deployment.*]
    if: >-
      task.state == "awaiting" && task.awaiting.kind == "deploy" &&
      facts["version-endpoint"].?stageId.orValue("") == task.awaiting.stageId &&
      facts["version-endpoint"].?next.orValue(null) != null
    do:
      - action: move
        with:
          to: await
          kind: deploy
          input: { stage: '\${facts["version-endpoint"].next}' }
`,
  },
  {
    mover: "deployment-pipeline",
    yaml: `  # Deployed past the last stage: land the task. Never force-deletes: a
  # dirty worktree or a live pane keeps it in Awaiting with a
  # "deployed and ready to land" warning until you mark it Done.
  - id: deploy-land
    label: Fully deployed
    on: [version-endpoint.deployment.*]
    if: >-
      task.state == "awaiting" && task.awaiting.kind == "deploy" &&
      facts["version-endpoint"].?stageId.orValue("") == task.awaiting.stageId &&
      facts["version-endpoint"].?land.orValue(false) == true
    do:
      - action: move
        with: { to: done }
`,
  },
  {
    mover: "github-review",
    yaml: `  # Reviewer tasks (someone else's PR): the author pushed or replied.
  - id: reviewer-author-activity
    label: Author activity
    on: github.pr.lastAuthorActivityAtChanged
    if: task.pr != null && task.pr.role == "reviewer" && task.state == "awaiting"
    do: [{ action: move, with: { to: dev } }]
`,
  },
  {
    mover: "github-review",
    yaml: `  # Reviewer tasks: the PR closed (or merged), the review is over.
  - id: reviewer-pr-closed
    label: PR closed
    on: github.pr.closedChanged
    if: task.pr != null && task.pr.role == "reviewer" && event.data.to == true
    do: [{ action: move, with: { to: done } }]
`,
  },
  {
    mover: "github-review",
    yaml: `  # Someone asked you for a review (needs config sources.github.settings
  # .watchReviewRequests: true): an inbox item that can open a reviewer task.
  - id: review-requested-inbox
    label: Review request
    on: github.reviewRequest.appeared
    do:
      - action: inbox
        with:
          title: 'Review requested: \${event.data.title}'
          body: '\${event.data.repository}#\${event.data.number} by \${event.data.author}'
          buttons:
            - label: Create review task
              action: createTask
              with:
                title: 'Review: \${event.data.title}'
                pr: '\${event.data.url}'
                role: reviewer
                start: true
            - { label: Dismiss, action: dismiss }
`,
  },
];

/**
 * The default `rules.yaml`. `legacyMovers` (a pre-rules config's `movers`
 * list) keeps only the rules that replace the listed movers, so a config
 * that disabled automatic moves (`movers: []`) gets an empty list.
 */
export function defaultRulesYaml(legacyMovers?: readonly string[]): string {
  const blocks = legacyMovers
    ? BLOCKS.filter((block) => legacyMovers.includes(block.mover))
    : BLOCKS;
  if (blocks.length === 0) {
    return `${HEADER}#\n# Migrated from config.json "movers": [] (automatic moves were off).\nrules: []\n`;
  }
  return `${HEADER}\nrules:\n${blocks.map((block) => block.yaml).join("\n")}`;
}

/** The default rules as written on a fresh install. */
export const DEFAULT_RULES_YAML = defaultRulesYaml();
