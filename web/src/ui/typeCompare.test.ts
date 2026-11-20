import test from "node:test";
import assert from "node:assert/strict";
import { comparisonKey, placeComparedSubjects } from "./typeCompare.ts";
import { isComparable, type ComparisonTypeData } from "../bridge/typeComparison.ts";

const marketMiner = { typeID: 483, itemID: null };
const firstMiner = { typeID: 483, itemID: 101 };
const secondMiner = { typeID: 483, itemID: 102 };
const thirdMiner = { typeID: 483, itemID: 103 };
const heron = { typeID: 605, itemID: 201 };
const category = (typeID: number) => typeID === 605 ? 6 : 7;

test("comparison keeps distinct stacks alongside a type-only column and skips duplicates on the grid", () => {
  const placed = placeComparedSubjects([marketMiner], [firstMiner, secondMiner, firstMiner], null, category);
  assert.deepEqual(placed, [marketMiner, firstMiner, secondMiner]);
  assert.equal(placeComparedSubjects(placed, [secondMiner, marketMiner], null, category), placed);
});

test("comparison header drops insert new columns and move existing columns using the captured index", () => {
  const current = [firstMiner, secondMiner, thirdMiner];
  assert.deepEqual(placeComparedSubjects(current, [marketMiner, thirdMiner], comparisonKey(secondMiner), category),
    [firstMiner, marketMiner, thirdMiner, secondMiner]);
  assert.deepEqual(placeComparedSubjects(current, [firstMiner], comparisonKey(secondMiner), category),
    [secondMiner, firstMiner, thirdMiner]);
  assert.deepEqual(placeComparedSubjects(current, [heron], comparisonKey(secondMiner), category), [heron]);
});

test("Compare accepts static types with attributes in a supported category", () => {
  const miner: ComparisonTypeData = { attributes: [[50, 5]], categoryID: 7, groupID: 54, dynamic: false, published: true };
  assert.equal(isComparable(miner), true);
  assert.equal(isComparable({ ...miner, dynamic: true }), false);
  assert.equal(isComparable({ ...miner, attributes: [] }), false);
  assert.equal(isComparable({ ...miner, categoryID: 1 }), false);
});
