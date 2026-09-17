import { useUnsavedNavigation } from "@/hooks/use-unsaved-navigation";
import useSWR from "swr";
import * as monaco from "monaco-editor";
import { configureMonacoYaml } from "monaco-yaml";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiHost } from "@/api";
import Heading from "@/components/ui/heading";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Button } from "@/components/ui/button";
import axios, { AxiosError } from "axios";
import copy from "copy-to-clipboard";
import { useTheme } from "@/context/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { LuCopy, LuSave } from "react-icons/lu";
import { MdOutlineRestartAlt } from "react-icons/md";
import RestartDialog from "@/components/overlay/dialog/RestartDialog";
import { useTranslation } from "react-i18next";
import { useRestart } from "@/api/ws";
import { useResizeObserver } from "@/hooks/resize-observer";
import { FrigateConfig } from "@/types/frigateConfig";
import { wrapAsync } from "@/utils/promise";
import { isMobile } from "react-device-detect";
import { phoneFixes } from "@/lib/fork/phone";
import { phoneEditorOptions } from "@/lib/fork/monaco-phone";

type SaveOptions = "saveonly" | "restart";

type ApiErrorResponse = {
  message?: string;
  detail?: string;
};

function ConfigEditor() {
  const { t } = useTranslation(["views/configEditor"]);
  const apiHost = useApiHost();

  useEffect(() => {
    document.title = t("documentTitle");
  }, [t]);

  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const { data: rawConfig } = useSWR<string>("config/raw");

  const { theme, systemTheme } = useTheme();
  const [error, setError] = useState<string | undefined>();

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const configRef = useRef<HTMLDivElement | null>(null);
  const schemaConfiguredRef = useRef(false);

  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const { send: sendRestart } = useRestart();
  const initialValidationRef = useRef(false);

  const onHandleSaveConfig = useCallback(
    async (save_option: SaveOptions): Promise<void> => {
      if (!editorRef.current) {
        return;
      }

      try {
        const response = await axios.post(
          `config/save?save_option=${save_option}`,
          editorRef.current.getValue(),
          {
            headers: { "Content-Type": "text/plain" },
          },
        );

        if (response.status === 200) {
          setError("");
          setHasChanges(false);
          toast.success(
            response.data?.message || t("configEditor.saved", { ns: "fork" }),
            { position: "top-center" },
          );
        }
      } catch (error) {
        toast.error(t("toast.error.savingError"), { position: "top-center" });

        const axiosError = error as AxiosError<ApiErrorResponse>;
        const errorMessage =
          axiosError.response?.data?.message ||
          axiosError.response?.data?.detail ||
          "Unknown error";

        setError(errorMessage);
        throw new Error(errorMessage);
      }
    },
    [editorRef, t],
  );

  const handleCopyConfig = useCallback(async () => {
    if (!editorRef.current) {
      return;
    }

    copy(editorRef.current.getValue());
    toast.success(t("toast.success.copyToClipboard"), {
      position: "top-center",
    });
  }, [editorRef, t]);

  const handleSaveOnly = useCallback(async () => {
    try {
      await onHandleSaveConfig("saveonly");
    } catch {
      // The save handler already shows the error and preserves dirty edits.
    }
  }, [onHandleSaveConfig]);

  // Ask first: saving before the confirmation meant Cancel still left the new
  // config on disk with nothing to say so.
  const handleSaveAndRestart = useCallback(() => {
    setRestartDialogOpen(true);
  }, []);

  // fork (UI92): switch the theme in place; recreating the editor for it
  // dropped the typed edits and the listener that tracks them
  const editorTheme = (systemTheme || theme) == "dark" ? "vs-dark" : "vs-light";
  useEffect(() => {
    monaco.editor.setTheme(editorTheme);
  }, [editorTheme]);

  const saveThenRestart = useCallback(async (): Promise<boolean> => {
    try {
      await onHandleSaveConfig("saveonly");
    } catch {
      // onHandleSaveConfig already shows the error; skip the restart
      return false;
    }
    sendRestart("restart");
    return true;
  }, [onHandleSaveConfig, sendRestart]);

  useEffect(() => {
    if (!rawConfig) {
      return;
    }

    const modelUri = monaco.Uri.parse(
      `a://b/api/config/schema_${Date.now()}.json`,
    );

    // Configure Monaco YAML schema only once
    if (!schemaConfiguredRef.current) {
      configureMonacoYaml(monaco, {
        enableSchemaRequest: true,
        hover: true,
        completion: true,
        validate: true,
        format: { enable: true },
        schemas: [
          {
            uri: `${apiHost}api/config/schema.json`,
            fileMatch: [String(modelUri)],
          },
        ],
      });
      schemaConfiguredRef.current = true;
    }

    if (!modelRef.current) {
      modelRef.current = monaco.editor.createModel(rawConfig, "yaml", modelUri);
    } else {
      modelRef.current.setValue(rawConfig);
    }
    const contentListener = modelRef.current.onDidChangeContent(() => {
      setHasChanges(modelRef.current?.getValue() != rawConfig);
    });

    const container = configRef.current;

    if (container && !editorRef.current) {
      editorRef.current = monaco.editor.create(container, {
        language: "yaml",
        model: modelRef.current,
        scrollBeyondLastLine: false,
        // fork: wrap lines and drop the minimap and gutters on phones
        ...(phoneFixes && isMobile ? phoneEditorOptions : {}),
      });
      editorRef.current?.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          void handleSaveOnly();
        },
      );
    } else if (editorRef.current) {
      editorRef.current.setModel(modelRef.current);
    }

    return () => {
      contentListener.dispose();
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
      if (modelRef.current) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
      schemaConfiguredRef.current = false;
    };
  }, [rawConfig, apiHost, handleSaveOnly]);

  // when in safe mode, attempt to validate the existing (invalid) config immediately
  // so that the user sees the validation errors without needing to press save
  useEffect(() => {
    if (
      config?.safe_mode &&
      rawConfig &&
      !initialValidationRef.current &&
      !error
    ) {
      initialValidationRef.current = true;
      axios
        .post(`config/save?save_option=saveonly`, rawConfig, {
          headers: { "Content-Type": "text/plain" },
        })
        .then(() => {
          // if this succeeds while in safe mode, we won't force any UI change
        })
        .catch((e: AxiosError<ApiErrorResponse>) => {
          const errorMessage =
            e.response?.data?.message ||
            e.response?.data?.detail ||
            "Unknown error";
          setError(errorMessage);
        });
    }
  }, [config?.safe_mode, rawConfig, error]);

  // monitoring state

  const [hasChanges, setHasChanges] = useState(false);
  useUnsavedNavigation(hasChanges);

  useEffect(() => {
    if (rawConfig && modelRef.current) {
      modelRef.current.setValue(rawConfig);
      setHasChanges(false);
    }
  }, [rawConfig]);

  // layout change handler

  const [{ width, height }] = useResizeObserver(configRef);

  useEffect(() => {
    if (editorRef.current) {
      // Small delay to ensure DOM has updated
      const timeoutId = setTimeout(() => {
        editorRef.current?.layout();
      }, 0);

      return () => clearTimeout(timeoutId);
    }
  }, [error, width, height]);

  if (!rawConfig) {
    return <ActivityIndicator />;
  }

  return (
    <div className="absolute bottom-2 left-0 right-0 top-2 md:left-2">
      <div className="relative flex h-full flex-col overflow-hidden">
        <div className="mr-1 flex items-center justify-between">
          <div>
            <Heading as="h2" className="mb-0 ml-1 md:ml-0">
              {t(config?.safe_mode ? "safeConfigEditor" : "configEditor")}
            </Heading>
            {config?.safe_mode && (
              <div className="text-sm text-secondary-foreground">
                {t("safeModeDescription")}
              </div>
            )}
          </div>
          <div className="flex flex-row gap-1">
            <Button
              size="sm"
              className="flex items-center gap-2"
              aria-label={t("copyConfig")}
              onClick={wrapAsync(() => handleCopyConfig())}
            >
              <LuCopy className="text-secondary-foreground" />
              <span className="hidden md:block">{t("copyConfig")}</span>
            </Button>
            <Button
              size="sm"
              className="flex items-center gap-2"
              aria-label={t("saveAndRestart")}
              onClick={handleSaveAndRestart}
            >
              <div className="relative size-5">
                <LuSave className="absolute left-0 top-0 size-3 text-secondary-foreground" />
                <MdOutlineRestartAlt className="absolute size-4 translate-x-1 translate-y-1/2 text-secondary-foreground" />
              </div>
              <span className="hidden md:block">{t("saveAndRestart")}</span>
            </Button>
            <Button
              size="sm"
              className="flex items-center gap-2"
              aria-label={t("saveOnly")}
              onClick={wrapAsync(handleSaveOnly)}
            >
              <LuSave className="text-secondary-foreground" />
              <span className="hidden md:block">{t("saveOnly")}</span>
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-1 flex-col overflow-hidden">
          {error && (
            <div className="mt-2 max-h-[30%] min-h-[2.5rem] overflow-auto whitespace-pre-wrap border-2 border-muted bg-background_alt p-4 text-sm text-danger md:max-h-[40%]">
              {error}
            </div>
          )}
          <div ref={configRef} className="flex-1 overflow-hidden" />
        </div>
      </div>
      <Toaster closeButton={true} />
      <RestartDialog
        isOpen={restartDialogOpen}
        onClose={() => setRestartDialogOpen(false)}
        onRestart={saveThenRestart}
      />
    </div>
  );
}

export default ConfigEditor;
