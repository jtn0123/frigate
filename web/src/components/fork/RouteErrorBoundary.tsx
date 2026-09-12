/**
 * Fork: route-level error boundary (report item C1).
 *
 * Upstream has no error boundary at all, so a render throw in any lazy page
 * or a chunk-load failure after a deploy unmounts the whole app to a blank
 * screen. This boundary renders a translated recovery panel instead and is
 * reset whenever the route changes so navigating away clears the error.
 *
 * Gated by the `errorBoundary` fork flag: when the flag is off the children
 * are rendered directly and upstream behaviour is unchanged.
 */

import {
  Component,
  Suspense,
  type ErrorInfo,
  type ReactNode,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useInRouterContext, useLocation } from "react-router-dom";
import { LuCopy, LuRotateCw, LuTriangleAlert } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import { isForkEnabled } from "@/fork/flags";
import { cn } from "@/lib/utils";

type Variant = "page" | "chrome";

type RouteErrorBoundaryProps = {
  children?: ReactNode;
  /**
   * `page` (default) fills its container with a full recovery panel.
   * `chrome` renders a compact strip for app chrome such as the sidebar so
   * a failure there never covers the page content.
   */
  variant?: Variant;
};

const CHUNK_LOAD_PATTERN =
  /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (CSS )?chunk [^ ]+ failed/i;

// eslint-disable-next-line react-refresh/only-export-components
export function isChunkLoadError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const err = error as { name?: unknown };
  return (
    err.name === "ChunkLoadError" || CHUNK_LOAD_PATTERN.test(errorText(error))
  );
}

/** The error's message, or the thrown value itself when a string was thrown. */
function errorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  const { message } = error as { message?: unknown };
  return typeof message === "string" ? message : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function buildDetails(error: unknown, info: ErrorInfo | null): string {
  const lines = [
    `Frigate UI error report`,
    `Time: ${new Date().toISOString()}`,
    `URL: ${window.location.href}`,
    `User agent: ${navigator.userAgent}`,
    `Message: ${errorMessage(error)}`,
  ];
  if (error instanceof Error && error.stack) {
    lines.push("", "Stack:", error.stack);
  }
  if (info?.componentStack) {
    lines.push("", "Component stack:", info.componentStack.trim());
  }
  return lines.join("\n");
}

type ErrorPanelProps = {
  error: unknown;
  info: ErrorInfo | null;
  variant: Variant;
};

function ErrorPanel({ error, info, variant }: Readonly<ErrorPanelProps>) {
  const { t } = useTranslation(["fork"]);
  const [copied, setCopied] = useState(false);
  const chunk = isChunkLoadError(error);
  const message = errorMessage(error);

  const reload = () => window.location.reload();

  const copyDetails = async () => {
    const details = buildDetails(error, info);
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (insecure context, permissions).
      // Fall back to a prompt so the user can still select and copy.
      window.prompt(t("errorBoundary.copyFallback"), details);
    }
  };

  if (variant === "chrome") {
    return (
      <div
        role="alert"
        data-testid="fork-error-boundary-chrome"
        className="absolute bottom-0 left-0 z-50 flex max-w-full items-center gap-2 rounded-tr-md bg-secondary px-3 py-1.5 text-xs text-primary shadow-md"
      >
        <LuTriangleAlert className="size-4 shrink-0 text-danger" />
        <span className="truncate">{t("errorBoundary.chromeTitle")}</span>
        <Button
          size="xs"
          variant="ghost"
          className="size-auto px-2 py-0.5"
          aria-label={t("errorBoundary.reload")}
          onClick={reload}
        >
          {t("errorBoundary.reload")}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="fork-error-boundary"
      className="flex size-full flex-col items-center justify-center gap-3 overflow-auto p-4 text-center"
    >
      <LuTriangleAlert className="size-10 text-danger" />
      <Heading as="h4">
        {t(chunk ? "errorBoundary.chunkTitle" : "errorBoundary.title")}
      </Heading>
      <p className="max-w-md text-sm text-secondary-foreground">
        {t(
          chunk
            ? "errorBoundary.chunkDescription"
            : "errorBoundary.description",
        )}
      </p>
      <code
        className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-secondary px-3 py-2 text-left text-xs text-primary"
        data-testid="fork-error-boundary-message"
      >
        {message}
      </code>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          size="sm"
          variant="select"
          aria-label={t("errorBoundary.reload")}
          onClick={reload}
        >
          <LuRotateCw className="mr-2 size-4" />
          {t("errorBoundary.reload")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyDetails(); // clipboard write is fire-and-forget
          }}
        >
          <LuCopy className={cn("mr-2 size-4", copied && "text-success")} />
          {copied ? t("errorBoundary.copied") : t("errorBoundary.copyDetails")}
        </Button>
      </div>
    </div>
  );
}

type BoundaryProps = {
  children?: ReactNode;
  variant: Variant;
};

type BoundaryState = {
  error: unknown;
  info: ErrorInfo | null;
  hasError: boolean;
};

class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, info: null, hasError: false };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, hasError: true };
  }

  override componentDidCatch(_error: unknown, info: ErrorInfo) {
    // React already reports the error through console.error; keep the
    // component stack so "Copy details" can include it.
    this.setState({ info });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <ErrorPanel
          error={this.state.error}
          info={this.state.info}
          variant={this.props.variant}
        />
      );
    }
    return this.props.children;
  }
}

/** Remounts the boundary on every route change so stale errors clear. */
function RouteKeyedBoundary(props: Readonly<BoundaryProps>) {
  const location = useLocation();
  return <Boundary key={location.pathname} {...props} />;
}

function KeyedBoundary(props: Readonly<BoundaryProps>) {
  const inRouter = useInRouterContext();
  return inRouter ? <RouteKeyedBoundary {...props} /> : <Boundary {...props} />;
}

export default function RouteErrorBoundary({
  children,
  variant = "page",
}: Readonly<RouteErrorBoundaryProps>) {
  if (!isForkEnabled("errorBoundary")) {
    return <>{children}</>;
  }
  return <KeyedBoundary variant={variant}>{children}</KeyedBoundary>;
}

type RouteSuspenseProps = {
  children?: ReactNode;
  fallback?: ReactNode;
};

/**
 * Drop-in replacement for the route `<Suspense>` in App.tsx: the same
 * Suspense wrapped in a page-level boundary, so the App.tsx hunk stays a
 * two-tag rename.
 */
export function RouteSuspense({
  children,
  fallback,
}: Readonly<RouteSuspenseProps>) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}
