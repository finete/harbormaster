import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingGate } from "./components/OnboardingGate";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

createRoot(root).render(
  <StrictMode>
    <OnboardingGate />
  </StrictMode>,
);
