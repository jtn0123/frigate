import { render, waitFor } from "@testing-library/react";
import { startTransition, useLayoutEffect, useState } from "react";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useSearchEffect } from "@/hooks/use-overlay-state";

afterEach(() => window.history.replaceState(null, "", "/"));

it("processes a newer settings link before removing the old query", async () => {
  window.history.replaceState(null, "", "/settings?page=cameraBirdseye");
  const processed = vi.fn();

  function SettingsLink() {
    const navigate = useNavigate();
    const [page, setPage] = useState("");
    useSearchEffect("page", (value) => {
      processed(value);
      startTransition(() => setPage(value));
      return true;
    });
    useLayoutEffect(() => {
      if (page === "cameraBirdseye") {
        void navigate("/settings?page=cameraDetect");
      }
    }, [page, navigate]);
    return <div>{page}</div>;
  }

  render(
    <BrowserRouter>
      <SettingsLink />
    </BrowserRouter>,
  );
  await waitFor(() => expect(processed).toHaveBeenCalledWith("cameraDetect"));
  expect(window.location.search).toBe("");
});

it.each(["front_door", "back_yard"])(
  "keeps camera cleanup from erasing a newer page for %s",
  async (camera) => {
    window.history.replaceState(
      null,
      "",
      "/settings?page=cameraBirdseye&camera=front_door",
    );
    const processed = vi.fn();
    const selectedCamera = vi.fn(() => true);

    function SettingsLink() {
      const navigate = useNavigate();
      const [page, setPage] = useState("");
      useSearchEffect("page", (value) => {
        processed(value);
        startTransition(() => setPage(value));
        return true;
      });
      useSearchEffect("camera", selectedCamera);
      useLayoutEffect(() => {
        if (page === "cameraBirdseye") {
          void navigate(`/settings?page=cameraDetect&camera=${camera}`);
        }
      }, [page, navigate]);
      return <div>{page}</div>;
    }

    render(
      <BrowserRouter>
        <SettingsLink />
      </BrowserRouter>,
    );
    await waitFor(() => expect(processed).toHaveBeenCalledWith("cameraDetect"));
    expect(selectedCamera).toHaveBeenCalledWith(camera);
    await waitFor(() => expect(window.location.search).toBe(""));
  },
);

it.each(["", "/frigate"])(
  "preserves newer overlay state when consuming a query under '%s'",
  async (basename) => {
    window.history.replaceState(null, "", `${basename}/review?id=event#top`);
    const overlay = { recording: { startTime: 123 } };

    function ReviewLink() {
      const navigate = useNavigate();
      const location = useLocation();
      const [ready, setReady] = useState(false);
      useSearchEffect("id", () => {
        startTransition(() => setReady(true));
        return true;
      });
      useLayoutEffect(() => {
        if (ready) {
          void navigate("/review?id=event#top", { state: overlay });
        }
      }, [ready, navigate]);
      return <div>{JSON.stringify(location.state)}</div>;
    }

    const view = render(
      <BrowserRouter basename={basename}>
        <ReviewLink />
      </BrowserRouter>,
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.hash).toBe("#top");
    const state = window.history.state as { usr?: unknown };
    expect(state.usr).toEqual(overlay);
    expect(view.container.textContent).toBe(JSON.stringify(overlay));
  },
);

it("does not navigate back to the old path when a newer link changes it", async () => {
  window.history.replaceState(null, "", "/settings?page=cameraBirdseye");
  const processed = vi.fn();

  function RouteLink() {
    const navigate = useNavigate();
    const [page, setPage] = useState("");
    useSearchEffect("page", (value) => {
      processed(value);
      startTransition(() => setPage(value));
      return true;
    });
    useLayoutEffect(() => {
      if (page === "cameraBirdseye") {
        void navigate("/live?page=all");
      }
    }, [page, navigate]);
    return <div>{page}</div>;
  }

  render(
    <BrowserRouter>
      <RouteLink />
    </BrowserRouter>,
  );
  await waitFor(() => expect(processed).toHaveBeenCalledWith("all"));
  await waitFor(() => expect(window.location.search).toBe(""));
  expect(window.location.pathname).toBe("/live");
});
