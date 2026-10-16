import { hashPassword } from '../server/security.mjs';
import { stdin, stdout } from 'node:process';
if (!stdin.isTTY) { console.error('Please run in an interactive terminal.'); process.exit(1); }
stdout.write('輸入管理員密碼（不會顯示）：');
stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
let password = '';
stdin.on('data', async chunk => {
  for (const char of chunk) {
    if (char === '\u0003') process.exit(1);
    if (char === '\r' || char === '\n') {
      stdin.setRawMode(false);
      if (password.length < 12) { console.error('\n密碼至少需要 12 字元。'); process.exit(1); }
      console.log('\nADMIN_PASSWORD_HASH=' + await hashPassword(password)); process.exit(0);
    }
    if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
    else password += char;
  }
});
