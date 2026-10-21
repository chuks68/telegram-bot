import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(__dirname, '../tests/fixtures/events.json');

const REQUIRED_FIELDS = ['id', 'contract', 'ledger', 'name'];

const KNOWN_EVENT_NAMES = new Set([
  'contract_initialized',
  'contract_deployed',
  'contract_updated',
  'contract_invoked',
  'contract_event',
  'contract_data_entry',
  'contract_data_entry_updated',
  'contract_data_entry_removed',
  'contract_code_uploaded',
  'contract_code_removed',
  'system_event',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEvents(events) {
  const errors = [];

  if (!Array.isArray(events)) {
    return ['fixtures must be an array of events'];
  }

  const seenIds = new Map();
  const lastLedgerByContract = new Map();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const label = `index ${index}`;

    if (!isPlainObject(event)) {
      errors.push(`${label}: event must be an object`);
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!(field in event)) {
        errors.push(`${label}: missing required field "${field}"`);
      }
    }

    const { id, contract, ledger, name } = event;

    if (id !== undefined) {
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(`${label}: "id" must be a non-empty string`);
      } else if (seenIds.has(id)) {
        errors.push(`${label}: duplicate event id "${id}" (already used at index ${seenIds.get(id)})`);
      } else {
        seenIds.set(id, index);
      }
    }

    if (contract !== undefined && (typeof contract !== 'string' || contract.length === 0)) {
      errors.push(`${label}: "contract" must be a non-empty string`);
    }

    if (ledger !== undefined) {
      if (typeof ledger !== 'number' || !Number.isInteger(ledger) || ledger < 0) {
        errors.push(`${label}: "ledger" must be a non-negative integer`);
      } else if (typeof contract === 'string' && contract.length > 0) {
        const previous = lastLedgerByContract.get(contract);
        if (previous !== undefined && ledger < previous.ledger) {
          errors.push(
            `${label}: ledger ${ledger} for contract "${contract}" is not monotonic (previous ${previous.ledger} at index ${previous.index})`,
          );
        } else {
          lastLedgerByContract.set(contract, { ledger, index });
        }
      }
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.length === 0) {
        errors.push(`${label}: "name" must be a non-empty string`);
      } else if (!KNOWN_EVENT_NAMES.has(name)) {
        errors.push(`${label}: unknown event name "${name}"`);
      }
    }
  }

  return errors;
}

async function main() {
  const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FIXTURES;

  let raw;
  try {
    raw = await readFile(target, 'utf-8');
  } catch (error) {
    console.error(`unable to read fixtures at ${target}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(`${target}: invalid JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const events = Array.isArray(data) ? data : data.events;
  const errors = validateEvents(events);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`${target}: validated ${events.length} event(s)`);
}

main().catch((error) => {
  console.error(`failed to validate fixtures: ${error.message}`);
  process.exitCode = 1;
});
