import { describe, expect, it } from 'vitest';
import { parseGroupImport } from '../../src/domain/groups/import';

describe('group CSV import', () => {
  it('trims cells and returns valid rows', () => {
    const result = parseGroupImport('Student ID,Email,Name\n 240001 , 240001a@JDU.UZ , Alice ');

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ studentId: '240001', email: '240001a@JDU.UZ', expectedEmail: '240001a@jdu.uz', status: 'new' });
    expect(result.rows[0]?.cells).toEqual({
      'Student ID': '240001',
      Email: '240001a@JDU.UZ',
      Name: 'Alice',
    });
  });

  it('rejects duplicate student IDs within the file and previews existing IDs', () => {
    const result = parseGroupImport(
      'Student ID,Email,Name\n240001,240001a@jdu.uz,Alice\n240001,240001a@jdu.uz,Alice\n240002,240002b@jdu.uz,Bob',
      { existingStudentIds: new Set(['240002']) },
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toMatchObject({ studentId: '240002', status: 'existing' });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, code: 'duplicate_student_id' }),
      ]),
    );
  });

  it('rejects duplicate emails case-insensitively', () => {
    const result = parseGroupImport('Student ID,Email,Name\n240001,240001a@jdu.uz,Alice\n240002,240001a@JDU.UZ,Bob');

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toContainEqual({
      row: 3,
      code: 'duplicate_email',
      message: 'Email is duplicated in this file',
    });
  });

  it('warns about unknown columns and reports missing required fields', () => {
    const result = parseGroupImport('Student ID,Email,Name,Nickname\n,student@jdu.uz,A,A\n240002,,B,B');

    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual(['Unknown column: Nickname']);
    expect(result.errors).toEqual([
      { row: 2, code: 'missing_student_id', message: 'Student ID is required' },
      { row: 3, code: 'missing_email', message: 'Email is required' },
    ]);
  });

  it('rejects malformed IDs, non-university email, and email mismatched with the ID and first name', () => {
    const result = parseGroupImport('Student ID,Email,Name\nabc,abcx@jdu.uz,Xena\n240002,b@example.com,Bob\n240003,240003x@jdu.uz,Carol');
    expect(result.rows).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual(['invalid_student_id', 'invalid_email', 'email_mismatch']);
  });

  it('classifies unchanged and changed repeat-import rows by Student ID', () => {
    const existingStudents = new Map([
      ['240001', { email: '240001a@jdu.uz', cells: { 'Student ID': '240001', Email: '240001a@jdu.uz', Name: 'Alice' } }],
      ['240002', { email: '240002b@jdu.uz', cells: { 'Student ID': '240002', Email: '240002b@jdu.uz', Name: 'Bob' } }],
    ]);
    const result = parseGroupImport('Student ID,Email,Name\n240001,240001a@jdu.uz,Alice\n240002,240002b@jdu.uz,Bobby', { existingStudents });
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.status)).toEqual(['existing', 'changed']);
  });

  it('reports duplicate headers as an import error', () => {
    const result = parseGroupImport('Student ID,Email,email\n240001,a@jdu.uz,b@jdu.uz');

    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({ row: 1, code: 'duplicate_header' });
  });
});
