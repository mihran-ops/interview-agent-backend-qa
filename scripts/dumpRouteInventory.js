'use strict';

// Prints the application's route inventory, or writes it to the pinned fixture with
// --write. Use --write only when a route change is intentional, in the same commit.

const fs = require('node:fs');
const path = require('node:path');
const { buildRouteInventory } = require('../test/helpers/buildRouteInventory');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'route-inventory.json');

const inventory = buildRouteInventory();

if (process.argv.includes('--write')) {
  fs.writeFileSync(FIXTURE, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`wrote ${inventory.length} routes to ${path.relative(process.cwd(), FIXTURE)}`);
} else {
  console.log(inventory.join('\n'));
  console.log(`\n${inventory.length} routes`);
}
