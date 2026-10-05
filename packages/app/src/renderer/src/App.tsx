import type { JSX } from "react";
import { Board } from "./components/Board";
import { TerminalsHost } from "./components/TerminalsHost";

export function App(): JSX.Element {
  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      <div className="w-[55%] min-w-[420px] border-r border-border">
        <Board />
      </div>
      <div className="flex-1">
        <TerminalsHost />
      </div>
    </div>
  );
}
