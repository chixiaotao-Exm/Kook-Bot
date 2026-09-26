const MAX_INPUT_LENGTH = 200;
const MAX_LITERAL_DIGITS = 30;
const MAX_OPERATIONS = 100;
const MAX_DEPTH = 20;
const MAX_FRACTION_BITS = 4096;
const MAX_INTEGER_DIGITS = 100;
const DECIMAL_PLACES = 12;
const DECIMAL_SCALE = 10n ** BigInt(DECIMAL_PLACES);

const ERROR_MESSAGES = Object.freeze({
  CALC_FORMAT: '算式格式不正确，请只使用数字、小数、括号和加减乘除。',
  CALC_LIMIT: '算式过长或结果过大，请简化后再计算。',
  CALC_DIVISION_ZERO: '不能除以零，请检查算式。',
});

export class CalculatorError extends Error {
  constructor(code = 'CALC_FORMAT') {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'CALC_FORMAT';
    super(ERROR_MESSAGES[safeCode]);
    this.name = 'CalculatorError';
    this.code = safeCode;
  }
}

function calculationError(code) { return new CalculatorError(code); }

function absolute(value) { return value < 0n ? -value : value; }

function greatestCommonDivisor(left, right) {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

function fraction(numerator, denominator = 1n) {
  if (denominator === 0n) throw calculationError('CALC_DIVISION_ZERO');
  if (absolute(numerator).toString(2).length > MAX_FRACTION_BITS
    || absolute(denominator).toString(2).length > MAX_FRACTION_BITS) throw calculationError('CALC_LIMIT');
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = greatestCommonDivisor(absolute(numerator), denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function decimalResult({ numerator, denominator }) {
  const magnitude = absolute(numerator);
  let scaled = (magnitude * DECIMAL_SCALE) / denominator;
  const remainder = (magnitude * DECIMAL_SCALE) % denominator;
  // Round halves away from zero, without converting money amounts to floating point.
  if (remainder * 2n >= denominator) scaled += 1n;
  const integer = String(scaled / DECIMAL_SCALE);
  if (integer.length > MAX_INTEGER_DIGITS) throw calculationError('CALC_LIMIT');
  const decimal = String(scaled % DECIMAL_SCALE).padStart(DECIMAL_PLACES, '0').replace(/0+$/, '');
  return {
    result: `${numerator < 0n && scaled !== 0n ? '-' : ''}${integer}${decimal ? `.${decimal}` : ''}`,
    approximate: remainder !== 0n,
  };
}

/** Parse only explicit calculator requests; ordinary channel messages remain untouched. */
export function parseCalculationRequest(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value === '计算' || value === '计算器') return { kind: 'help' };
  if (!value.startsWith('计算') || value.startsWith('计算器')) return null;
  return { kind: 'calculate', expression: value.slice(2).trim() };
}

/** Evaluate bounded arithmetic with exact rational intermediates and no executable code. */
export function calculate(expression) {
  if (typeof expression !== 'string') throw calculationError('CALC_FORMAT');
  if (expression.length > MAX_INPUT_LENGTH) throw calculationError('CALC_LIMIT');
  const normalized = expression.normalize('NFKC').trim().replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  if (normalized.length > MAX_INPUT_LENGTH) throw calculationError('CALC_LIMIT');
  if (!normalized || !/^[\d.\s()+*/-]+$/.test(normalized)) throw calculationError('CALC_FORMAT');

  let position = 0, operations = 0;
  const skipSpace = () => { while (/\s/.test(normalized[position] ?? '') && position < normalized.length) position++; };
  const operation = () => { if (++operations > MAX_OPERATIONS) throw calculationError('CALC_LIMIT'); };

  function primary(depth) {
    skipSpace();
    if (normalized[position] === '(') {
      if (depth >= MAX_DEPTH) throw calculationError('CALC_LIMIT');
      position++;
      const value = sum(depth + 1);
      skipSpace();
      if (normalized[position] !== ')') throw calculationError('CALC_FORMAT');
      position++;
      return value;
    }
    const literal = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(normalized.slice(position))?.[0];
    if (!literal) throw calculationError('CALC_FORMAT');
    const digits = literal.replace('.', '');
    if (digits.length > MAX_LITERAL_DIGITS) throw calculationError('CALC_LIMIT');
    position += literal.length;
    const decimals = literal.includes('.') ? literal.length - literal.indexOf('.') - 1 : 0;
    return fraction(BigInt(digits), 10n ** BigInt(decimals));
  }

  function unary(depth) {
    let sign = 1n;
    skipSpace();
    while (normalized[position] === '+' || normalized[position] === '-') {
      operation();
      if (normalized[position++] === '-') sign = -sign;
      skipSpace();
    }
    const value = primary(depth);
    return { numerator: sign * value.numerator, denominator: value.denominator };
  }

  function product(depth) {
    let value = unary(depth);
    skipSpace();
    while (normalized[position] === '*' || normalized[position] === '/') {
      operation();
      const operator = normalized[position++], right = unary(depth);
      value = operator === '*'
        ? fraction(value.numerator * right.numerator, value.denominator * right.denominator)
        : fraction(value.numerator * right.denominator, value.denominator * right.numerator);
      skipSpace();
    }
    return value;
  }

  function sum(depth) {
    let value = product(depth);
    skipSpace();
    while (normalized[position] === '+' || normalized[position] === '-') {
      operation();
      const sign = normalized[position++] === '+' ? 1n : -1n, right = product(depth);
      value = fraction(value.numerator * right.denominator + sign * right.numerator * value.denominator,
        value.denominator * right.denominator);
      skipSpace();
    }
    return value;
  }

  const value = sum(0);
  skipSpace();
  if (position !== normalized.length) throw calculationError('CALC_FORMAT');
  return { expression: normalized, ...decimalResult(value) };
}
