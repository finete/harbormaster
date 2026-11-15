import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingGate } from "./components/OnboardingGate";
import "./styles.css";

// Forward every uncaught error/unhandled rejection to main (see preload's
// `reportError`, logged as `[renderer] ...` in main.log): a packaged app's
// renderer devtools are never open, so without this they vanish silently.
window.addEventListener("error", (event) => {
  window.harbormaster.app.reportError({
    message: event.message,
    stack: event.error instanceof Error ? event.error.stack : undefined,
    source: "window.onerror",
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  window.harbormaster.app.reportError({
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    source: "unhandledrejection",
  });
});

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

createRoot(root).render(
  <StrictMode>
    <OnboardingGate />
  </StrictMode>,
);
