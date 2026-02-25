/// <reference types="unplugin-icons/types/vue" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  type Props = Record<string, never>;
  type RawBindings = Record<string, never>;
  const component: DefineComponent<Props, RawBindings, any>;
  export default component;
}
