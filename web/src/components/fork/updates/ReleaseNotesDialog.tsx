import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  releaseVersion,
  splitUnderTheHood,
  type ForkRelease,
  type ForkUpdateState,
  type ReleaseNotesMode,
} from "@/lib/fork/updates";

const UPDATE_COMMAND = "docker compose pull && docker compose up -d";

// Section headings in the notes sit under each release's own heading, and
// links open in a new tab so the dialog stays put.
const markdownComponents: Components = {
  h3: ({ node: _node, children, ...props }) => <h4 {...props}>{children}</h4>,
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** One release's notes, with the tooling-only "Under the hood" list folded. */
function ReleaseNotesBody({ notes }: Readonly<{ notes: string }>) {
  const { main, hood } = splitUnderTheHood(notes);
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {main}
      </ReactMarkdown>
      {hood && (
        <details className="mt-3" data-testid="fork-release-hood">
          <summary className="cursor-pointer text-muted-foreground">
            {hood.title}
          </summary>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {hood.body}
          </ReactMarkdown>
        </details>
      )}
    </>
  );
}

type ReleaseNotesDialogProps = {
  mode: ReleaseNotesMode;
  state: ForkUpdateState | undefined;
  releases: ForkRelease[];
  onClose: () => void;
  onCheckNow?: (() => Promise<void>) | undefined;
};

/** Release notes for the update button and What's new (UI42). */
export default function ReleaseNotesDialog({
  mode,
  state,
  releases,
  onClose,
  onCheckNow,
}: Readonly<ReleaseNotesDialogProps>) {
  const { t, i18n } = useTranslation(["fork"]);
  const [checking, setChecking] = useState(false);

  const running =
    releaseVersion(state?.current_tag) || (state?.current_version ?? "");
  let title: string;
  let description: string;
  if (mode === "update") {
    title = t("updates.availableTitle", { count: releases.length });
    description = t("updates.availableDescription", {
      current: running,
      latest: releaseVersion(state?.latest_tag),
    });
  } else {
    title = t("updates.whatsNewTitle");
    description = state?.current_tag
      ? t("updates.whatsNewDescription", { version: running })
      : t("updates.developmentDescription");
  }

  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
  });

  const checkNow = () => {
    if (!onCheckNow) {
      return;
    }
    setChecking(true);
    void onCheckNow().finally(() => setChecking(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-2xl"
        data-testid="fork-release-notes"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
          {releases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("updates.noNotes")}
            </p>
          ) : (
            releases.map((release) => (
              <section
                key={release.tag}
                className="space-y-2"
                data-testid="fork-release"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold">{release.name}</h3>
                  {release.published_at && (
                    <time
                      dateTime={release.published_at}
                      className="text-xs text-muted-foreground"
                    >
                      {dateFormat.format(new Date(release.published_at))}
                    </time>
                  )}
                </div>
                <div className="text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_em]:text-muted-foreground [&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:font-medium [&_li]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5">
                  <ReleaseNotesBody notes={release.notes} />
                </div>
                <a
                  href={release.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary underline-offset-4 hover:underline"
                >
                  {t("updates.viewOnGitHub")}
                </a>
              </section>
            ))
          )}
        </div>
        {mode === "update" && (
          <div
            className="space-y-1 rounded-md border p-3 text-sm"
            data-testid="fork-update-howto"
          >
            <p className="font-medium">{t("updates.howTo.title")}</p>
            <p className="text-muted-foreground">
              {t("updates.howTo.portainer")}
            </p>
            <p className="text-muted-foreground">
              {t("updates.howTo.compose")}
            </p>
            <code className="block overflow-x-auto whitespace-nowrap rounded bg-muted p-2 text-xs">
              {UPDATE_COMMAND}
            </code>
          </div>
        )}
        <DialogFooter className="gap-2">
          {mode === "update" && onCheckNow && (
            <Button variant="outline" disabled={checking} onClick={checkNow}>
              {checking ? t("updates.checking") : t("updates.checkNow")}
            </Button>
          )}
          <Button onClick={onClose}>{t("updates.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
