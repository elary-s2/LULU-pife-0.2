const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, 'assets', 'cards');
const dirs = ['clubs', 'diamonds', 'hearts', 'spades'];

const fontRegex = /font-size:32px;/g;
const matrixRegex = /transform="matrix\((-?[0-9]+\.?[0-9]*),0,0,(-?[0-9]+\.?[0-9]*),(-?[0-9]+\.?[0-9]*),(-?[0-9]+\.?[0-9]*)\)"/g;

let changedCount = 0;
let fileCount = 0;

for (const dir of dirs) {
  const folder = path.join(baseDir, dir);
  const files = fs.readdirSync(folder).filter((name) => name.endsWith('.svg'));

  for (const file of files) {
    const filePath = path.join(folder, file);
    let content = fs.readFileSync(filePath, 'utf8');
    fileCount += 1;
    const original = content;

    content = content.replace(fontRegex, 'font-size:36px;');

    let head, tail;
    const defsClose = content.indexOf('</defs>');
    if (defsClose !== -1) {
      head = content.slice(0, defsClose + 7);
      tail = content.slice(defsClose + 7);
    } else {
      const selfCloseDefs = content.search(/<defs[^>]*\/\s*>/);
      if (selfCloseDefs !== -1) {
        const match = content.match(/<defs[^>]*\/\s*>/);
        const pos = match.index + match[0].length;
        head = content.slice(0, pos);
        tail = content.slice(pos);
      } else {
        head = content;
        tail = '';
      }
    }

    tail = tail.replace(matrixRegex, (match, aStr, dStr, e, f) => {
      const a = parseFloat(aStr);
      const d = parseFloat(dStr);
      if (Math.abs(a) >= 1.2 && Math.abs(a) <= 3.5 && Math.abs(d) >= 1.2 && Math.abs(d) <= 3.5) {
        const na = +(a * 0.78).toFixed(10);
        const nd = +(d * 0.78).toFixed(10);
        const fmt = (v) => String(v).replace(/\.0+$/, '');
        return `transform="matrix(${fmt(na)},0,0,${fmt(nd)},${e},${f})"`;
      }
      return match;
    });

    const newContent = head + tail;
    if (newContent !== original) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      changedCount += 1;
    }
  }
}

console.log(`Processed ${fileCount} files, changed ${changedCount} files.`);
