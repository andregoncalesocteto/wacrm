// Pure parts of the generic connection form (no React, no i18n): initial
// values, validation and the request payload built from a field descriptor.

import type { DescriptorField } from './types';

export type FieldValue = string | boolean;
export type FormValues = Record<string, FieldValue>;
export type FieldError = 'required' | 'pattern';
export type FormErrors = Record<string, FieldError>;

export function initialValues(fields: DescriptorField[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) values[f.name] = f.type === 'switch' ? false : '';
  return values;
}

function text(v: FieldValue | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Required fields must be filled; a `pattern` applies to non-empty text. */
export function validateValues(
  fields: DescriptorField[],
  values: FormValues
): FormErrors {
  const errors: FormErrors = {};
  for (const f of fields) {
    if (f.type === 'switch') continue;
    const v = text(values[f.name]);
    if (!v) {
      if (f.required) errors[f.name] = 'required';
      continue;
    }
    if (f.type === 'select' && f.options && !f.options.includes(v)) {
      errors[f.name] = 'pattern';
      continue;
    }
    if (f.type === 'text' && f.pattern) {
      let ok = true;
      try {
        ok = new RegExp(f.pattern).test(v);
      } catch {
        ok = true; // a broken descriptor pattern must not block the user
      }
      if (!ok) errors[f.name] = 'pattern';
    }
  }
  return errors;
}

/**
 * Splits the values into the `config` and `credentials` objects of
 * POST /api/channels/connections. Secrets only ever land in `credentials`;
 * empty optional strings are left out.
 */
export function buildPayload(
  fields: DescriptorField[],
  values: FormValues
): {
  config: Record<string, FieldValue>;
  credentials: Record<string, FieldValue>;
} {
  const config: Record<string, FieldValue> = {};
  const credentials: Record<string, FieldValue> = {};
  for (const f of fields) {
    const raw = values[f.name];
    let value: FieldValue;
    if (f.type === 'switch') value = raw === true;
    else {
      value = text(raw);
      if (value === '') continue;
    }
    (f.target === 'credentials' ? credentials : config)[f.name] = value;
  }
  return { config, credentials };
}
