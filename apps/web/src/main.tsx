import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrap } from "./bootstrap";
import "@bayramm/ui/fonts.css";
import "@bayramm/ui/tokens.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

void bootstrap().then((services) => {
  createRoot(root).render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
});
