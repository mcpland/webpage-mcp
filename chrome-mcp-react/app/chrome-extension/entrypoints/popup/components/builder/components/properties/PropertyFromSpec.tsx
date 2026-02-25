import PropertyFormRendererVue from './PropertyFormRenderer.vue';
import { getNodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec-registry';
import { VueComponentHost } from '@/entrypoints/shared/react/mount-vue-in-react';
import './PropertyFromSpec.css';

type PropertyFromSpecProps = {
  node: any;
  variables?: Array<{ key: string; origin?: string; nodeId?: string; nodeName?: string }>;
};

export default function PropertyFromSpec({ node, variables }: PropertyFromSpecProps) {
  const hasSpec = !!getNodeSpec(node?.type);

  return hasSpec && node ? (
    <VueComponentHost component={PropertyFormRendererVue} componentProps={{ node, variables }} />
  ) : (
    <div className="property-from-spec__section">
      <div className="property-from-spec__title">未找到节点规范</div>
      <div className="property-from-spec__help">该节点尚未提供 NodeSpec，已回退到默认属性面板。</div>
    </div>
  );
}
