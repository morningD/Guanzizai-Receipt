import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { FirstRun } from "./FirstRun";
import { ErrorBoundary } from "./ErrorBoundary";
import { installFetchTracing } from "./console-log";
import "./styles.css";

installFetchTracing();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="应用">
      {import.meta.env.MODE === "portable"
        ? <FirstRun>{(delivery) => <App firstRunDelivery={delivery} />}</FirstRun>
        : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
