const Telnet = require('telnet-client');
const winston = require('winston');
const { merge } = require('lodash');

// Default config for telnet for receiver
const DEFAULT_CONFIG = {
  telnet: {
    port: 23,
    shellPrompt: '',
    echoLines: 0,
    irs: '\r',
    ors: '\r',
    separator: false,
    execTimeout: 250
  },
};

const RESPONSE_CODES = {
  SUCCESS: 0x0,
  EMPTY: 0x1,
  ERROR: 0x2,
};

const LABELS = {
  MV: 'Master Volume',
  CHANNEL: 'Channel',
};

const RESPONSES = [
  { pattern: /^MV(.*)$/, label: LABELS.MV },
  { pattern: /^SI(.*)$/, label: LABELS.CHANNEL }
];

const MAX_RETRIES = 4;

const DEFAULT_CALLBACK = (r) => {
  if (r.error) {
    console.error(r.error); // eslint-disable-line
    process.exit(1);
  } else {
    console.log(r.response); // eslint-disable-line
    process.exit(0);
  }
};

const boundary = (min, value, max) => {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
};

const splitLast = (str = '') => {
  const splitted = str.split('\n').filter((line) => line.trim().length);
  return splitted[splitted.length - 1].trim();
};

const promiseTimeout = (time) => new Promise((resolve) => setTimeout(resolve, time));

const normalize = (response) => {
  if (response.code === RESPONSE_CODES.EMPTY || response.code === RESPONSE_CODES.ERROR) {
    return response;
  }
  let matched;
  for (const patternObject of RESPONSES) { // eslint-disable-line
    const match = response.response.match(patternObject.pattern);
    if (match) {
      matched = { value: match[1], label: patternObject.label };
      break;
    }
  }
  if (matched) {
    return merge(response, { response: `${matched.label}: ${matched.value}` });
  }
  return response;
};

module.exports = class DenonClient {
  constructor(opts) {
    this.opts = opts;
    this.config = merge(DEFAULT_CONFIG.telnet, opts);
    this.sending = false;
    this.tickEnded = true;
    this.queue = [];
    this.getLogger();
    this.instantiateTicks();
  }

  getLogger() {
    if (process.env.NODE_ENV === 'production') {
      this.logger = new (winston.Logger)({
        level: 'warn',
        transports: [
          new (winston.transports.Console)(),
          new (winston.transports.File)({ filename: this.config.loggerLocation || `${__dirname}/{denon_remote.log}` })
        ]
      });
    } else {
      this.logger = new (winston.Logger)({
        level: 'verbose',
        transports: [
          new (winston.transports.Console)(),
        ]
      });
    }
  }

  instantiateTicks() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    this.tickInterval = setInterval(() => {
      this.tickEnded = true;
      if (!this.sending) this.next();
    }, 500);
  }


  /**
   * Pushes new command to queue, calls next afterwards if not sending
   *
   * @param  {String}   cmd      The command to execute
   * @param  {Function} callback The callback to execute upon success/timeout
   * @return {undefined}            Doesn't return anything
   */
  push(cmd, callback = DEFAULT_CALLBACK) {
    if (!cmd || !cmd.length) {
      const e = new Error('No valid cmd passed');
      this.logger.error(e);
      callback(e);
    } else {
      this.logger.info(`Queueing ${cmd} into transport`);
      this.queue.push({ cmd, callback });
      if (!this.sending) { this.next(); }
    }
  }

  cmd(...args) {
    return this.push(...args);
  }

  volume(amount, callback = DEFAULT_CALLBACK) {
    const normalizedAmount = boundary(0, amount, 95);
    return this.push(`MV${normalizedAmount}`, callback);
  }

  tv(callback = DEFAULT_CALLBACK) {
    return this.push('SITV', callback);
  }

  pc(callback = DEFAULT_CALLBACK) {
    return this.push('SISAT', callback);
  }

  mch() {
    return this.push('MSMCH STEREO');
  }

  /**
   * Next tick, this means we are requesting for a new queue shift.
   * 1. When tick has not ended yet, it returns
   * 2. When a sending is not finished yet (or hasnt timeouted yet) it returns
   * 3. When queue is empty it disconnects, waiting for new push events
   * 4. When queue is not empty and no sending is in progress:
   *   4.1 Make sure there is a connection, if not connect
   *   4.2 Send that command
   *
   * @return {Promise} Returns a promise, resolving when either premature return
   *                   (due to ticks / sending) or when send is done
   */
  next() {
    // when sending, return, next() is called upon timeout/success
    if (!this.tickEnded) {
      this.logger.info("Called next() while tick hasn't ended yet");
      return Promise.resolve();
    }
    if (this.sending) {
      this.logger.info('Called next() while transport is busy');
      return Promise.resolve();
    }
    // when queue empty, disconnect and return
    if (!this.queue.length) {
      this.logger.log('Denon', 'Queue is empty, disconnecting');
      clearInterval(this.tickInterval);
      return this.disconnect();
    }
    // when not sending, nor queue is empty, get cmd, make sure connection is
    // there, then send command
    this.tickEnded = false;
    const { cmd, callback } = this.queue.shift();
    if (!this.connection) {
      return this.connect().then(() => this.send(cmd, callback)).catch(e => callback({ error: e }));
    }

    return this.send(cmd, callback);
  }


  /**
   * Connects to the receiver by calling the telnet layer. Disconnects auto-
   * matically upon errors.
   *
   * @param  {Function} callback Callback when connection succeeded
   * @return {Promise}           Returns a Promise, resolving when connect is done, rejects after 5 tries
   */
  connect(i = 0) {
    this.connection = new Telnet();
    this.connection.connect(this.config);

    return new Promise((resolve, reject) => {
      this.connection.on('connect', resolve);
      this.connection.on('error', (e) =>
        this.disconnect().then(() => {
          if (this.opts.retryConnect && i < MAX_RETRIES) {
            this.logger.error(`Error occured, waiting another ${(2 ** i) * 100} ms`, e);
            return promiseTimeout((2 ** i) * 100).then(() => this.connect(i + 1).then(resolve).catch(reject));
          }
          return reject(e);
        })
      );
    });
  }

  /**
   * Disconnects the receiver by removing all connection references for our
   * transport layer
   *
   * @param  {Function} cb Callback when disconnection succeeded
   * @return {Promise}     Returns a Promise, resolving when disconnect is successfull
   */
  disconnect() {
    if (!this.connection) return Promise.reject();
    this.sending = false; // always reset sending just in case
    return new Promise((resolve) => {
      this.connection.on('close', () => {
        this.connection = null;
        resolve();
      });
      this.connection.end();
    });
  }

  /**
   * Sends a cmd with a given callback, sets sending to false after
   * success or timeout and calls next()
   *
   * @param  {String}   cmd      The command to excecute
   * @param  {Function} callback The callback upon timeout/success
   * @return {Promise}           Returns a Promise, resolving when send is done / all sends are ready
   */
  send(cmd, callback) {
    return this.exec(cmd).then((response) => {
      const normalizedResponse = normalize(response);
      this.sending = false;
      this.logger.info(`Response is: ${normalizedResponse.error || normalizedResponse.response}`);
      callback(normalizedResponse);
      return this.next();
    });
  }

  /**
   * Private method to execute a command with a given callback.
   * It internally checks whether the requests timeouts as a the telnet layer
   * doesn't really reliably aborts when a timeout occurs, or at least it
   * didn't in my tests
   *
   * @param  {String}   cmd The String for the command
   *
   * @return {Promise}      Returns a promise, resolving when either a timeout occurs or response is there
   */
  exec(cmd) {
    this.logger.info(`Trying to execute: ${cmd}`);
    // Receiver connection crashed, return with empty response
    if (!this.connection) {
      return Promise.reject(new Error('No connection made when trying to exec a command'));
    }

    const execTimeout = promiseTimeout(this.config.execTimeout * 1.5)
      .then(() => ({ code: RESPONSE_CODES.ERROR, error: new Error(`Timeout for ${cmd} happened first`) }));

    this.sending = true;
    const execPromise = this.connection.exec(cmd).then((response) => {
      const resp = splitLast(response); // some commands return multiple lines
      // note that this might be fullfilled but the outerlying promise from Promise.race might ignore the result
      this.logger.info(`Exec for ${cmd} successfull with response: ${resp}`);
      return { code: RESPONSE_CODES.SUCCESS, response: resp };
    }).catch((e) => {
      if (e.message === 'response not received') { // sometimes a response is empty, signalled through a timeout
        return { code: RESPONSE_CODES.EMPTY, response: `No response for ${cmd}` };
      }
      return { code: RESPONSE_CODES.ERROR, error: e };
    });
    // todo: response object für die timeouts
    return Promise.race([execTimeout, execPromise]);
  }
};
