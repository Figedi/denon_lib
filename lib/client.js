const Telnet = require('telnet-client');
const EventEmitter = require('eventemitter2');
const winston = require('winston');
const { assign, merge, isArray } = require('lodash');
const shortid = require('shortid');

// Default config for telnet for receiver
const DEFAULT_CONFIG = {
  loggerLocation: `${__dirname}/denon_remote.log`,
  retryConnect: true,
  telnetTimeout: 500,
  telnet: {
    port: 23,
    shellPrompt: '',
    echoLines: 0,
    irs: '\r',
    ors: '\r',
    separator: false,
  },
};

const RESPONSE_CODES = {
  SUCCESS: 0x0,
  EMPTY: 0x1,
  ERROR: 0x2,
};

// string codes as we are emitting those later on
const LIFECYCLE_CODES = {
  CONNECT: 'connect',
  RESPONSE: 'response',
  RAW_DATA: 'raw_data',
  ERROR: 'error',
  DISCONNECT: 'disconnect',
};

const LABELS = {
  MV: 'Master Volume',
  CHANNEL: 'Channel',
  POWER: 'Power',
};

const RESPONSES = [
  { pattern: /^MV(.*)$/, label: LABELS.MV },
  { pattern: /^SI(.*)$/, label: LABELS.CHANNEL },
  { pattern: /^PW(.*)$/, label: LABELS.POWER },
];

const MAX_RETRIES = 4;

const DEFAULT_CALLBACK = r => {
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

const promiseTimeout = time => new Promise(resolve => setTimeout(resolve, time));

const normalize = (cmd, response) => {
  if (response.code === RESPONSE_CODES.EMPTY || response.code === RESPONSE_CODES.ERROR) {
    return response;
  }
  let matched;
  let firstResponse;
  let filteredResponse;
  const cmdType = cmd.substr(0, 2).toLowerCase();
  // prefilter other output by comparing first two chars
  // (sometimes receiver returns multiple, unrelevant responses to the cmd)
  if (isArray(response.response)) {
    filteredResponse = response.response.filter(responseCode => responseCode.substr(0, 2).toLowerCase() === cmdType);
    firstResponse = response.response[0];
  } else {
    filteredResponse = [response.response].filter(responseCode => responseCode.substr(0, 2).toLowerCase() === cmdType);
    firstResponse = response.response;
  }

  // eslint-disable-next-line
  for (const patternObject of RESPONSES) {
    const match = firstResponse.match(patternObject.pattern);
    if (match) {
      matched = { value: match[1], label: patternObject.label };
      break;
    }
  }
  if (matched) {
    return assign(response, {
      response: filteredResponse,
      $original: response.response,
      $formatted: `${matched.label}: ${matched.value}`,
    });
  }
  return assign(response, { response: filteredResponse, $original: response.response });
};

module.exports = class DenonClient extends EventEmitter {
  constructor(opts) {
    super();
    this.config = merge(DEFAULT_CONFIG, opts, { telnet: { host: opts.host } });
    this.host = opts.host;
    this.sending = false;
    this.queue = [];
    this.setupLogger();
  }

  setupLogger() {
    if (process.env.NODE_ENV === 'production') {
      this.logger = new winston.Logger({
        level: 'warn',
        transports: [
          new winston.transports.Console(),
          new winston.transports.File({ filename: this.config.loggerLocation }),
        ],
      });
    } else {
      this.logger = new winston.Logger({
        level: 'verbose',
        transports: [new winston.transports.Console()],
      });
    }
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
      return -1;
    }
    const id = shortid.generate();
    this.logger.info(`Queueing ${cmd} into transport`);
    this.queue.push({ cmd, callback, id });
    if (!this.sending) {
      this.next();
    }
    return id;
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

  mch(callback = DEFAULT_CALLBACK) {
    return this.push('MSMCH STEREO', callback);
  }

  /**
   * Next cmd, this means we are requesting for a new queue shift.
   * 1. When a sending is not finished yet (or hasnt timeouted yet) it returns
   * 2. When queue is empty it disconnects, waiting for new push events
   * 3. When queue is not empty and no sending is in progress:
   *   3.1 Make sure there is a connection, if not connect
   *   3.2 Send that command
   *
   * @return {Promise} Returns a promise, resolving when either premature return
   *                   (due to sending) or when send is done
   */
  next(shouldDisconnect = false) {
    // when sending, return, next() is called upon timeout/success
    if (this.sending) {
      this.logger.info('Called next() while transport is busy');
      return Promise.resolve();
    }
    // when queue empty, disconnect and return
    if (!this.queue.length) {
      this.logger.info('Queue is empty, disconnecting');
      if (shouldDisconnect) {
        this.logger.info('Disconnecting...');
        return this.disconnect().then(() =>
          this.emit(LIFECYCLE_CODES.DISCONNECT, {
            code: LIFECYCLE_CODES.DISCONNECT,
            message: `Disconnected from host ${this.host}`,
          }),
        );
      }
      this.logger.info('Scheduling for disconnect within the next 500ms');
      return promiseTimeout(500).then(() => this.next(true));
    }
    // when not sending, nor queue is empty, get cmd, make sure connection is
    // there, then send command
    const { cmd, callback, id } = this.queue.shift();
    if (!this.connection) {
      return this.connect().then(() => this.send(cmd, callback, id)).catch(e => callback({ error: e }));
    }

    return this.send(cmd, callback, id);
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
    this.connection.connect(this.config.telnet);
    this.connection.on('data', dataBuffer =>
      this.emit(LIFECYCLE_CODES.RAW_DATA, {
        code: LIFECYCLE_CODES.RAW_DATA,
        data: dataBuffer.toString().trim(),
      }),
    );
    return new Promise((resolve, reject) => {
      this.connection.on('connect', () => {
        this.emit(LIFECYCLE_CODES.CONNECT, {
          code: LIFECYCLE_CODES.CONNECT,
          message: `Connected to ${this.host}`,
        });
        resolve();
      });
      this.connection.on('error', e =>
        this.disconnect().then(() => {
          if (this.config.retryConnect && i < MAX_RETRIES) {
            this.logger.error(`Error occured, waiting another ${2 ** i * 100} ms`, e);
            return promiseTimeout(2 ** i * 100).then(() => this.connect(i + 1).then(resolve).catch(reject));
          }
          return reject(e);
        }),
      );
    });
  }

  /**
   * Disconnects the receiver by removing all connection references for our
   * transport layer
   *
   * @return {Promise}     Returns a Promise, resolving when disconnect is successfull
   */
  disconnect() {
    if (!this.connection) return Promise.reject();
    this.sending = false; // always reset sending just in case
    return new Promise(resolve => {
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
  send(cmd, callback, id) {
    return this.exec(cmd).then(response => {
      const normalizedResponse = normalize(cmd, response);
      this.logger.info(`Response is: ${normalizedResponse.error || normalizedResponse.response}`);
      this.emit(LIFECYCLE_CODES.RESPONSE, { code: LIFECYCLE_CODES.RESPONSE, response: normalizedResponse, id });
      callback(normalizedResponse);
      this.sending = false;
      return this.next();
    });
  }

  /**
   * Private method to execute a command with a given callback.
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
    const start = +new Date();
    this.sending = true;

    return this.connection
      .send(cmd, { timeout: this.config.telnetTimeout })
      .then(response => {
        this.logger.info(`Exec for ${cmd} successfull with response: ${response.trim().split('\r').join(',')}`);
        return { code: RESPONSE_CODES.SUCCESS, response: response.trim().split('\r') };
      })
      .catch(e => {
        if (e.message === 'response not received') {
          // sometimes a response is empty, signalled through a timeout
          return { code: RESPONSE_CODES.EMPTY, response: `No response for ${cmd}` };
        }
        this.logger.error(`Exec for ${cmd} failed with error: ${e}`);
        return { code: RESPONSE_CODES.ERROR, error: e };
      })
      .then(promiseResponse => {
        const diff = new Date() - start;
        if (diff >= this.config.telnetTimeout) {
          return promiseResponse;
        } // this should never happen due to timeout: 500
        return promiseTimeout(500 - diff).then(() => promiseResponse);
      });
  }
};
