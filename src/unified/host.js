import { UnifiedRuntime } from './runtime.js';
import { UnifiedMainBinding } from './main-binding.js';
import { startUnifiedMcpHttp } from './mcp-http.js';
import { fail } from './store.js';

// Installation-scoped composition. The bridge must fence its legacy model
// schedulers before starting this host. Merely selecting a preset is not enough.
export async function startUnifiedHost({ bindingFile, assertInstallationOwner, isExcludedFromModelFiles,
  runtimeOptions, bindingOptions = {}, port = 0 }) {
  if (typeof assertInstallationOwner !== 'function' || typeof isExcludedFromModelFiles !== 'function') throw fail('UNIFIED_HOST_FENCE_REQUIRED');
  assertInstallationOwner();
  let http, runtime, closing = false, closePromise;
  const operations = new Set();
  const publisher = new UnifiedMainBinding({ ...bindingOptions, file: bindingFile, assertOwner: assertInstallationOwner, isExcludedFromModelFiles });
  publisher.checkPath();
  try {
    runtime = new UnifiedRuntime({ ...runtimeOptions,
      getContext: () => { assertInstallationOwner(); return runtimeOptions.getContext(); },
      bindMainTools: identity => {
        if (closing || !http) throw fail('MAIN_TOOLS_NOT_BOUND');
        runtime.owner.assert();
        return publisher.publish({ ...identity, endpoint: http.endpoint });
      },
    });
    http = await startUnifiedMcpHttp({ tools: runtime.tools, port });
  } catch (error) {
    runtime?.close();
    await http?.close();
    throw error;
  }
  const run = fn => {
    if (closing) return Promise.reject(fail('RUNTIME_CLOSED'));
    const operation = Promise.resolve().then(() => { assertInstallationOwner(); return fn(); });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  return {
    // No timer, QQ writer, mode change or remote prompt is started implicitly.
    ingest: input => {
      if (closing) throw fail('RUNTIME_CLOSED');
      assertInstallationOwner(); return runtime.ingest(input);
    },
    status: () => run(() => runtime.status()),
    tick: () => run(() => runtime.tick()),
    wakeConfig: key => run(() => runtime.wakeConfig(key)),
    friendRequest: event => run(() => runtime.friendRequest(event)),
    restore: () => run(() => runtime.restore()),
    onDshFrame: (...args) => run(() => runtime.onDshFrame(...args)),
    fromQQ: (...args) => run(() => runtime.management.fromQQ(...args)),
    fromConsole: (...args) => run(() => runtime.management.fromConsole(...args)),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      runtime.tools.revoke();
      closePromise = (async () => {
        // Keep the SQLite owner until even disconnected tool calls have ended.
        try {
          const drained = await Promise.allSettled([http.close(), Promise.allSettled([...operations])]);
          if (drained[0].status === 'rejected') throw drained[0].reason;
          publisher.clear();
        } finally { runtime.close(); }
      })();
      return closePromise;
    },
  };
}
