import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { createApp, type App as VueApp, type Component as VueComponent } from "vue";

type BeforeMountHook = () => void | Promise<void>;

interface MountVueInReactOptions {
  beforeMount?: BeforeMountHook;
}

interface VueHostProps {
  component: VueComponent;
}

export function VueComponentHost({ component }: VueHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    let vueApp: VueApp<Element> | null = createApp(component);
    vueApp.mount(hostRef.current);

    return () => {
      vueApp?.unmount();
      vueApp = null;
    };
  }, [component]);

  // Keep the old Vue layout behavior and avoid introducing an extra wrapper box.
  return createElement("div", { ref: hostRef, style: { display: "contents" } });
}

export async function mountVueInReact(
  component: VueComponent,
  options: MountVueInReactOptions = {},
): Promise<void> {
  if (options.beforeMount) {
    await options.beforeMount();
  }

  const mountNode = document.getElementById("app");
  if (!mountNode) {
    throw new Error("Cannot find #app mount node");
  }

  const root = createRoot(mountNode);
  root.render(createElement(VueComponentHost, { component }));
}
