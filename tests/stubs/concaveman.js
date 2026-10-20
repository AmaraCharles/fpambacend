'use strict';
// concaveman ships as an ES module, which Jest's CommonJS loader can't parse
// (Node itself loads it fine). Only turf.concave() uses it; tests don't.
module.exports = () => { throw new Error('concaveman is stubbed in tests'); };
