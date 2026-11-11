// Decides between the first-run wizard and the normal UI
// (docs/release-plan.md "Onboarding (four screens)"). On first run the
// wizard is the whole window and the app is not mounted yet (nothing
// restores or spawns behind it); "Welcome / Setup…" from the menu shows it
// over the running app instead, so open panes stay alive. "Start" enters
// the app with the New task composer open on the picked repository.

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { App, type ComposerRequest } from "../App";
import { Onboarding, type OnboardingResult } from "./Onboarding";

type Phase = "checking" | "wizard" | "app";

export function OnboardingGate(): JSX.Element {
  const [phase, setPhase] = useState<Phase>("checking");
  const [overlay, setOverlay] = useState(false);
  const [composerRequest, setComposerRequest] = useState<
    ComposerRequest | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    window.harbormaster.onboarding
      .shouldShow()
      .then((show) => {
        if (!cancelled) setPhase(show ? "wizard" : "app");
      })
      .catch(() => {
        // Never lock the user out of the app over a failed check.
        if (!cancelled) setPhase("app");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      window.harbormaster.onboarding.onShow(() => {
        setPhase((current) => {
          if (current === "app") setOverlay(true);
          return current === "checking" ? "wizard" : current;
        });
      }),
    [],
  );

  const finish = (result: OnboardingResult): void => {
    setComposerRequest((previous) => ({
      id: (previous?.id ?? 0) + 1,
      ...(result.where ? { where: result.where } : {}),
    }));
    setOverlay(false);
    setPhase("app");
  };

  if (phase === "checking") {
    return <div className="h-screen w-screen bg-background" />;
  }
  return (
    <>
      {phase === "app" && <App composerRequest={composerRequest} />}
      {(phase === "wizard" || overlay) && (
        <Onboarding
          closable={phase === "app"}
          onFinish={finish}
          onClose={() => setOverlay(false)}
        />
      )}
    </>
  );
}
