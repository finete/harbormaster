export function midTurnRestartWarning(count: number): string {
  return count === 1
    ? "An agent is mid-turn; restarting interrupts it."
    : `${count} agents are mid-turn; restarting interrupts them.`;
}
