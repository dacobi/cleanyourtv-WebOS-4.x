// Version numbers (1.5.16) and the builds of test releases.
function parts(v) {
  return String(v || '0')
    .replace(/^v/, '')
    .split('.')
    .map(function (n) {
      return parseInt(n, 10) || 0;
    });
}
// -1, 0 or 1, like a sort function
function cmp(a, b) {
  var x = parts(a),
    y = parts(b);
  for (var i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
module.exports = { cmp: cmp };
