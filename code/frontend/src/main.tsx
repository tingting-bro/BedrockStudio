import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installLoadingTracking } from "./lib/loading";
installLoadingTracking();
import "./styles.css";
import { toast } from "sonner";
import { installTextClipboard } from "./lib/text-clipboard";
const removeTextClipboard = installTextClipboard((message) =>
  toast.error(message),
);
window.addEventListener("pagehide", removeTextClipboard, { once: true });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
