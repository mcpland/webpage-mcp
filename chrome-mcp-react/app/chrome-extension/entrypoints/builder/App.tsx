import { createElement } from "react";
import LegacyApp from "./LegacyApp.vue";
import { VueComponentHost } from "../shared/react/mount-vue-in-react";

export default function BuilderApp() {
  return createElement(VueComponentHost, { component: LegacyApp });
}
