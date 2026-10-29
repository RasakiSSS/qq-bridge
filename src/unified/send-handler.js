import { fail } from './store.js';

// Host callbacks must preserve the existing send switch, ACL, silent-mode rule,
// secret filtering, output audit, rate reservation, target/reply validation and
// shared QQ send queue. This adapter deliberately cannot call OneBot directly.
export function createUnifiedSendHandler({ prepare, send }) {
  if (typeof prepare !== 'function' || typeof send !== 'function') throw fail('SEND_ADAPTER_REQUIRED');
  return {
    scope: 'scene', level: 'v1',
    async prepare(input) {
      if (!/^(group|private):[1-9]\d*$/.test(input.target || '')) throw fail('SCENE_DENIED');
      if (input.target.startsWith('private:') && input.payload.atUserId) throw fail('INVALID_ARGUMENTS');
      const prepared = await prepare(input);
      return prepared;
    },
    async dispatch(input) {
      input.assertCurrent();
      // send MUST use assertCurrent after asynchronous audit/queue waits and
      // before each actual write. An exception/partial result remains unknown
      // in the action ledger and is never automatically replayed.
      return send(input);
    },
  };
}
