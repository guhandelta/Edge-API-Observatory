import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

/** React owns the dashboard; the Worker serves its /api routes separately. */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
