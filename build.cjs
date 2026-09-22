const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, 'src', file), 'utf8');
// 用函数式替换：源码里可能含 $& / $1，字符串替换会被当成模式展开
const put = (html, mark, file) => html.replace(mark, () => read(file));
let html = read('shell.html');
html = put(html, '/* APP_STYLES */', 'styles.css');
html = put(html, '/* APP_ENGINE */', 'engine.js');
html = put(html, '/* APP_LIVE */', 'live.js');
html = put(html, '/* APP_TRANSLATE */', 'translate.js');
html = put(html, '/* APP_CODE */', 'app.js');
fs.writeFileSync(path.join(__dirname, 'MyDesk-next.html'), html);
console.log('Built MyDesk-next.html (' + Buffer.byteLength(html) + ' bytes)');
