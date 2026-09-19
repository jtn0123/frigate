/**
 * Fork: Frigate+ API key status on the Frigate+ settings page (UI113).
 *
 * `config.plus.enabled` is true when Frigate found a well-formed key in the
 * PLUS_API_KEY environment variable, a Docker secret of that name, or the
 * Home Assistant app's options (frigate/plus.py). Without one the page now
 * says how to add it instead of showing a red X.
 */

import { Trans, useTranslation } from "react-i18next";
import StatusPill from "./StatusPill";

type PlusKeyStatusProps = {
  connected: boolean;
};

export default function PlusKeyStatus({
  connected,
}: Readonly<PlusKeyStatusProps>) {
  const { t } = useTranslation(["fork"]);

  return (
    <div className="flex flex-col items-start gap-2">
      <StatusPill
        active={connected}
        label={
          connected
            ? t("plusKeyStatus.connected")
            : t("plusKeyStatus.notConnected")
        }
      />
      {!connected && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="plus-key-help"
        >
          <Trans
            ns="fork"
            i18nKey="plusKeyStatus.howToConnect"
            components={{
              code: (
                <code className="rounded bg-secondary px-1 py-0.5 text-xs text-primary" />
              ),
            }}
          />
        </p>
      )}
    </div>
  );
}
