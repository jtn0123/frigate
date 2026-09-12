import { AuthContext, type AuthState } from "./auth-state";
import axios from "axios";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";

export function AuthProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [auth, setAuth] = useState<AuthState>({
    user: null,
    allowedCameras: [],
    isLoading: true,
    isAuthenticated: false,
  });

  const { data: profile, error } = useSWR("/profile", {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    fetcher: (url) =>
      axios.get(url, { withCredentials: true }).then((res) => res.data),
  });

  useEffect(() => {
    if (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        // auth required but not logged in
        setAuth({
          user: null,
          allowedCameras: [],
          isLoading: false,
          isAuthenticated: true,
        });
      }
      return;
    }

    if (profile) {
      if (profile.username && profile.username !== "anonymous") {
        const newUser = {
          username: profile.username,
          role: profile.role || "viewer",
        };

        const allowedCameras = Array.isArray(profile.allowed_cameras)
          ? profile.allowed_cameras
          : [];
        setAuth({
          user: newUser,
          allowedCameras,
          isLoading: false,
          isAuthenticated: true,
        });
      } else {
        // Unauthenticated mode (anonymous)
        setAuth({
          user: null,
          allowedCameras: [],
          isLoading: false,
          isAuthenticated: false,
        });
      }
    }
  }, [profile, error]);

  const login = useCallback((user: AuthState["user"]) => {
    setAuth((current) => ({
      ...current,
      user,
      isLoading: false,
      isAuthenticated: true,
    }));
  }, []);

  const logout = useCallback(() => {
    setAuth({
      user: null,
      allowedCameras: [],
      isLoading: false,
      isAuthenticated: true,
    });
    void axios.get("/logout", { withCredentials: true });
  }, []);

  const value = useMemo(() => ({ auth, login, logout }), [auth, login, logout]);

  return <AuthContext value={value}>{children}</AuthContext>;
}
