import { installKeyReleaseGuard } from '@/utils/cancelled-keys';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_start',
  world: 'ISOLATED',
  main: installKeyReleaseGuard,
});
