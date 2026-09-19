/**
 * Fork: "How profiles work" on the Profiles settings page (UI115).
 *
 * With no profiles defined the page was one toggle and empty space. These
 * steps follow docs/docs/configuration/profiles.md: create a profile, set a
 * camera section's overrides for it, then activate it. Display only.
 */

import { useTranslation } from "react-i18next";

export default function ProfilesHowItWorks() {
  const { t } = useTranslation(["fork"]);

  const steps = [
    t("profilesHowItWorks.create"),
    t("profilesHowItWorks.override"),
    t("profilesHowItWorks.activate"),
  ];

  return (
    <section
      data-testid="profiles-how-it-works"
      className="mb-6 max-w-xl rounded-lg border border-border/70 p-4"
    >
      <h5 className="mb-3 text-sm font-semibold text-primary">
        {t("profilesHowItWorks.title")}
      </h5>
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm text-primary-variant">
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-primary"
            >
              {index + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("profilesHowItWorks.note")}
      </p>
    </section>
  );
}
