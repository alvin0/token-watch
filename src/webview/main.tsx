import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { vscodeApi, useStore } from "./store";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}

// Notify host that WebView is ready and trigger initial data fetch
vscodeApi.postMessage({ type: "ready" });
useStore.getState().requestQuery();
