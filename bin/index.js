#!/usr/bin/env node --harmony

const DenonClient = require('../lib/client');

if (require.main === module) {
  const parseArgs = require('minimist'); // eslint-disable-line
  const args = parseArgs(process.argv.slice(2));
  const client = new DenonClient({ host: args.host, retryConnect: true });
  client.push(args.cmd, (r) => {
    if (r.error) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  });
}

module.exports = DenonClient;
