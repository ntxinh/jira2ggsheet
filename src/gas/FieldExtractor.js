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

function pickSprint(sprintField) {
  if (!Array.isArray(sprintField) || sprintField.length === 0) return null;
  const sprints = sprintField.map(parseSprint_).filter(function (s) {
    return s !== null;
  });
  if (sprints.length === 0) return null;
  const active = sprints.find(function (s) {
    return s.state === 'active';
  });
  return active || sprints[sprints.length - 1];
}

function pickSprintId(sprintField) {
  const sprint = pickSprint(sprintField);
  return sprint ? sprint.id : '';
}

function parseSprint_(entry) {
  if (entry == null) return null;
  if (typeof entry === 'object') {
    if (entry.id == null) return null;
    return {
      id: entry.id,
      name: entry.name == null ? '' : String(entry.name),
      state: String(entry.state || '').toLowerCase(),
    };
  }
  if (typeof entry === 'string') {
    const idMatch = entry.match(/\bid=(\d+)/);
    if (!idMatch) return null;
    const stateMatch = entry.match(/\bstate=(\w+)/);
    const nameMatch = entry.match(/\bname=([^,\]]+)/);
    return {
      id: Number(idMatch[1]),
      name: nameMatch ? nameMatch[1] : '',
      state: stateMatch ? stateMatch[1].toLowerCase() : '',
    };
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
    const part = parts.find(function (p) { return p.type === type; });
    return part ? part.value : '';
  };
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
}

var EXTRACTORS = {
  issueKey: function (issue) {
    return issue.key;
  },
  issueType: function (issue) {
    return issue.fields.issuetype && issue.fields.issuetype.name;
  },
  priority: function (issue) {
    return issue.fields.priority && issue.fields.priority.name;
  },
  summary: function (issue) {
    return issue.fields.summary;
  },
  status: function (issue) {
    return issue.fields.status && issue.fields.status.name;
  },
  createdDate: function (issue, config) {
    return formatJiraDate(issue.fields.created, config);
  },
  storyPoints: function (issue, config) {
    return issue.fields[config.CUSTOM_FIELDS.storyPoints];
  },
  assignee: function (issue) {
    return issue.fields.assignee && issue.fields.assignee.displayName;
  },
  sprintId: function (issue, config) {
    return pickSprintId(issue.fields[config.CUSTOM_FIELDS.sprint]);
  },
};

function extractField(name, issue, config) {
  const fn = EXTRACTORS[name];
  if (!fn) {
    console.log('Unknown extractor in COLUMN_MAP: ' + name);
    return '';
  }
  try {
    const value = fn(issue, config);
    return value == null ? '' : value;
  } catch (err) {
    console.log('Extractor "' + name + '" failed: ' + err);
    return '';
  }
}
