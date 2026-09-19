import React from "react";
import ReactDOM from "react-dom/client";
import LoginPage from "@/pages/LoginPage.tsx";
import "@/api";
import "./index.css";
import { allowAndroidPageZoom } from "@/lib/fork/viewport-zoom";

// fork: the login page has its own viewport meta, which App.tsx never reaches
allowAndroidPageZoom();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LoginPage />
  </React.StrictMode>,
);
