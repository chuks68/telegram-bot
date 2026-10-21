import assert from "node:assert/strict";
import test from "node:test";
import { shortAddress } from "../dist/stellar/decode.js";

test("shortAddress pins exact shortened representation for 56-char G… account key", () => {
  const gAddr = "GA4OIW3SEYGMPLPPTCAHRMTCBJ2VW4S36FISNJ4TQF5M44M435JXMHPN";
  assert.equal(gAddr.length, 56);
  assert.equal(shortAddress(gAddr), "GA4OI…MHPN");
});

test("shortAddress pins exact shortened representation for 56-char C… contract key", () => {
  const cAddr = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
  assert.equal(cAddr.length, 56);
  assert.equal(shortAddress(cAddr), "CAAQC…C526");
});

test("shortAddress pins exact behavior for an empty string", () => {
  assert.equal(shortAddress(""), "");
});

test("shortAddress pins exact behavior for a string shorter than prefix+suffix length (9 chars)", () => {
  // prefix (5 chars) + ellipsis (1 char) + suffix (4 chars) = 9 chars of shortened output
  // Strings with length <= 12 are returned unchanged without shortening
  assert.equal(shortAddress("G"), "G");
  assert.equal(shortAddress("GABCD"), "GABCD");
  assert.equal(shortAddress("GABCDEFG"), "GABCDEFG"); // 8 chars (< 9 chars)
});

test("shortAddress pins exact shortened representation for a muxed M… address", () => {
  const muxedAddr = "MANRGOOGPYWEYN5THMLAXYM55E427LWC3SPQ7KYRRH3BHPCTEKUBAAAAAAAAAAAE2IYEW";
  assert.equal(muxedAddr.length, 69);
  assert.equal(shortAddress(muxedAddr), "MANRG…IYEW");
});
