import react from "@vitejs/plugin-react";
export default {
  plugins: [react()],
  envDir: false,
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    fileParallelism: false,
  },
};
