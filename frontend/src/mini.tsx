import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { MiniApp } from "./mini/MiniApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <MiniApp />
    </MotionConfig>
  </StrictMode>,
);
