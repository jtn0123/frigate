import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShareClipButton from "./ShareClipButton";

const axiosPost = vi.fn<(url: string, body: unknown) => Promise<unknown>>();
const swrMutate = vi.fn();
let revokeFromList: ((token: string) => void) | undefined;

vi.mock("axios", () => ({
  default: { post: (url: string, body: unknown) => axiosPost(url, body) },
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

describe("ShareClipButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeFromList = undefined;
    axiosPost.mockResolvedValue({ data: SHARE });
  });

  it("creates a link, shows its QR code as an image and refreshes the list", async () => {
    render(<ShareClipButton eventId="event-1" />);
    fireEvent.click(screen.getByTestId("share-clip"));

    expect(
      await screen.findByRole("img", { name: "clipShare.qr" }),
    ).toBeInTheDocument();
    expect(axiosPost).toHaveBeenCalledWith("fork/share", {
      event_id: "event-1",
    });
    expect(swrMutate).toHaveBeenCalledWith("fork/share");
    expect(screen.getByTestId("active-links")).toHaveTextContent(SHARE.token);
  });

  it("replaces the link with a notice once it is revoked from the list", async () => {
    render(<ShareClipButton eventId="event-1" />);
    fireEvent.click(screen.getByTestId("share-clip"));
    await screen.findByTestId("share-clip-url");

    act(() => revokeFromList?.("someOtherToken1234567890"));
    expect(screen.getByTestId("share-clip-url")).toBeInTheDocument();

    act(() => revokeFromList?.(SHARE.token));
    expect(screen.queryByTestId("share-clip-url")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "clipShare.revokedNotice",
    );
    expect(screen.getByTestId("active-links")).toHaveTextContent("none");
  });

  it("renders nothing without a clip", () => {
    const { container } = render(
      <ShareClipButton eventId="event-1" hasClip={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
