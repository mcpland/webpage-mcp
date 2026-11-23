import { inspectFrameHistory } from '@/utils/frame-history';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_start',
  world: 'ISOLATED',
  main() {
    // Register before page capture listeners can stop propagation.
    inspectFrameHistory('observe');
  },
});
