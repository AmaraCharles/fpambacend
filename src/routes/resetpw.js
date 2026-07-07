const b = require('bcryptjs');
const pw = 'NewPassword123'; // change this to what you want
b.hash(pw, 12).then(h => {
  console.log('hash:', h);
  return b.compare(pw, h);
}).then(r => console.log('verify:', r));