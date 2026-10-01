import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseUrl } from "@/api/baseUrl";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Step1FormData } from "../Step1NameAndDefine";
import type { Step2FormData } from "../Step2StateArea";
import Step3ChooseExamples, {
  type Step3FormData,
} from "../Step3ChooseExamples";

const fixture = vi.hoisted(() => ({
  trainImages: undefined as string[] | undefined,
  swrKeys: [] as unknown[],
  mutateCalls: 0,
}));

const axiosPost = vi.fn<(url: string, body?: unknown) => Promise<unknown>>();
const axiosPut = vi.fn<(url: string, body?: unknown) => Promise<unknown>>();
const axiosGet = vi.fn<(url: string) => Promise<unknown>>();
const toastSuccess = vi.fn<(message: string, options?: unknown) => void>();
const toastError = vi.fn<(message: string) => void>();

vi.mock("swr", () => ({
  default: (key: string | null) => {
    fixture.swrKeys.push(key);
    return {
      data: key ? fixture.trainImages : undefined,
      mutate: () => {
        fixture.mutateCalls += 1;
        return Promise.resolve(fixture.trainImages);
      },
    };
  },
}));
vi.mock("axios", () => ({
  default: {
    post: (url: string, body?: unknown) => axiosPost(url, body),
    put: (url: string, body?: unknown) => axiosPut(url, body),
    get: (url: string) => axiosGet(url),
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options?: unknown) =>
      toastSuccess(message, options),
    error: (message: string) => toastError(message),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const { ns: _ns, ...rest } = options ?? {};
      return Object.keys(rest).length > 0
        ? `${key} ${JSON.stringify(rest)}`
        : key;
    },
  }),
}));

const stateModel: Step1FormData = {
  modelName: "door",
  modelType: "state",
  classes: ["open", "closed"],
};
const stateAreas: Step2FormData = {
  cameraAreas: [{ camera: "front", crop: [0.1, 0.2, 0.3, 0.4] }],
};
const objectModel: Step1FormData = {
  modelName: "bird",
  modelType: "object",
  objectLabel: "bird",
  classes: ["robin", "jay"],
};
const { objectLabel: _label, ...unlabeledObjectModel } = objectModel;

type Props = {
  step1Data?: Step1FormData;
  step2Data?: Step2FormData;
  initialData?: Partial<Step3FormData>;
};

function renderStep({
  step1Data = stateModel,
  step2Data = stateAreas,
  initialData,
}: Props = {}) {
  const onClose = vi.fn<() => void>();
  const onBack = vi.fn<() => void>();
  render(
    <TooltipProvider>
      <Step3ChooseExamples
        step1Data={step1Data}
        step2Data={step2Data}
        {...(initialData ? { initialData } : {})}
        onClose={onClose}
        onBack={onBack}
      />
    </TooltipProvider>,
  );
  return { onClose, onBack };
}

const generated = { examplesGenerated: true };

function image(index: number) {
  const card = screen
    .getByRole("img", { name: `Example ${index}` })
    .closest<HTMLElement>("[role=button]");
  if (!card) {
    throw new Error(`no card for example ${index}`);
  }
  return card;
}

function continueButton() {
  // the spinner shown while processing adds its label to the name
  return screen.getByRole("button", { name: /button\.continue$/ });
}

function prompt(className: string) {
  return screen.getByText(
    `wizard.step3.selectImagesPrompt {"className":"${className}"}`,
  );
}

function refreshIcon() {
  const button = screen
    .getAllByRole("button")
    .find((el) => el.classList.contains("absolute"));
  if (!button) {
    throw new Error("refresh button missing");
  }
  return button;
}

function urls(mock: typeof axiosPost) {
  return mock.mock.calls.map(([url]) => url);
}

beforeEach(() => {
  fixture.trainImages = ["a.webp", "b.webp", "c.webp"];
  fixture.swrKeys = [];
  fixture.mutateCalls = 0;
  axiosPost.mockResolvedValue({ data: {} });
  axiosPut.mockResolvedValue({ data: {} });
  axiosGet.mockResolvedValue({ data: [] });
});

describe("Step3ChooseExamples generation", () => {
  it("generates state examples from the camera crops on mount", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    axiosPost.mockReturnValueOnce(
      new Promise((res) => {
        resolve = res;
      }),
    );
    renderStep();

    expect(
      screen.getByText("wizard.step3.generating.title"),
    ).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    expect(fixture.swrKeys).toContain(null);
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/generate_examples/state",
      { model_name: "door", cameras: { front: [0.1, 0.2, 0.3, 0.4] } },
    );

    await act(async () => {
      resolve({ data: {} });
    });

    expect(toastSuccess).toHaveBeenCalledWith(
      "wizard.step3.generateSuccess",
      undefined,
    );
    expect(fixture.mutateCalls).toBe(1);
    expect(fixture.swrKeys).toContain("classification/door/train");
    expect(prompt("open")).toBeInTheDocument();
    expect(image(1)).toBeInTheDocument();
  });

  it("generates object examples from the label", async () => {
    renderStep({ step1Data: objectModel });
    await waitFor(() =>
      expect(axiosPost).toHaveBeenCalledWith(
        "/classification/generate_examples/object",
        { model_name: "bird", label: "bird" },
      ),
    );
    expect(await screen.findByText(/selectImagesPrompt/)).toBeInTheDocument();
  });

  it("refuses to generate a state model without cameras", async () => {
    renderStep({ step2Data: { cameraAreas: [] } });
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("wizard.step3.errors.noCameras"),
    );
    expect(axiosPost).not.toHaveBeenCalled();
    expect(
      screen.getByText("wizard.step3.errors.generationFailed"),
    ).toBeInTheDocument();
  });

  it("refuses to generate an object model without a label", async () => {
    renderStep({
      step1Data: unlabeledObjectModel,
    });
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "wizard.step3.errors.noObjectLabel",
      ),
    );
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("reports a failed generation and retries", async () => {
    axiosPost.mockRejectedValueOnce({
      response: { data: { detail: "no recordings" } },
    });
    renderStep();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.generateFailed {"error":"no recordings"}',
      ),
    );
    expect(
      screen.getByText("wizard.step3.errors.generationFailed"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "wizard.step3.retryGenerate" }),
    );
    expect(await screen.findByText(/selectImagesPrompt/)).toBeInTheDocument();
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  it("uses the error message or a fallback when generation fails", async () => {
    axiosPost.mockRejectedValueOnce({
      response: { data: { message: "busy" } },
    });
    renderStep();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.generateFailed {"error":"busy"}',
      ),
    );

    axiosPost.mockRejectedValueOnce({});
    fireEvent.click(
      screen.getByRole("button", { name: "wizard.step3.retryGenerate" }),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.generateFailed {"error":"Failed to generate examples"}',
      ),
    );

    axiosPost.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(
      screen.getByRole("button", { name: "wizard.step3.retryGenerate" }),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.generateFailed {"error":"offline"}',
      ),
    );
  });

  it("skips generation when examples already exist", () => {
    renderStep({ initialData: generated });
    expect(axiosPost).not.toHaveBeenCalled();
    expect(prompt("open")).toBeInTheDocument();
    expect(
      screen.getByText("wizard.step3.selectImagesDescription"),
    ).toBeInTheDocument();
  });

  it("offers a retry when no images came back", async () => {
    fixture.trainImages = [];
    renderStep({ initialData: generated });
    expect(screen.getByText("wizard.step3.noImages")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "wizard.step3.retryGenerate" }),
    );
    await waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
  });

  it("regenerates immediately when nothing is classified yet", async () => {
    renderStep({ initialData: generated });
    fireEvent.click(refreshIcon());
    await waitFor(() =>
      expect(axiosPost).toHaveBeenCalledWith(
        "/classification/generate_examples/state",
        expect.anything(),
      ),
    );
    expect(
      screen.queryByText("wizard.step3.refreshConfirm.title"),
    ).not.toBeInTheDocument();
  });
});

describe("Step3ChooseExamples selection", () => {
  it("renders cache busted thumbnails with a spinner until loaded", () => {
    renderStep({ initialData: generated });

    const thumb = screen.getByRole("img", { name: "Example 1" });
    expect(thumb.getAttribute("src")).toMatch(
      new RegExp(
        `^${baseUrl.replaceAll(".", "\\.")}clips/door/train/a\\.webp\\?t=\\d+$`,
      ),
    );
    const card = image(1);
    const before = card.childElementCount;
    fireEvent.load(thumb);
    expect(card.childElementCount).toBe(before - 1);
  });

  it("caps the grid at 24 images", () => {
    fixture.trainImages = Array.from({ length: 30 }, (_, i) => `${i}.webp`);
    renderStep({ initialData: generated });
    expect(screen.getAllByRole("img")).toHaveLength(24);
  });

  it("toggles selection by click and keyboard", () => {
    renderStep({ initialData: generated });

    expect(image(1)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(image(1));
    expect(image(1)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(image(1));
    expect(image(1)).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(image(2), { key: "Enter" });
    expect(image(2)).toHaveAttribute("aria-pressed", "true");
  });

  it("walks through states, goes back, and trains when every state has examples", async () => {
    axiosGet.mockResolvedValue({ data: ["c.webp", "a.webp"] });
    const { onBack, onClose } = renderStep({ initialData: generated });

    fireEvent.click(image(1));
    fireEvent.click(continueButton());
    expect(prompt("closed")).toBeInTheDocument();
    // a.webp now belongs to "open" and leaves the grid
    expect(screen.getAllByRole("img")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "button.back" }));
    expect(prompt("open")).toBeInTheDocument();
    expect(image(1)).toHaveAttribute("aria-pressed", "true");
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(continueButton());
    fireEvent.click(screen.getByRole("img", { name: "Example 1" }));
    fireEvent.click(continueButton());

    await waitFor(() =>
      expect(
        screen.getByText("wizard.step3.training.title"),
      ).toBeInTheDocument(),
    );
    expect(axiosPut).toHaveBeenCalledWith("/config/set", {
      requires_restart: 0,
      update_topic: "config/classification/custom/door",
      config_data: {
        classification: {
          custom: {
            door: {
              enabled: true,
              name: "door",
              threshold: 0.8,
              state_config: {
                cameras: { front: { crop: [0.1, 0.2, 0.3, 0.4] } },
                motion: true,
              },
            },
          },
        },
      },
    });
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/door/dataset/categorize",
      { training_file: "a.webp", category: "open" },
    );
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/door/dataset/categorize",
      { training_file: "b.webp", category: "closed" },
    );
    expect(axiosGet).toHaveBeenCalledWith("/classification/door/train");
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/door/train/delete",
      {
        ids: ["c.webp"],
      },
    );
    expect(urls(axiosPost)).not.toContain(
      "/classification/door/dataset/closed/create",
    );
    expect(urls(axiosPost)).toContain("/classification/door/train");
    expect(toastSuccess).toHaveBeenCalledWith("wizard.step3.trainingStarted", {
      closeButton: true,
    });
    expect(
      screen.queryByRole("button", { name: "button.continue" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "button.close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deselecting on a revisit drops the earlier choice", async () => {
    renderStep({ initialData: generated });
    fireEvent.click(image(1));
    fireEvent.click(continueButton());
    fireEvent.click(screen.getByRole("button", { name: "button.back" }));
    fireEvent.click(image(1));
    fireEvent.click(image(2));
    fireEvent.click(continueButton());

    // a.webp is free again, b.webp is now "open"
    expect(prompt("closed")).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("goes back to the previous step from the first state", () => {
    const { onBack } = renderStep({ initialData: generated });
    fireEvent.click(screen.getByRole("button", { name: "button.back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("creates the model without training when a state has no examples", async () => {
    axiosGet.mockRejectedValue(new Error("gone"));
    const { onClose } = renderStep({ initialData: generated });

    fireEvent.click(image(1));
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(urls(axiosPost)).toContain(
      "/classification/door/dataset/closed/create",
    );
    expect(urls(axiosPost)).not.toContain("/classification/door/train");
    expect(urls(axiosPost)).not.toContain("/classification/door/train/delete");
    expect(toastSuccess).toHaveBeenCalledWith("wizard.step3.modelCreated", {
      closeButton: true,
    });
  });

  it("warns about states without examples and confirms a refresh", async () => {
    renderStep({ initialData: generated });

    for (const index of [1, 2, 3]) {
      fireEvent.click(image(index));
    }
    fireEvent.click(continueButton());

    expect(
      screen.getByText("wizard.step3.missingStatesWarning.title"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/selectImagesPrompt/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "wizard.step3.refreshExamples" }),
    );
    expect(
      await screen.findByText("wizard.step3.refreshConfirm.title"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("wizard.step3.refreshConfirm.description"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByText("wizard.step3.refreshConfirm.title"),
      ).not.toBeInTheDocument(),
    );
    expect(axiosPost).not.toHaveBeenCalled();

    fireEvent.click(refreshIcon());
    fireEvent.click(
      await screen.findByRole("button", { name: "button.continue" }),
    );
    await waitFor(() =>
      expect(axiosPost).toHaveBeenCalledWith(
        "/classification/generate_examples/state",
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/"className":"open"/)).toBeInTheDocument();
  });

  it("finishes an all classified state model through continue", async () => {
    const { onClose } = renderStep({
      initialData: {
        examplesGenerated: true,
        imageClassifications: {
          "a.webp": "closed",
          "b.webp": "closed",
          "c.webp": "closed",
          "old.webp": "",
        },
      },
    });
    // every image belongs to another state, so continue submits directly
    expect(screen.queryByText(/selectImagesPrompt/)).not.toBeInTheDocument();
    fireEvent.click(continueButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(axiosPut).toHaveBeenCalledTimes(1);
    const categorized = axiosPost.mock.calls
      .filter(([url]) => url.endsWith("/categorize"))
      .map(([, body]) => body);
    expect(categorized).toEqual([
      { training_file: "a.webp", category: "closed" },
      { training_file: "b.webp", category: "closed" },
      { training_file: "c.webp", category: "closed" },
    ]);
    expect(urls(axiosPost)).toContain(
      "/classification/door/dataset/open/create",
    );
  });

  it("shows progress while classifying and reports failures", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    axiosPut.mockReturnValueOnce(
      new Promise((_res, rej) => {
        reject = rej;
      }),
    );
    renderStep({
      initialData: {
        examplesGenerated: true,
        imageClassifications: {
          "a.webp": "closed",
          "b.webp": "closed",
          "c.webp": "closed",
        },
      },
    });
    fireEvent.click(continueButton());

    expect(
      await screen.findByText("wizard.step3.classifying"),
    ).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();

    await act(async () => {
      reject({ response: { data: { message: "config locked" } } });
    });
    expect(toastError).toHaveBeenCalledWith(
      'wizard.step3.errors.classifyFailed {"error":"config locked"}',
    );
    expect(continueButton()).toBeEnabled();

    axiosPut.mockRejectedValueOnce({ response: { data: { detail: "bad" } } });
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.classifyFailed {"error":"bad"}',
      ),
    );

    axiosPut.mockRejectedValueOnce({});
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.classifyFailed {"error":"Failed to classify images"}',
      ),
    );
  });

  it("reports failures from the last selection step", async () => {
    axiosPut.mockRejectedValue(new Error("down"));
    renderStep({ initialData: generated });
    fireEvent.click(image(1));
    fireEvent.click(continueButton());
    fireEvent.click(image(1));
    fireEvent.click(continueButton());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.classifyFailed {"error":"down"}',
      ),
    );

    axiosPut.mockRejectedValueOnce({ response: { data: { detail: "nope" } } });
    fireEvent.click(image(1));
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.classifyFailed {"error":"nope"}',
      ),
    );

    axiosPut.mockRejectedValueOnce({ response: { data: { message: "m" } } });
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.classifyFailed {"error":"m"}',
      ),
    );

    axiosPut.mockRejectedValueOnce({});
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'wizard.step3.errors.classifyFailed {"error":"Failed to classify images"}',
      ),
    );
  });

  it("files leftover object images under none and trains", async () => {
    const { onClose } = renderStep({
      step1Data: objectModel,
      initialData: generated,
    });

    fireEvent.click(image(1));
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());

    await waitFor(() =>
      expect(
        screen.getByText("wizard.step3.training.title"),
      ).toBeInTheDocument(),
    );
    const put = axiosPut.mock.calls[0]?.[1];
    expect(put).toMatchObject({
      config_data: {
        classification: {
          custom: {
            bird: {
              object_config: {
                objects: ["bird"],
                classification_type: "sub_label",
              },
            },
          },
        },
      },
    });
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/bird/dataset/categorize",
      { training_file: "a.webp", category: "robin" },
    );
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/bird/dataset/categorize",
      { training_file: "b.webp", category: "none" },
    );
    expect(axiosPost).toHaveBeenCalledWith(
      "/classification/bird/dataset/categorize",
      { training_file: "c.webp", category: "none" },
    );
    expect(axiosGet).not.toHaveBeenCalled();
    expect(urls(axiosPost)).toContain(
      "/classification/bird/dataset/jay/create",
    );
    expect(urls(axiosPost)).toContain("/classification/bird/train");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("creates an object model without training when nothing was picked", async () => {
    const { onClose } = renderStep({
      step1Data: {
        ...unlabeledObjectModel,
        objectType: "attribute",
      },
      initialData: generated,
    });

    fireEvent.click(continueButton());
    fireEvent.click(continueButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(axiosPut.mock.calls[0]?.[1]).toMatchObject({
      config_data: {
        classification: {
          custom: {
            bird: {
              object_config: { objects: [], classification_type: "attribute" },
            },
          },
        },
      },
    });
    expect(urls(axiosPost)).not.toContain("/classification/bird/train");
  });
});
