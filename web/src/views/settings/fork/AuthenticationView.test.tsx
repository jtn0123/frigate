import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/types/user";
import AuthenticationView from "../AuthenticationView";

type UsersUpdater = (users: User[] | undefined) => User[] | undefined;
type HttpResponse = { status: number };

const state = vi.hoisted(() => ({
  config: undefined as unknown,
  users: undefined as unknown,
  usersError: undefined as unknown,
  updateConfig: vi.fn<() => Promise<unknown>>(),
  mutateUsers:
    vi.fn<(updater?: UsersUpdater, revalidate?: boolean) => Promise<unknown>>(),
  put: vi.fn<(url: string, body?: unknown) => Promise<HttpResponse>>(),
  post: vi.fn<(url: string, body?: unknown) => Promise<HttpResponse>>(),
  del: vi.fn<(url: string) => Promise<HttpResponse>>(),
  toastSuccess: vi.fn<(message: string, options?: unknown) => void>(),
  toastError: vi.fn<(message: string, options?: unknown) => void>(),
  wrapped: [] as Promise<unknown>[],
}));

// The view hands wrapAsync handlers that rethrow after toasting; keep each
// promise so a test can assert the rejection instead of leaking it.
vi.mock("@/utils/promise", () => ({
  wrapAsync:
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    (...args: A) => {
      const promise = Promise.resolve(fn(...args));
      promise.catch(() => undefined);
      state.wrapped.push(promise);
    },
}));
vi.mock("swr", () => ({
  default: (key: string) => {
    if (key === "config") {
      return { data: state.config, mutate: state.updateConfig };
    }
    if (key === "users") {
      return {
        data: state.users,
        error: state.usersError,
        mutate: state.mutateUsers,
      };
    }
    return { data: undefined };
  },
}));
vi.mock("axios", () => ({
  default: {
    put: (url: string, body?: unknown) => state.put(url, body),
    post: (url: string, body?: unknown) => state.post(url, body),
    delete: (url: string) => state.del(url),
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options?: unknown) =>
      state.toastSuccess(message, options),
    error: (message: string, options?: unknown) =>
      state.toastError(message, options),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const rest = { ...options };
      delete rest["ns"];
      return Object.keys(rest).length > 0
        ? `${key} ${JSON.stringify(rest)}`
        : key;
    },
  }),
}));

// The overlay dialogs carry their own forms and tests; these stubs expose
// their callbacks so the view's handlers can be driven directly.
vi.mock("@/components/overlay/SetPasswordDialog", () => ({
  default: (props: {
    show: boolean;
    onSave: (password: string, oldPassword?: string) => void;
    onCancel: () => void;
    initialError?: string | null;
    isLoading?: boolean;
  }) =>
    props.show ? (
      <div data-testid="set-password">
        <span data-testid="password-error">{props.initialError ?? ""}</span>
        <span data-testid="password-loading">{String(props.isLoading)}</span>
        <button onClick={() => props.onSave("newpass", "oldpass")}>
          stub-save-password
        </button>
        <button onClick={props.onCancel}>stub-cancel-password</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/CreateUserDialog", () => ({
  default: (props: {
    show: boolean;
    onCreate: (user: string, password: string, role: string) => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="create-user">
        <button onClick={() => props.onCreate("carol", "secret", "viewer")}>
          stub-create-user
        </button>
        <button onClick={props.onCancel}>stub-cancel-create</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/DeleteUserDialog", () => ({
  default: (props: {
    show: boolean;
    username?: string;
    onDelete: () => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="delete-user">
        <span>{`delete ${props.username}`}</span>
        <button onClick={props.onDelete}>stub-delete-user</button>
        <button onClick={props.onCancel}>stub-cancel-delete</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/RoleChangeDialog", () => ({
  default: (props: {
    show: boolean;
    username: string;
    currentRole: string;
    availableRoles: string[];
    onSave: (role: string) => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="role-change">
        <span>{`${props.username}:${props.currentRole}`}</span>
        <span data-testid="available-roles">
          {props.availableRoles.join(",")}
        </span>
        <button onClick={() => props.onSave("operator")}>stub-save-role</button>
        <button onClick={props.onCancel}>stub-cancel-role</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/CreateRoleDialog", () => ({
  default: (props: {
    show: boolean;
    onCreate: (role: string, cameras: string[]) => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="create-role">
        <button onClick={() => props.onCreate("guard", ["front_door"])}>
          stub-create-role
        </button>
        <button onClick={props.onCancel}>stub-cancel-create-role</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/EditRoleCamerasDialog", () => ({
  default: (props: {
    show: boolean;
    role: string;
    currentCameras: string[];
    onSave: (cameras: string[]) => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="edit-role">
        <span>{`${props.role}:${props.currentCameras.join(",")}`}</span>
        <button onClick={() => props.onSave(["back_yard"])}>
          stub-save-cameras
        </button>
        <button onClick={props.onCancel}>stub-cancel-edit-role</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/DeleteRoleDialog", () => ({
  default: (props: {
    show: boolean;
    role: string;
    onDelete: () => void;
    onCancel: () => void;
  }) =>
    props.show ? (
      <div data-testid="delete-role">
        <span>{`delete role ${props.role}`}</span>
        <button onClick={props.onDelete}>stub-delete-role</button>
        <button onClick={props.onCancel}>stub-cancel-delete-role</button>
      </div>
    ) : null,
}));

/** Narrows an indexed lookup that the test knows is present. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const MANY_CAMERAS = ["a", "b", "c", "d", "e", "f"];

function makeConfig(roles: Record<string, string[] | null>) {
  return {
    auth: { roles },
    cameras: {
      front_door: { friendly_name: "Front Door" },
      back_yard: {},
    },
  };
}

function makeUsers(): User[] {
  return [
    { username: "admin", role: "admin" },
    { username: "bob", role: "operator" },
    { username: "dave", role: "" },
  ];
}

function httpError(data: Record<string, string>) {
  return { response: { data } };
}

/** Apply the last optimistic updater passed to mutateUsers. */
function lastUsersUpdate(input: User[]): User[] | undefined {
  const call = state.mutateUsers.mock.calls.at(-1);
  expect(call?.[1]).toBe(false);
  const updater = call?.[0];
  if (!updater) throw new Error("mutateUsers was not called with an updater");
  return updater(input);
}

function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest("tr");
  if (!row) throw new Error(`no table row for ${text}`);
  return row;
}

beforeEach(() => {
  state.wrapped = [];
  state.config = makeConfig({
    admin: [],
    viewer: [],
    operator: ["front_door"],
    many: MANY_CAMERAS,
    broken: null,
  });
  state.users = makeUsers();
  state.usersError = undefined;
  state.updateConfig.mockResolvedValue(undefined);
  state.mutateUsers.mockResolvedValue(undefined);
  state.put.mockResolvedValue({ status: 200 });
  state.post.mockResolvedValue({ status: 201 });
  state.del.mockResolvedValue({ status: 200 });
});

describe("AuthenticationView loading and error states", () => {
  it("shows a spinner while config or users are loading", () => {
    state.users = undefined;
    const { container } = render(<AuthenticationView />);

    expect(container.querySelector(".animate-spin, svg")).not.toBeNull();
    expect(screen.queryByText("users.management.title")).toBeNull();
  });

  it("shows the users load error with a retry that refetches", () => {
    state.users = undefined;
    state.usersError = { response: { status: 500 } };
    render(<AuthenticationView section="users" />);

    const retry = screen.getByRole("button");
    fireEvent.click(retry);
    expect(state.mutateUsers).toHaveBeenCalledWith();
  });

  it("names the roles page in the forbidden error", () => {
    state.users = undefined;
    state.usersError = { response: { status: 403 } };
    render(<AuthenticationView section="roles" />);

    expect(
      screen.getByText('usersLoadError.forbiddenRoles {"status":403}'),
    ).toBeInTheDocument();
  });

  it("sets the document title", () => {
    render(<AuthenticationView section="users" />);
    expect(document.title).toBe("documentTitle.authentication");
  });
});

describe("AuthenticationView sections", () => {
  it("renders both sections with a separator when no section is given", () => {
    render(<AuthenticationView />);

    expect(screen.getByText("users.management.title")).toBeInTheDocument();
    expect(screen.getByText("roles.management.title")).toBeInTheDocument();
  });

  it("renders only users for the users section", () => {
    render(<AuthenticationView section="users" />);

    expect(screen.getByText("users.management.title")).toBeInTheDocument();
    expect(screen.queryByText("roles.management.title")).toBeNull();
  });

  it("renders only roles for the roles section", () => {
    render(<AuthenticationView section="roles" />);

    expect(screen.getByText("roles.management.title")).toBeInTheDocument();
    expect(screen.queryByText("users.management.title")).toBeNull();
  });
});

describe("AuthenticationView users", () => {
  it("lists users with roles and hides role and delete actions for admin", () => {
    render(<AuthenticationView section="users" />);

    expect(within(rowFor("admin")).getByText("role.admin")).toBeInTheDocument();
    expect(
      within(rowFor("bob")).getByText("role.operator"),
    ).toBeInTheDocument();
    // an empty role falls back to viewer
    expect(within(rowFor("dave")).getByText("role.viewer")).toBeInTheDocument();

    expect(within(rowFor("admin")).getAllByRole("button")).toHaveLength(1);
    expect(within(rowFor("bob")).getAllByRole("button")).toHaveLength(3);
  });

  it("shows the empty state when there are no users", () => {
    state.users = [];
    render(<AuthenticationView section="users" />);

    expect(screen.getByText("users.table.noUsers")).toBeInTheDocument();
  });

  it("creates a user and appends it optimistically", async () => {
    render(<AuthenticationView section="users" />);

    fireEvent.click(screen.getByRole("button", { name: "users.addUser" }));
    fireEvent.click(screen.getByText("stub-create-user"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'users.toast.success.createUser {"user":"carol"}',
        { position: "top-center" },
      ),
    );
    expect(state.post).toHaveBeenCalledWith("users", {
      username: "carol",
      password: "secret",
      role: "viewer",
    });
    expect(lastUsersUpdate([{ username: "x", role: "admin" }])).toEqual([
      { username: "x", role: "admin" },
      { username: "carol", role: "viewer" },
    ]);
    expect(screen.queryByTestId("create-user")).toBeNull();
  });

  it("closes the create dialog on cancel", () => {
    render(<AuthenticationView section="users" />);

    fireEvent.click(screen.getByRole("button", { name: "users.addUser" }));
    fireEvent.click(screen.getByText("stub-cancel-create"));
    expect(screen.queryByTestId("create-user")).toBeNull();
  });

  it("does nothing for an unexpected create status", async () => {
    state.post.mockResolvedValue({ status: 204 });
    render(<AuthenticationView section="users" />);

    fireEvent.click(screen.getByRole("button", { name: "users.addUser" }));
    fireEvent.click(screen.getByText("stub-create-user"));

    await waitFor(() => expect(state.post).toHaveBeenCalled());
    expect(state.toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByTestId("create-user")).toBeInTheDocument();
  });

  it.each([
    [httpError({ message: "taken" }), "taken"],
    [httpError({ detail: "bad role" }), "bad role"],
    [new Error("offline"), "Unknown error"],
  ])("toasts the create failure message", async (error, message) => {
    state.post.mockRejectedValue(error);
    render(<AuthenticationView section="users" />);

    fireEvent.click(screen.getByRole("button", { name: "users.addUser" }));
    fireEvent.click(screen.getByText("stub-create-user"));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        `users.toast.error.createUserFailed {"errorMessage":"${message}"}`,
        { position: "top-center" },
      ),
    );
  });

  it("deletes a user and filters it out", async () => {
    render(<AuthenticationView section="users" />);

    const [, , deleteButton] = within(rowFor("bob")).getAllByRole("button");
    fireEvent.click(must(deleteButton));
    expect(screen.getByText("delete bob")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-delete-user"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'users.toast.success.deleteUser {"user":"bob"}',
        { position: "top-center" },
      ),
    );
    expect(state.del).toHaveBeenCalledWith("users/bob");
    expect(lastUsersUpdate(makeUsers())).toEqual([
      { username: "admin", role: "admin" },
      { username: "dave", role: "" },
    ]);
    expect(screen.queryByTestId("delete-user")).toBeNull();
  });

  it("toasts a failed delete and keeps the dialog open", async () => {
    state.del.mockRejectedValue(httpError({ detail: "nope" }));
    render(<AuthenticationView section="users" />);

    const [, , deleteButton] = within(rowFor("bob")).getAllByRole("button");
    fireEvent.click(must(deleteButton));
    fireEvent.click(screen.getByText("stub-delete-user"));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        'users.toast.error.deleteUserFailed {"errorMessage":"nope"}',
        { position: "top-center" },
      ),
    );
    expect(screen.getByTestId("delete-user")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-cancel-delete"));
    expect(screen.queryByTestId("delete-user")).toBeNull();
  });

  it("changes a user's role", async () => {
    render(<AuthenticationView section="users" />);

    const [roleButton] = within(rowFor("bob")).getAllByRole("button");
    fireEvent.click(must(roleButton));
    expect(screen.getByText("bob:operator")).toBeInTheDocument();
    expect(screen.getByTestId("available-roles")).toHaveTextContent(
      "admin,viewer,operator,many,broken",
    );
    fireEvent.click(screen.getByText("stub-save-role"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'users.toast.success.roleUpdated {"user":"bob"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("users/bob/role", {
      role: "operator",
    });
    expect(lastUsersUpdate(makeUsers())).toEqual([
      { username: "admin", role: "admin" },
      { username: "bob", role: "operator" },
      { username: "dave", role: "" },
    ]);
    expect(lastUsersUpdate([{ username: "bob", role: "viewer" }])).toEqual([
      { username: "bob", role: "operator" },
    ]);
    expect(screen.queryByTestId("role-change")).toBeNull();
  });

  it("opens the role dialog with viewer for a user without a role", () => {
    render(<AuthenticationView section="users" />);

    const [roleButton] = within(rowFor("dave")).getAllByRole("button");
    fireEvent.click(must(roleButton));
    expect(screen.getByText("dave:viewer")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-cancel-role"));
    expect(screen.queryByTestId("role-change")).toBeNull();
  });

  it("toasts a failed role change", async () => {
    state.put.mockRejectedValue(httpError({ message: "forbidden" }));
    render(<AuthenticationView section="users" />);

    const [roleButton] = within(rowFor("bob")).getAllByRole("button");
    fireEvent.click(must(roleButton));
    fireEvent.click(screen.getByText("stub-save-role"));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        'users.toast.error.roleUpdateFailed {"errorMessage":"forbidden"}',
        { position: "top-center" },
      ),
    );
  });

  it("updates a password and closes the dialog", async () => {
    render(<AuthenticationView section="users" />);

    const [, passwordButton] = within(rowFor("bob")).getAllByRole("button");
    fireEvent.click(must(passwordButton));
    fireEvent.click(screen.getByText("stub-save-password"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        "users.toast.success.updatePassword",
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("users/bob/password", {
      password: "newpass",
      old_password: "oldpass",
    });
    expect(screen.queryByTestId("set-password")).toBeNull();
  });

  it("keeps the password dialog open with the server error, then clears it on cancel", async () => {
    state.put.mockRejectedValue(httpError({ detail: "wrong old password" }));
    render(<AuthenticationView section="users" />);

    const [passwordButton] = within(rowFor("admin")).getAllByRole("button");
    fireEvent.click(must(passwordButton));
    fireEvent.click(screen.getByText("stub-save-password"));

    await waitFor(() =>
      expect(screen.getByTestId("password-error")).toHaveTextContent(
        "wrong old password",
      ),
    );
    expect(state.put).toHaveBeenCalledWith("users/admin/password", {
      password: "newpass",
      old_password: "oldpass",
    });
    expect(screen.getByTestId("password-loading")).toHaveTextContent("false");

    fireEvent.click(screen.getByText("stub-cancel-password"));
    expect(screen.queryByTestId("set-password")).toBeNull();
    fireEvent.click(must(passwordButton));
    expect(screen.getByTestId("password-error")).toHaveTextContent("");
  });

  it("falls back to an unknown password error", async () => {
    state.put.mockRejectedValue(new Error("offline"));
    render(<AuthenticationView section="users" />);

    const [passwordButton] = within(rowFor("admin")).getAllByRole("button");
    fireEvent.click(must(passwordButton));
    fireEvent.click(screen.getByText("stub-save-password"));

    await waitFor(() =>
      expect(screen.getByTestId("password-error")).toHaveTextContent(
        "Unknown error",
      ),
    );
  });
});

describe("AuthenticationView roles", () => {
  it("lists non-admin roles with their camera summary", () => {
    render(<AuthenticationView section="roles" />);

    expect(screen.queryByText("admin")).toBeNull();
    expect(
      within(rowFor("viewer")).getByText("menu.live.allCameras"),
    ).toBeInTheDocument();
    // viewer is built in, so it has no actions
    expect(within(rowFor("viewer")).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(rowFor("operator")).getByText("Front Door"),
    ).toBeInTheDocument();
    expect(within(rowFor("many")).getByText("6 cameras")).toBeInTheDocument();
    // a non-array role value counts as all cameras
    expect(
      within(rowFor("broken")).getByText("menu.live.allCameras"),
    ).toBeInTheDocument();
    expect(within(rowFor("operator")).getAllByRole("button")).toHaveLength(2);
  });

  it("shows the empty state with only the admin role", () => {
    state.config = makeConfig({ admin: [] });
    render(<AuthenticationView section="roles" />);

    expect(screen.getByText("roles.table.noRoles")).toBeInTheDocument();
  });

  it("shows the empty state when auth has no roles", () => {
    state.config = { auth: {}, cameras: {} };
    render(<AuthenticationView section="roles" />);

    expect(screen.getByText("roles.table.noRoles")).toBeInTheDocument();
  });

  it("creates a role", async () => {
    render(<AuthenticationView section="roles" />);

    fireEvent.click(screen.getByRole("button", { name: "roles.addRole" }));
    fireEvent.click(screen.getByText("stub-create-role"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'roles.toast.success.createRole {"role":"guard"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("config/set", {
      requires_restart: 0,
      config_data: { auth: { roles: { guard: ["front_door"] } } },
      update_topic: "config/auth",
    });
    expect(state.updateConfig).toHaveBeenCalled();
    expect(screen.queryByTestId("create-role")).toBeNull();
  });

  it("toasts a failed role creation", async () => {
    state.put.mockRejectedValue(httpError({ message: "exists" }));
    render(<AuthenticationView section="roles" />);

    fireEvent.click(screen.getByRole("button", { name: "roles.addRole" }));
    fireEvent.click(screen.getByText("stub-create-role"));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        'roles.toast.error.createRoleFailed {"errorMessage":"exists"}',
        { position: "top-center" },
      ),
    );
    // wrapAsync drops this rethrow, so the dialog never sees the failure
    await expect(state.wrapped.at(-1)).rejects.toEqual(
      httpError({ message: "exists" }),
    );
    expect(screen.getByTestId("create-role")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-cancel-create-role"));
    expect(screen.queryByTestId("create-role")).toBeNull();
  });

  it("edits a role's cameras", async () => {
    render(<AuthenticationView section="roles" />);

    const [editButton] = within(rowFor("operator")).getAllByRole("button");
    fireEvent.click(must(editButton));
    expect(screen.getByText("operator:front_door")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-save-cameras"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'roles.toast.success.updateCameras {"role":"operator"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledWith("config/set", {
      requires_restart: 0,
      config_data: { auth: { roles: { operator: ["back_yard"] } } },
      update_topic: "config/auth",
    });
    expect(state.updateConfig).toHaveBeenCalled();
    expect(screen.queryByTestId("edit-role")).toBeNull();
  });

  it("toasts a failed camera edit and closes on cancel", async () => {
    state.put.mockRejectedValue(new Error("offline"));
    render(<AuthenticationView section="roles" />);

    const [editButton] = within(rowFor("operator")).getAllByRole("button");
    fireEvent.click(must(editButton));
    fireEvent.click(screen.getByText("stub-save-cameras"));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        'roles.toast.error.updateCamerasFailed {"errorMessage":"Unknown error"}',
        { position: "top-center" },
      ),
    );
    await expect(state.wrapped.at(-1)).rejects.toThrow("offline");
    fireEvent.click(screen.getByText("stub-cancel-edit-role"));
    expect(screen.queryByTestId("edit-role")).toBeNull();
  });

  it("deletes a role and moves its users to viewer", async () => {
    render(<AuthenticationView section="roles" />);

    const [, deleteButton] = within(rowFor("operator")).getAllByRole("button");
    fireEvent.click(must(deleteButton));
    expect(screen.getByText("delete role operator")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-delete-role"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'roles.toast.success.deleteRole {"role":"operator"}',
        { position: "top-center" },
      ),
    );
    expect(state.toastSuccess).toHaveBeenCalledWith(
      'roles.toast.success.userRolesUpdated {"count":1}',
      { position: "top-center" },
    );
    expect(state.put).toHaveBeenCalledWith("users/bob/role", {
      role: "viewer",
    });
    expect(state.put).toHaveBeenCalledWith("config/set", {
      requires_restart: 0,
      config_data: { auth: { roles: { operator: "" } } },
      update_topic: "config/auth",
    });
    expect(lastUsersUpdate(makeUsers())).toEqual([
      { username: "admin", role: "admin" },
      { username: "bob", role: "viewer" },
      { username: "dave", role: "" },
    ]);
    expect(state.updateConfig).toHaveBeenCalled();
    expect(screen.queryByTestId("delete-role")).toBeNull();
  });

  it("deletes a role without users and skips the user updates", async () => {
    render(<AuthenticationView section="roles" />);

    const [, deleteButton] = within(rowFor("many")).getAllByRole("button");
    fireEvent.click(must(deleteButton));
    fireEvent.click(screen.getByText("stub-delete-role"));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith(
        'roles.toast.success.deleteRole {"role":"many"}',
        { position: "top-center" },
      ),
    );
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(state.mutateUsers).not.toHaveBeenCalled();
  });

  it("toasts failures from both the user updates and the role delete", async () => {
    state.put.mockImplementation((url: string) =>
      Promise.reject(
        httpError(
          url === "config/set" ? { detail: "locked" } : { message: "denied" },
        ),
      ),
    );
    render(<AuthenticationView section="roles" />);

    const [, deleteButton] = within(rowFor("operator")).getAllByRole("button");
    fireEvent.click(must(deleteButton));
    fireEvent.click(screen.getByText("stub-delete-role"));

    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        'roles.toast.error.deleteRoleFailed {"errorMessage":"locked"}',
        { position: "top-center" },
      ),
    );
    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith(
        'roles.toast.error.userUpdateFailed {"errorMessage":"denied"}',
        { position: "top-center" },
      ),
    );
    // the delete handler swallows the rethrow itself
    await expect(state.wrapped.at(-1)).resolves.toBeUndefined();
    // the dialog stays open after a failed delete
    expect(screen.getByTestId("delete-role")).toBeInTheDocument();
    fireEvent.click(screen.getByText("stub-cancel-delete-role"));
    expect(screen.queryByTestId("delete-role")).toBeNull();
  });
});
