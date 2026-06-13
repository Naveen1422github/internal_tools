const KIND_BY_TYPE = {
  handoff: 'signal',
  review: 'signal',
  proposal: 'signal',
  counter: 'signal',
  decision: 'signal',
  gotcha: 'signal',
  rollup: 'signal',
  'session-note': 'log',
  changelog: 'log',
};

const CATEGORY_BY_TYPE = {
  handoff: 'Activity',
  review: 'Activity',
  proposal: 'Activity',
  counter: 'Activity',
  decision: 'Reference',
  gotcha: 'Reference',
  rollup: 'Activity',
  'session-note': 'Activity',
  changelog: 'Activity',
};

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;

module.exports = {
  KIND_BY_TYPE,
  CATEGORY_BY_TYPE,
  SLUG_REGEX,
};
