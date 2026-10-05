import type { HarbormasterApi } from "./api";

declare global {
  interface Window {
    harbormaster: HarbormasterApi;
  }
}
