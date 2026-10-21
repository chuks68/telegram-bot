/**
 * Minimal, dependency-free JSON Schema checker for tests.
 *
 * It understands only what the repo's schemas use: `type` (one name or a
 * list), `enum`, `properties`, `required`, `additionalProperties` (false or a
 * schema), `items`, `minimum` and `format: "date-time"`. Any other keyword
 * throws, so a schema can never depend on a rule this checker would silently
 * skip.
 */

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description"]);
const KEYWORDS = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minimum",
  "format",
]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

// What Date#toISOString produces, which is where every timestamp in a report comes from.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function hasType(value, type) {
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return jsonType(value) === type;
}

/** Rejects schemas this checker cannot evaluate faithfully, before any value is checked. */
function assertSupported(schema, path) {
  if (jsonType(schema) !== "object") throw new Error(`json-schema-lite: ${path} is not a schema object`);
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !KEYWORDS.has(key)) {
      throw new Error(`json-schema-lite: unsupported keyword "${key}" at ${path}`);
    }
  }
  if (schema.type !== undefined) {
    for (const type of [schema.type].flat()) {
      if (!TYPES.has(type)) throw new Error(`json-schema-lite: unknown type "${type}" at ${path}`);
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`json-schema-lite: enum at ${path} must be a non-empty array`);
  }
  if (schema.format !== undefined && schema.format !== "date-time") {
    throw new Error(`json-schema-lite: unsupported format "${schema.format}" at ${path}`);
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(properties, key)) {
      throw new Error(`json-schema-lite: required "${key}" at ${path} is not in properties`);
    }
  }
  for (const [key, child] of Object.entries(properties)) assertSupported(child, `${path}.properties.${key}`);
  if (jsonType(schema.additionalProperties) === "object") {
    assertSupported(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.items !== undefined) assertSupported(schema.items, `${path}.items`);
}

function check(schema, value, path, errors) {
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((type) => hasType(value, type))) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${jsonType(value)}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
  }
  if (schema.format === "date-time" && typeof value === "string") {
    if (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: ${JSON.stringify(value)} is not an ISO 8601 UTC timestamp`);
    }
  }
  if (jsonType(value) === "object") {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        check(properties[key], child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: not in the schema`);
      } else if (jsonType(schema.additionalProperties) === "object") {
        check(schema.additionalProperties, child, `${path}.${key}`, errors);
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
  }
}

/**
 * Every way `value` breaks `schema`, one "path: reason" line each (`$` is the
 * root). An empty array means the value conforms.
 */
export function validate(schema, value) {
  assertSupported(schema, "$");
  const errors = [];
  check(schema, value, "$", errors);
  return errors;
}
