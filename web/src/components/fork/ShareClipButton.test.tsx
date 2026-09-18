import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShareClipButton from "./ShareClipButton";

const axiosPost = vi.fn<(url: string, body: unknown) => Promise<unknown>>();
const swrMutate = vi.fn();
let revokeFromList: ((token: string) => void) | undefined;

vi.mock("axios", () => ({
  default: {
    post: (url: string, body: unknown) => axiosPost(url, body),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "response" in error,
  },
}));
vi.mock("swr", () => ({
  default: vi.fn(),
  useSWRConfig: () => ({ mutate: swrMutate }),
}));
vi.mock("@/components/fork/ActiveShareLinks", () => ({
  default: (props: {
    currentToken?: string;
    onRevoked: (token: string) => void;
  }) => {
    revokeFromList = props.onRevoked;
    return <div data-testid="active-links">{props.currentToken ?? "none"}</div>;
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

const SHARE = {
  token: "e2eShareToken123456789012345678",
  url: "/share/e2eShareToken123456789012345678",
  expires_at: 1,
  event_id: "event-1",
  camera: "front_door",
  label: "person",
  start_time: 1,
  end_time: 2,
  has_clip: true,
};

const OTHER_SHARE = { ...SHARE, token: "e2eSecondToken12345678901234567" };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function openDialog() {
  fireEvent.click(screen.getByTestId("share-clip"));
}

function clickCreate() {
  fireEvent.click(screen.getByTestId("share-clip-create"));
}

describe("ShareClipButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeFromList = undefined;
    axiosPost.mockResolvedValue({ data: SHARE });
  });

  it("opens on the active list without creating a link", () => {
    render(<ShareClipButton eventId="event-1" />);
    openDialog();

    expect(screen.getByTestId("active-links")).toHaveTextContent("none");
    expect(screen.getByTestId("share-clip-create")).toHaveTextContent(
      "clipShare.create",
    );
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("creates a link, shows its QR code as an image and refreshes the list", async () => {
    render(<ShareClipButton eventId="event-1" />);
    openDialog();
    clickCreate();

    expect(
      await screen.findByRole("img", { name: "clipShare.qr" }),
    ).toBeInTheDocument();
    expect(axiosPost).toHaveBeenCalledWith("fork/share", {
      event_id: "event-1",
    });
    expect(swrMutate).toHaveBeenCalledWith("fork/share");
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("active-links")).toHaveTextContent(SHARE.token);
    expect(screen.queryByTestId("share-clip-create")).not.toBeInTheDocument();
  });

  it("stays open with the list and a limit message when the cap answers 429", async () => {
    axiosPost.mockRejectedValue({ response: { status: 429 } });
    render(<ShareClipButton eventId="event-1" />);
    openDialog();
    clickCreate();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "clipShare.limitReached",
    );
    expect(screen.getByTestId("share-clip-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("active-links")).toBeInTheDocument();
    expect(swrMutate).not.toHaveBeenCalled();

    // revoking a link makes room, so the message goes and create is offered
    act(() => revokeFromList?.("someOtherToken1234567890"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-clip-create")).not.toBeDisabled();
  });

  it("stays open with a general message on any other create failure", async () => {
    axiosPost.mockRejectedValue(new Error("offline"));
    render(<ShareClipButton eventId="event-1" />);
    openDialog();
    clickCreate();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "clipShare.createFailed",
    );
    expect(screen.getByTestId("active-links")).toBeInTheDocument();

    // the button retries, and a success clears the message
    axiosPost.mockResolvedValue({ data: SHARE });
    clickCreate();
    await screen.findByTestId("share-clip-url");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not send a second request while one is in flight", () => {
    axiosPost.mockReturnValue(deferred<unknown>().promise);
    render(<ShareClipButton eventId="event-1" />);
    openDialog();
    clickCreate();

    expect(screen.getByTestId("share-clip-create")).toBeDisabled();
    clickCreate();
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it("drops a result that arrives after the dialog was closed and reopened", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    axiosPost
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<ShareClipButton eventId="event-1" />);
    openDialog();
    clickCreate();
    fireEvent.keyDown(screen.getByTestId("share-clip-dialog"), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("share-clip-dialog")).not.toBeInTheDocument(),
    );

    openDialog();
    // the abandoned request does not keep the reopened dialog busy
    expect(screen.getByTestId("share-clip-create")).not.toBeDisabled();
    await act(async () => {
      first.resolve({ data: SHARE });
      await first.promise;
    });
    expect(screen.queryByTestId("share-clip-url")).not.toBeInTheDocument();
    // the abandoned link still exists on the server, so the list is refreshed
    expect(swrMutate).toHaveBeenCalledWith("fork/share");

    clickCreate();
    await act(async () => {
      second.resolve({ data: OTHER_SHARE });
      await second.promise;
    });
    expect(
      screen.getByTestId<HTMLInputElement>("share-clip-url").value,
    ).toContain(OTHER_SHARE.token);
  });

  it("replaces the link with a notice once it is revoked from the list", async () => {
    render(<ShareClipButton eventId="event-1" />);
    openDialog();
    clickCreate();
    await screen.findByTestId("share-clip-url");

    act(() => revokeFromList?.("someOtherToken1234567890"));
    expect(screen.getByTestId("share-clip-url")).toBeInTheDocument();

    act(() => revokeFromList?.(SHARE.token));
    expect(screen.queryByTestId("share-clip-url")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "clipShare.revokedNotice",
    );
    expect(screen.getByTestId("active-links")).toHaveTextContent("none");
    // a replacement can be made without reopening the dialog
    expect(screen.getByTestId("share-clip-create")).not.toBeDisabled();
  });

  it("renders nothing without a clip", () => {
    const { container } = render(
      <ShareClipButton eventId="event-1" hasClip={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
