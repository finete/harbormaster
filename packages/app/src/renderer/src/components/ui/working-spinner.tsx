import type { AnimationEvent, JSX } from "react";
import { cn } from "../../lib/utils";

const ANIMATION_NAME = "working-spin";

/**
 * Pin a freshly started spinner animation to the document timeline origin,
 * so every spinner on screen shows the same step at the same moment
 * instead of each one starting its revolution whenever it mounted.
 */
function alignPhase(event: AnimationEvent<HTMLSpanElement>): void {
  if (event.animationName !== ANIMATION_NAME) return;
  const element = event.currentTarget;
  if (typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations()) {
    if (
      "animationName" in animation &&
      animation.animationName === ANIMATION_NAME
    ) {
      animation.startTime = 0;
    }
  }
}

/**
 * "Agent working" indicator: a yellow ring with a gap, turning in 12 steps
 * per second (see `.working-spinner` in styles.css for why it is stepped
 * and compositor-only). Reduced-motion users get a still, closed ring.
 */
export function WorkingSpinner({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden
      onAnimationStart={alignPhase}
      className={cn(
        "working-spinner block shrink-0 rounded-full border-2 border-status-working border-t-transparent motion-reduce:border-t-status-working",
        className,
      )}
    />
  );
}
