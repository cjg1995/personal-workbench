import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [vue()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve("src/renderer/index.html"),
        diff: path.resolve("src/renderer/diff.html"),
        editor: path.resolve("src/renderer/editor.html"),
      },
    },
  },
});
