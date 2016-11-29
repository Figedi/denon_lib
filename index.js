const Transport = require('./server');

if (require.main === module) {
  const parseArgs = require('minimist'); // eslint-disable-line
  const args = parseArgs(process.argv.slice(2));
  new Transport({ host: args.host, retryConnect: true }).push(args.cmd);
}

module.exports = Transport;
