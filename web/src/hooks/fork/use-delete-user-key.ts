import { useCallback, useContext } from "react";
import { AuthContext } from "@/context/auth-state";
import { deleteUserNamespacedKey } from "@/hooks/use-user-persistence";

/**
 * Fork (UI86): delete a user-namespaced preference whose key is only known
 * when the action runs, such as a deleted camera group's layout.
 * `useUserPersistence` binds a single key when it renders.
 */
export function useDeleteUserKey() {
  const { auth } = useContext(AuthContext);
  const username = auth.user?.username;
  return useCallback(
    (key: string) => deleteUserNamespacedKey(key, username),
    [username],
  );
}
