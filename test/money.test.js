// Tests ₹ formatting (Indian digit grouping) and the working-day reversal math.
import { describe, it, expect } from 'vitest';
import { formatInr, groupIndian, addWorkingDays, isWeekend } from '../src/core/money.js';

describe('money formatting — ₹ with Indian digit grouping', () => {
  it('groups digits the Indian way', () => {
    expect(groupIndian('1234567')).toBe('12,34,567');
    expect(groupIndian('100000')).toBe('1,00,000');
    expect(groupIndian('999')).toBe('999');
    expect(groupIndian('1000')).toBe('1,000');
  });

  it('formats paise into rupees with two decimals', () => {
    expect(formatInr(149900)).toBe('₹1,499.00');
    expect(formatInr(4999900)).toBe('₹49,999.00');
    expect(formatInr(100)).toBe('₹1.00');
    expect(formatInr(1)).toBe('₹0.01');
    expect(formatInr(123456789)).toBe('₹12,34,567.89');
  });
});

describe('reversal date — 5 working days, weekends skipped', () => {
  it('skips Saturday and Sunday', () => {
    // 2025-08-20 is a Wednesday (UTC). +5 working days -> Wed 2025-08-27.
    const start = new Date('2025-08-20T10:00:00.000Z');
    const end = addWorkingDays(start, 5);
    expect(isWeekend(end)).toBe(false);
    // Wed +5 business days = next Wed
    expect(end.getUTCFullYear()).toBe(2025);
    expect(end.getUTCMonth()).toBe(7); // August
    expect(end.getUTCDate()).toBe(27);
  });

  it('never lands the reversal date on a weekend', () => {
    for (let i = 0; i < 14; i++) {
      const start = new Date('2025-08-01T00:00:00.000Z');
      start.setUTCDate(start.getUTCDate() + i);
      const end = addWorkingDays(start, 5);
      expect(isWeekend(end)).toBe(false);
    }
  });
});
