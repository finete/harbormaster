// Engine: the agent-facing guide to the rules language, written as
// `<stateDir>/rules/AGENTS.md` (plus a `CLAUDE.md` that imports it) on
// every start, so an agent working in the rules directory has the
// reference in its context. Pure: the text is built from the schema
// (action names, `with` fields, required keys), the github source's fact
// names and typed field tables below (a `RuleTaskView` or action-input
// field added without a line here fails typecheck).

import type {
  CreateTaskActionInput,
  InboxActionInput,
  MessageActionInput,
  MoveActionInput,
  RuleTaskView,
} from "../../contracts/rules.js";
import { pullRequestFacts } from "../sources/github-source.js";
import { RULES_SCHEMA } from "./rules-schema.js";

/** First line of the managed guide; never edit the generated file. */
export const RULES_GUIDE_HEADER =
  "<!-- Managed by Harbormaster: regenerated on every start. Do not edit; put your notes in rules.yaml comments. -->";

/** Managed files in the rules dir (rules-dir-relative path → text). */
export const RULES_GUIDE_FILE = "AGENTS.md";
export const RULES_GUIDE_CLAUDE_FILE = "CLAUDE.md";

/** `task` in CEL: one line per `RuleTaskView` field. */
const TASK_FIELDS: Record<keyof RuleTaskView, string> = {
  id: "task id",
  title: "task title",
  kind: '`"task"` or `"temp_task"`',
  state: '`"backlog"` | `"dev"` | `"awaiting"` | `"done"`',
  awaiting:
    'the awaiting record (`kind`: `"review"` | `"deploy"` (with `stageId`, `stageLabel`) | `"author-response"` | `"slack"` | an addon kind), `null` outside Awaiting',
  branch: "branch name or `null`",
  repository: "repository id (`github.com/org/repo`) or `null`",
  pr: 'the task\'s PR or `null`: `number`, `url`, `state` (`"draft"` | `"open"` | `"merged"` | `"closed"`), `reviewDecision`, `headRefOid`, `mergeCommit`, … and `role` (`"author"` | `"reviewer"`)',
  parentTaskId: "parent task id or `null`",
  createdAt: "ISO time",
  stateChangedAt: "ISO time the task last changed column",
};

const MOVE_FIELDS: Record<keyof MoveActionInput, string> = {
  to: "`dev` | `done` | `await`",
  kind: "awaiting kind for `to: await` (default `review`; `deploy`, `author-response`, …)",
  input:
    "kind inputs (strings); for `deploy`, `stage` picks a stage id (default: the entry stage)",
  enter:
    "run the kind's onEnter side effect (push/open PR, squash-merge); default `false` — rules only move",
};

const INBOX_FIELDS: Record<keyof InboxActionInput, string> = {
  title: "item title",
  body: "markdown body",
  priority: "`false` files it under Other instead of Priority (default `true`)",
  buttons:
    "list of `{ label, action: openTask | createTask | dismiss | snooze, with? }` (`createTask`'s `with` = the createTask fields)",
};

const CREATE_TASK_FIELDS: Record<keyof CreateTaskActionInput, string> = {
  title: "task title",
  prompt: "the agent's first prompt",
  repository: "repository id; derived from `pr` when it is a URL",
  pr: "PR number or URL",
  role: "`author` | `reviewer`",
  start: "launch the agent right away",
};

const MESSAGE_FIELDS: Record<keyof MessageActionInput, string> = {
  text: "message text",
  mode: "`steer` (interrupt) | `followUp` (after the current turn)",
  to: "target task id (default: the event's task)",
};

const ACTION_FIELDS: Record<string, Record<string, string>> = {
  move: MOVE_FIELDS,
  inbox: INBOX_FIELDS,
  createTask: CREATE_TASK_FIELDS,
  message: MESSAGE_FIELDS,
};

const ACTION_SUMMARY: Record<string, string> = {
  move: "move the event's task to another column",
  inbox: "add an item to the inbox",
  createTask: "create a task",
  message: "send a message to a task's agent session",
};

/** Built-in action names, from the schema's `action` enum. */
export function ruleActionNames(): string[] {
  const options = RULES_SCHEMA.definitions.action.properties.action.anyOf;
  for (const option of options) {
    if ("enum" in option) return [...option.enum];
  }
  return [];
}

/** `with` field names of a built-in action and which are required, from the schema. */
function schemaFields(action: string): { names: string[]; required: string[] } {
  const definitions = RULES_SCHEMA.definitions as unknown as Record<
    string,
    { properties?: Record<string, unknown>; required?: readonly string[] }
  >;
  const definition = definitions[`${action}Input`];
  return {
    names: Object.keys(definition?.properties ?? {}),
    required: [...(definition?.required ?? [])],
  };
}

/** The github source's per-task fact names (`facts.github.*`). */
function githubFactNames(): string[] {
  return Object.keys(
    pullRequestFacts({
      number: 0,
      url: "",
      state: "OPEN",
      isDraft: false,
      reviewRequested: false,
      reviewSubmitted: false,
    }),
  );
}

function actionSection(action: string): string {
  const { names, required } = schemaFields(action);
  const described = ACTION_FIELDS[action] ?? {};
  const lines = names.map((name) => {
    const note = described[name] ?? "";
    const flag = required.includes(name) ? " **(required)**" : "";
    return `  - \`${name}\`${flag}: ${note}`;
  });
  return [
    `- \`${action}\`: ${ACTION_SUMMARY[action] ?? ""}. \`with\`:`,
    ...lines,
  ].join("\n");
}

/** The guide's worked example (a complete, valid rules file; a test parses it). */
export const RULES_GUIDE_EXAMPLE_YAML = `rules:
  - id: approved-nudge
    label: PR approved
    on: github.pr.reviewDecisionChanged
    if: >-
      task != null && task.pr != null && task.pr.role == "author" &&
      event.data.to == "approved"
    do:
      - action: message
        with:
          text: 'PR #\${facts.github.number} was approved. Rebase if needed and make sure CI is green.'
          mode: followUp
  - id: ci-failed-inbox
    label: CI failed
    on: github.pr.checksChanged
    if: task != null && "checks" in facts.github && facts.github.checks == "failure"
    do:
      - action: inbox
        with:
          title: 'CI failed: \${task.title}'
          body: '\${facts.github.url}'
          buttons:
            - { label: Open, action: openTask }
            - { label: Dismiss, action: dismiss }
`;

function buildGuide(): string {
  const actions = ruleActionNames();
  const ruleRequired = RULES_SCHEMA.definitions.rule.required.join("`, `");
  const taskFields = (Object.keys(TASK_FIELDS) as Array<keyof RuleTaskView>)
    .map((field) => `  - \`task.${field}\`: ${TASK_FIELDS[field]}`)
    .join("\n");
  return `${RULES_GUIDE_HEADER}

# Harbormaster rules

This folder holds Harbormaster's board automation: **event → condition →
action**. Harbormaster (the app) re-reads these files on every refresh tick;
nothing needs restarting. JSON Schema: \`packages/core/schemas/rules.schema.json\`
in the Harbormaster repo.

## Files

- \`rules.yaml\`: the global, ordered rule list. Applies to every repository
  without an override.
- \`repos/<repository id>.yaml\` (e.g. \`repos/github.com/acme/api.yaml\`):
  when present it **replaces** the global list for that repository (it does
  not extend it; copy the global rules you still want).
- \`*.mjs\`: optional JS escape-hatch modules (see below).
- A file with any validation problem loads **no rules at all**.
- \`AGENTS.md\` / \`CLAUDE.md\` (this guide) are rewritten on every start.

## A rule

\`\`\`yaml
rules:
  - id: my-rule            # unique within the file; [A-Za-z0-9][A-Za-z0-9._-]*
    label: Short name      # REQUIRED, 1-40 chars: shown on the Rules page and in task history
    description: optional free-form note
    on: [github.pr.*]      # event type(s)
    if: task.state == "dev"   # optional condition; absent = always
    do:                    # one or more actions, in order
      - action: move
        with: { to: await, kind: review }
\`\`\`

Required keys: \`${ruleRequired}\`. **\`label\` is required**: a rule without
one makes the whole file fail to load.

### \`on\`: event types

A string or a list. Exact (\`github.pr.mergedChanged\`) or a glob: \`*\`
matches one dot-separated segment, \`**\` any number of segments
(\`github.pr.*\`, \`**\`).

Events are CloudEvents (\`event.id\`, \`event.source\`, \`event.type\`,
\`event.subject\` = \`task/<id>\` when about a task, \`event.time\`,
\`event.data\`). Sources snapshot facts and Harbormaster diffs them into:

- \`<source>.<entity>.<field>Changed\` with \`event.data = { from, to }\`
- \`<source>.<entity>.appeared\` / \`.disappeared\` with \`event.data\` = the facts

Built-in sources and entities:

- \`github.pr.*\`: the task's PR (fields below).
- \`github.reviewRequest.*\` / \`github.mention.*\`: open PRs requesting your
  review / mentioning you (opt-in: config.json
  \`sources.github.settings.watchReviewRequests\` / \`watchMentions\`); data: \`repository\`, \`number\`,
  \`url\`, \`title\`, \`author\`. No task.
- \`version-endpoint.deployment.*\`: a task awaiting a deploy stage hooked to
  \`version-endpoint\`.
- \`harbormaster.task.*\`: the board itself (\`state\`, \`awaitingKind\`,
  \`stageId\`, \`repository\`, \`branch\`, \`pipeline\`); fires when a task
  changes column, so a rule re-evaluates when a task enters the state it
  cares about. Listening to \`[github.pr.*, harbormaster.task.*]\` and reading
  \`facts\` (not \`event.data\`) makes a rule level-triggered.

### \`if\`: a CEL condition

CEL (Common Expression Language) that must return a boolean. Optional
chaining is on: \`facts["version-endpoint"].?next.orValue(null)\`. Use
\`"key" in map\` before reading a fact that may be missing. A condition that
throws is a no-op plus a warning in the audit log. Variables:

- \`event\`: the CloudEvent above.
- \`task\`: the event's task (\`null\` when the event has none). Absent fields
  are \`null\`, never missing:
${taskFields}
- \`facts.<source>\`: that source's current facts for the event's task (\`{}\`
  when none):
  - \`facts.github\`: ${githubFactNames()
    .map((name) => `\`${name}\``)
    .join(
      ", ",
    )}. \`state\` is \`"open"\` | \`"draft"\` | \`"merged"\` | \`"closed"\`; \`reviewDecision\` is lower-case (\`"approved"\`, \`"changes_requested"\`, \`"review_required"\`) or \`null\`.
  - \`facts["version-endpoint"]\`: \`stageId\` (stage the task waits at),
    \`satisfiedStageId\`, \`next\` (stage to enter next or \`null\`), \`land\`
    (deployed past the last stage). Use brackets: the id has a dash.
  - \`facts.harbormaster\`: \`state\`, \`awaitingKind\`, \`stageId\`,
    \`repository\`, \`branch\`, \`pipeline\` (the repository's stage ids).
  - Addon sources appear under their own id.
- \`repo\`: the task's repository or \`null\`: \`repo.id\`,
  \`repo.deployment.stages\` (each \`id\`, \`label\`, \`hook\`, \`options\`).

**JS escape hatch:** \`if: js:./checks.mjs#isHotfix\` calls the exported
function \`isHotfix({ event, task, facts, repo })\` from \`checks.mjs\` in this
folder; it must return a boolean. \`action: js:./actions.mjs#fn\` receives the
same variables plus \`with\` and returns one built-in action
(\`{ action, with }\`), a list of them, or nothing.

### \`do\`: actions

Each entry is \`{ action, with }\`. Built-in actions: ${actions
    .map((name) => `\`${name}\``)
    .join(", ")}.

${actions.map(actionSection).join("\n")}

**Templates:** any \`with\` string may contain \`\${<CEL>}\`. A string that is
exactly \`'\${expr}'\` becomes the typed value; inside longer text it is
interpolated. Quote such strings in YAML: \`title: 'Review: \${event.data.title}'\`.

### Arbitration

Rules run in file order. Per refresh tick **a task makes at most one move:
the first matching rule's \`move\` wins**; later moves are \`superseded\`. Every
matching \`inbox\`, \`createTask\` and \`message\` runs. A move that is refused
(illegal, a dirty worktree when landing) stays pending and is retried.

## Validate after every edit

\`\`\`sh
harbormaster rules list                  # every file: loaded? problems with line numbers, last fired
harbormaster rules check                 # dry run of the current rules over recorded events
harbormaster rules check --task <id>     # … only one task's events
harbormaster rules check --replay <from> # … from an ISO time or YYYY-MM-DD
harbormaster events --rule <id>          # what a rule actually did (audit log)
\`\`\`

These talk to the running Harbormaster app. \`rules list\` must show no
problems for the files you touched. \`rules check\` executes nothing.

## Worked example

Send an approved PR's author task back to the agent with a nudge, and file
an inbox item when CI fails:

\`\`\`yaml
${RULES_GUIDE_EXAMPLE_YAML}\`\`\`
`;
}

/** The managed `AGENTS.md` for the rules directory. */
export const RULES_GUIDE_MARKDOWN = buildGuide();

/** Every managed file in the rules dir, rewritten on every start. */
export const RULES_MANAGED_FILES: Readonly<Record<string, string>> = {
  [RULES_GUIDE_FILE]: RULES_GUIDE_MARKDOWN,
  [RULES_GUIDE_CLAUDE_FILE]: "@AGENTS.md\n",
};
