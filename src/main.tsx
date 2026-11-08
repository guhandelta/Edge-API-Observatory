import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, getInitialTheme } from "./theme";
import "./styles.css";
import "./dashboard.css";
import "./theme.css";

/** Set the palette before React paints so a saved dark choice does not flash light. */
const initialTheme = getInitialTheme();
applyTheme(initialTheme);

/** React owns the dashboard; the Worker serves its /api routes separately. */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App initialTheme={initialTheme} />
  </React.StrictMode>,
);
