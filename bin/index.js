#!/usr/bin/env node --harmony

const DenonClient = require('../lib/client');

if (require.main === module) {
  const parseArgs = require('minimist'); // eslint-disable-line
  const args = parseArgs(process.argv.slice(2));
  const client = new DenonClient({ host: args.host, retryConnect: true });
  const cb = (r) => {
    if (r.error) {
      console.error(r.error); // eslint-disable-line
      process.exit(1);
    } else {
      console.log(r.response); // eslint-disable-line
      process.exit(0);
    }
  };
  client.push(args.cmd, cb);
}

module.exports = DenonClient;
