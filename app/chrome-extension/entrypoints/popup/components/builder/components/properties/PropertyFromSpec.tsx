import PropertyFormRenderer from './PropertyFormRenderer';
import { getNodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec-registry';
import { getMessage } from '@/utils/i18n';
import './PropertyFromSpec.css';

type PropertyFromSpecProps = {
  node: any;
  variables?: Array<{ key: string; origin?: string; nodeId?: string; nodeName?: string }>;
};

export default function PropertyFromSpec({ node, variables }: PropertyFromSpecProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);
  const hasSpec = !!getNodeSpec(node?.type);

  return hasSpec && node ? (
    <PropertyFormRenderer node={node} variables={variables as any} />
  ) : (
    <div className="property-from-spec__section">
      <div className="property-from-spec__title">
        {t('builderNodeSpecNotFound', 'Node specification not found')}
      </div>
      <div className="property-from-spec__help">
        {t(
          'builderNodeSpecFallbackHint',
          'The node does not yet provide a NodeSpec and has fallen back to the default properties panel.',
        )}
      </div>
    </div>
  );
}
