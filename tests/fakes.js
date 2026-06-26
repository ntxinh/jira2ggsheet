class FakeSheet {
  constructor(rows, name) {
    this.rows = (rows || []).map((r) => r.slice());
    this.name = name || '';
  }

  getName() {
    return this.name;
  }

  setName(name) {
    this.name = name;
    return this;
  }

  copyTo(ss) {
    const copy = new FakeSheet(this.rows, 'Copy of ' + this.name);
    ss._sheets.push(copy);
    return copy;
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

function fakeSpreadsheetApp(sheets) {
  const ss = {
    _sheets: sheets.slice(),
    getSheets() {
      return this._sheets;
    },
    getSheetByName(name) {
      return this._sheets.find((s) => s.getName() === name) || null;
    },
  };
  return {
    getActiveSpreadsheet() {
      return ss;
    },
  };
}

module.exports = { FakeSheet, fakeSpreadsheetApp };
