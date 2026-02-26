import PropertyFormRenderer from './PropertyFormRenderer';
import { getNodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec-registry';
import './PropertyFromSpec.css';

type PropertyFromSpecProps = {
  node: any;
  variables?: Array<{ key: string; origin?: string; nodeId?: string; nodeName?: string }>;
};

export default function PropertyFromSpec({ node, variables }: PropertyFromSpecProps) {
  const hasSpec = !!getNodeSpec(node?.type);

  return hasSpec && node ? (
    <PropertyFormRenderer node={node} variables={variables as any} />
  ) : (
    <div className="property-from-spec__section">
      <div className="property-from-spec__title">Node specification not found</div>
      <div className="property-from-spec__help">The node does not yet provide a NodeSpec and has fallen back to the default properties panel. </div>
    </div>
  );
}
