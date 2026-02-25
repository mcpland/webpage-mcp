// Type shim for unplugin-icons virtual modules used as Vue components
// Keeps TS happy in IDE and during type-check without generating code.
declare module '~icons/*' {
  import type { DefineComponent } from 'vue';
  // Use explicit, non-empty object types to satisfy eslint rule
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}
