import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import { Log } from "meteor/logging";

/*
  Adds migration capabilities. Migrations are defined like:

  Migrations.add({
    up: function() {}, //*required* code to run to migrate upwards
    version: 1, //*required* number to identify migration order
    down: function() {}, //*optional* code to run to migrate downwards
    name: 'Something' //*optional* display name for the migration
  });

  The ordering of migrations is determined by the version you set.

  To run the migrations, set the MIGRATE environment variable to either
  'latest' or the version number you want to migrate to. Optionally, append
  ',exit' if you want the migrations to exit the meteor process, e.g if you're
  migrating from a script (remember to pass the --once parameter).

  e.g:
  MIGRATE="latest" mrt # ensure we'll be at the latest version and run the app
  MIGRATE="latest,exit" mrt --once # ensure we'll be at the latest version and exit
  MIGRATE="2,exit" mrt --once # migrate to version 2 and exit

  Note: Migrations will lock ensuring only 1 app can be migrating at once. If
  a migration crashes, the control record in the migrations collection will
  remain locked and at the version it was at previously, however the db could
  be in an inconsistent state.
*/

// since we'll be at version 0 by default, we should have a migration set for
// it.
const DefaultMigration = { async: false, version: 0, up: function () {} };

export const Migrations = {
  _list: [DefaultMigration],
  options: {
    // false disables logging
    log: true,
    // null or a function
    logger: null,
    // enable/disable info log "already at latest."
    logIfLatest: true,
    // migrations collection name
    collectionName: "migrations",
  },
  config: function (opts) {
    this.options = Object.assign({}, this.options, opts);
  },
};

/*
  Logger factory function. Takes a prefix string and options object
  and uses an injected `logger` if provided, else falls back to
  Meteor's `Log` package.
  Will send a log object to the injected logger, on the following form:
    message: String
    level: String (info, warn, error, debug)
    tag: 'Migrations'
*/
function createLogger(prefix) {
  check(prefix, String);

  // Return noop if logging is disabled.
  if (Migrations.options.log === false) {
    return function () {};
  }

  return function (level, message) {
    check(level, Match.OneOf("info", "error", "warn", "debug"));
    check(message, String);

    const logger = Migrations.options && Migrations.options.logger;

    if (logger && _.isFunction(logger)) {
      logger({
        level: level,
        message: message,
        tag: prefix,
      });
    } else {
      Log[level]({ message: prefix + ": " + message });
    }
  };
}

let log;

Meteor.startup(function () {
  const options = Migrations.options;

  // collection holding the control record
  Migrations._collection = new Mongo.Collection(options.collectionName);

  log = createLogger("Migrations");

  ["info", "warn", "error", "debug"].forEach(function (level) {
    log[level] = _.partial(log, level);
  });

  if (process.env.MIGRATE) Migrations.migrateTo(process.env.MIGRATE);
});

// Add a new migration:
// {up: function *required
//  version: Number *required
//  down: function *optional
//  name: String *optional
// }
Migrations.add = function (migration) {
  if (typeof migration.up !== "function")
    throw new Meteor.Error("Migration must supply an up function.");

  if (typeof migration.version !== "number")
    throw new Meteor.Error("Migration must supply a version number.");

  if (migration.version <= 0)
    throw new Meteor.Error("Migration version must be greater than 0");

  // Freeze the migration object to make it hereafter immutable
  Object.freeze(migration);

  this._list.push(migration);
  this._list = _.sortBy(this._list, function (m) {
    return m.version;
  });
};

// Attempts to run the migrations using command in the form of:
// e.g 'latest', 'latest,exit', 2
// use 'XX,rerun' to re-run the migration at that version
Migrations.migrateTo = async function (command) {
  if (
    typeof command === "undefined" ||
    command === "" ||
    this._list.length === 0
  )
    throw new Error("Cannot migrate using invalid command: " + command);

  let version;
  let subcommand;
  if (typeof command === "number") {
    version = command;
  } else {
    version = command.split(",")[0]; //.trim();
    subcommand = command.split(",")[1]; //.trim();
  }

  if (version === "latest") {
    await this._migrateToAsync(this._list[this._list.length - 1].version);
  } else {
    await this._migrateToAsync(parseInt(version), subcommand === "rerun");
  }

  // remember to run meteor with --once otherwise it will restart
  if (subcommand === "exit") process.exit(0);
};

// just returns the current version
Migrations.getVersion = function () {
  return this._getControl().version;
};

// just returns the current version
Migrations.getVersionAsync = async function () {
  const result = await this._getControl();
  return result.version;
};

Migrations._migrateToAsync = async function (version, rerun) {
  const self = this;
  const control = await this._getControlAsync(); // Side effect: upserts control document.
  let currentVersion = control.version;

  //Avoid unneeded locking, check if migration actually is going to run
  if (!rerun && currentVersion === version) {
    if (Migrations.options.logIfLatest) {
      log.info("Not migrating, already at version " + version);
    }
    return;
  }

  if ((await lockAsync()) === false) {
    log.info("Not migrating, control is locked.");
    return;
  }

  if (rerun) {
    log.info("Rerunning version " + version);
    await migrateAsync("up", this._findIndexByVersion(version));
    log.info("Finished migrating.");
    await unlockAsync();
    return;
  }

  const startIdx = this._findIndexByVersion(currentVersion);
  const endIdx = this._findIndexByVersion(version);

  // log.info('startIdx:' + startIdx + ' endIdx:' + endIdx);
  log.info(
    "Migrating from version " +
      this._list[startIdx].version +
      " -> " +
      this._list[endIdx].version
  );

  // run the actual migration
  async function migrateAsync(direction, idx) {
    const migration = self._list[idx];

    if (typeof migration[direction] !== "function") {
      await unlockAsync();
      throw new Meteor.Error(
        "Cannot migrate " + direction + " on version " + migration.version
      );
    }

    function maybeName() {
      return migration.name ? " (" + migration.name + ")" : "";
    }

    log.info(
      "Running " +
        direction +
        "() on version " +
        migration.version +
        maybeName()
    );

    if (migration.async) {
      await migration[direction](migration);
    } else {
      migration[direction](migration);
    }
  }

  async function lockAsync() {
    // This is atomic. The selector ensures only one caller at a time will see
    // the unlocked control, and locking occurs in the same update's modifier.
    // All other simultaneous callers will get false back from the update.
    const result =
      (await self._collection.updateAsync(
        { _id: "control", locked: false },
        { $set: { locked: true, lockedAt: new Date() } }
      )) === 1;
    return result;
  }

  // Side effect: saves version.
  async function unlockAsync() {
    await self._setControlAsync({ locked: false, version: currentVersion });
  }

  async function updateVersionAsync() {
    await self._setControlAsync({ locked: true, version: currentVersion });
  }

  if (currentVersion < version) {
    for (let i = startIdx; i < endIdx; i++) {
      await migrateAsync("up", i + 1);
      currentVersion = self._list[i + 1].version;
      await updateVersionAsync();
    }
  } else {
    for (let i = startIdx; i > endIdx; i--) {
      await migrateAsync("down", i);
      currentVersion = self._list[i - 1].version;
      await updateVersionAsync();
    }
  }

  await unlockAsync();
  log.info("Finished migrating.");
};

// gets the current control record, optionally creating it if non-existent
Migrations._getControl = function () {
  const control = this._collection.findOne({ _id: "control" });

  return control || this._setControl({ version: 0, locked: false });
};

// gets the current control record, optionally creating it if non-existent
Migrations._getControlAsync = async function () {
  const control = await this._collection.findOneAsync({ _id: "control" });

  return control || this._setControl({ version: 0, locked: false });
};

// sets the control record
Migrations._setControl = function (control) {
  // be quite strict
  check(control.version, Number);
  check(control.locked, Boolean);

  this._collection.update(
    { _id: "control" },
    { $set: { version: control.version, locked: control.locked } },
    { upsert: true }
  );

  return control;
};

Migrations._setControlAsync = async function (control) {
  // be quite strict
  check(control.version, Number);
  check(control.locked, Boolean);

  await this._collection.updateAsync(
    { _id: "control" },
    { $set: { version: control.version, locked: control.locked } },
    { upsert: true }
  );

  return control;
};

// returns the migration index in _list or throws if not found
Migrations._findIndexByVersion = function (version) {
  for (let i = 0; i < this._list.length; i++) {
    if (this._list[i].version === version) return i;
  }

  throw new Meteor.Error("Can't find migration version " + version);
};

//reset (mainly intended for tests)
Migrations._reset = function () {
  this._list = [{ version: 0, up: function () {} }];
  this._collection.remove({});
};

//reset (mainly intended for tests)
Migrations._resetAsync = async function () {
  this._list = [{ version: 0, up: function () {} }];
  await this._collection.removeAsync({});
};

// unlock control
Migrations.unlock = function () {
  this._collection.update({ _id: "control" }, { $set: { locked: false } });
};

// unlock control
Migrations.unlockAsync = async function () {
  this._collection.updateAsync({ _id: "control" }, { $set: { locked: false } });
};
