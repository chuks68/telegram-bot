/**
 * Tests for isTimeoutError error classification.
 *
 * Validates which errors are treated as timeouts for retries and logging.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isTimeoutError } from "../dist/notifications/format.js";

test("AbortError Error instance", () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  assert.strictEqual(isTimeoutError(err), true);
});

test("TimeoutError Error instance", () => {
  const err = new Error("Operation timed out");
  err.name = "TimeoutError";
  assert.strictEqual(isTimeoutError(err), true);
});

test("AbortError as plain object", () => {
  const err = { name: "AbortError" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("TimeoutError as plain object", () => {
  const err = { name: "TimeoutError" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("ETIMEDOUT on Error instance", () => {
  const err = new Error("Connection timed out");
  err.code = "ETIMEDOUT";
  assert.strictEqual(isTimeoutError(err), true);
});

test("ESOCKETTIMEDOUT on Error instance", () => {
  const err = new Error("Socket timeout");
  err.code = "ESOCKETTIMEDOUT";
  assert.strictEqual(isTimeoutError(err), true); // matches via message pattern
});

test("ECONNRESET on Error instance", () => {
  const err = new Error("Connection reset");
  err.code = "ECONNRESET";
  assert.strictEqual(isTimeoutError(err), true);
});

test("UND_ERR_* on Error instance", () => {
  const err = new Error("Undici error");
  err.code = "UND_ERR_BODY_TIMEOUT";
  assert.strictEqual(isTimeoutError(err), true);
});

test("ETIMEDOUT as plain object", () => {
  const err = { code: "ETIMEDOUT" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("ECONNRESET as plain object", () => {
  const err = { code: "ECONNRESET" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("UND_ERR_* as plain object", () => {
  const err = { code: "UND_ERR_CONNECT_TIMEOUT" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("Error message 'timed out'", () => {
  const err = new Error("Request timed out");
  assert.strictEqual(isTimeoutError(err), true);
});

test("Error message 'timeout'", () => {
  const err = new Error("timeout");
  assert.strictEqual(isTimeoutError(err), true);
});

test("Error message 'TIMEOUT' (case-insensitive)", () => {
  const err = new Error("NETWORK TIMEOUT");
  assert.strictEqual(isTimeoutError(err), true);
});

test("Error message with 'timed out' in middle", () => {
  const err = new Error("The operation timed out after 5000ms");
  assert.strictEqual(isTimeoutError(err), true);
});

test("Plain object with message 'timed out'", () => {
  const err = { message: "Connection timed out" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("Error message without timeout", () => {
  const err = new Error("Bad request");
  assert.strictEqual(isTimeoutError(err), false);
});

test("HttpError wrapping AbortError", () => {
  const inner = new Error("Aborted");
  inner.name = "AbortError";
  const err = new Error("HTTP request failed");
  err.cause = inner;
  assert.strictEqual(isTimeoutError(err), false); // doesn't unwrap cause
});

test("HttpError with ETIMEDOUT code", () => {
  const err = new Error("HTTP request failed");
  err.code = "ETIMEDOUT";
  assert.strictEqual(isTimeoutError(err), true);
});

test("HttpError with timeout message", () => {
  const err = new Error("HTTP request timed out");
  assert.strictEqual(isTimeoutError(err), true);
});

test("Generic Error with unrelated name", () => {
  const err = new Error("Something went wrong");
  err.name = "Error";
  assert.strictEqual(isTimeoutError(err), false);
});

test("Error with non-timeout code", () => {
  const err = new Error("Not found");
  err.code = "ENOTFOUND";
  assert.strictEqual(isTimeoutError(err), false);
});

test("Error with non-timeout message", () => {
  const err = new Error("Unauthorized");
  assert.strictEqual(isTimeoutError(err), false);
});

test("Plain object with non-timeout code", () => {
  const err = { code: "EPIPE" };
  assert.strictEqual(isTimeoutError(err), false);
});

test("Plain object with non-timeout message", () => {
  const err = { message: "Access denied" };
  assert.strictEqual(isTimeoutError(err), false);
});

test("null", () => {
  assert.strictEqual(isTimeoutError(null), false);
});

test("undefined", () => {
  assert.strictEqual(isTimeoutError(undefined), false);
});

test("plain string", () => {
  assert.strictEqual(isTimeoutError("timed out"), false);
});

test("plain string 'timeout'", () => {
  assert.strictEqual(isTimeoutError("timeout"), false);
});

test("number", () => {
  assert.strictEqual(isTimeoutError(123), false);
});

test("empty object", () => {
  assert.strictEqual(isTimeoutError({}), false);
});

test("array", () => {
  assert.strictEqual(isTimeoutError([]), false);
});

test("Error with empty message", () => {
  const err = new Error("");
  assert.strictEqual(isTimeoutError(err), false);
});

test("Error with undefined code", () => {
  const err = new Error("Something");
  err.code = undefined;
  assert.strictEqual(isTimeoutError(err), false);
});

test("Plain object with undefined code", () => {
  const err = { code: undefined };
  assert.strictEqual(isTimeoutError(err), false);
});

test("Plain object with null code", () => {
  const err = { code: null };
  assert.strictEqual(isTimeoutError(err), false);
});

test("Plain object with numeric code", () => {
  const err = { code: 123 };
  assert.strictEqual(isTimeoutError(err), false);
});

test("Error with both AbortError name and ETIMEDOUT code", () => {
  const err = new Error("Aborted");
  err.name = "AbortError";
  err.code = "ETIMEDOUT";
  assert.strictEqual(isTimeoutError(err), true);
});

test("Plain object with both TimeoutError name and timeout message", () => {
  const err = { name: "TimeoutError", message: "Request timed out" };
  assert.strictEqual(isTimeoutError(err), true);
});

test("Error with timeout message but non-timeout code", () => {
  const err = new Error("Request timed out");
  err.code = "EPIPE";
  assert.strictEqual(isTimeoutError(err), true); // message wins
});
