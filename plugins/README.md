# Plugins: adding a new kind of equipment

Show Control can be taught to talk to a new piece of equipment without changing the app itself.
A plugin is one `.js` file. Put it in either folder and restart Show Control:

- `plugins/` inside the Show Control folder (comes with the app)
- `Show Control/plugins/` in your home folder (yours, kept when you update the app)

It then appears in **System > Equipment setup > Add equipment**, under its category, and its
commands appear in the cue editor. If a plugin has a mistake in it, Show Control still starts:
the Setup screen lists the plugin and what is wrong with it.

Before writing a plugin, check whether one of the built-in "anything" kinds already does the job:
**Anything that takes OSC**, **text commands over TCP/UDP**, **web address (HTTP)**,
**MIDI over the network**, or **Bitfocus Companion** (which already controls 700+ kinds of gear).

## Writing one

See [`examples/example-relay.js`](examples/example-relay.js) for a complete, commented example.
A plugin exports a function that is given Show Control's building blocks and returns a driver class:

```js
module.exports = ({ Driver, net, dgram, osc, request, result, LineSession, templates }) => class MyThing extends Driver {
  static meta = { type: 'my-thing', label: 'My thing', category: 'other', fields: [], help: [], commands: {} };
  start() { /* connect; call this.seen() whenever the device answers */ }
  async command(cmd, args) { /* do it; return result('ok' | 'sent' | 'timeout' | ...) */ }
  stop() { super.stop(); /* close sockets and timers */ }
};
```

- `meta.type` must be new (lower-case letters, numbers and `-`). Built-in kinds can't be replaced.
- `meta.fields` are the extra boxes on the Setup screen: `[key, type, label, placeholder]`, with
  type `text`, `password`, `port`, `number` or `select:value=Label|value=Label`. The address is always there.
- `meta.commands` are what a cue can do: `{ command: [[arg, type, default, label], ...] }`, with
  type `text`, `number`, `n1` (shown from 1, sent from 0), `select:a|b` or `bool:Yes|No`.
- Set `meta.oneWay: true` if the device never answers (then Test only checks the address is there).
- Use `this.setStatus('connecting' | 'online' | 'offline')`, `this.seen()`, `this.patch({...})` for
  state the screens can show, and `this.log(message, 'warn')`.
- Return outcomes with `result(...)`: `ok`, `accepted`, `sent`, `busy`, `rejected`, `unsupported`,
  `timeout`, `auth_failed`, `fault`, `offline`. Never pretend something worked.
