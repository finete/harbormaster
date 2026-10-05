// Utility: cross-cutting pub/sub infrastructure. Managers call this
// directly (Manager → Utility is an allowed call direction); it is the only
// piece of the command API that knows about `node:events`, keeping the
// `CoreEvents` contract itself transport-agnostic.

import { EventEmitter } from "node:events";
import type {
  CoreEventMap,
  CoreEventName,
  CoreEvents,
} from "../contracts/events.js";

export class CoreEventBus implements CoreEvents {
  private readonly emitter = new EventEmitter();

  on<E extends CoreEventName>(
    event: E,
    listener: (payload: CoreEventMap[E]) => void,
  ): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => {
      this.emitter.off(event, listener as (...args: unknown[]) => void);
    };
  }

  emit<E extends CoreEventName>(event: E, payload: CoreEventMap[E]): void {
    this.emitter.emit(event, payload);
  }
}
