import { describe, expect, it } from 'vitest';
import { parseGroupImport } from '../../src/domain/groups/import';

describe('group CSV import', () => {
  it('trims cells and returns valid rows', () => {
    const result = parseGroupImport('Student ID,Email,Name\n 240001 , STUDENT@JDU.UZ , Alice ');

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ studentId: '240001', email: 'STUDENT@JDU.UZ' });
    expect(result.rows[0]?.cells).toEqual({
      'Student ID': '240001',
      Email: 'STUDENT@JDU.UZ',
      Name: 'Alice',
    });
  });

  it('rejects duplicate student IDs within the file and against existing IDs', () => {
    const result = parseGroupImport(
      'Student ID,Email\n240001,a@jdu.uz\n240001,b@jdu.uz\n240002,c@jdu.uz',
      { existingStudentIds: new Set(['240002']) },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, code: 'duplicate_student_id' }),
        expect.objectContaining({ row: 4, code: 'existing_student_id' }),
      ]),
    );
  });

  it('rejects duplicate emails case-insensitively', () => {
    const result = parseGroupImport('Student ID,Email\n240001,a@jdu.uz\n240002,A@JDU.UZ');

    expect(result.rows).toHaveLength(1);
    expect(result.errors).toContainEqual({
      row: 3,
      code: 'duplicate_email',
      message: 'Email is duplicated in this file',
    });
  });

  it('warns about unknown columns and reports missing required fields', () => {
    const result = parseGroupImport('Student ID,Email,Nickname\n,student@jdu.uz,A\n240002,,B');

    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual(['Unknown column: Nickname']);
    expect(result.errors).toEqual([
      { row: 2, code: 'missing_student_id', message: 'Student ID is required' },
      { row: 3, code: 'missing_email', message: 'Email is required' },
    ]);
  });

  it('reports duplicate headers as an import error', () => {
    const result = parseGroupImport('Student ID,Email,email\n240001,a@jdu.uz,b@jdu.uz');

    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({ row: 1, code: 'duplicate_header' });
  });
});
