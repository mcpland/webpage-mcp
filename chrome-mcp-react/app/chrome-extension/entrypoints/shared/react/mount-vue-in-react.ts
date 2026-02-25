import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createApp,
  h,
  reactive,
  type InjectionKey,
  type App as VueApp,
  type Component as VueComponent,
} from "vue";

type BeforeMountHook = () => void | Promise<void>;

interface MountVueInReactOptions {
  beforeMount?: BeforeMountHook;
}

interface VueHostProps {
  component: VueComponent;
  componentProps?: Record<string, unknown>;
  componentProvides?: VueProvideEntry[];
}

export interface VueProvideEntry {
  key: InjectionKey<unknown> | string | symbol;
  value: unknown;
}

export function VueComponentHost({
  component,
  componentProps,
  componentProvides,
}: VueHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const vueAppRef = useRef<VueApp<Element> | null>(null);
  const reactivePropsRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const reactiveProps = reactive<Record<string, unknown>>({ ...(componentProps ?? {}) });
    reactivePropsRef.current = reactiveProps;

    const vueApp = createApp({
      render() {
        return h(component, reactiveProps);
      },
    });

    for (const entry of componentProvides ?? []) {
      try {
        vueApp.provide(entry.key as any, entry.value);
      } catch {
        // ignore invalid provide values
      }
    }

    vueApp.mount(hostRef.current);
    vueAppRef.current = vueApp;

    return () => {
      vueAppRef.current?.unmount();
      vueAppRef.current = null;
      reactivePropsRef.current = null;
    };
  }, [component, componentProvides]);

  useEffect(() => {
    const reactiveProps = reactivePropsRef.current;
    if (!reactiveProps) {
      return;
    }

    const nextProps = componentProps ?? {};
    for (const key of Object.keys(reactiveProps)) {
      if (!Object.prototype.hasOwnProperty.call(nextProps, key)) {
        delete reactiveProps[key];
      }
    }
    Object.assign(reactiveProps, nextProps);
  }, [componentProps]);

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
