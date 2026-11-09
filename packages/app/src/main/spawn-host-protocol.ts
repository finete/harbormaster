// Wire format between the main process and the spawn host (see
// spawn-host-client.ts for why the host exists). Plain structured-clone data
// only: a `ProcessRunRequest` goes out, a stdout/stderr pair or a flattened
// execFile error comes back.

import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "@harbormaster/core";

export interface SpawnHostRequest {
  id: number;
  request: ProcessRunRequest;
}

/** The execFile failure fields `run()`'s error description reads, flattened for structured clone. */
export interface SerializedRunError {
  message: string;
  killed?: boolean;
  code?: string | number;
  signal?: string;
  stderr?: string;
}

export type SpawnHostResponse =
  | { id: number; ok: true; result: ProcessRunResult }
  | { id: number; ok: false; error: SerializedRunError };

export function serializeRunError(error: unknown): SerializedRunError {
  if (!error || typeof error !== "object") return { message: String(error) };
  const fields = error as {
    message?: unknown;
    killed?: unknown;
    code?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  return {
    message:
      typeof fields.message === "string" ? fields.message : String(error),
    ...(typeof fields.killed === "boolean" ? { killed: fields.killed } : {}),
    ...(typeof fields.code === "string" || typeof fields.code === "number"
      ? { code: fields.code }
      : {}),
    ...(typeof fields.signal === "string" ? { signal: fields.signal } : {}),
    ...(fields.stderr !== undefined && fields.stderr !== null
      ? { stderr: String(fields.stderr) }
      : {}),
  };
}

/** Rebuilds an `Error` carrying the same fields an in-process execFile rejection has. */
export function deserializeRunError(error: SerializedRunError): Error {
  const { message, ...fields } = error;
  return Object.assign(new Error(message), fields);
}

/** The host side of one request: run it, answer with a response (never throws). */
export async function handleSpawnHostRequest(
  runner: ProcessRunner,
  message: SpawnHostRequest,
): Promise<SpawnHostResponse> {
  try {
    return { id: message.id, ok: true, result: await runner(message.request) };
  } catch (error) {
    return { id: message.id, ok: false, error: serializeRunError(error) };
  }
}
