import { defineConfig } from 'vite';

// WICHTIG für GitHub Pages:
// - Projekt-Seite (https://<user>.github.io/<repo>/)  -> base: '/<repo>/'
// - User-/Org-Seite (https://<user>.github.io)         -> base: '/'
// - Eigene Domain / Custom Domain                       -> base: '/'
//
// Passe REPO_NAME unten an den tatsächlichen GitHub-Repository-Namen an,
// oder überschreibe per Umgebungsvariable: VITE_BASE=/mein-repo/ vite build
const REPO_NAME = 'logicforge';

export default defineConfig({
  base: process.env.VITE_BASE || `/${REPO_NAME}/`,
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5173,
    open: true,
  },
});
