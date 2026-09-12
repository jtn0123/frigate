import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import ErrorState from "@/components/fork/ErrorState";
import { wrapAsync } from "@/utils/promise";

type Analysis = {
  transcript?: string;
  translation?: string;
  language?: string | null;
  sounds?: { label: string; similarity: number }[];
  stages?: Record<string, { status: string }>;
  large_status?: string;
  large_second_opinion?: Analysis;
};
type Results = {
  status: string;
  chunks: {
    id: string;
    start: number;
    end: number;
    state: string;
    result: Analysis | null;
  }[];
};

function AnalysisText({ result }: Readonly<{ result: Analysis }>) {
  const { t } = useTranslation("views/events");
  const failed = Object.entries(result.stages ?? {}).filter(
    ([, stage]) => stage.status === "failed",
  );
  return (
    <div className="space-y-2 text-sm">
      {failed.length > 0 && (
        <p className="text-warning">{t("audioAnalysis.partial")}</p>
      )}
      {result.transcript && (
        <div>
          <h5 className="font-medium">{t("audioAnalysis.original")}</h5>
          <p dir="auto" className="whitespace-pre-wrap break-words">
            {result.transcript}
          </p>
        </div>
      )}
      {result.translation && result.translation !== result.transcript && (
        <div>
          <h5 className="font-medium">{t("audioAnalysis.translation")}</h5>
          <p className="whitespace-pre-wrap break-words">
            {result.translation}
          </p>
        </div>
      )}
      {!result.transcript && (
        <p className="text-muted-foreground">{t("audioAnalysis.noSpeech")}</p>
      )}
      {Boolean(result.sounds?.length) && (
        <div>
          <h5 className="font-medium">{t("audioAnalysis.sounds")}</h5>
          <p>
            {result.sounds
              ?.map((sound) => sound.label.replaceAll("_", " "))
              .join(", ")}
          </p>
        </div>
      )}
    </div>
  );
}

export default function AudioReviewResults({
  reviewId,
  onSeek,
}: Readonly<{ reviewId: string; onSeek: (time: number) => void }>) {
  const { t } = useTranslation("views/events");
  const { data, error, mutate } = useSWR<Results>(
    `review/${encodeURIComponent(reviewId)}/audio`,
    { refreshInterval: 15000 },
  );
  return (
    <section className="my-2 space-y-2 rounded-lg border border-secondary p-3">
      <h4 className="font-medium">{t("audioAnalysis.title")}</h4>
      <p className="text-xs text-muted-foreground">
        {t("audioAnalysis.unverified")}
      </p>
      {error ? (
        <ErrorState compact error={error} onRetry={wrapAsync(() => mutate())} />
      ) : !data ? (
        <p className="text-sm">{t("audioAnalysis.loading")}</p>
      ) : (
        <>
          {data.status !== "available" && (
            <p className="text-sm text-muted-foreground">
              {t(
                data.status === "unavailable"
                  ? "audioAnalysis.unavailable"
                  : "audioAnalysis.empty",
              )}
            </p>
          )}
          {data.chunks.map((chunk) => (
            <article
              key={chunk.id}
              className="space-y-2 border-t border-secondary pt-2"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSeek(chunk.start)}
              >
                {t("audioAnalysis.play", {
                  time: new Date(chunk.start * 1000).toLocaleTimeString(),
                })}
              </Button>
              {(!chunk.result ||
                ["failed", "expired"].includes(chunk.state)) && (
                <p className="text-sm text-muted-foreground">
                  {t(`audioAnalysis.states.${chunk.state}`)}
                </p>
              )}
              {chunk.result && <AnalysisText result={chunk.result} />}
              {chunk.state === "second_opinion" && (
                <p className="text-sm text-warning">
                  {t("audioAnalysis.deferred")}
                </p>
              )}
              {chunk.result?.large_status?.startsWith("expired:") && (
                <p className="text-sm text-muted-foreground">
                  {t("audioAnalysis.expired")}
                </p>
              )}
              {chunk.result?.large_status?.startsWith("retry failed:") && (
                <p className="text-sm text-warning">
                  {t("audioAnalysis.secondFailed")}
                </p>
              )}
              {chunk.result?.large_second_opinion && (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("audioAnalysis.secondOpinion")}
                  </summary>
                  <AnalysisText result={chunk.result.large_second_opinion} />
                </details>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
