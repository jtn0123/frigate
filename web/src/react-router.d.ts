import type { NavigateOptions, To } from "react-router";

// App uses BrowserRouter, whose navigation returns synchronously. Remove this
// augmentation when switching to a data router (RouterProvider).
// https://reactrouter.com/api/hooks/useNavigate#return-type-augmentation
declare module "react-router" {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void;
    (delta: number): void;
  }
}
