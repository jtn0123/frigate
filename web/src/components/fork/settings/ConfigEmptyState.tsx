/**
 * Fork: empty states for config-form map sections (UI105).
 *
 * A map section with no entries (Generative AI with no providers) rendered
 * only a small "Add" button. A section opts in with the root uiSchema option
 * `forkEmptyState`, and `ObjectFieldTemplate` renders this in place of the
 * bare button while the map is empty. The action calls the same
 * `onAddProperty` the button did.
 */

import { useTranslation } from "react-i18next";
import { LuPlus, LuSparkles } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import type { ConfigEmptyStateKind } from "@/lib/fork/config-empty-state";

type ConfigEmptyStateProps = {
  kind: ConfigEmptyStateKind;
  onAdd?: () => void;
  disabled?: boolean;
};

export default function ConfigEmptyState({
  kind,
  onAdd,
  disabled,
}: Readonly<ConfigEmptyStateProps>) {
  const { t } = useTranslation(["fork"]);

  // One kind today ("genaiProviders"); a second one picks its strings here.
  const copy = {
    title: t("configEmptyState.genaiProviders.title"),
    description: t("configEmptyState.genaiProviders.description"),
    action: t("configEmptyState.genaiProviders.action"),
  };

  return (
    <div
      data-testid="config-empty-state"
      data-kind={kind}
      className="flex max-w-5xl flex-col items-center gap-2 rounded-lg border border-dashed border-secondary-highlight px-6 py-10 text-center"
    >
      <div className="mb-1 flex size-12 items-center justify-center rounded-full bg-secondary">
        <LuSparkles className="size-6 text-primary-variant" aria-hidden />
      </div>
      <Heading as="h4" className="mb-0">
        {copy.title}
      </Heading>
      <p className="max-w-md text-sm text-primary-variant">
        {copy.description}
      </p>
      {onAdd && (
        <Button
          type="button"
          variant="select"
          className="mt-3 gap-2"
          onClick={onAdd}
          disabled={disabled}
        >
          <LuPlus className="size-4" aria-hidden />
          {copy.action}
        </Button>
      )}
    </div>
  );
}
