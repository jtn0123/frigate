import { baseUrl } from "./baseUrl";
import { SWRConfig } from "swr";
import { WsProvider } from "./WsProvider";
import axios from "axios";
import { ReactNode } from "react";
import { isRedirectingToLogin, setRedirectingToLogin } from "./auth-redirect";
import { reportReadError } from "./fork/read-error-toast";

axios.defaults.baseURL = `${baseUrl}api/`;
// Set once at module scope (not in render) and merge so headers other code
// has already set on the shared axios instance are preserved.
Object.assign(axios.defaults.headers.common, {
  "X-CSRF-TOKEN": 1,
  "X-CACHE-BYPASS": 1,
});

type ApiProviderType = {
  children?: ReactNode;
  options?: Record<string, unknown>;
};

export function ApiProvider({ children, options }: ApiProviderType) {
  return (
    <SWRConfig
      value={{
        // Global read policy: collapse duplicate requests for the same key
        // within 2s, throttle refocus revalidation across the ~370 hooks to
        // once per 10s, and bound error retries instead of retrying forever.
        // keepPreviousData is deliberately not set globally: ~25 hooks use a
        // conditional (null) key and rely on data resetting to undefined.
        dedupingInterval: 2000,
        focusThrottleInterval: 10000,
        errorRetryCount: 3,
        fetcher: (key) => {
          const [path, params] = Array.isArray(key) ? key : [key, undefined];
          return axios.get(path, { params }).then((res) => res.data);
        },
        onError: (error, _key) => {
          if (
            error.response &&
            [401, 302, 307].includes(error.response.status)
          ) {
            // redirect to the login page if not already there
            const loginPage = error.response.headers.get("location") ?? "login";
            if (window.location.href !== loginPage && !isRedirectingToLogin()) {
              setRedirectingToLogin(true);
              window.location.href = loginPage;
            }
          } else {
            reportReadError(error, _key);
          }
        },
        ...options,
      }}
    >
      <WsProvider>{children}</WsProvider>
    </SWRConfig>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApiHost() {
  return baseUrl;
}
