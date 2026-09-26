import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, parseCalculationRequest, CalculatorError } from '../src/calculator.js';

test('only explicit calculation requests activate the calculator', () => {
  for (const input of ['菜单', '12+3', '请计算 12+3', '计算器在哪里', '', undefined, null]) {
    assert.equal(parseCalculationRequest(input), null);
  }
  for (const input of ['计算', ' 计算器\n', '\n计算 ']) assert.deepEqual(parseCalculationRequest(input), { kind: 'help' });
  assert.deepEqual(parseCalculationRequest('计算12+3'), { kind: 'calculate', expression: '12+3' });
  assert.deepEqual(parseCalculationRequest('  计算 （１２＋３）×２  '), { kind: 'calculate', expression: '（１２＋３）×２' });
});

test('invalid and oversized explicit requests reach a safe calculator error', () => {
  for (const input of ['sk-secret-not-arithmetic', '1'.repeat(201)]) {
    const request = parseCalculationRequest(`计算 ${input}`);
    assert.equal(request.kind, 'calculate');
    assert.throws(() => calculate(request.expression), error => error.code?.startsWith('CALC_') && !error.message.includes(input));
  }
});

test('decimal arithmetic stays exact for prices and large integers', () => {
  assert.deepEqual(calculate('0.1 + 0.2'), { expression: '0.1 + 0.2', result: '0.3', approximate: false });
  assert.equal(calculate('12.50*3+8.99*2').result, '55.48');
  assert.equal(calculate('9007199254740993+1').result, '9007199254740994');
  assert.equal(calculate('999999999999999999999999999999+1').result, '1000000000000000000000000000000');
  assert.deepEqual(calculate('1/3*3'), { expression: '1/3*3', result: '1', approximate: false });
});

test('precedence, parentheses, unary signs and alternate multiplication symbols work', () => {
  const cases = [
    ['2+3*4', '14'], ['(2+3)*4', '20'], ['-(-2 + +3)*4', '-4'], ['2*-3', '-6'],
    ['8/-2', '-4'], ['1--2', '3'], ['.5+1.', '1.5'], ['２.５×（３＋１）÷２', '5'],
    ['3x4+2X5', '22'], ['−2×−3', '6'], ['12\n+\t3', '15'],
  ];
  for (const [expression, expected] of cases) assert.equal(calculate(expression).result, expected, expression);
});

test('terminating results trim zeroes and repeating results round at twelve decimal places', () => {
  for (const [expression, result, approximate] of [
    ['1/8', '0.125', false], ['5/2', '2.5', false], ['1/3', '0.333333333333', true],
    ['2/3', '0.666666666667', true], ['-1/6', '-0.166666666667', true],
    ['1/1000000000000', '0.000000000001', false], ['1/2000000000000', '0.000000000001', true],
    ['-1/2000000000000', '-0.000000000001', true], ['-1/10000000000000', '0', true],
    ['19999999999999/20000000000000', '1', true], ['-0', '0', false],
  ]) assert.deepEqual(calculate(expression), { expression, result, approximate });
});

test('zero denominators, including calculated zero, are rejected with a distinct safe error', () => {
  for (const expression of ['1/0', '0/0', '1/(0.3-0.1-0.2)', '1/-0']) {
    assert.throws(() => calculate(expression), { code: 'CALC_DIVISION_ZERO', message: '不能除以零，请检查算式。' });
  }
});

test('malformed input, executable JavaScript, exponent syntax and implicit products are rejected', () => {
  for (const expression of [
    '', ' ', '1+', '()', '(1', '1)', '1..2', '.', '2(3)', '(2)(3)', '1 2', '1/**/2',
    '1e3', '2**3', '2^3', 'sqrt(4)', 'Math.random()', 'globalThis.process.exit()',
    '1;throw 2', '${1+2}', '1,000+2', '$12+3', '<script>', 'NaN', 'Infinity', '0xFF',
  ]) assert.throws(() => calculate(expression), { code: 'CALC_FORMAT' }, expression);
  for (const expression of [null, undefined, 123, {}, []]) assert.throws(() => calculate(expression), { code: 'CALC_FORMAT' });
});

test('exported calculator errors always carry a fixed message, even for an invalid code', () => {
  assert.throws(() => calculate('sk-secret-not-arithmetic'), error => error instanceof CalculatorError && error.code === 'CALC_FORMAT');
  assert.equal(new CalculatorError('sk-secret-not-arithmetic').message, new CalculatorError().message);
});

test('literal size, input length, operation count and nesting have resource limits', () => {
  const tooLarge = ['1'.repeat(31), '0.'.concat('0'.repeat(30)), ' '.repeat(201), '+'.repeat(101) + '1', '('.repeat(21) + '1' + ')'.repeat(21)];
  for (const expression of tooLarge) assert.throws(() => calculate(expression), { code: 'CALC_LIMIT' });
  assert.equal(calculate('('.repeat(20) + '1' + ')'.repeat(20)).result, '1');
  assert.equal(calculate('+'.repeat(100) + '1').result, '1');
});

test('output cannot flood the channel with an oversized integer or scientific notation', () => {
  assert.throws(() => calculate(Array(4).fill('999999999999999999999999999999').join('*')), { code: 'CALC_LIMIT' });
  const { result } = calculate(Array(3).fill('999999999999999999999999999999').join('*'));
  assert.equal(result.length, 90);
  assert.match(result, /^\d+$/);
});
