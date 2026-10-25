import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const path='secrets.local.json';
try {
 writeFileSync(path,JSON.stringify({DATA_KEY:randomBytes(32).toString('base64url'),IDENTITY_KEY:randomBytes(32).toString('base64url'),BOOTSTRAP_TOKEN:randomBytes(32).toString('base64url')},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Created secrets.local.json. Keep an OFFLINE backup, upload with wrangler secret bulk, and never commit it.');
 console.log('Never run this as a replacement for existing production keys. Existing file is not overwritten.');
} catch (error) {console.error(error.code==='EEXIST'?'Refusing to overwrite existing secrets.':error.message);process.exitCode=1;}
