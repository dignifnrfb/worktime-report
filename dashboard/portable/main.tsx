import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("页面初始化失败。");

createRoot(root).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
