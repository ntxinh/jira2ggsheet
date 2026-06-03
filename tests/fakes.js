class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((r) => r.slice());
  }

  getLastRow() {
    for (let i = this.rows.length; i > 0; i--) {
      if (this.rows[i - 1].some((v) => v !== '' && v != null)) return i;
    }
    return 0;
  }

  getRange(row, col, numRows, numCols) {
    numRows = numRows || 1;
    numCols = numCols || 1;
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) {
            const v = (self.rows[row - 1 + r] || [])[col - 1 + c];
            line.push(v === undefined ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setValue(value) {
        while (self.rows.length < row) self.rows.push([]);
        const line = self.rows[row - 1];
        while (line.length < col) line.push('');
        line[col - 1] = value;
      },
    };
  }

  deleteRow(row) {
    this.rows.splice(row - 1, 1);
  }
}

function fakeSpreadsheetApp(sheetsByName) {
  return {
    getActiveSpreadsheet() {
      return {
        getSheetByName(name) {
          return sheetsByName[name] || null;
        },
      };
    },
  };
}

module.exports = { FakeSheet, fakeSpreadsheetApp };
