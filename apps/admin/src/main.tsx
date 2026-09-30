import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@bayramm/ui/fonts.css";
import "@bayramm/ui/tokens.css";
import "@bayramm/ui/kit.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
