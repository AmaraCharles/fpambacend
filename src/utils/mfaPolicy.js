'use strict';
// Which roles must use two-step sign-in. Accounts that can approve records or
// administer users are the ones worth stealing, so by default they must turn
// it on before using the API (they can still sign in and set it up).
//   MFA_REQUIRED_ROLES="System Admin,Supervisor"   — custom list
//   MFA_REQUIRED_ROLES=none                         — not required for anyone
const DEFAULT = ['System Admin', 'Supervisor', 'Sub-Head'];

function requiredRoles() {
  const v = process.env.MFA_REQUIRED_ROLES;
  if (v === undefined || v === '') return DEFAULT;
  if (v.trim().toLowerCase() === 'none') return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

/** True when this user must set up two-step sign-in before using the API. */
const mfaSetupRequired = user => !!user && requiredRoles().includes(user.role) && !user.mfa?.enabled;

module.exports = { requiredRoles, mfaSetupRequired };
