export interface ImportedGroupRow {
  row: number;
  studentId: string;
  email: string;
  expectedEmail: string;
  status: 'new' | 'existing' | 'changed';
  cells: Readonly<Record<string, string>>;
}

export type GroupImportErrorCode =
  | 'empty_file'
  | 'invalid_csv'
  | 'duplicate_header'
  | 'missing_header'
  | 'missing_student_id'
  | 'missing_email'
  | 'missing_name'
  | 'invalid_student_id'
  | 'invalid_email'
  | 'email_mismatch'
  | 'duplicate_student_id'
  | 'duplicate_email';

export interface GroupImportError {
  row: number;
  code: GroupImportErrorCode;
  message: string;
}

export interface GroupImportResult {
  rows: ImportedGroupRow[];
  errors: GroupImportError[];
  warnings: string[];
}

export interface GroupImportOptions {
  existingStudentIds?: ReadonlySet<string>;
  existingStudents?: ReadonlyMap<string, { email: string; cells: Readonly<Record<string, string>> }>;
}

type ParsedCsvRow = { row: number; cells: string[] };

const REQUIRED_HEADERS = new Map<string, string>([
  ['student id', 'Student ID'],
  ['email', 'Email'],
  ['name', 'Name'],
  ['first name', 'First Name'],
]);

/** Parses and validates a header-based CSV export for group membership import. */
export function parseGroupImport(
  text: string,
  options: GroupImportOptions | ReadonlySet<string> = {},
): GroupImportResult {
  const existingStudentIds: ReadonlySet<string> = isStudentIdSet(options)
    ? options
    : options.existingStudentIds ?? new Set<string>();
  const existingStudents = isStudentIdSet(options) ? undefined : options.existingStudents;
  const parsed = parseCsv(text);
  if (parsed.error) {
    return { rows: [], errors: [{ row: parsed.error.row, code: 'invalid_csv', message: parsed.error.message }], warnings: [] };
  }
  if (parsed.rows.length === 0 || parsed.rows[0]?.cells.every((cell) => cell === '')) {
    return {
      rows: [],
      errors: [{ row: 1, code: 'empty_file', message: 'CSV must contain a header line' }],
      warnings: [],
    };
  }

  const [headerRow, ...dataRows] = parsed.rows;
  if (!headerRow) {
    return { rows: [], errors: [{ row: 1, code: 'empty_file', message: 'CSV must contain a header line' }], warnings: [] };
  }

  const headerKeys = headerRow.cells.map((header) => header.toLocaleLowerCase());
  const errors: GroupImportError[] = [];
  const warnings: string[] = [];
  const seenHeaders = new Set<string>();
  for (const [index, key] of headerKeys.entries()) {
    if (seenHeaders.has(key)) {
      errors.push({ row: headerRow.row, code: 'duplicate_header', message: `Duplicate header: ${headerRow.cells[index] ?? ''}` });
    }
    seenHeaders.add(key);
    if (!REQUIRED_HEADERS.has(key) && headerRow.cells[index]) warnings.push(`Unknown column: ${headerRow.cells[index]}`);
  }

  const studentIdIndex = headerKeys.indexOf('student id');
  const emailIndex = headerKeys.indexOf('email');
  const nameIndex = headerKeys.includes('first name') ? headerKeys.indexOf('first name') : headerKeys.indexOf('name');
  if (studentIdIndex < 0) errors.push({ row: headerRow.row, code: 'missing_header', message: 'Student ID column is required' });
  if (emailIndex < 0) errors.push({ row: headerRow.row, code: 'missing_header', message: 'Email column is required' });
  if (nameIndex < 0) errors.push({ row: headerRow.row, code: 'missing_header', message: 'Name or First Name column is required' });
  if (errors.some((error) => error.code === 'duplicate_header' || error.code === 'missing_header')) {
    return { rows: [], errors, warnings: unique(warnings) };
  }

  const rows: ImportedGroupRow[] = [];
  const seenStudentIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const dataRow of dataRows) {
    if (dataRow.cells.every((cell) => cell === '')) continue;
    const cells: Record<string, string> = {};
    headerRow.cells.forEach((header, index) => {
      cells[header] = dataRow.cells[index] ?? '';
    });
    const studentId = dataRow.cells[studentIdIndex] ?? '';
    const email = dataRow.cells[emailIndex] ?? '';
    const normalizedEmail = email.toLocaleLowerCase();
    const firstName = dataRow.cells[nameIndex] ?? '';
    const expectedEmail = studentId && firstName ? `${studentId}${Array.from(firstName)[0]?.toLocaleLowerCase()}@jdu.uz` : '';
    const rowErrors: GroupImportError[] = [];
    if (!studentId) rowErrors.push({ row: dataRow.row, code: 'missing_student_id', message: 'Student ID is required' });
    else if (!/^\d+$/.test(studentId)) rowErrors.push({ row: dataRow.row, code: 'invalid_student_id', message: 'Student ID must be numeric' });
    if (!email) rowErrors.push({ row: dataRow.row, code: 'missing_email', message: 'Email is required' });
    else if (!/^[^\s@]+@jdu\.uz$/i.test(email)) rowErrors.push({ row: dataRow.row, code: 'invalid_email', message: 'University email must end in @jdu.uz' });
    if (!firstName) rowErrors.push({ row: dataRow.row, code: 'missing_name', message: 'First name is required' });
    if (/^\d+$/.test(studentId) && expectedEmail && /^[^\s@]+@jdu\.uz$/i.test(email) && normalizedEmail !== expectedEmail) {
      rowErrors.push({ row: dataRow.row, code: 'email_mismatch', message: 'Email does not match Student ID and first name' });
    }
    if (studentId && seenStudentIds.has(studentId)) {
      rowErrors.push({ row: dataRow.row, code: 'duplicate_student_id', message: 'Student ID is duplicated in this file' });
    }
    if (email && seenEmails.has(normalizedEmail)) {
      rowErrors.push({ row: dataRow.row, code: 'duplicate_email', message: 'Email is duplicated in this file' });
    }
    errors.push(...rowErrors);
    if (studentId) seenStudentIds.add(studentId);
    if (email) seenEmails.add(normalizedEmail);
    if (rowErrors.length === 0) {
      const existing = existingStudents?.get(studentId);
      const changed = existing && (existing.email.toLocaleLowerCase() !== normalizedEmail ||
        Object.entries(cells).some(([key, value]) => existing.cells[key] !== value));
      rows.push({ row: dataRow.row, studentId, email, expectedEmail,
        status: changed ? 'changed' : existing || existingStudentIds.has(studentId) ? 'existing' : 'new', cells });
    }
  }

  return { rows, errors, warnings: unique(warnings) };
}

export const importGroups = parseGroupImport;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isStudentIdSet(value: GroupImportOptions | ReadonlySet<string>): value is ReadonlySet<string> {
  return typeof (value as ReadonlySet<string>).has === 'function';
}

function parseCsv(text: string): { rows: ParsedCsvRow[]; error?: { row: number; message: string } } {
  const rows: ParsedCsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let row = 1;
  let rowStart = 1;

  const finishRow = () => {
    cells.push(cell.trim());
    rows.push({ row: rowStart, cells });
    cells = [];
    cell = '';
    rowStart = row + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell.trim() === '') {
      inQuotes = true;
    } else if (character === ',') {
      cells.push(cell.trim());
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
      row += 1;
    } else {
      cell += character;
    }
  }
  if (inQuotes) return { rows: [], error: { row: rowStart, message: 'Unclosed quoted field' } };
  if (cell !== '' || cells.length > 0 || text.endsWith(',')) finishRow();
  return { rows };
}
