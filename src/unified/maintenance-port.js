import net from 'node:net';
import {fail} from './store.js';

// Legacy executables probe this exact listening port before deciding that a
// live PID is stale. Hold the kernel socket throughout maintenance, without
// publishing HTTP handlers, credentials, or a control surface.
export async function holdMigrationPort(port) {
  if (!Number.isInteger(port)||port<1||port>65535)throw fail('MIGRATION_INVALID_PORT');
  const server=net.createServer(socket=>socket.destroy());
  let fault=false;
  server.on('error',()=>{fault=true;});
  await new Promise((ok,no)=>{
    server.once('error',()=>no(fail('MIGRATION_INSTALLATION_LOCKED')));
    server.listen({port,host:'127.0.0.1',exclusive:true},ok);
  });
  return {assert(){if(fault||!server.listening||server.address()?.port!==port)throw fail('MIGRATION_EXCLUSIVE_REQUIRED');},
    close:()=>new Promise((ok,no)=>server.close(e=>e?no(e):ok()))};
}
