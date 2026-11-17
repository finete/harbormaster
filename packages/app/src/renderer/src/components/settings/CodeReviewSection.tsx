// Settings → Code review: the same `CodeReviewSettings` the wizard's Code
// review step renders (S3), summarized for the current default agent.

import type { JSX } from "react";
import type { SettingsSnapshot } from "../../../../preload/api";
import { valueText } from "../../lib/settings-form";
import { CodeReviewSettings } from "../CodeReviewSettings";

export function CodeReviewSection({
  snapshot,
}: {
  snapshot: SettingsSnapshot;
}): JSX.Element {
  const defaultHarness = valueText(snapshot.values["launch.defaultHarness"]);
  return defaultHarness ? (
    <CodeReviewSettings defaultHarness={defaultHarness} />
  ) : (
    <CodeReviewSettings />
  );
}
