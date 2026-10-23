'use strict';
// Canonical list of states (FCT + 36), the same names the asset-code index
// uses for branch codes. normalizeState() maps common variants onto them so
// the registry stops collecting free-text spellings ("Akwa-Ibom", "abuja",
// "Adamawa and Taraba"…).
const { BRANCH_CODES } = require('./assetCodeIndex');

const NIGERIA_STATES = Object.keys(BRANCH_CODES);

const ALIASES = {
  abuja: 'FCT', 'federal capital territory': 'FCT', 'f.c.t': 'FCT', 'fct abuja': 'FCT', 'abuja fct': 'FCT',
  'akwa-ibom': 'Akwa Ibom', akwaibom: 'Akwa Ibom',
  'cross-river': 'Cross River', crossriver: 'Cross River',
  nassarawa: 'Nasarawa',
};

const key = s => String(s).trim().toLowerCase().replace(/\s+state$/, '').replace(/\s+/g, ' ');
const BY_KEY = new Map(NIGERIA_STATES.map(s => [s.toLowerCase(), s]));

/** Canonical state name, '' for blank, or null if it isn't a recognised state. */
function normalizeState(input) {
  if (input == null || String(input).trim() === '') return '';
  const k = key(input);
  return BY_KEY.get(k) || ALIASES[k] || null;
}

const isValidState = s => NIGERIA_STATES.includes(s);

module.exports = { NIGERIA_STATES, normalizeState, isValidState };
