import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isHardened, hardenFile } from '../state-acl.mjs';
import { fail } from './store.js';

// HOST ONLY. The caller must own the single bridge installation, not merely a
// per-session lock. Never accept a model-controlled path or endpoint here.
export class UnifiedMainBinding {
  constructor({ file, assertOwner, isExcludedFromModelFiles, verify = isHardened, harden = hardenFile }) {
    if (!path.isAbsolute(file) || typeof assertOwner !== 'function' || typeof isExcludedFromModelFiles !== 'function') throw fail('INVALID_BINDING_HOST');
    this.file = file; this.assertOwner = assertOwner; this.excluded = isExcludedFromModelFiles;
    this.verify = verify; this.harden = harden; this.publisher = randomUUID();
  }
  checkPath() {
    this.assertOwner();
    const parent = path.dirname(this.file);
    if (!fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent).toLowerCase() !== path.resolve(parent).toLowerCase()
      || !this.verify(parent) || this.excluded(this.file) !== true) throw fail('BINDING_PATH_UNSAFE');
    if (fs.existsSync(this.file)) {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !this.verify(this.file)) throw fail('BINDING_PATH_UNSAFE');
    }
  }
  publish({ sessionId, endpoint, token }) {
    this.checkPath();
    const url = new URL(endpoint);
    if (typeof sessionId !== 'string' || !/^[\w:.-]{1,256}$/.test(sessionId)
      || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp'
      || url.username || url.password || url.search || url.hash) throw fail('INVALID_MAIN_BINDING');
    // No await between host fencing and rename. Stale files may be replaced
    // only after the installation owner has been verified by the host.
    const temp = `${this.file}.${this.publisher}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      // Start empty, verify permissions, only then write the secret.
      if (!this.harden(temp)?.ok || !this.verify(temp)) throw fail('BINDING_PATH_UNSAFE');
      fs.writeFileSync(fd, JSON.stringify({ version: 1, sessionId, endpoint: url.href, token, publisher: this.publisher }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.checkPath();
      fs.renameSync(temp, this.file);
      return true;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  clear() {
    this.checkPath();
    if (!fs.existsSync(this.file)) return false;
    const stat = fs.statSync(this.file);
    if (stat.size > 16384) throw fail('BINDING_PATH_UNSAFE');
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (value.publisher !== this.publisher) return false;
    fs.unlinkSync(this.file);
    return true;
  }
}
