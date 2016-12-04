Denon CLI Application
==============

A small library to control your denon receiver with a minimal cmd-set (includes CLI-wrapper).

Install
---------

Run `npm run denon_remote`

Usage CLI
-------

Run `denon_remote --host <host> --cmd <cmd>` from your command line.

Usage library
--------

```javascript
  const DenonClient = require('denon_remote');
  const client = new DenonClient({ host: '127.0.0.1', retryConnect: true });
  const cb = (response) => console.log(response.error || response.respose);
  client.push('SI?', cb); // Channel
  client.push('MV?', cb); // Master Volume
```

Help
---------

I'm always open to new ideas, feel free to post issues or open a pull request
