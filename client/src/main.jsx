import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./components/common/UI";
import App from "./App";
import { loadFonts } from "./lib/fonts";
import { retryQuery } from "./lib/api";
import "./styles/index.css";
import "./styles/animations.css";
import "./styles/tokens.css";
import "./styles/theme.css";
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryQuery,
      staleTime: 15000,
      refetchOnWindowFocus: true,
    },
  },
});
loadFonts();
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
