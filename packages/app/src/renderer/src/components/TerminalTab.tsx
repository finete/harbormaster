import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { closeReview } from "../lib/review-close";
import { isReviewPanelId } from "../lib/task-urls";
import { truncateTitle } from "../lib/terminal-title";

/**
 * Custom dockview tab renderer for terminal panels: same look as dockview's
 * built-in default tab (reuses its `dv-default-tab*` classes/CSS vars so
 * the theme stays identical), but truncates the live title for display
 * while keeping the full title in the `title` attribute (hover tooltip) and
 * exposing stable data-testids for e2e — the default tab renderer has
 * neither.
 *
 * Title state is read off dockview's own panel api (`onDidTitleChange`),
 * not app-level React state: TerminalPane pushes title updates through
 * `props.api.setTitle`, so a title change here never touches the panel
 * component tree and can't remount a terminal/pty.
 *
 * Closing the review tab first closes its Plannotator session, asking when
 * unsent comments would be lost (lib/review-close.ts); "Keep open" leaves
 * the tab where it is.
 */
export function TerminalTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const { api } = props;
  // The same tab look serves the `url` panels (review/preview, UrlPane).
  const testId = api.tabComponent === "url" ? "url-tab" : "terminal-tab";
  const [title, setTitle] = useState(api.title ?? "");
  const closingRef = useRef(false);

  function close(): void {
    if (!isReviewPanelId(api.id)) {
      api.close();
      return;
    }
    if (closingRef.current) return;
    closingRef.current = true;
    const url = api.getParameters<{ url?: string }>().url;
    void closeReview(url)
      .then((closed) => {
        if (closed) api.close();
      })
      .finally(() => {
        closingRef.current = false;
      });
  }

  useEffect(() => {
    setTitle(api.title ?? "");
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title);
    });
    return () => disposable.dispose();
  }, [api]);

  return (
    <div
      className="dv-default-tab"
      data-testid={testId}
      data-panel-id={api.id}
      title={title}
      role="tab"
      tabIndex={0}
      onClick={() => api.setActive()}
      // Middle-click closes the tab on mouse DOWN, as native tab bars do.
      // preventDefault also suppresses the browser's middle-click autoscroll.
      onMouseDown={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        api.setActive();
      }}
    >
      <span className="dv-default-tab-content" data-testid={`${testId}-title`}>
        {truncateTitle(title)}
      </span>
      <button
        type="button"
        className="dv-default-tab-action"
        data-testid={`${testId}-close`}
        aria-label="Close"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <svg
          height="11"
          width="11"
          viewBox="0 0 28 28"
          aria-hidden="true"
          focusable={false}
          className="dockview-svg"
        >
          <title>Close</title>
          <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
        </svg>
      </button>
    </div>
  );
}
