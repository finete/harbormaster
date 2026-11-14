// Engine: the JSON Schema for rules files (`<stateDir>/rules/rules.yaml`,
// `<stateDir>/rules/repos/<repo>.yaml`). The same document ships as
// `packages/core/schemas/rules.schema.json` for editors (a unit test keeps
// the two identical); this module is what core validates against on load.

const TEMPLATE = { type: "string", pattern: "^\\$\\{[\\s\\S]+\\}$" } as const;

export const RULES_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://github.com/finete/harbormaster/blob/main/packages/core/schemas/rules.schema.json",
  title: "Harbormaster rules file",
  description:
    "Board automation as event → condition → action. `rules.yaml` is the global ordered list; `repos/<repository id>.yaml`, when present, replaces it for that repository.",
  type: "object",
  additionalProperties: false,
  required: ["rules"],
  properties: {
    rules: {
      type: "array",
      items: { $ref: "#/definitions/rule" },
    },
  },
  definitions: {
    rule: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "on", "do"],
      properties: {
        id: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
          description: "Unique within the file; shown in the audit log.",
        },
        label: {
          type: "string",
          minLength: 1,
          maxLength: 40,
          description:
            "Required. Short name shown on the Rules page and with the rule's actions in the task's audit line and History (\"Needs changes\").",
        },
        description: {
          type: "string",
          description: "Free-form note about the rule.",
        },
        on: {
          description:
            "Event type(s): exact (`github.pr.mergedChanged`) or glob (`github.pr.*`; `*` = one segment, `**` = any).",
          oneOf: [
            { $ref: "#/definitions/eventPattern" },
            {
              type: "array",
              minItems: 1,
              items: { $ref: "#/definitions/eventPattern" },
            },
          ],
        },
        if: {
          type: "string",
          minLength: 1,
          description:
            "CEL over `event`, `task`, `facts`, `repo`; or `js:./file.mjs#fn` (a function in the rules dir returning a boolean).",
        },
        do: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/definitions/action" },
        },
      },
    },
    eventPattern: {
      type: "string",
      pattern: "^[A-Za-z0-9*][A-Za-z0-9_.*-]*$",
    },
    jsRef: {
      type: "string",
      pattern: "^js:\\./[^#]+#[A-Za-z_$][A-Za-z0-9_$]*$",
    },
    template: TEMPLATE,
    action: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          anyOf: [
            { enum: ["move", "inbox", "createTask", "message"] },
            { $ref: "#/definitions/jsRef" },
          ],
        },
        with: { type: "object" },
      },
      allOf: [
        {
          if: { properties: { action: { const: "move" } } },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
          then: {
            required: ["with"],
            properties: { with: { $ref: "#/definitions/moveInput" } },
          },
        },
        {
          if: { properties: { action: { const: "inbox" } } },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
          then: {
            required: ["with"],
            properties: { with: { $ref: "#/definitions/inboxInput" } },
          },
        },
        {
          if: { properties: { action: { const: "createTask" } } },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
          then: {
            required: ["with"],
            properties: { with: { $ref: "#/definitions/createTaskInput" } },
          },
        },
        {
          if: { properties: { action: { const: "message" } } },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
          then: {
            required: ["with"],
            properties: { with: { $ref: "#/definitions/messageInput" } },
          },
        },
      ],
    },
    moveInput: {
      type: "object",
      additionalProperties: false,
      required: ["to"],
      properties: {
        to: { enum: ["dev", "done", "await"] },
        kind: { type: "string", minLength: 1 },
        input: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Awaiting-kind inputs; for `deploy`, `stage` picks a stage id (default: the entry stage).",
        },
        enter: {
          description:
            "Run the kind's onEnter side effect (push/open PR, squash-merge). Default false.",
          anyOf: [{ type: "boolean" }, TEMPLATE],
        },
      },
    },
    inboxInput: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        priority: { anyOf: [{ type: "boolean" }, TEMPLATE] },
        buttons: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "action"],
            properties: {
              label: { type: "string", minLength: 1 },
              action: { enum: ["openTask", "createTask", "dismiss", "snooze"] },
              with: { type: "object" },
            },
          },
        },
      },
    },
    createTaskInput: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1 },
        prompt: { type: "string" },
        repository: { type: "string" },
        pr: { anyOf: [{ type: "integer" }, { type: "string" }] },
        role: { anyOf: [{ enum: ["author", "reviewer"] }, TEMPLATE] },
        start: { anyOf: [{ type: "boolean" }, TEMPLATE] },
      },
    },
    messageInput: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1 },
        mode: { anyOf: [{ enum: ["steer", "followUp"] }, TEMPLATE] },
        to: { type: "string" },
      },
    },
  },
} as const;
