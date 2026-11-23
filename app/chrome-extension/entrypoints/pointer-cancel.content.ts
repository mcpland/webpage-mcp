import { observeCancelledMouseRelease } from '@/utils/cancelled-mouse';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_start',
  world: 'ISOLATED',
  main: observeCancelledMouseRelease,
});
