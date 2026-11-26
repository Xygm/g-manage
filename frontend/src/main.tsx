import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { MainApp } from "./main/MainApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <MainApp />
    </MotionConfig>
  </StrictMode>,
);
