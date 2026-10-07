/** Small whole-number problems; division always has an exact integer answer. */
export function generateMathProblem(random = Math.random) {
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
  const operator = ["+", "−", "×", "÷"][integer(0, 3)];
  let a, b, answer;
  if (operator === "+") { a = integer(0, 10); b = integer(0, 10); answer = a + b; }
  else if (operator === "−") { a = integer(0, 20); b = integer(0, a); answer = a - b; }
  else if (operator === "×") { a = integer(1, 9); b = integer(1, 9); answer = a * b; }
  else { b = integer(2, 9); answer = integer(1, 9); a = b * answer; }
  return { question: `${a} ${operator} ${b} = ?`, answer };
}
export function isCorrectAnswer(value, expected) {
  if (typeof value === "string") {
    value = value.trim();
    if (!/^-?\d{1,6}$/.test(value)) return false;
  } else if (typeof value !== "number") return false;
  return Number.isInteger(Number(value)) && Number(value) === expected;
}
