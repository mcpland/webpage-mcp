/**
 * Design Tokens Module (Phase 5.4)
 *
 * Runtime CSS custom property detection, resolution, and application.
 *
 * Usage:
 * ```typescript
 * import { createDesignTokensService } from './core/design-tokens';
 *
 * const service = createDesignTokensService();
 *
 * // Get available tokens for an element
 * const { tokens } = service.getContextTokens(element);
 *
 * // Apply a token to a style property
 * service.applyTokenToStyle(transactionManager, element, 'color', '--color-primary');
 *
 * // Cleanup
 * service.dispose();
 * ```
 */

// Main service
export {
  createDesignTokensService,
  type DesignTokensService,
  type DesignTokensServiceOptions,
  type GetContextTokensOptions,
  type GetRootTokensOptions,
} from './design-tokens-service';

// Detector
export {
  createTokenDetector,
  type TokenDetector,
  type TokenDetectorOptions,
} from './token-detector';

// Resolver
export {
  createTokenResolver,
  type TokenResolver,
  type TokenResolverOptions,
  type ResolveForPropertyOptions,
} from './token-resolver';

// Types
export type {
  // Core identifiers
  CssVarName,
  RootCacheKey,
  RootType,
  // Token classification
  TokenKind,
  // Declaration source
  StyleSheetRef,
  TokenDeclarationOrigin,
  TokenDeclaration,
  // Token model
  DesignToken,
  // Index and query
  TokenIndexStats,
  TokenIndex,
  ContextToken,
  TokenQueryResult,
  // Resolution
  CssVarReference,
  TokenAvailability,
  TokenResolutionMethod,
  TokenResolution,
  TokenResolvedForProperty,
  // Cache invalidation
  TokenInvalidationReason,
  TokenInvalidationEvent,
  Unsubscribe,
} from './types';
