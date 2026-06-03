const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.startsWith('test_') && f.endsWith('.js'))
  .sort();

for (const file of files) {
  const tests = require(path.join(__dirname, file));
  for (const name of Object.keys(tests)) {
    try {
      tests[name]();
      passed++;
      console.log('PASS  ' + file + ' :: ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL  ' + file + ' :: ' + name + '\n      ' + err.message);
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
