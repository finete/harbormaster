// Engine: the generic core of automatic movement. Ported from pi-home's
// src/engines/transition-machine.ts `arbitrateMove`. It owns no domain
// rules: movers propose moves, the arbiter runs them in configured order,
// checks legality against the transition engine, and picks the first legal
// non-stay proposal. The manager executes it, so a task moves at most one
// step per `refresh()` and every intermediate state is persisted. A mover
// error means "stay" plus a warning, never a movement — errors never move
// anything.

import type { TaskState } from "../../../src/contracts/model.js";
import { isAllowedTransition } from "../../../src/engines/task-transitions.js";
import type {
  BoardMove,
  MoverHelpers,
  MoverInput,
  TaskMover,
} from "./addons.js";

export interface ArbiterDecision {
  move: BoardMove;
  /** Name of the mover whose proposal won, when one did. */
  mover?: string;
  /** Mover failures and illegal proposals from this call; never fatal. */
  warnings: string[];
}

const TARGET_STATE: Record<Exclude<BoardMove["type"], "stay">, TaskState> = {
  dev: "dev",
  review: "awaiting",
  deploy: "awaiting",
  done: "done",
};

export async function arbitrateMove(
  input: MoverInput,
  helpers: MoverHelpers,
  movers: readonly (readonly [string, TaskMover])[],
): Promise<ArbiterDecision> {
  const warnings: string[] = [];
  for (const [name, mover] of movers) {
    let move: BoardMove;
    try {
      move = await mover.decide(input, helpers);
    } catch (error) {
      warnings.push(
        `Mover ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (move.type === "stay") continue;
    const target = TARGET_STATE[move.type];
    if (!isAllowedTransition(input.task.state, target)) {
      warnings.push(`Mover ${name} proposed an illegal ${move.type} move`);
      continue;
    }
    return { move, mover: name, warnings };
  }
  return { move: { type: "stay" }, warnings };
}
