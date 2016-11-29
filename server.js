const Telnet = require('telnet-client');
const winston = require('winston');
const { merge } = require('lodash');

// Default config for telnet for receiver and for transport layer
// Note that the latter are solely for timeouts (tick + exec). Exec timeout
// is negotiable, it worked in my network environment quite well, but it could
// be higher in yours
const DEFAULT_CONFIG = {
  telnet: {
    port: 23,
    shellPrompt: '',
    echoLines: 0,
    irs: '\r',
    ors: '\r',
    separator: false,
    execTimeout: 400
  },
  transport: {
    execTimeout: 600, // add extra 100ms just in case
    tickTimeout: 550 // add extra 50ms just in case
  }
};

const noop = () => {};

const splitLast = () => {}; // todo


module.exports = class Transport {

  constructor(opts) {
    this.opts = opts;
    this.config = merge(DEFAULT_CONFIG.telnet, opts);

    this.sending = false;
    this.tickEnded = true;
    this.queue = [];
    this.getLogger();
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

  /**
   * Pushes new command to queue, calls next afterwards if not sending
   *
   * @param  {String}   cmd      The command to execute
   * @param  {Function} callback The callback to execute upon success/timeout
   * @return {async}            Doesn't return anything, response is async
   */
  push(cmd, callback = this.logger.log) {
    this.logger.info('ReceiverDebug', `Queueing ${cmd} into transport`);
    this.queue.push({ cmd, callback });
    if (!this.sending) { this.next(); }
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
   * @return {undefined} Returns undefined in all cases
   */
  next() {
    // when sending, return, next() is called upon timeout/success
    if (!this.tickEnded) {
      this.logger.info('ReceiverDebug', "Called next() while tick hasn't ended yet");
      return;
    }
    if (this.sending) {
      this.logger.info('ReceiverDebug', 'Called next() while transport is busy');
      return;
    }
    // when queue empty, disconnect and return
    if (!this.queue.length) {
      this.logger.log('Denon', 'Queue is empty, disconnecting');
      this.disconnect(noop);
      return undefined;
    }
    // when not sending, nor queue is empty, get cmd, make sure connection is
    // there, then send command
    this.sending = true;
    const { cmd, callback } = this.queue.shift();
    if (!this.connection) {
      this.connect(() => { this.send(cmd, callback); });
    } else {
      this.send(cmd, callback);
    }
  }


  /**
   * Connects to the receiver by calling the telnet layer. Disconnects auto-
   * matically upon errors.
   *
   * @param  {Function} callback Callback when connection succeeded
   * @return {async}             Doesn't return anything, response is async
   */
  connect(callback, i = 0) {
    this.connection = new Telnet();
    this.connection.connect(this.config);
    this.connection.on('connect', callback);
    this.connection.on('error', (e) => {
      this.logger.error('Receiver', `Error occured, waiting another ${(i * 100) ** 2} ms`, e);
      this.disconnect(() => {
        if (this.opts.retryConnect && i <= 5) {
          setTimeout(() => this.connect(callback, i + 1), (i * 100) ** 2);
        }
      });
    });
  }

  /**
   * Disconnects the receiver by removing all connection references for our
   * transport layer
   *
   * @param  {Function}             cb Callback when disconnection succeeded
   * @return {[async|undefined]}       Doesn't return anything, response is
   *                                   async or undefined
   */
  disconnect(cb) {
    if (!this.connection) return;
    this.sending = false; // always reset sending just in case
    this.connection.on('close', () => {
      this.connection = null;
      cb();
    });
    this.connection.end();
  }

  /**
   * Sends a cmd with a given callback, sets sending to false after
   * success or timeout and calls next()
   *
   * @param  {String}   cmd      The command to excecute
   * @param  {Function} callback The callback upon timeout/success
   * @return {async}             Returns async response
   */
  send(cmd, callback) {
    this.exec(cmd, (response) => {
      callback(response);
      this.sending = false;
      this.next();
    });
  }

  /**
   * Private method to execute a command with a given callback.
   * It internally checks whether the requests timeouts as a the telnet layer
   * doesn't really reliably aborts when a timeout occurs, or at least it
   * didn't in my tests
   *
   * @param  {String}   cmd The String for the command
   * @param  {Function} cb  The callback, either called with false (timeoutted)
   *                        or the callback value from the receiver end.
   *
   * @return {async}        Doesn't return anything, response is async
   */
  exec(cmd, cb) {
    this.logger.info('ReceiverDebug', `Trying to execute: ${cmd}`);
    // Receiver connection crashed, return with empty response
    if (!this.connection) {
      return cb('');
    }

    // timeouts of requests since some requests do not return a response,
    // thus do not trigger the callback
    let timeoutFirst;
    let responseFirst;
    setTimeout(() => {
      if (!responseFirst) {
        this.logger.info('ReceiverDebug', `Timeout for ${cmd} happened first`);
        timeoutFirst = true;
        // always return the original cmd after timeout as an 'ack' mechanism,
        // timeouts or empty responses which result in a timeout are often
        // occured when SISAT or SITV are called, thus we provide a safe way
        // to ack the channel selection, but also lose knowledge about real
        // timeouts (although this has never happened yet)
        cb(cmd);
      }
    }, DEFAULT_CONFIG.transport.execTimeout);

    // ticks according to receiver spec, only send every min 500ms (can be longer
    // when sending needs longer)
    setTimeout(() => {
      this.tickEnded = true;
      if (!this.sending) {
        this.next();
      } // call next when the tick and send have ended
    }, DEFAULT_CONFIG.transport.tickTimeout);
    this.tickEnded = false;

    this.connection.exec(cmd, (response) => {
      if (!timeoutFirst) {
        responseFirst = true;
        const resp = splitLast(response); // some commands return multiple lines
        this.logger.info('ReceiverDebug', `Exec for ${cmd} successfull with response: ${resp}`);
        cb(resp);
      }
    });
  }
};
