const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load order matters: later files call functions defined in earlier ones.
const SRC_FILES = ['Config.js', 'FieldExtractor.js', 'SheetWriter.js', 'WebApp.js'];

/**
 * Evaluates the Apps Script source files in one shared vm context,
 * mimicking Apps Script's single global scope. Pass fakes for Apps
 * Script services (SpreadsheetApp, ContentService, ...) via `globals`.
 * Files that don't exist yet are skipped so tasks can build up incrementally.
 */
function loadAppsScript(globals) {
  const sandbox = Object.assign({ console }, globals);
  vm.createContext(sandbox);
  for (const file of SRC_FILES) {
    const full = path.join(__dirname, '..', 'src', file);
    if (!fs.existsSync(full)) continue;
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

module.exports = { loadAppsScript };
