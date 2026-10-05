// Ported from pi-home's src/utilities/defaults.ts.

import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../contracts/services.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
