// Isolated full-stack browser fixture. Never imported by the production server.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createApp } from '../server/app.mjs';
import { createAdmin } from '../server/db.mjs';
import { testDatabase } from './database.mjs';
const database = await testDatabase();
const directory = await mkdtemp(join(tmpdir(), 'fulfill-browser-'));
const files = new Map();
let failNextUpload = false;
const drive = {
  async status() { return { configured: true, connected: true, folderUrl: 'https://drive.google.com/drive/folders/e2e-fixture' }; },
  async connect() { throw new Error('OAuth is tested by isolated adapter tests.'); },
  async callback() { throw new Error('OAuth is tested by isolated adapter tests.'); },
  async upload({ recordingId, path, mimeType }) {
    if (failNextUpload) {
      failNextUpload = false;
      throw Object.assign(new Error('Simulasi fixture: Google Drive sedang tidak tersedia.'), { status: 502 });
    }
    const bytes = await readFile(path);
    files.set(recordingId, {bytes,mimeType});
    return { id: recordingId, bytes: bytes.length };
  },
  async media(id, range) {
    const file = files.get(id);
    if (!file) return new Response(null, {status:404});
    const size = file.bytes.length;
    if (!range) return new Response(file.bytes, {headers:{'content-type':file.mimeType,'content-length':String(size),'accept-ranges':'bytes'}});
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null,{status:416,headers:{'content-range':`bytes */${size}`}});
    const start=Number(match[1]), end=Math.min(Number(match[2]||size-1),size-1);
    if(start>end) return new Response(null,{status:416,headers:{'content-range':`bytes */${size}`}});
    return new Response(file.bytes.subarray(start,end+1),{status:206,headers:{'content-type':file.mimeType,'content-length':String(end-start+1),'content-range':`bytes ${start}-${end}/${size}`,'accept-ranges':'bytes'}});
  }
};
const app=createApp({database:database.db,dataDir:directory,drive,env:{COOKIE_SECURE:'false'}});
await createAdmin(app.locals.db,{name:'Admin Pengujian',username:'admin-test',password:'Browser test only 2026!'});
const server=app.listen(0,'127.0.0.1',()=>console.log('READY '+server.address().port));
// The parent test controls only this isolated adapter over its private stdin pipe.
// No test control endpoint or fake Drive is exposed by the production server.
const controls = createInterface({ input: process.stdin });
controls.on('line', command => {
  if (command === 'fail-next-upload') {
    failNextUpload = true;
    console.log('CONTROL fail-next-upload');
  }
});
async function close(){server.close(async()=>{await database.close();await rm(directory,{recursive:true,force:true});process.exit(0);});}
process.on('SIGTERM',close);process.on('SIGINT',close);
