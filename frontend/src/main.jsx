import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import ImageViewer from "./ImageViewer.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ImageViewer />
  </React.StrictMode>
);