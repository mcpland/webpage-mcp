import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { config } from "dotenv";
import { resolve } from "path";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import Components from "unplugin-vue-components/vite";
import IconsResolver from "unplugin-icons/resolver";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local") });

const CHROME_EXTENSION_KEY = process.env.CHROME_EXTENSION_KEY;
// Detect dev mode early for manifest-level switches
const IS_DEV =
  process.env.NODE_ENV !== "production" && process.env.MODE !== "production";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  runner: {
    // Option 1: Disable auto-start (recommended)
    disabled: true,

    // Option 2: If you want to enable auto-start with existing config, uncomment below
    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // Use environment variable for the key, fallback to undefined if not set
    key: CHROME_EXTENSION_KEY,
    default_locale: "zh_CN",
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    permissions: [
      "nativeMessaging",
      "tabs",
      "activeTab",
      "scripting",
      "contextMenus",
      "downloads",
      "webRequest",
      "webNavigation",
      "debugger",
      "history",
      "bookmarks",
      "offscreen",
      "storage",
      "declarativeNetRequest",
      "alarms",
      // Allow programmatic control of Chrome Side Panel
      "sidePanel",
    ],
    host_permissions: ["<all_urls>"],
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    action: {
      default_popup: "popup.html",
      default_title: "Webpage MCP Server",
    },
    // Chrome Side Panel entry for workflow management
    // Ref: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
    side_panel: {
      default_path: "sidepanel.html",
    },
    // Keyboard shortcuts for quick triggers
    commands: {
      // run_quick_trigger_1: {
      //   suggested_key: { default: 'Ctrl+Shift+1' },
      //   description: 'Run quick trigger 1',
      // },
      // run_quick_trigger_2: {
      //   suggested_key: { default: 'Ctrl+Shift+2' },
      //   description: 'Run quick trigger 2',
      // },
      // run_quick_trigger_3: {
      //   suggested_key: { default: 'Ctrl+Shift+3' },
      //   description: 'Run quick trigger 3',
      // },
      // open_workflow_sidepanel: {
      //   suggested_key: { default: 'Ctrl+Shift+O' },
      //   description: 'Open workflow sidepanel',
      // },
      toggle_web_editor: {
        suggested_key: { default: "Ctrl+Shift+O", mac: "Command+Shift+O" },
        description: "Toggle Web Editor mode",
      },
      toggle_quick_panel: {
        suggested_key: { default: "Ctrl+Shift+U", mac: "Command+Shift+U" },
        description: "Toggle Quick Panel AI Chat",
      },
    },
    web_accessible_resources: [
      {
        resources: [
          "/models/*", // Allow access to all files under public/models/
          "/workers/*", // Allow access to worker files
          "/inject-scripts/*", // Allow helper files injected by content scripts
        ],
        matches: ["<all_urls>"],
      },
    ],
    // Note: The following security policies block dev server resource loading in development,
    // only enabled in production, development uses WXT default policies.
    ...(IS_DEV
      ? {}
      : {
          cross_origin_embedder_policy: { value: "require-corp" as const },
          cross_origin_opener_policy: { value: "same-origin" as const },
          content_security_policy: {
            // Allow inline styles injected by Vite (compiled CSS) and data images used in UI thumbnails
            extension_pages:
              "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;",
          },
        }),
  },
  vite: (env) => ({
    plugins: [
      // Keep Vue SFC support for the parity layer while React is the app shell
      vue(),
      // TailwindCSS v4 Vite plugin – no PostCSS config required
      tailwindcss(),
      // Auto-register SVG icons as Vue components; all icons are bundled locally
      Components({
        dts: false,
        resolvers: [
          IconsResolver({
            prefix: "i",
            enabledCollections: ["lucide", "mdi", "ri"],
          }),
        ],
      }) as any,
      Icons({ compiler: "vue3", autoInstall: false }) as any,
      // Ensure static assets are available as early as possible to avoid race conditions in dev
      // Copy workers/_locales/inject-scripts into the build output before other steps
      viteStaticCopy({
        targets: [
          {
            src: "inject-scripts/*.js",
            dest: "inject-scripts",
          },
          {
            src: ["workers/*"],
            dest: "workers",
          },
          {
            src: "_locales/**/*",
            dest: "_locales",
          },
        ],
        // Use writeBundle so outDir exists for dev and prod
        hook: "writeBundle",
        // Enable watch so changes to these files are reflected during dev
        watch: {
          // Use default patterns inferred from targets; explicit true enables watching
          // Vite plugin will watch src patterns and re-copy on change
        } as any,
      }) as any,
    ],
    build: {
      // Build artifacts need to be compatible with es6
      target: "es2015",
      // Generate sourcemaps in non-production environments
      sourcemap: env.mode !== "production",
      // Disable gzip compressed size reporting, as compressing large files may be slow
      reportCompressedSize: false,
      // Trigger warning when chunk size exceeds 1500kb
      chunkSizeWarningLimit: 1500,
      minify: false,
    },
  }),
});
