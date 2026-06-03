/** 'A' -> 1, 'C' -> 3, 'AA' -> 27. Throws on anything that isn't letters. */
function columnLetterToIndex(letter) {
  const upper = String(letter).toUpperCase();
  let index = 0;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) throw new Error('Invalid column letter: ' + letter);
    index = index * 26 + (code - 64);
  }
  if (index === 0) throw new Error('Invalid column letter: ' + letter);
  return index;
}

var BLOCK_NODE_TYPES_ = ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'];

function adfToPlainText(description) {
  if (description == null) return '';
  if (typeof description === 'string') return description;
  return walkAdfNode_(description).replace(/\n+$/, '').replace(/\n{2,}/g, '\n');
}

function walkAdfNode_(node) {
  if (node == null) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  let out = (node.content || []).map(walkAdfNode_).join('');
  if (BLOCK_NODE_TYPES_.indexOf(node.type) !== -1) out += '\n';
  return out;
}

function pickSprintId(sprintField) {
  if (!Array.isArray(sprintField) || sprintField.length === 0) return '';
  const sprints = sprintField.map(parseSprint_).filter(function (s) {
    return s !== null;
  });
  if (sprints.length === 0) return '';
  const active = sprints.find(function (s) {
    return s.state === 'active';
  });
  return (active || sprints[sprints.length - 1]).id;
}

function parseSprint_(entry) {
  if (entry == null) return null;
  if (typeof entry === 'object') {
    if (entry.id == null) return null;
    return { id: entry.id, state: String(entry.state || '').toLowerCase() };
  }
  if (typeof entry === 'string') {
    const idMatch = entry.match(/\bid=(\d+)/);
    if (!idMatch) return null;
    const stateMatch = entry.match(/\bstate=(\w+)/);
    return { id: Number(idMatch[1]), state: stateMatch ? stateMatch[1].toLowerCase() : '' };
  }
  return null;
}

function formatJiraDate(isoString, config) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  if (typeof Utilities !== 'undefined') {
    return Utilities.formatDate(date, config.TIMEZONE, config.DATE_FORMAT);
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = function (type) {
    return parts.find(function (p) {
      return p.type === type;
    }).value;
  };
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
}
