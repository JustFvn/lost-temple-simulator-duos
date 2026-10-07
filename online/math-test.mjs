import assert from "node:assert/strict";
import { generateMathProblem, isCorrectAnswer } from "./math-challenge.js";

let seed = 832145;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const operators = new Set();
for (let i = 0; i < 10000; i++) {
  const problem = generateMathProblem(random);
  const [, left, operator, right] = problem.question.match(/^(\d+) ([+−×÷]) (\d+) = \?$/);
  const a = Number(left), b = Number(right);
  operators.add(operator);
  const expected = operator === "+" ? a + b : operator === "−" ? a - b : operator === "×" ? a * b : a / b;
  assert.equal(problem.answer, expected);
  assert(Number.isInteger(problem.answer) && problem.answer >= 0 && problem.answer <= 81);
  if (operator === "÷") { assert(b > 0); assert.equal(a % b, 0); }
  assert(isCorrectAnswer(` ${expected} `, expected));
  assert(isCorrectAnswer(expected, expected));
  assert(!isCorrectAnswer(expected + 1, expected));
}
assert.equal(operators.size, 4);
for (const value of ["", " ", null, false, true, [], {}, NaN, Infinity, "0x10", "1e1", "2+2", "4.0", "0000000"]) assert(!isCorrectAnswer(value, 0));
assert(isCorrectAnswer("0", 0)); assert(!isCorrectAnswer("", 0));
console.log("OK: 10000 道簡單加減乘除題、整除／非負整數答案、空值及非法輸入拒絕。");
