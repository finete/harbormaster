// Engine: validate `config.sources.<id>.settings` against a source's
// `settingsSchema` (JSON Schema via ajv). Pure; compiled validators are
// cached per schema object.

import { Ajv, type ValidateFunction } from "ajv";
import type { JsonSchema } from "../../contracts/rules.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap<JsonSchema, ValidateFunction>();

/** Problems with `settings` (empty = valid, or no schema to check against). */
export function sourceSettingsProblems(
  sourceId: string,
  schema: JsonSchema | undefined,
  settings: Readonly<Record<string, unknown>>,
): string[] {
  if (!schema) return [];
  let validate = validators.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      return [
        `Source ${sourceId} has an invalid settingsSchema: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    validators.set(schema, validate);
  }
  if (validate(settings)) return [];
  return (validate.errors ?? []).map(
    (error) =>
      `Config sources.${sourceId}.settings${error.instancePath.replace(/\//g, ".")} ${error.message ?? "is invalid"}`,
  );
}
